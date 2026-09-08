"""JSON Schema gate tests: every violation class must produce a path-bearing error."""

from __future__ import annotations

from typing import Any

import pytest

from tableauforge.spec.schema import (
    SpecValidationError,
    assert_valid_spec,
    load_schema,
    repair_identifiers,
    repair_zones,
    validate_spec,
)


def test_canonical_spec_is_valid(canonical_spec_dict: dict[str, Any]) -> None:
    assert validate_spec(canonical_spec_dict) == []


def test_assert_valid_spec_passes_silently(canonical_spec_dict: dict[str, Any]) -> None:
    assert assert_valid_spec(canonical_spec_dict) is None


def test_load_schema_is_cached() -> None:
    assert load_schema() is load_schema()
    assert load_schema()["title"] == "DashboardSpec v1"


def test_bad_enum_chart_type(canonical_spec_dict: dict[str, Any]) -> None:
    canonical_spec_dict["worksheets"][0]["chart"]["type"] = "sunburst"
    errors = validate_spec(canonical_spec_dict)
    assert len(errors) == 1
    assert errors[0].startswith("$.worksheets[0].chart.type:")
    assert "'sunburst'" in errors[0]


def test_missing_required_field_property(canonical_spec_dict: dict[str, Any]) -> None:
    del canonical_spec_dict["datasources"][0]["fields"][0]["name"]
    errors = validate_spec(canonical_spec_dict)
    assert any(
        e.startswith("$.datasources[0].fields[0]:") and "'name' is a required property" in e
        for e in errors
    )


def test_missing_required_top_level(canonical_spec_dict: dict[str, Any]) -> None:
    del canonical_spec_dict["workbook"]
    errors = validate_spec(canonical_spec_dict)
    assert any(e.startswith("$:") and "'workbook' is a required property" in e for e in errors)


def test_additional_properties_rejected(canonical_spec_dict: dict[str, Any]) -> None:
    canonical_spec_dict["surprise"] = True
    errors = validate_spec(canonical_spec_dict)
    assert any(e.startswith("$:") and "Additional properties" in e for e in errors)


def test_bad_identifier_pattern(canonical_spec_dict: dict[str, Any]) -> None:
    canonical_spec_dict["datasources"][0]["id"] = "Sales-DS"
    errors = validate_spec(canonical_spec_dict)
    assert any(e.startswith("$.datasources[0].id:") and "Sales-DS" in e for e in errors)


def test_zone_worksheet_kind_requires_worksheet_ref(canonical_spec_dict: dict[str, Any]) -> None:
    del canonical_spec_dict["dashboards"][0]["zones"][0]["worksheet"]
    errors = validate_spec(canonical_spec_dict)
    assert any(
        e.startswith("$.dashboards[0].zones[0]:") and "'worksheet' is a required property" in e
        for e in errors
    )


def test_assert_valid_spec_raises_with_errors(canonical_spec_dict: dict[str, Any]) -> None:
    canonical_spec_dict["worksheets"][0]["chart"]["type"] = "sunburst"
    del canonical_spec_dict["datasources"][0]["fields"][0]["name"]
    with pytest.raises(SpecValidationError) as excinfo:
        assert_valid_spec(canonical_spec_dict)
    err = excinfo.value
    assert isinstance(err.errors, list)
    assert len(err.errors) >= 2
    assert all(e.startswith("$") for e in err.errors)
    assert "DashboardSpec failed schema validation" in str(err)


# ---- deterministic repairs (repair_identifiers / repair_zones) --------------
#
# Measured against three real local-model rebuild specs: bad identifiers were the
# largest single error class (21 of 59 schema errors), and every one of them
# cleared after repair_identifiers.


def test_repair_identifiers_slugifies_definition_ids(canonical_spec_dict: dict[str, Any]) -> None:
    canonical_spec_dict["dashboards"][0]["id"] = "platform-overview"
    repair_identifiers(canonical_spec_dict)
    assert canonical_spec_dict["dashboards"][0]["id"] == "platform_overview"
    assert validate_spec(canonical_spec_dict) == []


def test_repair_identifiers_rewrites_references_to_renamed_ids(
    canonical_spec_dict: dict[str, Any],
) -> None:
    """A renamed id is worthless if its references still point at the old one."""
    ws = canonical_spec_dict["worksheets"][0]
    ds = canonical_spec_dict["datasources"][0]
    old_ws, old_ds = ws["id"], ds["id"]
    ws["id"], ds["id"] = f"{old_ws}-A", f"{old_ds}-A"
    ws["datasource"] = f"{old_ds}-A"
    canonical_spec_dict["dashboards"][0]["zones"][0]["worksheet"] = f"{old_ws}-A"

    repair_identifiers(canonical_spec_dict)

    assert ws["id"] == f"{old_ws}_a"
    assert ws["datasource"] == ds["id"] == f"{old_ds}_a"
    assert canonical_spec_dict["dashboards"][0]["zones"][0]["worksheet"] == f"{old_ws}_a"
    assert validate_spec(canonical_spec_dict) == []


def test_repair_identifiers_resolves_a_zone_naming_its_worksheet_by_title(
    canonical_spec_dict: dict[str, Any],
) -> None:
    """The dominant real-world failure: zones carry the worksheet's TITLE."""
    ws = canonical_spec_dict["worksheets"][0]
    ws["title"] = "Ease of Biz Correlation Sheet"
    canonical_spec_dict["dashboards"][0]["zones"][0]["worksheet"] = "Ease of Biz Correlation Sheet"

    repair_identifiers(canonical_spec_dict)

    assert canonical_spec_dict["dashboards"][0]["zones"][0]["worksheet"] == ws["id"]
    assert validate_spec(canonical_spec_dict) == []


def test_repair_identifiers_keeps_slugged_ids_unique(canonical_spec_dict: dict[str, Any]) -> None:
    """A slug must never collide with an id that was already legal, or the
    colliding worksheet's zones would silently re-point at the wrong sheet."""
    first = canonical_spec_dict["worksheets"][0]
    second = dict(first)
    second["id"] = f"{first['id']}!"  # slugifies onto the first's id
    second["title"] = "Second"
    canonical_spec_dict["worksheets"].append(second)

    repair_identifiers(canonical_spec_dict)

    assert second["id"] != first["id"]
    assert validate_spec(canonical_spec_dict) == []


def test_repair_zones_salvages_text_filed_under_a_near_miss_key(
    canonical_spec_dict: dict[str, Any],
) -> None:
    zones = canonical_spec_dict["dashboards"][0]["zones"]
    zones.append({"kind": "text", "label": "Q3 summary", "x": 0, "y": 80, "w": 100, "h": 10})
    repair_zones(canonical_spec_dict)
    assert zones[-1] == {"kind": "text", "text": "Q3 summary", "x": 0, "y": 80, "w": 100, "h": 10}
    assert validate_spec(canonical_spec_dict) == []


def test_repair_zones_downgrades_a_text_zone_with_no_text(
    canonical_spec_dict: dict[str, Any],
) -> None:
    """It keeps its slot in the layout; no caption is invented to fill it."""
    zones = canonical_spec_dict["dashboards"][0]["zones"]
    zones.append({"kind": "text", "x": 0, "y": 80, "w": 50, "h": 10})
    assert validate_spec(canonical_spec_dict)  # 'text' is a required property

    repair_zones(canonical_spec_dict)

    assert zones[-1]["kind"] == "blank"
    assert validate_spec(canonical_spec_dict) == []


def test_repair_zones_drops_a_dangling_worksheet_reference(
    canonical_spec_dict: dict[str, Any],
) -> None:
    """The schema checks the id PATTERN, not that the worksheet exists, so a
    dangling reference sails through validation and dies in the compiler
    instead — this repair is the only thing that catches it."""
    zones = canonical_spec_dict["dashboards"][0]["zones"]
    zones.append({"kind": "worksheet", "worksheet": "no_such_sheet", "x": 50, "y": 80, "w": 50, "h": 10})
    assert validate_spec(canonical_spec_dict) == []  # schema is blind to it

    repair_zones(canonical_spec_dict)

    assert zones[-1]["kind"] == "blank"
    assert "worksheet" not in zones[-1]


def test_repair_zones_infers_missing_kind_and_drops_nulls(
    canonical_spec_dict: dict[str, Any],
) -> None:
    zones = canonical_spec_dict["dashboards"][0]["zones"]
    ws_id = canonical_spec_dict["worksheets"][0]["id"]
    zones.append({"worksheet": ws_id, "x": 0, "y": 80, "w": 50, "h": 10, "confidence": None})

    repair_zones(canonical_spec_dict)

    assert zones[-1]["kind"] == "worksheet"
    assert "confidence" not in zones[-1]
    assert validate_spec(canonical_spec_dict) == []


def test_repairs_leave_a_clean_spec_untouched(canonical_spec_dict: dict[str, Any]) -> None:
    import copy

    before = copy.deepcopy(canonical_spec_dict)
    repair_identifiers(canonical_spec_dict)
    repair_zones(canonical_spec_dict)
    assert canonical_spec_dict == before


def test_omitted_shelves_are_the_same_as_empty_ones(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """A KPI counter carries its measure on 'label' and nothing on the shelves.
    The prompt calls that "empty rows/cols"; a model writes it by leaving the
    keys out. Both notations say the same thing, so both must validate."""
    chart = lakeview_spec_dict["worksheets"][1]["chart"]
    assert chart["type"] == "counter" and chart["rows"] == [] and chart["cols"] == []
    del chart["rows"]
    del chart["cols"]

    assert validate_spec(lakeview_spec_dict) == []


def test_a_shelf_may_still_not_be_a_non_array(canonical_spec_dict: dict[str, Any]) -> None:
    """Optional is not untyped — a scalar on a shelf is still a contract error."""
    canonical_spec_dict["worksheets"][0]["chart"]["rows"] = {"field": "Sales"}
    errors = validate_spec(canonical_spec_dict)
    assert len(errors) == 1
    assert errors[0].startswith("$.worksheets[0].chart.rows:")
