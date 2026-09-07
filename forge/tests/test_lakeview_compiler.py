"""Lakeview (`.lvdash.json`) compiler tests: the spec vocabulary this target
adds, the pinned-table-backed widget/spec shapes, the deterministic id scheme,
caps, and the golden-file regression gate (plan 2026-08-10 Phase 5).

The emitted document must stay in the same structural family as the server's
deterministic TypeScript emitter (server/src/migration/bi/lakeview-emit.ts):
`{datasets, pages}`, plain-string dataset `query`, PAGE_TYPE_CANVAS pages,
12-column integer positions, one `main_query` per widget, and a `spec` whose
version + legal encoding channels come from the pinned widget table.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from tableauforge.compiler.lakeview import (
    GRID_COLUMNS,
    MAIN_QUERY,
    MAX_DATASETS,
    MAX_PAGES,
    MAX_WIDGETS_PER_PAGE,
    WIDGET_TYPE_FOR_CHART,
    CompileError,
    UnsupportedFeatureError,
    compile_caveats,
    compile_lakeview,
    compile_lakeview_parts,
    compile_warnings,
    lakeview_id,
)
from tableauforge.spec.models import DashboardSpec
from tableauforge.spec.schema import SpecValidationError, assert_valid_spec

GOLDEN_LVDASH = Path(__file__).resolve().parent / "golden" / "rebuild_live.lvdash.json"


def _compile(spec_dict: dict[str, Any]) -> str:
    return compile_lakeview(DashboardSpec.model_validate(spec_dict))


def _doc(spec_dict: dict[str, Any]) -> dict[str, Any]:
    return json.loads(_compile(spec_dict))


def _widgets(doc: dict[str, Any]) -> list[dict[str, Any]]:
    return [entry["widget"] for page in doc["pages"] for entry in page["layout"]]


def _widget_titled(doc: dict[str, Any], title: str) -> dict[str, Any]:
    for widget in _widgets(doc):
        if (widget["spec"].get("frame") or {}).get("title") == title:
            return widget
    raise AssertionError(f"no widget titled {title!r}")


# --- spec vocabulary the databricks target adds -----------------------------


def test_schema_accepts_sql_formula_language(lakeview_spec_dict: dict[str, Any]) -> None:
    assert_valid_spec(lakeview_spec_dict)  # raises on failure


def test_models_accept_sql_formula_language(lakeview_spec_dict: dict[str, Any]) -> None:
    spec = DashboardSpec.model_validate(lakeview_spec_dict)
    calc = spec.datasources[0].calculated_fields[0]
    assert calc.formula_language == "sql"


@pytest.mark.parametrize("chart_type", ["counter", "pie", "heatmap", "pivot", "combo"])
def test_schema_accepts_the_widened_chart_types(
    lakeview_spec_dict: dict[str, Any], chart_type: str
) -> None:
    lakeview_spec_dict["worksheets"][0]["chart"]["type"] = chart_type
    assert_valid_spec(lakeview_spec_dict)


def test_schema_still_rejects_an_unknown_chart_type(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["worksheets"][0]["chart"]["type"] = "sunburst"
    with pytest.raises(SpecValidationError):
        assert_valid_spec(lakeview_spec_dict)


def test_schema_still_rejects_an_unknown_formula_language(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"][0]["calculated_fields"][0]["formula_language"] = "hql"
    with pytest.raises(SpecValidationError):
        assert_valid_spec(lakeview_spec_dict)


# --- document shape ---------------------------------------------------------


def test_document_is_datasets_plus_canvas_pages(lakeview_spec_dict: dict[str, Any]) -> None:
    doc = _doc(lakeview_spec_dict)
    assert sorted(doc) == ["datasets", "pages"]
    assert doc["pages"], "at least one page"
    for page in doc["pages"]:
        assert page["pageType"] == "PAGE_TYPE_CANVAS"
        assert sorted(page) == ["displayName", "layout", "name", "pageType"]


def test_no_ui_settings_anywhere(lakeview_spec_dict: dict[str, Any]) -> None:
    # uiSettings' genieSpace shape is unverified in the Phase-0 corpus — the
    # emitter never invents it (same rule the TypeScript emitter carries).
    assert "uiSettings" not in _compile(lakeview_spec_dict)


def test_datasets_carry_a_plain_string_three_part_query(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    doc = _doc(lakeview_spec_dict)
    orders = next(d for d in doc["datasets"] if d["displayName"] == "orders")
    assert isinstance(orders["query"], str)
    assert "queryLines" not in orders
    assert "FROM `main`.`analytics`.`orders`" in orders["query"]
    # Raw columns are projected by physical name; a row-level sql calc rides the
    # dataset as an aliased expression.
    assert "`Region`" in orders["query"]
    assert "AS `Region Label`" in orders["query"]


def test_dataset_query_omits_measure_calcs(lakeview_spec_dict: dict[str, Any]) -> None:
    # An aggregate calc is a widget-level expression, not a dataset projection —
    # SUM(...) in an ungrouped SELECT would not even parse.
    orders = next(
        d for d in _doc(lakeview_spec_dict)["datasets"] if d["displayName"] == "orders"
    )
    assert "Total Sales" not in orders["query"]


def test_only_worksheet_bound_datasources_become_datasets(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"].append(
        {
            "id": "orphan_ds",
            "name": "orphan",
            "kind": "live_database",
            "database": {
                "dialect": "databricks",
                "host": "adb.example.net",
                "http_path": "/sql/1.0/warehouses/abc123",
                "database": "main",
                "db_schema": "analytics",
                "table": "orphan",
            },
            "fields": [{"name": "X", "datatype": "string", "role": "dimension"}],
        }
    )
    names = [d["displayName"] for d in _doc(lakeview_spec_dict)["datasets"]]
    assert "orphan" not in names


def test_two_same_named_datasources_get_distinct_display_names(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """A brief can legitimately carry two datasources called 'orders' (an
    embedded extract and a published one). Emitting two datasets with the same
    displayName is FATAL to the validator, so the whole build died on a name
    collision the compiler could simply disambiguate."""
    twin = copy.deepcopy(lakeview_spec_dict["datasources"][1])
    twin["id"] = "orders_published"
    twin["name"] = "orders"  # same display name, different datasource
    lakeview_spec_dict["datasources"].append(twin)
    lakeview_spec_dict["worksheets"][2]["datasource"] = "orders_published"

    datasets = _doc(lakeview_spec_dict)["datasets"]
    display_names = [d["displayName"] for d in datasets]
    assert len(display_names) == len(set(display_names)), display_names
    # The first one keeps the plain name; later ones carry their datasource id.
    assert display_names[0] == "orders"
    assert "orders (orders_published)" in display_names


def test_widget_carries_one_main_query_against_its_dataset(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    doc = _doc(lakeview_spec_dict)
    by_name = {d["displayName"]: d["name"] for d in doc["datasets"]}
    widget = _widget_titled(doc, "Sales by Region")
    assert [q["name"] for q in widget["queries"]] == [MAIN_QUERY]
    query = widget["queries"][0]["query"]
    assert query["datasetName"] == by_name["orders"]
    assert query["disaggregated"] is False
    # Every field entry is {name, expression} — the emitter's query-field shape.
    for field in query["fields"]:
        assert sorted(field) == ["expression", "name"]
    names = {f["name"]: f["expression"] for f in query["fields"]}
    assert names["Region"] == "`Region`"
    assert names["sum(Sales)"] == "SUM(`Sales`)"


def test_encodings_reference_query_field_names(lakeview_spec_dict: dict[str, Any]) -> None:
    doc = _doc(lakeview_spec_dict)
    for widget in _widgets(doc):
        available = {f["name"] for f in widget["queries"][0]["query"]["fields"]}
        for channel, binding in widget["spec"]["encodings"].items():
            entries = binding if isinstance(binding, list) else [binding]
            for entry in entries:
                if isinstance(entry, dict) and "fieldName" in entry:
                    assert entry["fieldName"] in available, (
                        f"{channel} references an unknown query field: {entry}"
                    )


def test_measure_calc_rides_the_widget_expression(lakeview_spec_dict: dict[str, Any]) -> None:
    widget = _widget_titled(_doc(lakeview_spec_dict), "Total Sales")
    fields = {f["name"]: f["expression"] for f in widget["queries"][0]["query"]["fields"]}
    assert fields["Total Sales"] == "SUM(`Sales`)"
    assert widget["spec"]["widgetType"] == "counter"
    assert widget["spec"]["encodings"]["value"]["fieldName"] == "Total Sales"


# --- widget-type map + pinned-table conformance ------------------------------


def test_chart_type_map_matches_the_pinned_vocabulary() -> None:
    assert WIDGET_TYPE_FOR_CHART == {
        "bar": "bar",
        "line": "line",
        "area": "area",
        "scatter": "scatter",
        "text_table": "table",
        "dual_axis_bar_line": "combo",
        "counter": "counter",
        "pie": "pie",
        "heatmap": "heatmap",
        "pivot": "pivot",
        "combo": "combo",
    }


@pytest.mark.parametrize(
    "chart_type,widget_type,spec_version",
    [
        ("bar", "bar", 3),
        ("line", "line", 3),
        ("area", "area", 3),
        ("scatter", "scatter", 3),
        ("text_table", "table", 1),
        ("pie", "pie", 3),
        ("heatmap", "heatmap", 3),
        ("combo", "combo", 1),
    ],
)
def test_spec_version_comes_from_the_pinned_table(
    lakeview_spec_dict: dict[str, Any], chart_type: str, widget_type: str, spec_version: int
) -> None:
    lakeview_spec_dict["worksheets"][0]["chart"]["type"] = chart_type
    widget = _widget_titled(_doc(lakeview_spec_dict), "Sales by Region")
    assert widget["spec"]["widgetType"] == widget_type
    assert widget["spec"]["version"] == spec_version


def test_unknown_chart_type_is_a_compile_error(lakeview_spec_dict: dict[str, Any]) -> None:
    # Model validation is bypassed on purpose: the point is that the compiler
    # itself never invents a widget type for a chart it does not map.
    spec = DashboardSpec.model_validate(lakeview_spec_dict)
    spec.worksheets[0].chart.type = "sunburst"  # type: ignore[assignment]
    with pytest.raises(UnsupportedFeatureError, match="sunburst"):
        compile_lakeview(spec)


def test_duplicate_worksheet_titles_are_a_compile_error(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["worksheets"][1]["title"] = "Sales by Region"
    with pytest.raises(CompileError, match="unique"):
        _compile(lakeview_spec_dict)


def test_pivot_uses_the_pinned_rows_columns_cell_channels(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["worksheets"][0]["chart"] = {
        "type": "pivot",
        "rows": [{"field": "Region"}],
        "cols": [{"field": "Order Date"}],
        "label": {"field": "Sales", "aggregation": "sum"},
    }
    widget = _widget_titled(_doc(lakeview_spec_dict), "Sales by Region")
    encodings = widget["spec"]["encodings"]
    assert [f["fieldName"] for f in encodings["rows"]] == ["Region"]
    assert [f["fieldName"] for f in encodings["columns"]] == ["Order Date"]
    assert encodings["cell"]["fieldName"] == "sum(Sales)"


def test_combo_y_routes_secondary_rows_to_the_secondary_series(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """A Tableau dual axis is two axes, and the corpus's combo `y` holder pins a
    `secondary` field list beside `primary` (jobs-system-tables.lvdash.json), so
    the second measure keeps its own axis instead of being folded onto the first."""
    lakeview_spec_dict["worksheets"][0]["chart"]["type"] = "dual_axis_bar_line"
    lakeview_spec_dict["worksheets"][0]["chart"]["secondary_rows"] = [
        {"field": "Quantity", "aggregation": "sum"}
    ]
    widget = _widget_titled(_doc(lakeview_spec_dict), "Sales by Region")
    y = widget["spec"]["encodings"]["y"]
    assert [f["fieldName"] for f in y["primary"]["fields"]] == ["sum(Sales)"]
    assert [f["fieldName"] for f in y["secondary"]["fields"]] == ["sum(Quantity)"]
    # ...and both series are projected as query fields, or the second renders blank.
    assert [f["name"] for f in widget["queries"][0]["query"]["fields"]] == [
        "Region",
        "sum(Sales)",
        "sum(Quantity)",
    ]


def test_a_combo_without_a_second_axis_emits_no_secondary_holder(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["worksheets"][0]["chart"]["type"] = "combo"
    widget = _widget_titled(_doc(lakeview_spec_dict), "Sales by Region")
    assert "secondary" not in widget["spec"]["encodings"]["y"]


def test_date_part_is_unsupported(lakeview_spec_dict: dict[str, Any]) -> None:
    lakeview_spec_dict["worksheets"][0]["chart"]["cols"] = [
        {"field": "Order Date", "date_part": "month"}
    ]
    with pytest.raises(UnsupportedFeatureError, match="date_part"):
        _compile(lakeview_spec_dict)


def test_unknown_field_reference_is_a_compile_error(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["worksheets"][0]["chart"]["cols"] = [{"field": "Nope"}]
    with pytest.raises(CompileError, match="Nope"):
        _compile(lakeview_spec_dict)


def test_non_sql_calculated_field_is_a_compile_error(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"][0]["calculated_fields"][0]["formula_language"] = "dax"
    with pytest.raises(CompileError, match="formula_language"):
        _compile(lakeview_spec_dict)


def test_the_language_gate_is_spec_wide_not_only_the_used_datasources(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    # A spec is authored for exactly one target, so a wrong-language calc
    # anywhere is an error — even on a datasource no worksheet reads.
    lakeview_spec_dict["datasources"].append(
        {
            "id": "orphan_ds",
            "name": "orphan",
            "kind": "live_database",
            "database": {
                "dialect": "databricks",
                "host": "adb.example.net",
                "database": "main",
                "db_schema": "analytics",
                "table": "orphan",
            },
            "fields": [{"name": "X", "datatype": "string", "role": "dimension"}],
            "calculated_fields": [
                {
                    "name": "Bad",
                    "formula": "SUM(orphan[X])",
                    "datatype": "real",
                    "role": "measure",
                    "formula_language": "dax",
                }
            ],
        }
    )
    with pytest.raises(CompileError, match="orphan_ds"):
        _compile(lakeview_spec_dict)


def test_non_live_database_datasource_is_a_compile_error(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"][0]["kind"] = "embedded_csv"
    lakeview_spec_dict["datasources"][0]["csv"] = {"table_name": "orders"}
    lakeview_spec_dict["datasources"][0].pop("database")
    with pytest.raises(CompileError, match="live-database"):
        _compile(lakeview_spec_dict)


# --- layout ------------------------------------------------------------------


def test_positions_are_integers_on_a_12_column_grid(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    for page in _doc(lakeview_spec_dict)["pages"]:
        for entry in page["layout"]:
            position = entry["position"]
            assert sorted(position) == ["height", "width", "x", "y"]
            for key, value in position.items():
                assert isinstance(value, int), f"{key} is not an integer: {value!r}"
            assert 0 <= position["x"]
            assert position["x"] + position["width"] <= GRID_COLUMNS


def test_widgets_on_a_page_never_overlap(lakeview_spec_dict: dict[str, Any]) -> None:
    for page in _doc(lakeview_spec_dict)["pages"]:
        boxes = [e["position"] for e in page["layout"]]
        for i, a in enumerate(boxes):
            for b in boxes[i + 1 :]:
                overlap = (
                    a["x"] < b["x"] + b["width"]
                    and b["x"] < a["x"] + a["width"]
                    and a["y"] < b["y"] + b["height"]
                    and b["y"] < a["y"] + a["height"]
                )
                assert not overlap, f"overlapping widgets: {a} and {b}"


def test_a_three_across_row_tiles_instead_of_stacking(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """Rounding x and w independently made a 0/30/60 row three 4-wide widgets
    ending at 4/8/12 — they overlapped, and `_place` stacked two of them onto
    their own rows. Snapping the column EDGES cumulatively tiles the row."""
    lakeview_spec_dict["dashboards"][0]["zones"] = [
        {"kind": "worksheet", "worksheet": ws, "x": x, "y": 0, "w": 30, "h": 40}
        for ws, x in (
            ("total_sales_kpi", 0),
            ("sales_by_region", 30),
            ("events_by_channel", 60),
        )
    ]
    positions = [e["position"] for e in _doc(lakeview_spec_dict)["pages"][0]["layout"]]
    assert [(p["x"], p["x"] + p["width"]) for p in positions] == [(0, 4), (4, 7), (7, 11)]
    assert {p["y"] for p in positions} == {0}, "the row must stay one row"


def test_a_stacked_column_tiles_instead_of_being_re_flowed(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """The vertical twin of the three-across bug. Rows are 4x finer than
    columns, but y and h were rounded against the 12-column grid and only THEN
    multiplied by the row scale — so 0/30/60 became 0/16/32 with heights of 16,
    16 and 16... and then a 30%-tall zone at y=60 rounded to y=32 h=16 while its
    neighbour ended at 32, which is fine, but 0/25/50 or 0/33/66 did not tile at
    all. Snapping both vertical edges on the ROW grid keeps the column intact."""
    lakeview_spec_dict["dashboards"][0]["zones"] = [
        {"kind": "worksheet", "worksheet": ws, "x": 0, "y": y, "w": 100, "h": 30}
        for ws, y in (
            ("total_sales_kpi", 0),
            ("sales_by_region", 30),
            ("events_by_channel", 60),
        )
    ]
    spec = DashboardSpec.model_validate(lakeview_spec_dict)
    positions = [e["position"] for e in _doc(lakeview_spec_dict)["pages"][0]["layout"]]
    edges = [(p["y"], p["y"] + p["height"]) for p in positions]
    assert edges == [(0, 14), (14, 29), (29, 43)], edges
    _, notes = compile_caveats(spec)
    assert not any("moved down the canvas" in n for n in notes), notes


def test_vertical_resolution_survives_the_grid(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """Rounding h against 12 columns quantised every height to a multiple of 4
    rows: a 10%-tall zone and a 14%-tall zone came out identical."""
    lakeview_spec_dict["dashboards"][0]["zones"] = [
        {"kind": "worksheet", "worksheet": "total_sales_kpi", "x": 0, "y": 0, "w": 100, "h": 10},
        {"kind": "worksheet", "worksheet": "sales_by_region", "x": 0, "y": 10, "w": 100, "h": 14},
    ]
    positions = [e["position"] for e in _doc(lakeview_spec_dict)["pages"][0]["layout"]]
    assert positions[0]["height"] != positions[1]["height"], positions


def test_a_widget_the_placer_moves_is_an_informational_note(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["dashboards"][0]["zones"] = [
        {"kind": "worksheet", "worksheet": ws, "x": 0, "y": 0, "w": 100, "h": 50}
        for ws in ("total_sales_kpi", "sales_by_region")
    ]
    warnings, notes = compile_caveats(DashboardSpec.model_validate(lakeview_spec_dict))
    assert any("moved down the canvas" in n for n in notes), notes
    assert not any("moved down the canvas" in w for w in warnings), warnings


def test_text_and_blank_zones_are_reported_not_silently_dropped(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    warnings = compile_warnings(DashboardSpec.model_validate(lakeview_spec_dict))
    assert any("text zone" in w for w in warnings), warnings


def test_non_databricks_source_is_an_informational_note_not_a_warning(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """It fires on every non-Databricks source — i.e. on every migration this
    target exists to serve — so as a warning it made every run
    `complete_with_warnings` and buried the warnings that meant something."""
    lakeview_spec_dict["datasources"][1]["database"] = {
        "dialect": "sqlserver",
        "host": "sql.example.internal",
        "database": "analytics",
        "db_schema": "dbo",
        "table": "events",
    }
    model = DashboardSpec.model_validate(lakeview_spec_dict)
    warnings, notes = compile_caveats(model)
    assert any("Unity Catalog" in n for n in notes), notes
    assert not any("Unity Catalog" in w for w in warnings), warnings
    # It is a caveat, not a refusal: the dashboard still compiles.
    assert "FROM `analytics`.`dbo`.`events`" in _compile(lakeview_spec_dict)


def test_quick_filters_compile_to_ai_bi_filter_widgets(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["worksheets"][0]["filters"] = [
        {
            "field": "Order Date",
            "filter_type": "range",
            "show_quick_filter": True,
        }
    ]
    lakeview_spec_dict["dashboards"][0]["shared_filters"] = [
        {"field": "Region", "filter_type": "categorical", "values": ["West"],
         "show_quick_filter": True}
    ]
    doc = _doc(lakeview_spec_dict)
    page = doc["pages"][0]
    types = [e["widget"]["spec"]["widgetType"] for e in page["layout"]]
    # Filters own the top row, in shared-then-worksheet order.
    assert types[:2] == ["filter-multi-select", "filter-date-range-picker"]
    positions = [e["position"] for e in page["layout"][:2]]
    assert positions == [
        {"x": 0, "y": 0, "width": 3, "height": 4},
        {"x": 3, "y": 0, "width": 3, "height": 4},
    ]
    # ...and the charts are pushed below the filter row rather than under it.
    assert all(e["position"]["y"] >= 4 for e in page["layout"][2:])

    widget = page["layout"][0]["widget"]
    assert widget["spec"]["encodings"]["fields"] == [
        {"fieldName": "Region", "displayName": "Region", "queryName": MAIN_QUERY}
    ]
    query = widget["queries"][0]
    assert query["name"] == MAIN_QUERY
    assert query["query"]["fields"] == [{"name": "Region", "expression": "`Region`"}]
    assert query["query"]["disaggregated"] is False
    assert widget["spec"]["frame"] == {"showTitle": True, "title": "Region"}


def test_a_numeric_range_quick_filter_is_a_range_slider(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["worksheets"][0]["filters"] = [
        {"field": "Quantity", "filter_type": "range", "show_quick_filter": True}
    ]
    doc = _doc(lakeview_spec_dict)
    types = [w["spec"]["widgetType"] for w in _widgets(doc)]
    assert "range-slider" in types


def test_an_emitted_filter_is_a_note_and_an_unemittable_one_is_a_warning(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["worksheets"][0]["filters"] = [
        # A range filter over a STRING column: no AI/BI range widget can render it.
        {"field": "Region", "filter_type": "range", "show_quick_filter": True},
        {"field": "Quantity", "filter_type": "range", "show_quick_filter": True},
        # No quick filter: a value restriction with no on-canvas control.
        {"field": "Region", "filter_type": "categorical", "values": ["East"]},
    ]
    warnings, notes = compile_caveats(DashboardSpec.model_validate(lakeview_spec_dict))
    assert any("'Region'" in w and "range widgets need" in w for w in warnings), warnings
    assert any("'Region'" in w and "no quick filter" in w for w in warnings), warnings
    assert any("'Quantity'" in n and "range-slider" in n for n in notes), notes
    assert not any("'Quantity'" in w for w in warnings), warnings


def test_a_filter_on_an_unknown_field_is_a_warning_not_a_widget(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["dashboards"][0]["shared_filters"] = [
        {"field": "Nope", "filter_type": "categorical", "show_quick_filter": True}
    ]
    warnings, _ = compile_caveats(DashboardSpec.model_validate(lakeview_spec_dict))
    assert any("'Nope'" in w for w in warnings), warnings
    assert all(
        not w["spec"]["widgetType"].startswith("filter")
        for w in _widgets(_doc(lakeview_spec_dict))
    )


def test_a_relative_date_filter_is_a_warning_not_a_dead_build(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """It used to RAISE, which threw away a whole authored build after the fact
    — and compile_caveats swallowed the exception, so the dashboard's other
    warnings vanished with it. It is a non-emittable filter like the others:
    warn, emit nothing for it, and keep the rest of the dashboard."""
    lakeview_spec_dict["dashboards"][0]["shared_filters"] = [
        {"field": "Order Date", "filter_type": "relative_date", "show_quick_filter": True}
    ]
    doc = _doc(lakeview_spec_dict)
    page = doc["pages"][0]
    types = [e["widget"]["spec"]["widgetType"] for e in page["layout"]]
    assert not any(t.startswith("filter-") or t == "range-slider" for t in types), types

    warnings, _ = compile_caveats(DashboardSpec.model_validate(lakeview_spec_dict))
    assert any(
        "relative_date" in w and "Order Date" in w for w in warnings
    ), warnings


def test_a_relative_date_filter_does_not_hide_the_other_warnings(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """The raise made compile_caveats bail out of the dashboard loop, taking the
    text-zone warning (and every later one) with it."""
    lakeview_spec_dict["dashboards"][0]["shared_filters"] = [
        {"field": "Order Date", "filter_type": "relative_date", "show_quick_filter": True}
    ]
    warnings, _ = compile_caveats(DashboardSpec.model_validate(lakeview_spec_dict))
    assert any("text zone" in w for w in warnings), warnings


def test_a_standalone_sheet_page_carries_its_own_quick_filters(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["dashboards"] = []
    lakeview_spec_dict["worksheets"][0]["filters"] = [
        {"field": "Region", "filter_type": "categorical", "show_quick_filter": True}
    ]
    doc = _doc(lakeview_spec_dict)
    page = next(p for p in doc["pages"] if p["displayName"] == "Sales by Region")
    assert [e["widget"]["spec"]["widgetType"] for e in page["layout"]] == [
        "filter-multi-select",
        "bar",
    ]
    assert page["layout"][1]["position"] == {"x": 0, "y": 4, "width": 12, "height": 44}


# --- dashboard parameters ----------------------------------------------------


def _param(name: str, datatype: str, default: str, **extra: Any) -> dict[str, Any]:
    return {"name": name, "datatype": datatype, "default": default, **extra}


def _both_sheets_on_one_dashboard(spec: dict[str, Any]) -> None:
    """Place the events sheet on the main dashboard too, so one page queries
    both datasources (what a shared parameter needs)."""
    spec["dashboards"][0]["zones"].append(
        {"kind": "worksheet", "worksheet": "events_by_channel", "x": 0, "y": 60, "w": 100, "h": 40}
    )


def test_a_parameter_free_build_declares_no_parameters_key(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """The key is omitted, never emitted empty — a parameter-free build's bytes
    must not move (the golden fixture is one)."""
    doc = _doc(lakeview_spec_dict)
    assert all("parameters" not in d for d in doc["datasets"])
    assert all("parameters" not in q["query"] for w in _widgets(doc) for q in w["queries"])


def test_a_parameter_is_declared_on_its_dataset_in_the_pinned_shape(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"][0]["parameters"] = [
        _param("region_filter", "string", "East", display_name="Region filter")
    ]
    doc = _doc(lakeview_spec_dict)
    dataset = next(d for d in doc["datasets"] if d["displayName"] == "orders")
    assert dataset["parameters"] == [
        {
            "displayName": "Region filter",
            "keyword": "region_filter",
            "dataType": "STRING",
            "defaultSelection": {
                "values": {"dataType": "STRING", "values": [{"value": "East"}]}
            },
        }
    ]
    # Single-value only: the MULTI/RANGE complex forms are out of scope.
    assert "complexType" not in dataset["parameters"][0]
    # ...and only the datasource that declared it carries one.
    assert "parameters" not in next(d for d in doc["datasets"] if d["displayName"] == "events")


def test_a_parameter_becomes_a_filter_widget_in_the_corpus_shape(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"][0]["parameters"] = [_param("region_filter", "string", "East")]
    doc = _doc(lakeview_spec_dict)
    page = doc["pages"][0]
    widget = page["layout"][0]["widget"]
    dataset_name = next(d for d in doc["datasets"] if d["displayName"] == "orders")["name"]
    query_name = f"parameter_{dataset_name}_region_filter"

    assert widget["spec"]["widgetType"] == "filter-single-select"
    assert widget["spec"]["version"] == 2
    assert widget["queries"] == [
        {
            "name": query_name,
            "query": {
                "datasetName": dataset_name,
                "parameters": [{"name": "region_filter", "keyword": "region_filter"}],
                "disaggregated": False,
            },
        }
    ]
    # A parameter query BINDS; it never projects fields.
    assert "fields" not in widget["queries"][0]["query"]
    assert widget["spec"]["encodings"]["fields"] == [
        {"parameterName": "region_filter", "queryName": query_name}
    ]
    assert widget["spec"]["frame"] == {"showTitle": True, "title": "region_filter"}
    assert page["layout"][0]["position"] == {"x": 0, "y": 0, "width": 3, "height": 4}


@pytest.mark.parametrize(
    "datatype,widget_type",
    [
        ("string", "filter-single-select"),
        ("integer", "filter-single-select"),
        ("decimal", "filter-single-select"),
        ("date", "filter-date-picker"),
    ],
)
def test_each_pinned_parameter_form_gets_its_pinned_widget(
    lakeview_spec_dict: dict[str, Any], datatype: str, widget_type: str
) -> None:
    lakeview_spec_dict["datasources"][0]["parameters"] = [_param("p", datatype, "1")]
    doc = _doc(lakeview_spec_dict)
    assert doc["pages"][0]["layout"][0]["widget"]["spec"]["widgetType"] == widget_type


def test_a_datetime_parameter_is_declared_but_gets_no_control(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """DATETIME is a pinned dataset parameter but the corpus never binds a plain
    one to a widget — so it is declared and said out loud, never guessed onto a
    date picker."""
    lakeview_spec_dict["datasources"][0]["parameters"] = [
        _param("as_of", "datetime", "2026-01-01 00:00:00")
    ]
    doc = _doc(lakeview_spec_dict)
    dataset = next(d for d in doc["datasets"] if d["displayName"] == "orders")
    assert dataset["parameters"][0]["dataType"] == "DATETIME"
    assert all(not w["spec"]["widgetType"].startswith("filter") for w in _widgets(doc))
    warnings, notes = compile_caveats(DashboardSpec.model_validate(lakeview_spec_dict))
    assert any("'as_of'" in n and "no on-canvas control" in n for n in notes), notes
    assert not any("'as_of'" in w for w in warnings), warnings


def test_one_widget_binds_every_datasource_that_declares_the_parameter(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """A keyword declared on two datasources is ONE control with one query per
    dataset — two controls would silently disagree."""
    _both_sheets_on_one_dashboard(lakeview_spec_dict)
    for ds in lakeview_spec_dict["datasources"]:
        ds["parameters"] = [_param("as_of", "date", "2026-01-01")]
    doc = _doc(lakeview_spec_dict)
    names = {d["displayName"]: d["name"] for d in doc["datasets"]}
    page = doc["pages"][0]
    controls = [
        e["widget"] for e in page["layout"] if e["widget"]["spec"]["widgetType"].startswith("filter")
    ]
    assert len(controls) == 1
    widget = controls[0]
    assert widget["spec"]["widgetType"] == "filter-date-picker"
    assert [q["query"]["datasetName"] for q in widget["queries"]] == [
        names["orders"],
        names["events"],
    ]
    assert [q["name"] for q in widget["queries"]] == [
        f"parameter_{names['orders']}_as_of",
        f"parameter_{names['events']}_as_of",
    ]
    assert widget["spec"]["encodings"]["fields"] == [
        {"parameterName": "as_of", "queryName": f"parameter_{names['orders']}_as_of"},
        {"parameterName": "as_of", "queryName": f"parameter_{names['events']}_as_of"},
    ]
    # Both datasets declare it, so both carry the pinned entry.
    assert all(d["parameters"][0]["keyword"] == "as_of" for d in doc["datasets"])


def test_a_keyword_declared_with_two_datatypes_is_a_compile_error(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    _both_sheets_on_one_dashboard(lakeview_spec_dict)
    lakeview_spec_dict["datasources"][0]["parameters"] = [_param("as_of", "date", "2026-01-01")]
    lakeview_spec_dict["datasources"][1]["parameters"] = [_param("as_of", "string", "2026-01-01")]
    with pytest.raises(CompileError, match="cannot bind two datatypes"):
        _compile(lakeview_spec_dict)


def test_parameter_controls_come_before_quick_filters_then_the_charts(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"][0]["parameters"] = [_param("region_filter", "string", "East")]
    lakeview_spec_dict["dashboards"][0]["shared_filters"] = [
        {"field": "Region", "filter_type": "categorical", "show_quick_filter": True}
    ]
    page = _doc(lakeview_spec_dict)["pages"][0]
    assert [e["widget"]["spec"]["widgetType"] for e in page["layout"]][:2] == [
        "filter-single-select",
        "filter-multi-select",
    ]
    assert [e["position"] for e in page["layout"][:2]] == [
        {"x": 0, "y": 0, "width": 3, "height": 4},
        {"x": 3, "y": 0, "width": 3, "height": 4},
    ]
    assert all(e["position"]["y"] >= 4 for e in page["layout"][2:])


def test_a_standalone_sheet_page_carries_its_parameter_control(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["dashboards"] = []
    lakeview_spec_dict["datasources"][0]["parameters"] = [_param("region_filter", "string", "East")]
    lakeview_spec_dict["worksheets"][0]["filters"] = [
        {"field": "Region", "filter_type": "categorical", "show_quick_filter": True}
    ]
    page = next(
        p for p in _doc(lakeview_spec_dict)["pages"] if p["displayName"] == "Sales by Region"
    )
    assert [e["widget"]["spec"]["widgetType"] for e in page["layout"]] == [
        "filter-single-select",
        "filter-multi-select",
        "bar",
    ]
    # The chart still fills the canvas below the one control row.
    assert page["layout"][2]["position"] == {"x": 0, "y": 4, "width": 12, "height": 44}


def test_a_declared_parameter_may_be_read_by_the_dataset_sql(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"][0]["parameters"] = [_param("threshold", "decimal", "100")]
    lakeview_spec_dict["datasources"][0]["calculated_fields"].append(
        {
            "name": "Big Order",
            "formula": "CASE WHEN `Sales` > :threshold THEN 'yes' ELSE 'no' END",
            "datatype": "string",
            "role": "dimension",
            "formula_language": "sql",
        }
    )
    dataset = next(d for d in _doc(lakeview_spec_dict)["datasets"] if d["displayName"] == "orders")
    assert ":threshold" in dataset["query"]
    assert dataset["parameters"][0]["keyword"] == "threshold"


def test_an_undeclared_parameter_reference_is_a_compile_error(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """`:threshold` with no declaration imports as a complete-looking dashboard
    whose dataset query fails the moment anyone opens it."""
    lakeview_spec_dict["datasources"][0]["calculated_fields"].append(
        {
            "name": "Big Order",
            "formula": "CASE WHEN `Sales` > :threshold THEN 'yes' ELSE 'no' END",
            "datatype": "string",
            "role": "dimension",
            "formula_language": "sql",
        }
    )
    with pytest.raises(CompileError, match=r":threshold"):
        _compile(lakeview_spec_dict)


def test_an_aggregate_calc_may_not_read_a_parameter(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """An aggregate calc is a WIDGET expression; only a dataset query binds a
    parameter, so `:threshold` there would compile into an expression nothing
    resolves."""
    lakeview_spec_dict["datasources"][0]["parameters"] = [_param("threshold", "decimal", "100")]
    lakeview_spec_dict["datasources"][0]["calculated_fields"].append(
        {
            "name": "Big Sales",
            "formula": "SUM(CASE WHEN `Sales` > :threshold THEN `Sales` ELSE 0 END)",
            "datatype": "real",
            "role": "measure",
            "formula_language": "sql",
        }
    )
    with pytest.raises(CompileError, match="row-level"):
        _compile(lakeview_spec_dict)


def test_a_declared_but_unread_parameter_is_a_warning(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """A parameter no dataset SQL reads still ships a live-looking control that
    changes nothing — silently. That is exactly the kind of thing this target's
    caveats exist to say out loud."""
    lakeview_spec_dict["datasources"][0]["parameters"] = [
        _param("region_filter", "string", "East")
    ]
    warnings = compile_warnings(DashboardSpec.model_validate(lakeview_spec_dict))
    assert any(
        ":region_filter" in w and "orders" in w for w in warnings
    ), warnings


def test_a_parameter_the_dataset_sql_reads_is_not_warned_about(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"][0]["parameters"] = [
        _param("threshold", "decimal", "100")
    ]
    lakeview_spec_dict["datasources"][0]["calculated_fields"].append(
        {
            "name": "Big Order",
            "formula": "CASE WHEN `Sales` > :threshold THEN 'yes' ELSE 'no' END",
            "datatype": "string",
            "role": "dimension",
            "formula_language": "sql",
        }
    )
    warnings = compile_warnings(DashboardSpec.model_validate(lakeview_spec_dict))
    assert not any(":threshold" in w for w in warnings), warnings


def test_a_colon_inside_a_literal_is_not_a_parameter_reference(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"][0]["calculated_fields"].append(
        {
            "name": "Stamp",
            "formula": "CONCAT(`Region`, ' 12:30')",
            "datatype": "string",
            "role": "dimension",
            "formula_language": "sql",
        }
    )
    assert "12:30" in _compile(lakeview_spec_dict)  # no CompileError


def test_compiling_a_parameterised_spec_twice_is_byte_identical(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    _both_sheets_on_one_dashboard(lakeview_spec_dict)
    for ds in lakeview_spec_dict["datasources"]:
        ds["parameters"] = [_param("as_of", "date", "2026-01-01")]
    lakeview_spec_dict["datasources"][0]["parameters"].append(
        _param("region_filter", "string", "East")
    )
    assert _compile(lakeview_spec_dict) == _compile(lakeview_spec_dict)


def test_a_duplicate_parameter_name_on_one_datasource_is_rejected(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"][0]["parameters"] = [
        _param("as_of", "date", "2026-01-01"),
        _param("as_of", "date", "2026-02-01"),
    ]
    with pytest.raises(ValueError, match="duplicate parameter name"):
        _compile(lakeview_spec_dict)


def test_the_schema_gates_parameter_shape(lakeview_spec_dict: dict[str, Any]) -> None:
    lakeview_spec_dict["datasources"][0]["parameters"] = [_param("as_of", "date", "2026-01-01")]
    assert_valid_spec(lakeview_spec_dict)  # raises on failure
    # Lakeview's vocabulary, not the spec's: `real` is `decimal` here.
    lakeview_spec_dict["datasources"][0]["parameters"][0]["datatype"] = "real"
    with pytest.raises(SpecValidationError):
        assert_valid_spec(lakeview_spec_dict)


def test_the_schema_rejects_a_non_snake_case_parameter_name(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"][0]["parameters"] = [_param("As Of", "date", "2026-01-01")]
    with pytest.raises(SpecValidationError):
        assert_valid_spec(lakeview_spec_dict)


def test_an_unplaceable_shelf_entry_is_dropped_with_a_note(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    # The `size` shelf has no home on a bar widget: it must be reported and
    # dropped, never guessed onto the wire — and never left as an unreferenced
    # query field the warehouse computes on every refresh.
    lakeview_spec_dict["worksheets"][0]["chart"]["size"] = {
        "field": "Quantity",
        "aggregation": "sum",
    }
    warnings = compile_warnings(DashboardSpec.model_validate(lakeview_spec_dict))
    assert any(
        "'Quantity'" in w and "no pinned channel" in w for w in warnings
    ), warnings
    widget = _widget_titled(_doc(lakeview_spec_dict), "Sales by Region")
    assert "size" not in widget["spec"]["encodings"]
    assert [f["name"] for f in widget["queries"][0]["query"]["fields"]] == [
        "Region",
        "sum(Sales)",
    ]


def test_a_channel_the_pinned_table_rejects_is_reported(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    # `scatter` pins color/x/y but not `label`: the label shelf reaches _bind and
    # is refused there against the pinned table, rather than in _note_unplaced.
    lakeview_spec_dict["worksheets"][0]["chart"]["type"] = "scatter"
    lakeview_spec_dict["worksheets"][0]["chart"]["label"] = {"field": "Order Date"}
    warnings = compile_warnings(DashboardSpec.model_validate(lakeview_spec_dict))
    assert any(
        "'label'" in w and "not a pinned channel" in w for w in warnings
    ), warnings
    widget = _widget_titled(_doc(lakeview_spec_dict), "Sales by Region")
    assert "label" not in widget["spec"]["encodings"]
    # ...and the refused field is not projected either.
    assert all(
        f["name"] != "Order Date" for f in widget["queries"][0]["query"]["fields"]
    )


def test_a_docs_pinned_widget_type_is_reported(lakeview_spec_dict: dict[str, Any]) -> None:
    # Every type the chart map reaches happens to be corpus-verified today; this
    # guards the branch that fires the day one is not.
    from tableauforge.compiler import lakeview as lakeview_mod

    original = dict(lakeview_mod.WIDGET_TYPE_FOR_CHART)
    lakeview_mod.WIDGET_TYPE_FOR_CHART["bar"] = "funnel"
    try:
        warnings = compile_warnings(DashboardSpec.model_validate(lakeview_spec_dict))
    finally:
        lakeview_mod.WIDGET_TYPE_FOR_CHART.clear()
        lakeview_mod.WIDGET_TYPE_FOR_CHART.update(original)
    assert any("pinned" in w and "docs" in w for w in warnings), warnings


def test_a_fieldless_datasource_falls_back_to_select_star(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["datasources"][1]["fields"] = []
    lakeview_spec_dict["worksheets"][2]["chart"] = {
        "type": "text_table",
        "rows": [],
        "cols": [],
    }
    events = next(
        d for d in _doc(lakeview_spec_dict)["datasets"] if d["displayName"] == "events"
    )
    assert events["query"] == "SELECT\n  *\nFROM `main`.`analytics`.`events`"


def test_undashboarded_worksheets_get_their_own_page(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    titles = [p["displayName"] for p in _doc(lakeview_spec_dict)["pages"]]
    assert "Revenue Overview" in titles
    assert "Events by Channel" in titles


# --- ids + determinism -------------------------------------------------------


def test_lakeview_id_is_the_sha1_slug_scheme() -> None:
    import hashlib

    expected = hashlib.sha1(b"Rebuild Live::dataset:orders").hexdigest()[:8]
    assert lakeview_id("Rebuild Live", "dataset:orders") == expected
    assert len(expected) == 8


def test_every_emitted_id_is_eight_lowercase_hex(lakeview_spec_dict: dict[str, Any]) -> None:
    import re

    doc = _doc(lakeview_spec_dict)
    ids = [d["name"] for d in doc["datasets"]]
    ids += [p["name"] for p in doc["pages"]]
    ids += [w["name"] for w in _widgets(doc)]
    for value in ids:
        assert re.fullmatch(r"[0-9a-f]{8}", value), value
    assert len(ids) == len(set(ids)), "emitted ids must be unique"


def test_compiling_twice_is_byte_identical(lakeview_spec_dict: dict[str, Any]) -> None:
    first = _compile(copy.deepcopy(lakeview_spec_dict))
    second = _compile(copy.deepcopy(lakeview_spec_dict))
    assert first == second


def test_ids_are_seeded_with_the_workbook_name(lakeview_spec_dict: dict[str, Any]) -> None:
    before = _doc(lakeview_spec_dict)["datasets"][0]["name"]
    lakeview_spec_dict["workbook"]["name"] = "Another Workbook"
    after = _doc(lakeview_spec_dict)["datasets"][0]["name"]
    assert before != after


# --- caps --------------------------------------------------------------------


def _wide_spec(spec_dict: dict[str, Any], worksheets: int) -> dict[str, Any]:
    """Same spec with `worksheets` standalone bar worksheets (each on its own page)."""
    spec_dict["dashboards"] = []
    spec_dict["worksheets"] = [
        {
            "id": f"ws_{i}",
            "title": f"Sheet {i}",
            "datasource": "orders_ds",
            "chart": {
                "type": "bar",
                "rows": [{"field": "Sales", "aggregation": "sum"}],
                "cols": [{"field": "Region"}],
            },
        }
        for i in range(worksheets)
    ]
    return spec_dict


def test_page_cap_is_enforced(lakeview_spec_dict: dict[str, Any]) -> None:
    spec = _wide_spec(lakeview_spec_dict, MAX_PAGES + 1)
    with pytest.raises(CompileError, match=f"{MAX_PAGES}"):
        _compile(spec)


def test_widgets_per_page_cap_is_enforced(lakeview_spec_dict: dict[str, Any]) -> None:
    spec = _wide_spec(lakeview_spec_dict, MAX_WIDGETS_PER_PAGE + 1)
    spec["dashboards"] = [
        {
            "id": "big",
            "title": "Big",
            "size": {"width": 1200, "height": 800},
            "zones": [
                {
                    "kind": "worksheet",
                    "worksheet": f"ws_{i}",
                    "x": 0,
                    "y": 0,
                    "w": 10,
                    "h": 10,
                }
                for i in range(MAX_WIDGETS_PER_PAGE + 1)
            ],
        }
    ]
    with pytest.raises(CompileError, match=f"{MAX_WIDGETS_PER_PAGE}"):
        _compile(spec)


def test_dataset_cap_is_enforced(lakeview_spec_dict: dict[str, Any]) -> None:
    # One dataset per worksheet-bound datasource; spread over two dashboards so
    # the page and widgets-per-page caps stay clear and the dataset cap is what
    # actually trips.
    count = MAX_DATASETS + 1
    lakeview_spec_dict["datasources"] = [
        {
            "id": f"ds_{i}",
            "name": f"t{i}",
            "kind": "live_database",
            "database": {
                "dialect": "databricks",
                "host": "adb.example.net",
                "database": "main",
                "db_schema": "analytics",
                "table": f"t{i}",
            },
            "fields": [{"name": "V", "datatype": "string", "role": "dimension"}],
        }
        for i in range(count)
    ]
    lakeview_spec_dict["worksheets"] = [
        {
            "id": f"ws_{i}",
            "title": f"Sheet {i}",
            "datasource": f"ds_{i}",
            "chart": {"type": "text_table", "rows": [{"field": "V"}], "cols": []},
        }
        for i in range(count)
    ]
    half = count // 2
    lakeview_spec_dict["dashboards"] = [
        {
            "id": f"d{n}",
            "title": f"Dash {n}",
            "size": {"width": 1200, "height": 800},
            "zones": [
                {"kind": "worksheet", "worksheet": f"ws_{i}", "x": 0, "y": 0, "w": 10, "h": 10}
                for i in ids
            ],
        }
        for n, ids in enumerate((range(half), range(half, count)))
    ]
    with pytest.raises(CompileError, match=f"{MAX_DATASETS}"):
        _compile(lakeview_spec_dict)


# --- the logical split -------------------------------------------------------


def _parts(spec_dict: dict[str, Any]) -> list[Any]:
    return compile_lakeview_parts(DashboardSpec.model_validate(spec_dict))


def _part_docs(spec_dict: dict[str, Any]) -> list[dict[str, Any]]:
    return [json.loads(part.text) for part in _parts(spec_dict)]


def _page_titles(doc: dict[str, Any]) -> list[str]:
    return [page["displayName"] for page in doc["pages"]]


def test_a_report_that_fits_compiles_to_exactly_one_part(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    parts = _parts(lakeview_spec_dict)
    assert len(parts) == 1
    part = parts[0]
    assert (part.index, part.total) == (1, 1)
    # An unsplit report is untouched: same name, same bytes as compile_lakeview.
    assert part.title == lakeview_spec_dict["workbook"]["name"]
    assert part.text == _compile(lakeview_spec_dict)


def test_a_report_over_the_page_cap_splits_instead_of_failing(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    spec = _wide_spec(copy.deepcopy(lakeview_spec_dict), 28)
    parts = _parts(spec)
    assert len(parts) == 2
    assert all(part.page_count <= MAX_PAGES for part in parts)
    # 28 pages come back as 14 + 14, not 15 + 13: a part left at the cap gives
    # whoever imports it no room to add a page.
    assert [part.page_count for part in parts] == [14, 14]
    assert [(p.index, p.total) for p in parts] == [(1, 2), (2, 2)]


def test_the_split_keeps_every_page_exactly_once_and_in_order(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    spec = _wide_spec(copy.deepcopy(lakeview_spec_dict), 28)
    titles = [t for doc in _part_docs(spec) for t in _page_titles(doc)]
    assert titles == [f"Sheet {i}" for i in range(28)]
    names = [page["name"] for doc in _part_docs(spec) for page in doc["pages"]]
    assert len(names) == len(set(names))


def test_split_parts_carry_only_the_datasets_their_pages_query(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    # 20 sheets on orders_ds; events_ds is bound by no worksheet at all.
    spec = _wide_spec(copy.deepcopy(lakeview_spec_dict), 20)
    for doc in _part_docs(spec):
        declared = {d["name"] for d in doc["datasets"]}
        queried = {
            entry["widget"]["queries"][0]["query"]["datasetName"]
            for page in doc["pages"]
            for entry in page["layout"]
        }
        assert queried <= declared, "a widget must not reference a missing dataset"
        assert declared == queried, "a part must not carry datasets it never queries"


def test_split_titles_number_the_documents(lakeview_spec_dict: dict[str, Any]) -> None:
    spec = _wide_spec(copy.deepcopy(lakeview_spec_dict), 28)
    assert [part.title for part in _parts(spec)] == [
        "Rebuild Live (1 of 2)",
        "Rebuild Live (2 of 2)",
    ]


def test_splitting_is_deterministic(lakeview_spec_dict: dict[str, Any]) -> None:
    spec = _wide_spec(copy.deepcopy(lakeview_spec_dict), 31)
    first = [part.text for part in _parts(copy.deepcopy(spec))]
    second = [part.text for part in _parts(copy.deepcopy(spec))]
    assert first == second


def test_every_part_stays_within_the_page_cap_at_any_size(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    for count in (MAX_PAGES + 1, 31, 46, 100):
        spec = _wide_spec(copy.deepcopy(lakeview_spec_dict), count)
        parts = _parts(spec)
        assert sum(p.page_count for p in parts) == count
        assert all(1 <= p.page_count <= MAX_PAGES for p in parts)
        # No more documents than the page count actually forces.
        assert len(parts) == -(-count // MAX_PAGES)


def _two_source_spec(spec_dict: dict[str, Any], per_source: int) -> dict[str, Any]:
    """`per_source` sheets on orders_ds followed by `per_source` on events_ds."""
    spec_dict["dashboards"] = []
    spec_dict["worksheets"] = [
        {
            "id": f"ws_{ds}_{i}",
            "title": f"{ds} {i}",
            "datasource": ds,
            "chart": {
                "type": "text_table",
                "rows": [{"field": "Region" if ds == "orders_ds" else "Channel"}],
                "cols": [],
            },
        }
        for ds in ("orders_ds", "events_ds")
        for i in range(per_source)
    ]
    return spec_dict


def test_a_part_closes_on_a_datasource_seam_rather_than_mid_source(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    # 26 pages -> 2 parts of 13 by arithmetic alone, which would put the last
    # orders sheet on part 2. The seam sits at 12, inside the slack, so the split
    # follows the data instead: all orders together, all events together.
    spec = _two_source_spec(copy.deepcopy(lakeview_spec_dict), 12)
    spec["worksheets"] += [
        {
            "id": f"ws_extra_{i}",
            "title": f"events extra {i}",
            "datasource": "events_ds",
            "chart": {"type": "text_table", "rows": [{"field": "Channel"}], "cols": []},
        }
        for i in range(2)
    ]
    docs = _part_docs(spec)
    assert len(docs) == 2
    assert all(t.startswith("orders_ds") for t in _page_titles(docs[0]))
    assert all(not t.startswith("orders_ds") for t in _page_titles(docs[1]))
    assert [len(d["datasets"]) for d in docs] == [1, 1]


def test_every_page_on_its_own_datasource_still_splits_evenly(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """30 pages, each on a datasource of its own, is 30 seams. Closing a part at
    the first one inside the slack gave 13/13/4 — three dashboards where two
    even ones fit. A seam may only close a part when the tail still fits in the
    parts that remain."""
    count = 30
    lakeview_spec_dict["datasources"] = [
        {
            "id": f"ds_{i}",
            "name": f"t{i}",
            "kind": "live_database",
            "database": {
                "dialect": "databricks",
                "host": "adb.example.net",
                "database": "main",
                "db_schema": "analytics",
                "table": f"t{i}",
            },
            "fields": [{"name": "V", "datatype": "string", "role": "dimension"}],
        }
        for i in range(count)
    ]
    lakeview_spec_dict["worksheets"] = [
        {
            "id": f"ws_{i}",
            "title": f"Sheet {i}",
            "datasource": f"ds_{i}",
            "chart": {"type": "text_table", "rows": [{"field": "V"}], "cols": []},
        }
        for i in range(count)
    ]
    lakeview_spec_dict["dashboards"] = []
    parts = _parts(lakeview_spec_dict)
    assert [p.page_count for p in parts] == [15, 15]


def test_the_dataset_cap_splits_when_the_pages_can_be_separated(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    # 101 datasources over 101 single-sheet pages: too many datasets for one
    # dashboard, but every page carries its own, so parts come out legal.
    count = MAX_DATASETS + 1
    lakeview_spec_dict["datasources"] = [
        {
            "id": f"ds_{i}",
            "name": f"t{i}",
            "kind": "live_database",
            "database": {
                "dialect": "databricks",
                "host": "adb.example.net",
                "database": "main",
                "db_schema": "analytics",
                "table": f"t{i}",
            },
            "fields": [{"name": "V", "datatype": "string", "role": "dimension"}],
        }
        for i in range(count)
    ]
    lakeview_spec_dict["worksheets"] = [
        {
            "id": f"ws_{i}",
            "title": f"Sheet {i}",
            "datasource": f"ds_{i}",
            "chart": {"type": "text_table", "rows": [{"field": "V"}], "cols": []},
        }
        for i in range(count)
    ]
    lakeview_spec_dict["dashboards"] = []
    docs = _part_docs(lakeview_spec_dict)
    assert sum(len(d["pages"]) for d in docs) == count
    assert all(len(d["datasets"]) <= MAX_DATASETS for d in docs)
    assert all(len(d["pages"]) <= MAX_PAGES for d in docs)


def test_the_dataset_cap_error_reports_the_specs_own_dataset_count(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """The message read the LARGEST PART's dataset count, which is by
    construction <= the cap — so it said "the 100-dataset cap ... the largest
    single part needs 51", which reads as nonsense. Report what the SPEC binds."""
    count = MAX_DATASETS + 2  # over the cap, but few enough pages to stay legal
    lakeview_spec_dict["datasources"] = [
        {
            "id": f"ds_{i}",
            "name": f"t{i}",
            "kind": "live_database",
            "database": {
                "dialect": "databricks",
                "host": "adb.example.net",
                "database": "main",
                "db_schema": "analytics",
                "table": f"t{i}",
            },
            "fields": [{"name": "V", "datatype": "string", "role": "dimension"}],
        }
        for i in range(count)
    ]
    lakeview_spec_dict["worksheets"] = [
        {
            "id": f"ws_{i}",
            "title": f"Sheet {i}",
            "datasource": f"ds_{i}",
            "chart": {"type": "text_table", "rows": [{"field": "V"}], "cols": []},
        }
        for i in range(count)
    ]
    half = count // 2
    lakeview_spec_dict["dashboards"] = [
        {
            "id": f"dash_{d}",
            "title": f"Dash {d}",
            "size": {"width": 1200, "height": 800},
            "zones": [
                {"kind": "worksheet", "worksheet": f"ws_{i}", "x": 0, "y": 0, "w": 10, "h": 10}
                for i in range(d * half, (d + 1) * half)
            ],
        }
        for d in range(2)
    ]
    # Two pages, so the page cap is not what forces the split.
    assert len(_parts(lakeview_spec_dict)) == 2
    with pytest.raises(CompileError) as exc:
        _compile(lakeview_spec_dict)
    message = str(exc.value)
    assert f"binds {count} datasources" in message, message
    assert f"{MAX_DATASETS}-dataset cap" in message, message


def test_a_single_over_full_dashboard_is_still_an_error_a_split_cannot_fix(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    # Every datasource on ONE dashboard page. A split moves pages between
    # documents, so it can never relieve a single page that is itself too big:
    # the widgets-per-page cap is reported, and nothing is silently dropped.
    count = MAX_DATASETS + 1
    lakeview_spec_dict["datasources"] = [
        {
            "id": f"ds_{i}",
            "name": f"t{i}",
            "kind": "live_database",
            "database": {
                "dialect": "databricks",
                "host": "adb.example.net",
                "database": "main",
                "db_schema": "analytics",
                "table": f"t{i}",
            },
            "fields": [{"name": "V", "datatype": "string", "role": "dimension"}],
        }
        for i in range(count)
    ]
    lakeview_spec_dict["worksheets"] = [
        {
            "id": f"ws_{i}",
            "title": f"Sheet {i}",
            "datasource": f"ds_{i}",
            "chart": {"type": "text_table", "rows": [{"field": "V"}], "cols": []},
        }
        for i in range(count)
    ]
    lakeview_spec_dict["dashboards"] = [
        {
            "id": "one",
            "title": "One",
            "size": {"width": 1200, "height": 800},
            "zones": [
                {"kind": "worksheet", "worksheet": f"ws_{i}", "x": 0, "y": 0, "w": 10, "h": 10}
                for i in range(count)
            ],
        }
    ]
    with pytest.raises(CompileError, match="widgets"):
        _parts(lakeview_spec_dict)


# --- golden ------------------------------------------------------------------


def test_golden_lvdash_matches(lakeview_spec_dict: dict[str, Any]) -> None:
    compiled = _compile(lakeview_spec_dict)
    assert GOLDEN_LVDASH.exists(), f"golden fixture missing: {GOLDEN_LVDASH}"
    assert compiled == GOLDEN_LVDASH.read_text(encoding="utf-8"), (
        "compiled .lvdash.json differs from the golden fixture — review the diff "
        "and re-bless tests/golden/rebuild_live.lvdash.json only if the change is "
        "intended (it is also re-ingested by the server's integration suite)"
    )
