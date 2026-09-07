"""Pydantic model tests: round-trip fidelity, cross-field validators, lookup helpers."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from tableauforge.spec.models import (
    CalculatedField,
    Chart,
    DashboardSpec,
    Datasource,
    Field,
    FieldRef,
    Zone,
)


def _string_field(name: str = "A") -> dict[str, str]:
    return {"name": name, "datatype": "string", "role": "dimension"}


def test_model_validate_round_trip(canonical_spec_dict: dict[str, Any]) -> None:
    spec = DashboardSpec.model_validate(canonical_spec_dict)
    dumped = spec.model_dump(mode="json", exclude_none=True, exclude_defaults=True)
    assert dumped == canonical_spec_dict
    assert DashboardSpec.model_validate(dumped) == spec


def test_extra_keys_forbidden(canonical_spec_dict: dict[str, Any]) -> None:
    canonical_spec_dict["surprise"] = True
    with pytest.raises(ValidationError):
        DashboardSpec.model_validate(canonical_spec_dict)


def test_datasource_embedded_csv_requires_csv() -> None:
    with pytest.raises(ValidationError, match="requires csv"):
        Datasource.model_validate(
            {"id": "x", "name": "X", "kind": "embedded_csv", "fields": [_string_field()]}
        )


def test_datasource_live_database_requires_database() -> None:
    with pytest.raises(ValidationError, match="requires database"):
        Datasource.model_validate(
            {
                "id": "x",
                "name": "X",
                "kind": "live_database",
                "csv": {"table_name": "irrelevant"},
                "fields": [_string_field()],
            }
        )


def test_zone_worksheet_kind_requires_worksheet() -> None:
    with pytest.raises(ValidationError, match="requires a worksheet id"):
        Zone.model_validate({"kind": "worksheet", "x": 0, "y": 0, "w": 50, "h": 50})


def test_zone_text_kind_requires_text() -> None:
    with pytest.raises(ValidationError, match="requires text"):
        Zone.model_validate({"kind": "text", "x": 0, "y": 0, "w": 50, "h": 50})


def test_zone_blank_kind_needs_no_ref() -> None:
    zone = Zone.model_validate({"kind": "blank", "x": 0, "y": 0, "w": 50, "h": 50})
    assert zone.worksheet is None
    assert zone.text is None


def test_field_map_includes_calculated_fields() -> None:
    ds = Datasource.model_validate(
        {
            "id": "ds",
            "name": "ds",
            "kind": "embedded_csv",
            "csv": {"table_name": "t"},
            "fields": [
                {"name": "Sales", "datatype": "real", "role": "measure"},
                _string_field("Region"),
            ],
            "calculated_fields": [
                {
                    "name": "Sales % of Total",
                    "formula": "SUM([Sales]) / TOTAL(SUM([Sales]))",
                    "datatype": "real",
                    "role": "measure",
                    "template": "percent_of_total",
                }
            ],
        }
    )
    fmap = ds.field_map()
    assert set(fmap) == {"Sales", "Region", "Sales % of Total"}
    assert isinstance(fmap["Sales"], Field)
    assert isinstance(fmap["Sales % of Total"], CalculatedField)


def test_datasource_by_id_lookup(canonical_spec_dict: dict[str, Any]) -> None:
    spec = DashboardSpec.model_validate(canonical_spec_dict)
    assert spec.datasource_by_id("sales_ds").name == "sales"
    with pytest.raises(KeyError, match="unknown datasource id"):
        spec.datasource_by_id("nope")


def test_worksheet_by_id_lookup(canonical_spec_dict: dict[str, Any]) -> None:
    spec = DashboardSpec.model_validate(canonical_spec_dict)
    assert spec.worksheet_by_id("sales_by_region").title == "Sales by Region"
    with pytest.raises(KeyError, match="unknown worksheet id"):
        spec.worksheet_by_id("nope")


def test_all_field_refs_completeness() -> None:
    chart = Chart(
        type="bar",
        rows=[FieldRef(field="r1")],
        cols=[FieldRef(field="c1"), FieldRef(field="c2")],
        color=FieldRef(field="color"),
        size=FieldRef(field="size"),
        label=FieldRef(field="label"),
        detail=[FieldRef(field="d1"), FieldRef(field="d2")],
        tooltip=[FieldRef(field="t1")],
        secondary_rows=[FieldRef(field="s1")],
    )
    assert [r.field for r in chart.all_field_refs()] == [
        "r1", "c1", "c2", "color", "size", "label", "d1", "d2", "t1", "s1",
    ]


def test_all_field_refs_skips_absent_optionals() -> None:
    chart = Chart(type="bar", rows=[FieldRef(field="r1")], cols=[])
    assert [r.field for r in chart.all_field_refs()] == ["r1"]
