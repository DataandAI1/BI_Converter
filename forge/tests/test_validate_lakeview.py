"""Validation pipeline for compiled `.lvdash.json` artifacts (plan 2026-08-10
Phase 5): the four layers, what each one refuses, and the one thing it warns
about instead of refusing (a widget type pinned from Databricks' docs rather
than from an exported dashboard).
"""

from __future__ import annotations

import copy
import json
from typing import Any

import pytest

from tableauforge.compiler.lakeview import compile_lakeview
from tableauforge.spec.models import DashboardSpec
from tableauforge.validate.lakeview import (
    LAKEVIEW_FORMAT_VERSION,
    validate_lakeview_artifact,
)


def _artifact(spec_dict: dict[str, Any]) -> str:
    return compile_lakeview(DashboardSpec.model_validate(spec_dict))


def _validate(spec_dict: dict[str, Any], text: str):
    return validate_lakeview_artifact(spec_dict, text)


def _mutate(text: str, fn) -> str:
    doc = json.loads(text)
    fn(doc)
    return json.dumps(doc, indent=2, ensure_ascii=False) + "\n"


def _layer(report, name: str) -> dict[str, Any]:
    for entry in report.to_dict()["layers"]:
        if entry["name"] == name:
            return entry
    raise AssertionError(f"no layer named {name!r} in {report.to_dict()}")


def _first_widget(doc: dict[str, Any]) -> dict[str, Any]:
    return doc["pages"][0]["layout"][0]["widget"]


@pytest.fixture
def artifact(lakeview_spec_dict: dict[str, Any]) -> str:
    return _artifact(lakeview_spec_dict)


# --- happy path --------------------------------------------------------------


def test_compiled_artifact_passes_every_layer(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    report, warnings = _validate(lakeview_spec_dict, artifact)
    assert report.passed, report.to_dict()
    assert warnings == []


def test_report_declares_four_named_layers(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    report, _ = _validate(lakeview_spec_dict, artifact)
    body = report.to_dict()
    assert body["xsd_version"] == LAKEVIEW_FORMAT_VERSION
    assert [(l["layer"], l["name"]) for l in body["layers"]] == [
        (1, "json-structure"),
        (2, "widget-lint"),
        (3, "sql-parse"),
        (4, "cross-refs"),
    ]


# --- layer 1: JSON structure -------------------------------------------------


def test_unparseable_json_fails_layer_1_and_skips_the_rest(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    report, _ = _validate(lakeview_spec_dict, "{not json")
    body = report.to_dict()
    assert body["passed"] is False
    assert [l["name"] for l in body["layers"]] == ["json-structure"]


def test_missing_pages_key_fails_layer_1(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    text = _mutate(artifact, lambda d: d.pop("pages"))
    report, _ = _validate(lakeview_spec_dict, text)
    assert _layer(report, "json-structure")["passed"] is False


def test_wrong_page_type_fails_layer_1(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        d["pages"][0]["pageType"] = "PAGE_TYPE_GLOBAL_FILTERS"

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("PAGE_TYPE_CANVAS" in e for e in errors), errors


def test_duplicate_ids_fail_layer_1(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        d["pages"][1]["name"] = d["pages"][0]["name"]

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("duplicate" in e for e in errors), errors


def test_non_integer_position_fails_layer_1(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        d["pages"][0]["layout"][0]["position"]["x"] = 1.5

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("integer" in e for e in errors), errors


def test_position_off_the_grid_fails_layer_1(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        d["pages"][0]["layout"][0]["position"]["width"] = 13

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("12-column" in e for e in errors), errors


def test_page_cap_fails_layer_1(lakeview_spec_dict: dict[str, Any], artifact: str) -> None:
    def bad(d):
        page = d["pages"][0]
        d["pages"] = [
            {**copy.deepcopy(page), "name": f"{i:08x}"} for i in range(16)
        ]

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("15" in e for e in errors), errors


def test_ui_settings_fails_layer_1(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        d["uiSettings"] = {"genieSpace": {"enabled": True}}

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("uiSettings" in e for e in errors), errors


# --- layer 2: widget lint vs the pinned table --------------------------------


def test_unknown_widget_type_fails_layer_2(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        _first_widget(d)["spec"]["widgetType"] = "sunburst"

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "widget-lint")["errors"]
    assert any("sunburst" in e for e in errors), errors


def test_spec_version_off_the_pin_fails_layer_2(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        _first_widget(d)["spec"]["version"] = 99

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "widget-lint")["errors"]
    assert any("99" in e for e in errors), errors


def test_unpinned_encoding_channel_fails_layer_2(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        widget = _first_widget(d)
        widget["spec"]["encodings"]["size"] = {"fieldName": "Total Sales"}

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "widget-lint")["errors"]
    assert any("size" in e for e in errors), errors


def test_unverified_widget_type_warns_but_passes(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    # 'funnel' is pinned from Databricks' docs, never observed on the wire.
    def bad(d):
        widget = _first_widget(d)
        widget["spec"]["widgetType"] = "funnel"
        widget["spec"]["version"] = 3
        widget["spec"]["encodings"] = {}

    report, warnings = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    assert _layer(report, "widget-lint")["passed"] is True
    assert any("funnel" in w and "docs" in w for w in warnings), warnings


# --- layer 3: Databricks SQL parse -------------------------------------------


def test_unparseable_dataset_query_fails_layer_3(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        d["datasets"][0]["query"] = "SELECT FROM WHERE (("

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "sql-parse")["errors"]
    assert any("does not parse" in e for e in errors), errors


def test_non_select_dataset_query_fails_layer_3(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        d["datasets"][0]["query"] = "DROP TABLE `main`.`analytics`.`orders`"

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "sql-parse")["errors"]
    assert any("SELECT" in e for e in errors), errors


def test_unparseable_widget_expression_fails_layer_3(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        _first_widget(d)["queries"][0]["query"]["fields"][0]["expression"] = "SUM(`Sales`"

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "sql-parse")["errors"]
    assert any("does not parse" in e for e in errors), errors


def test_unparseable_spec_sql_expression_fails_layer_3(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    # The authored sql_expression itself, straight off the spec — the artifact
    # can be structurally perfect while the translated formula is nonsense.
    lakeview_spec_dict["datasources"][0]["calculated_fields"][1]["formula"] = "SUM(((`Sales`"
    report, _ = _validate(lakeview_spec_dict, artifact)
    errors = _layer(report, "sql-parse")["errors"]
    assert any("Total Sales" in e for e in errors), errors


# --- layer 4: cross-references -----------------------------------------------


def test_dangling_dataset_name_fails_layer_4(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        _first_widget(d)["queries"][0]["query"]["datasetName"] = "deadbeef"

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "cross-refs")["errors"]
    assert any("deadbeef" in e for e in errors), errors


def test_encoding_pointing_at_no_query_field_fails_layer_4(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        _first_widget(d)["spec"]["encodings"]["value"]["fieldName"] = "Nope"

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "cross-refs")["errors"]
    assert any("Nope" in e for e in errors), errors


def test_expression_over_an_unknown_column_fails_layer_4(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    """The dataset's projection resolved to a concrete column list, so a column
    outside it does not exist — the widget's query fails at load. Only the
    unresolvable cases (`SELECT *`, an unparseable query) stay silent."""
    def bad(d):
        fields = _first_widget(d)["queries"][0]["query"]["fields"]
        fields[0]["expression"] = "SUM(`Not A Column`)"

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "cross-refs")["errors"]
    assert any("Not A Column" in e for e in errors), errors


def test_expression_over_a_select_star_dataset_is_left_alone(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        d["datasets"][0]["query"] = "SELECT * FROM `main`.`analytics`.`orders`"
        fields = _first_widget(d)["queries"][0]["query"]["fields"]
        fields[0]["expression"] = "SUM(`Not A Column`)"

    report, warnings = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    assert _layer(report, "cross-refs")["passed"] is True
    assert not any("Not A Column" in w for w in warnings), warnings


# --- layer 3: semantic SQL lint ----------------------------------------------


def test_an_ungrouped_aggregate_dataset_projection_fails_layer_3(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    """`SELECT SUM(x), y FROM t` parses perfectly and then dies with
    MISSING_GROUP_BY the first time the dashboard opens."""
    def bad(d):
        d["datasets"][0]["query"] = (
            "SELECT\n  `Region`,\n  SUM(`Sales`) AS `Total`\nFROM "
            "`main`.`analytics`.`orders`"
        )

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "sql-parse")["errors"]
    assert any("ungrouped aggregate" in e for e in errors), errors


def test_a_grouped_aggregate_dataset_projection_passes_layer_3(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def ok(d):
        d["datasets"][0]["query"] = (
            "SELECT\n  `Region`,\n  SUM(`Sales`) AS `Total`\nFROM "
            "`main`.`analytics`.`orders`\nGROUP BY `Region`"
        )

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, ok))
    assert _layer(report, "sql-parse")["passed"] is True


def test_an_aggregating_chart_with_no_aggregate_field_warns(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        widget = next(
            e["widget"]
            for e in d["pages"][0]["layout"]
            if e["widget"]["spec"]["widgetType"] == "bar"
        )
        for field in widget["queries"][0]["query"]["fields"]:
            field["expression"] = f"`{field['name']}`"

    report, warnings = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    assert _layer(report, "sql-parse")["passed"] is True
    assert any("one mark per source row" in w for w in warnings), warnings


def test_a_filter_widget_is_not_linted_for_a_missing_aggregate(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["worksheets"][0]["filters"] = [
        {"field": "Region", "filter_type": "categorical", "show_quick_filter": True}
    ]
    text = _artifact(lakeview_spec_dict)
    report, warnings = _validate(lakeview_spec_dict, text)
    assert report.passed, report.to_dict()
    assert warnings == []


# --- layer 2: required channels + query fields --------------------------------


def test_a_widget_missing_a_required_channel_fails_layer_2(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        widget = next(
            e["widget"]
            for e in d["pages"][0]["layout"]
            if e["widget"]["spec"]["widgetType"] == "bar"
        )
        widget["spec"]["encodings"].pop("y")

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "widget-lint")["errors"]
    assert any("needs a 'y' encoding" in e for e in errors), errors


def test_a_counter_without_a_value_channel_fails_layer_2(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        _first_widget(d)["spec"]["encodings"] = {}

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "widget-lint")["errors"]
    assert any("'value'" in e for e in errors), errors


def test_a_pivot_accepts_rows_or_columns_but_needs_a_cell(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        widget = _first_widget(d)
        widget["spec"]["widgetType"] = "pivot"
        widget["spec"]["version"] = 3
        widget["spec"]["encodings"] = {
            "rows": [{"fieldName": "Total Sales", "displayName": "Total Sales"}]
        }

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "widget-lint")["errors"]
    assert any("'cell'" in e for e in errors), errors
    assert not any("'rows' or 'columns'" in e for e in errors), errors


def test_a_widget_with_no_query_fields_fails_layer_2(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        _first_widget(d)["queries"][0]["query"]["fields"] = []

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "widget-lint")["errors"]
    assert any("projects no fields" in e for e in errors), errors


def test_a_fields_entry_with_a_dangling_queryname_fails_layer_2(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    lakeview_spec_dict["worksheets"][0]["filters"] = [
        {"field": "Region", "filter_type": "categorical", "show_quick_filter": True}
    ]

    def bad(d):
        for page in d["pages"]:
            for entry in page["layout"]:
                fields = entry["widget"]["spec"]["encodings"].get("fields")
                if fields:
                    fields[0]["queryName"] = "some_other_query"

    text = _mutate(_artifact(lakeview_spec_dict), bad)
    report, _ = _validate(lakeview_spec_dict, text)
    errors = _layer(report, "widget-lint")["errors"]
    assert any("queryName" in e for e in errors), errors


# --- layer 1: page/dataset integrity ------------------------------------------


def test_an_empty_page_layout_fails_layer_1(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        d["pages"][0]["layout"] = []

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("layout is empty" in e for e in errors), errors


def test_overlapping_widgets_fail_layer_1(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        entries = d["pages"][0]["layout"]
        entries[1]["position"] = dict(entries[0]["position"])

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("overlap on the grid" in e for e in errors), errors


def test_duplicate_dataset_display_names_fail_layer_1(
    lakeview_spec_dict: dict[str, Any], artifact: str
) -> None:
    def bad(d):
        d["datasets"][1]["displayName"] = d["datasets"][0]["displayName"]

    report, _ = _validate(lakeview_spec_dict, _mutate(artifact, bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("duplicate dataset displayName" in e for e in errors), errors


# --- dataset parameters --------------------------------------------------------


def _parameterised(spec_dict: dict[str, Any], datatype: str = "string") -> dict[str, Any]:
    spec_dict["datasources"][0]["parameters"] = [
        {"name": "region_filter", "datatype": datatype, "default": "East"}
    ]
    return spec_dict


def _orders(doc: dict[str, Any]) -> dict[str, Any]:
    return next(d for d in doc["datasets"] if d["displayName"] == "orders")


def _control(doc: dict[str, Any]) -> dict[str, Any]:
    for page in doc["pages"]:
        for entry in page["layout"]:
            if entry["widget"]["spec"]["widgetType"].startswith("filter"):
                return entry["widget"]
    raise AssertionError("no filter widget in the document")


def test_a_parameterised_artifact_passes_every_layer(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    spec = _parameterised(lakeview_spec_dict)
    report, warnings = _validate(spec, _artifact(spec))
    assert report.passed, report.to_dict()
    assert warnings == []


def test_an_off_pin_parameter_data_type_fails_layer_1(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    spec = _parameterised(lakeview_spec_dict)

    def bad(d):
        _orders(d)["parameters"][0]["dataType"] = "BOOLEAN"

    report, _ = _validate(spec, _mutate(_artifact(spec), bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("dataType 'BOOLEAN' is not pinned" in e for e in errors), errors


def test_an_off_pin_complex_type_fails_layer_1(lakeview_spec_dict: dict[str, Any]) -> None:
    spec = _parameterised(lakeview_spec_dict)

    def bad(d):
        _orders(d)["parameters"][0]["complexType"] = "SET"

    report, _ = _validate(spec, _mutate(_artifact(spec), bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("complexType 'SET' is not pinned" in e for e in errors), errors


def test_a_default_selection_whose_data_type_disagrees_fails_layer_1(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    spec = _parameterised(lakeview_spec_dict)

    def bad(d):
        _orders(d)["parameters"][0]["defaultSelection"]["values"]["dataType"] = "INTEGER"

    report, _ = _validate(spec, _mutate(_artifact(spec), bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("does not match the parameter's dataType" in e for e in errors), errors


def test_a_range_parameter_needs_the_range_selection_shape(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    """A DATETIME parameter gets no widget, so this exercises the dataset
    declaration alone: the RANGE form's default is a min/max pair, and the
    single-value `values` shape imports and then opens on nothing."""
    spec = _parameterised(lakeview_spec_dict, datatype="datetime")
    text = _artifact(spec)

    def wrong(d):
        _orders(d)["parameters"][0]["complexType"] = "RANGE"

    report, _ = _validate(spec, _mutate(text, wrong))
    errors = _layer(report, "json-structure")["errors"]
    assert any("must carry a 'range' object" in e for e in errors), errors

    def right(d):
        parameter = _orders(d)["parameters"][0]
        parameter["complexType"] = "RANGE"
        parameter["defaultSelection"] = {
            "range": {
                "dataType": "DATETIME",
                "min": {"value": "now-12M/M"},
                "max": {"value": "now-1M/M"},
            }
        }

    report, _ = _validate(spec, _mutate(text, right))
    assert _layer(report, "json-structure")["errors"] == []


def test_an_empty_parameters_list_fails_layer_1(lakeview_spec_dict: dict[str, Any]) -> None:
    def bad(d):
        d["datasets"][0]["parameters"] = []

    report, _ = _validate(lakeview_spec_dict, _mutate(_artifact(lakeview_spec_dict), bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("non-empty list when present" in e for e in errors), errors


def test_a_duplicate_parameter_keyword_fails_layer_1(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    spec = _parameterised(lakeview_spec_dict)

    def bad(d):
        parameters = _orders(d)["parameters"]
        parameters.append(copy.deepcopy(parameters[0]))

    report, _ = _validate(spec, _mutate(_artifact(spec), bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("duplicate parameter keyword" in e for e in errors), errors


def test_a_misnamed_parameter_query_fails_layer_1(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    spec = _parameterised(lakeview_spec_dict)

    def bad(d):
        widget = _control(d)
        widget["queries"][0]["name"] = "main_query"
        widget["spec"]["encodings"]["fields"][0]["queryName"] = "main_query"

    report, _ = _validate(spec, _mutate(_artifact(spec), bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("a parameter query must be named" in e for e in errors), errors


def test_a_parameter_query_that_also_projects_fields_fails_layer_1(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    spec = _parameterised(lakeview_spec_dict)

    def bad(d):
        _control(d)["queries"][0]["query"]["fields"] = [
            {"name": "Region", "expression": "`Region`"}
        ]

    report, _ = _validate(spec, _mutate(_artifact(spec), bad))
    errors = _layer(report, "json-structure")["errors"]
    assert any("must not also project 'fields'" in e for e in errors), errors


def test_a_parameter_name_bound_through_the_wrong_query_fails_layer_2(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    spec = _parameterised(lakeview_spec_dict)

    def bad(d):
        widget = _control(d)
        widget["queries"][0]["query"]["parameters"][0]["keyword"] = "other"
        widget["queries"][0]["name"] = widget["queries"][0]["name"].replace(
            "region_filter", "other"
        )
        widget["spec"]["encodings"]["fields"][0]["queryName"] = widget["queries"][0]["name"]

    report, _ = _validate(spec, _mutate(_artifact(spec), bad))
    errors = _layer(report, "widget-lint")["errors"]
    assert any("the control would move nothing" in e for e in errors), errors


def test_a_keyword_the_dataset_does_not_declare_fails_layer_4(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    spec = _parameterised(lakeview_spec_dict)

    def bad(d):
        # The dataset renames its parameter; the widget still binds the old one.
        _orders(d)["parameters"][0]["keyword"] = "renamed"

    report, _ = _validate(spec, _mutate(_artifact(spec), bad))
    errors = _layer(report, "cross-refs")["errors"]
    assert any("does not declare" in e and "region_filter" in e for e in errors), errors


def test_a_control_that_is_not_the_pinned_widget_for_the_form_fails_layer_4(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    spec = _parameterised(lakeview_spec_dict)

    def bad(d):
        # A STRING parameter's pinned control is the single-select; the
        # multi-select is the STRING:MULTI form's, which this is not.
        _control(d)["spec"]["widgetType"] = "filter-multi-select"

    report, _ = _validate(spec, _mutate(_artifact(spec), bad))
    errors = _layer(report, "cross-refs")["errors"]
    assert any("pinned widget for that form is 'filter-single-select'" in e for e in errors), errors


def test_a_parameter_query_against_an_unknown_dataset_fails_layer_4(
    lakeview_spec_dict: dict[str, Any],
) -> None:
    spec = _parameterised(lakeview_spec_dict)

    def bad(d):
        widget = _control(d)
        widget["queries"][0]["query"]["datasetName"] = "deadbeef"
        widget["queries"][0]["name"] = "parameter_deadbeef_region_filter"
        widget["spec"]["encodings"]["fields"][0]["queryName"] = widget["queries"][0]["name"]

    report, _ = _validate(spec, _mutate(_artifact(spec), bad))
    assert _layer(report, "json-structure")["errors"] == []
    errors = _layer(report, "cross-refs")["errors"]
    assert any("deadbeef" in e for e in errors), errors
