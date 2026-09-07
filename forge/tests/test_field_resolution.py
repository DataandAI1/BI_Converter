"""Tests for the deterministic field-reference resolver (tableauforge.spec.field_resolution).

The resolver is the repair layer that keeps a build alive when an authored spec
references a near-miss name, a bare date part, or a concept the data does not
carry — turning what used to be a hard HTTP 422 into a reported rename/derive/drop.
"""

from __future__ import annotations

import copy
from typing import Any

from tableauforge.spec.precheck import precheck_field_references
from tableauforge.spec.field_resolution import resolve_field_references
from tableauforge.spec.models import DashboardSpec
from tableauforge.spec.schema import assert_valid_spec


def _spec() -> dict[str, Any]:
    """Two datasources on one dashboard — the CX shape from the reported bug."""
    return {
        "spec_version": "1.0",
        "workbook": {"name": "CX"},
        "datasources": [
            {
                "id": "ny_times_ces",
                "name": "ces",
                "kind": "embedded_csv",
                "csv": {"table_name": "ces"},
                "fields": [
                    {"name": "Completed Date", "datatype": "date", "role": "dimension"},
                    {"name": "Sent Date", "datatype": "date", "role": "dimension"},
                    {"name": "Channel Type", "datatype": "string", "role": "dimension"},
                    {"name": "CES", "datatype": "real", "role": "measure", "default_aggregation": "avg"},
                ],
            },
            {
                "id": "ny_times_volume",
                "name": "volume",
                "kind": "embedded_csv",
                "csv": {"table_name": "volume"},
                "fields": [
                    {"name": "Date", "datatype": "date", "role": "dimension"},
                    {"name": "Queue", "datatype": "string", "role": "dimension"},
                    {"name": "Contacts", "datatype": "integer", "role": "measure", "default_aggregation": "sum"},
                ],
            },
        ],
        "worksheets": [
            {
                "id": "ces_ws", "title": "CES", "datasource": "ny_times_ces",
                "chart": {"type": "bar", "rows": [{"field": "CES", "aggregation": "avg"}],
                          "cols": [{"field": "Channel Type"}]},
            },
            {
                "id": "vol_ws", "title": "Volume", "datasource": "ny_times_volume",
                "chart": {"type": "bar", "rows": [{"field": "Contacts", "aggregation": "sum"}],
                          "cols": [{"field": "Queue"}]},
            },
        ],
        "dashboards": [
            {
                "id": "main", "title": "CX", "size": {"width": 1200, "height": 800},
                "zones": [
                    {"kind": "worksheet", "worksheet": "ces_ws", "x": 0, "y": 0, "w": 50, "h": 100},
                    {"kind": "worksheet", "worksheet": "vol_ws", "x": 50, "y": 0, "w": 50, "h": 100},
                ],
                "shared_filters": [],
            }
        ],
    }


def _gate(spec: dict[str, Any]) -> list[str]:
    return precheck_field_references(DashboardSpec.model_validate(spec))


def test_clean_spec_unchanged() -> None:
    spec = _spec()
    before = copy.deepcopy(spec)
    actions = resolve_field_references(spec)
    assert actions == []
    assert spec == before


def test_case_insensitive_filter_rename() -> None:
    spec = _spec()
    spec["worksheets"][0]["filters"] = [
        {"field": "channel type", "filter_type": "categorical", "values": ["Chat"]}
    ]
    actions = resolve_field_references(spec)
    assert spec["worksheets"][0]["filters"][0]["field"] == "Channel Type"
    assert any(a.action == "renamed" and a.resolved == "Channel Type" for a in actions)
    assert _gate(spec) == []


def test_unresolvable_worksheet_filter_dropped() -> None:
    spec = _spec()
    spec["worksheets"][1]["filters"] = [
        {"field": "Vendor", "filter_type": "categorical", "values": ["Acme"]},
        {"field": "Queue", "filter_type": "categorical", "values": ["Sales"]},
    ]
    actions = resolve_field_references(spec)
    remaining = [f["field"] for f in spec["worksheets"][1]["filters"]]
    assert remaining == ["Queue"]  # real filter kept, invented one dropped
    assert any(a.action == "dropped" and a.original == "Vendor" for a in actions)
    assert _gate(spec) == []


def test_bare_date_part_filter_derived() -> None:
    spec = _spec()
    spec["worksheets"][0]["filters"] = [
        {"field": "Month", "filter_type": "categorical", "values": ["January"]}
    ]
    resolve_field_references(spec)
    flt = spec["worksheets"][0]["filters"][0]
    assert flt["field"] == "Completed Date"  # first date field on the CES source
    assert flt["date_part"] == "month"
    assert flt["filter_type"] == "categorical"
    assert _gate(spec) == []


def test_databricks_target_never_derives_date_parts() -> None:
    """The Lakeview compiler rejects date_part refs, so the resolver must not
    inject them: a bare date-part name falls to drop/gate instead."""
    # Filter: droppable — the sheet renders unfiltered.
    spec = _spec()
    spec["worksheets"][0]["filters"] = [
        {"field": "Month", "filter_type": "categorical", "values": ["January"]}
    ]
    actions = resolve_field_references(spec, target="databricks")
    assert spec["worksheets"][0]["filters"] == []
    assert any(a.action == "dropped" and a.original == "Month" for a in actions)

    # Shelf: structural — left unresolved for the gate to reject loudly.
    spec = _spec()
    spec["worksheets"][0]["chart"]["cols"] = [{"field": "Month"}]
    actions = resolve_field_references(spec, target="databricks")
    assert spec["worksheets"][0]["chart"]["cols"] == [{"field": "Month"}]
    assert any(a.action == "unresolved" and a.original == "Month" for a in actions)
    assert _gate(spec) != []

    # Default target still derives (regression guard for the tableau path).
    spec = _spec()
    spec["worksheets"][0]["chart"]["cols"] = [{"field": "Month"}]
    resolve_field_references(spec)
    assert spec["worksheets"][0]["chart"]["cols"][0]["date_part"] == "month"


def test_shared_filter_absent_everywhere_dropped() -> None:
    spec = _spec()
    spec["dashboards"][0]["shared_filters"] = [
        {"field": "Fiscal Year", "filter_type": "categorical", "values": [2026]},
        {"field": "Channel Type", "filter_type": "categorical", "values": ["Chat"]},
    ]
    actions = resolve_field_references(spec)
    kept = [f["field"] for f in spec["dashboards"][0]["shared_filters"]]
    assert kept == ["Channel Type"]  # real (exists in CES) kept; invented dropped
    assert any(a.action == "dropped" and a.original == "Fiscal Year" for a in actions)
    assert _gate(spec) == []


def test_shared_filter_case_insensitive_rename() -> None:
    spec = _spec()
    spec["dashboards"][0]["shared_filters"] = [
        {"field": "channel type", "filter_type": "categorical", "values": ["Chat"]}
    ]
    actions = resolve_field_references(spec)
    assert spec["dashboards"][0]["shared_filters"][0]["field"] == "Channel Type"
    assert any(a.action == "renamed" and a.resolved == "Channel Type" for a in actions)
    assert _gate(spec) == []


def test_optional_encoding_dropped() -> None:
    spec = _spec()
    spec["worksheets"][0]["chart"]["color"] = {"field": "Segment"}
    actions = resolve_field_references(spec)
    assert "color" not in spec["worksheets"][0]["chart"]  # key removed, not nulled
    assert any(a.action == "dropped" and a.location == "color" for a in actions)
    assert _gate(spec) == []


def test_structural_shelf_left_for_gate() -> None:
    """A rows/cols reference to a nonexistent field cannot be dropped safely — the
    resolver records it 'unresolved' and leaves it for the gate to reject."""
    spec = _spec()
    spec["worksheets"][0]["chart"]["cols"] = [{"field": "Nonexistent Dim"}]
    actions = resolve_field_references(spec)
    assert spec["worksheets"][0]["chart"]["cols"][0]["field"] == "Nonexistent Dim"
    assert any(a.action == "unresolved" and a.location == "cols" for a in actions)
    assert _gate(spec) != []  # still a hard error — a chart cannot render without it


def test_sort_by_unresolvable_dropped() -> None:
    spec = _spec()
    spec["worksheets"][0]["chart"]["sort"] = {"by": "Vendor", "order": "desc"}
    resolve_field_references(spec)
    assert "sort" not in spec["worksheets"][0]["chart"]  # key removed, not nulled
    assert _gate(spec) == []


def test_resolved_spec_stays_schema_valid() -> None:
    """Dropping an encoding/sort must remove the key, never leave a null — a
    persisted null would fail a later re-validation (editor/refine paths)."""
    spec = _spec()
    spec["worksheets"][0]["chart"]["color"] = {"field": "Segment"}
    spec["worksheets"][0]["chart"]["sort"] = {"by": "Vendor", "order": "desc"}
    spec["worksheets"][1]["filters"] = [
        {"field": "Vendor", "filter_type": "categorical", "values": ["Acme"]}
    ]
    resolve_field_references(spec)
    assert_valid_spec(spec)  # raises if the repaired spec drifted out of schema


def test_full_reported_scenario_resolves_to_clean_build() -> None:
    """The reported bug end to end: shared filters over invented concepts on a
    two-datasource dashboard. After resolution the gate is clean."""
    spec = _spec()
    spec["dashboards"][0]["shared_filters"] = [
        {"field": "channel type", "filter_type": "categorical", "values": ["Chat"]},
        {"field": "Fiscal Year", "filter_type": "categorical", "values": [2026]},
        {"field": "Vendor", "filter_type": "categorical", "values": ["Acme"]},
    ]
    assert _gate(spec) != []  # broken before resolution
    resolve_field_references(spec)
    assert _gate(spec) == []  # clean after
    # 'channel type' -> 'Channel Type' survives (real on CES); the two invented
    # dimensions are dropped.
    kept = [f["field"] for f in spec["dashboards"][0]["shared_filters"]]
    assert kept == ["Channel Type"]
