"""Validation pipeline for compiled `.lvdash.json` artifacts — the mirrored
layered contract of validate/pipeline.py and validate/pbit.py, reusing their
ValidationReport/LayerResult classes so the server and web render every target's
report unchanged.

Runtime layers:
  1. json-structure — the document parses and has the shape the format demands:
                      `{datasets, pages}`, canvas pages, a single `main_query`
                      per widget (a parameter-filter widget is the one exception:
                      it carries one binding query per dataset it drives),
                      dataset `parameters[]` entries whose dataType/complexType
                      and defaultSelection shape are pinned, integer 12-column
                      positions, unique 8-hex ids, the compile-time caps, and NO
                      `uiSettings` (its `genieSpace` shape is unverified — the
                      emitter never invents it).
  2. widget-lint    — every widget is backed by the pinned format table
                      (`spec/lakeview_widget_types.json`): an unknown
                      `widgetType`, an off-pin `spec.version`, or an encoding
                      channel the table does not list for that type is an error.
                      So is a widget missing a channel its type cannot render
                      without (a bar with no `y`, a counter with no `value`, a
                      filter with no `fields`) or carrying no query field at all
                      — both are blank widgets, which the format itself is happy
                      to describe. A `verified: false` type is a WARNING — it is
                      pinned from Databricks' docs rather than from an exported
                      dashboard, which is a "check how it renders", not a broken
                      file.
  3. sql-parse      — every dataset query and every authored SQL expression
                      (widget field expressions and the spec's own
                      `formula_language: 'sql'` calculated fields) parses as
                      Databricks SQL via sqlglot, and a dataset query is a
                      SELECT (AI/BI datasets are read-only — no DDL/DML). Parsing
                      is not enough on its own: a dataset projection carrying an
                      aggregate with no GROUP BY parses perfectly and then fails
                      with MISSING_GROUP_BY the first time the dashboard opens,
                      so that is an error too.
  4. cross-refs     — a widget's `datasetName` resolves to a declared dataset and
                      every encoding `fieldName` resolves to one of that widget's
                      own query fields (both errors: either one renders the
                      visual blank). Likewise for parameters: a keyword a query
                      binds must be declared on THAT query's dataset, and the
                      widget binding it must be the pinned widget for the
                      parameter's form. Column resolution — does a field expression
                      only touch columns the dataset actually projects — is an
                      error when the dataset's projection could be resolved
                      statically, and is skipped entirely when it could not
                      (`SELECT *`, or a query layer 3 already rejected).

Layers 2-4 are skipped when layer 1 fails — the same catastrophic-failure rule
validate/pipeline.py and validate/pbit.py use, for the same reason: there is
nothing coherent left to check.

Warnings are returned alongside the report rather than stuffed into it: a
LayerResult carries errors only, and a warning must not flip `passed`. The
generator folds them into the build's warnings, where the server already turns
them into a `complete_with_warnings` run.
"""

from __future__ import annotations

import json
import re
from typing import Any

import sqlglot
from sqlglot import exp
from sqlglot.errors import ParseError

from tableauforge.compiler.lakeview import (
    GRID_COLUMNS,
    MAIN_QUERY,
    MAX_DATASETS,
    MAX_PAGES,
    MAX_WIDGETS_PER_PAGE,
    PAGE_TYPE_CANVAS,
    parameter_form,
    parameter_query_name,
    parameter_types,
    widget_types,
)
from tableauforge.validate.pipeline import LayerResult, ValidationReport

#: The report's format-arbiter version tag. There is no schema for a
#: `.lvdash.json` — the structural contract in this module is the arbiter, so its
#: version string fills the report's existing xsd_version field honestly.
LAKEVIEW_FORMAT_VERSION = "lvdash-format/1"

#: sqlglot dialect for every parse in layer 3.
SQL_DIALECT = "databricks"

_ID_RE = re.compile(r"[0-9a-f]{8}")

#: Channels a widget type cannot render anything without. Absence is an error:
#: the format is perfectly happy to describe a bar chart with no `y`, and AI/BI
#: renders it as an empty box. Each entry is a list of alternatives — `pivot`
#: needs rows OR columns, everything else needs each named channel.
REQUIRED_CHANNELS: dict[str, tuple[tuple[str, ...], ...]] = {
    "area": (("x",), ("y",)),
    "bar": (("x",), ("y",)),
    "combo": (("x",), ("y",)),
    "counter": (("value",),),
    "heatmap": (("x",), ("y",)),
    "line": (("x",), ("y",)),
    "pie": (("angle",),),
    "pivot": (("rows", "columns"), ("cell",)),
    "scatter": (("x",), ("y",)),
    "table": (("columns",),),
    "filter-date-picker": (("fields",),),
    "filter-date-range-picker": (("fields",),),
    "filter-multi-select": (("fields",),),
    "filter-single-select": (("fields",),),
    "filter-text-input": (("fields",),),
    "range-slider": (("fields",),),
}

#: Widget types whose fields are chart measures/dimensions, so an aggregating
#: (`disaggregated: false`) query over them is expected to carry an aggregate.
#: `table` renders rows, and a filter widget projects the column it filters on —
#: neither is a grouped chart, so neither is linted for one.
_AGGREGATING_TYPES = frozenset(
    {"area", "bar", "combo", "counter", "heatmap", "line", "pie", "pivot", "scatter"}
)


class _Document:
    """The parsed artifact, in the shape layers 2-4 traverse."""

    def __init__(self, doc: dict[str, Any]):
        self.doc = doc
        self.datasets: list[dict[str, Any]] = [
            d for d in doc.get("datasets") or [] if isinstance(d, dict)
        ]
        self.pages: list[dict[str, Any]] = [
            p for p in doc.get("pages") or [] if isinstance(p, dict)
        ]

    def widgets(self) -> list[tuple[str, dict[str, Any]]]:
        """(where, widget) for every widget on every page."""
        out: list[tuple[str, dict[str, Any]]] = []
        for page in self.pages:
            where = str(page.get("displayName", page.get("name", "?")))
            for entry in page.get("layout") or []:
                if isinstance(entry, dict) and isinstance(entry.get("widget"), dict):
                    out.append((where, entry["widget"]))
        return out


# ------------------------------------------------------- layer 1: structure


def _check_position(where: str, position: Any, errors: list[str]) -> None:
    if not isinstance(position, dict):
        errors.append(f"{where}: layout entry has no position object")
        return
    for key in ("x", "y", "width", "height"):
        value = position.get(key)
        # bool is an int subclass; a JSON true here is a shape error, not a 1.
        if not isinstance(value, int) or isinstance(value, bool):
            errors.append(f"{where}: position.{key} must be an integer, got {value!r}")
            return
    if position["x"] < 0 or position["y"] < 0:
        errors.append(f"{where}: position has a negative origin {position!r}")
    if position["width"] < 1 or position["height"] < 1:
        errors.append(f"{where}: position must have a positive size, got {position!r}")
    elif position["x"] + position["width"] > GRID_COLUMNS:
        errors.append(
            f"{where}: position spans past the {GRID_COLUMNS}-column grid "
            f"(x={position['x']}, width={position['width']})"
        )


def _check_overlaps(where: str, layout: list[Any], errors: list[str]) -> None:
    """Pairwise grid overlap on one page. Two widgets sharing a cell is not a
    rendering nicety: AI/BI stacks them and one is unreachable, so the page ships
    content nobody can see."""
    boxes: list[tuple[int, dict[str, int]]] = []
    for j, entry in enumerate(layout):
        position = entry.get("position") if isinstance(entry, dict) else None
        if not isinstance(position, dict):
            continue
        if all(
            isinstance(position.get(k), int) and not isinstance(position.get(k), bool)
            for k in ("x", "y", "width", "height")
        ):
            boxes.append((j, position))
    for index, (j, a) in enumerate(boxes):
        for k, b in boxes[index + 1 :]:
            if (
                a["x"] < b["x"] + b["width"]
                and b["x"] < a["x"] + a["width"]
                and a["y"] < b["y"] + b["height"]
                and b["y"] < a["y"] + a["height"]
            ):
                errors.append(
                    f"{where}: layout[{j}] and layout[{k}] overlap on the grid "
                    f"({a} vs {b}) — one of the two widgets would be unreachable"
                )


def _is_parameter_query(entry: Any) -> bool:
    """A query that BINDS dataset parameters rather than projecting fields —
    the corpus's parameter-filter shape."""
    if not isinstance(entry, dict) or not isinstance(entry.get("query"), dict):
        return False
    return bool(entry["query"].get("parameters"))


def _check_query_entry(where: str, entry: Any, errors: list[str]) -> None:
    """One `queries[]` entry: the projecting `main_query` every chart/field-filter
    widget carries, or one of a parameter widget's per-dataset binding queries."""
    if not isinstance(entry, dict):
        errors.append(f"{where}: widget query entry is not an object, got {entry!r}")
        return
    query = entry.get("query")
    if not isinstance(query, dict):
        errors.append(f"{where}: widget query has no query object")
        return
    dataset_name = query.get("datasetName")
    if not isinstance(dataset_name, str):
        errors.append(f"{where}: widget query has no datasetName")
    if not isinstance(query.get("disaggregated"), bool):
        errors.append(f"{where}: widget query has no boolean 'disaggregated'")

    if not _is_parameter_query(entry):
        if entry.get("name") != MAIN_QUERY:
            errors.append(f"{where}: the widget query must be named {MAIN_QUERY!r}")
        fields = query.get("fields")
        if not isinstance(fields, list):
            errors.append(f"{where}: widget query has no fields list")
        else:
            for field in fields:
                if (
                    not isinstance(field, dict)
                    or not isinstance(field.get("name"), str)
                    or not isinstance(field.get("expression"), str)
                ):
                    errors.append(
                        f"{where}: every query field must be "
                        f"{{name, expression}} strings, got {field!r}"
                    )
        return

    # A parameter query BINDS, it does not project: the corpus never carries
    # both on one query, and a `fields` list here would make the widget read a
    # column and a parameter through the same query.
    if "fields" in query:
        errors.append(
            f"{where}: a parameter-binding query must not also project 'fields'"
        )
    keywords: list[str] = []
    for parameter in query["parameters"]:
        if (
            not isinstance(parameter, dict)
            or not isinstance(parameter.get("name"), str)
            or not isinstance(parameter.get("keyword"), str)
        ):
            errors.append(
                f"{where}: every query parameter must be {{name, keyword}} strings, "
                f"got {parameter!r}"
            )
            continue
        keywords.append(parameter["keyword"])
    if len(keywords) == 1 and isinstance(dataset_name, str):
        expected = parameter_query_name(dataset_name, keywords[0])
        if entry.get("name") != expected:
            errors.append(
                f"{where}: a parameter query must be named {expected!r} "
                f"(dataset + keyword), got {entry.get('name')!r}"
            )


def _check_widget_shape(where: str, widget: dict[str, Any], errors: list[str]) -> None:
    name = widget.get("name")
    if not isinstance(name, str) or not _ID_RE.fullmatch(name):
        errors.append(f"{where}: widget name must be 8 lowercase hex characters, got {name!r}")
    queries = widget.get("queries")
    if not isinstance(queries, list) or not queries:
        errors.append(f"{where}: widget must carry at least one query, got {queries!r}")
    elif len(queries) > 1 and not all(_is_parameter_query(e) for e in queries):
        # Only a parameter widget carries several queries — one per dataset it
        # drives. Anything else with two queries is a shape nobody emits.
        errors.append(
            f"{where}: only a parameter-filter widget may carry more than one query, "
            f"got {len(queries)}"
        )
    else:
        for index, entry in enumerate(queries):
            spot = where if len(queries) == 1 else f"{where}.queries[{index}]"
            _check_query_entry(spot, entry, errors)
    spec = widget.get("spec")
    if not isinstance(spec, dict):
        errors.append(f"{where}: widget has no spec object")
        return
    if not isinstance(spec.get("widgetType"), str):
        errors.append(f"{where}: widget spec has no widgetType")
    if not isinstance(spec.get("version"), int) or isinstance(spec.get("version"), bool):
        errors.append(f"{where}: widget spec has no integer version")
    if not isinstance(spec.get("encodings"), dict):
        errors.append(f"{where}: widget spec has no encodings object")


def _check_value_selection(
    where: str, selection: Any, data_type: str, errors: list[str]
) -> None:
    values = selection.get("values")
    if not isinstance(values, dict):
        errors.append(
            f"{where}: defaultSelection must carry a 'values' object for a "
            f"{data_type} parameter, got {selection!r}"
        )
        return
    if values.get("dataType") != data_type:
        errors.append(
            f"{where}: defaultSelection.values.dataType "
            f"{values.get('dataType')!r} does not match the parameter's "
            f"dataType {data_type!r}"
        )
    entries = values.get("values")
    if not isinstance(entries, list) or not entries:
        errors.append(f"{where}: defaultSelection.values.values must be a non-empty list")
        return
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("value"), str):
            errors.append(
                f"{where}: every defaultSelection value must be {{value: string}}, "
                f"got {entry!r}"
            )


def _check_range_selection(
    where: str, selection: Any, data_type: str, errors: list[str]
) -> None:
    bounds = selection.get("range")
    if not isinstance(bounds, dict):
        errors.append(
            f"{where}: a RANGE parameter's defaultSelection must carry a 'range' "
            f"object, got {selection!r}"
        )
        return
    if bounds.get("dataType") != data_type:
        errors.append(
            f"{where}: defaultSelection.range.dataType {bounds.get('dataType')!r} "
            f"does not match the parameter's dataType {data_type!r}"
        )
    for edge in ("min", "max"):
        value = bounds.get(edge)
        if not isinstance(value, dict) or not isinstance(value.get("value"), str):
            errors.append(
                f"{where}: defaultSelection.range.{edge} must be {{value: string}}, "
                f"got {value!r}"
            )


def _check_dataset_parameters(where: str, dataset: dict[str, Any], errors: list[str]) -> None:
    """`datasets[].parameters[]`: every entry must be a form the pinned table
    carries, with the defaultSelection shape that form uses.

    An off-pin `dataType`/`complexType` is not a cosmetic problem — AI/BI rejects
    the import, and a mismatched defaultSelection imports and then opens the
    dashboard on no value at all."""
    pins = parameter_types()
    parameters = dataset.get("parameters")
    if parameters is None:
        return
    if not isinstance(parameters, list) or not parameters:
        errors.append(
            f"{where}: 'parameters' must be a non-empty list when present (omit the "
            f"key entirely when the dataset declares none), got {parameters!r}"
        )
        return
    keywords: list[str] = []
    for i, parameter in enumerate(parameters):
        spot = f"{where}.parameters[{i}]"
        if not isinstance(parameter, dict):
            errors.append(f"{spot} is not an object")
            continue
        keyword = parameter.get("keyword")
        if not isinstance(keyword, str) or not keyword:
            errors.append(f"{spot}: keyword must be a non-empty string, got {keyword!r}")
        else:
            keywords.append(keyword)
        if not isinstance(parameter.get("displayName"), str):
            errors.append(f"{spot}: displayName must be a string")
        data_type = parameter.get("dataType")
        if data_type not in pins["dataTypes"]:
            errors.append(
                f"{spot}: dataType {data_type!r} is not pinned (pinned: "
                f"{pins['dataTypes']}) — the emitter never invents a parameter type"
            )
            continue
        complex_type = parameter.get("complexType")
        if complex_type is not None and complex_type not in pins["complexTypes"]:
            errors.append(
                f"{spot}: complexType {complex_type!r} is not pinned (pinned: "
                f"{pins['complexTypes']})"
            )
            continue
        selection = parameter.get("defaultSelection")
        if not isinstance(selection, dict):
            errors.append(f"{spot}: defaultSelection must be an object, got {selection!r}")
            continue
        if complex_type == "RANGE":
            _check_range_selection(spot, selection, str(data_type), errors)
        else:
            _check_value_selection(spot, selection, str(data_type), errors)
    duplicates = sorted({k for k in keywords if keywords.count(k) > 1})
    if duplicates:
        errors.append(
            f"{where}: duplicate parameter keyword(s) {duplicates} — one `:keyword` "
            "resolves to one parameter per dataset"
        )


def _check_structure(doc: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if "uiSettings" in doc:
        errors.append(
            "document must not carry 'uiSettings' — its genieSpace shape is "
            "unverified in the pinned corpus and is never emitted"
        )
    unexpected = sorted(set(doc) - {"datasets", "pages"})
    if unexpected:
        errors.append(f"unexpected top-level key(s): {unexpected}")

    datasets = doc.get("datasets")
    if not isinstance(datasets, list):
        errors.append("document must carry a 'datasets' list")
        datasets = []
    pages = doc.get("pages")
    if not isinstance(pages, list) or not pages:
        errors.append("document must carry a non-empty 'pages' list")
        pages = []

    ids: list[str] = []
    display_names: list[str] = []
    for i, dataset in enumerate(datasets):
        where = f"dataset[{i}]"
        if not isinstance(dataset, dict):
            errors.append(f"{where} is not an object")
            continue
        name = dataset.get("name")
        if not isinstance(name, str) or not _ID_RE.fullmatch(name):
            errors.append(f"{where}: name must be 8 lowercase hex characters, got {name!r}")
        else:
            ids.append(name)
        if not isinstance(dataset.get("displayName"), str):
            errors.append(f"{where}: displayName must be a string")
        else:
            display_names.append(dataset["displayName"])
        query = dataset.get("query")
        if not isinstance(query, str) or not query.strip():
            errors.append(f"{where}: query must be a non-empty SQL string")
        if "queryLines" in dataset:
            errors.append(
                f"{where}: the emitted form is the plain 'query' string, never 'queryLines'"
            )
        _check_dataset_parameters(where, dataset, errors)
    if len(datasets) > MAX_DATASETS:
        errors.append(
            f"document declares {len(datasets)} datasets; the cap is {MAX_DATASETS}"
        )
    # Two datasets named the same thing are indistinguishable in the AI/BI editor's
    # dataset picker — whoever opens the dashboard cannot tell which is which.
    duplicate_names = sorted({n for n in display_names if display_names.count(n) > 1})
    if duplicate_names:
        errors.append(
            f"duplicate dataset displayName(s): {duplicate_names} — every dataset "
            "must be distinguishable in the AI/BI dataset picker"
        )
    if len(pages) > MAX_PAGES:
        errors.append(f"document declares {len(pages)} pages; the cap is {MAX_PAGES}")

    for i, page in enumerate(pages):
        where = f"page[{i}]"
        if not isinstance(page, dict):
            errors.append(f"{where} is not an object")
            continue
        name = page.get("name")
        if not isinstance(name, str) or not _ID_RE.fullmatch(name):
            errors.append(f"{where}: name must be 8 lowercase hex characters, got {name!r}")
        else:
            ids.append(name)
        if not isinstance(page.get("displayName"), str):
            errors.append(f"{where}: displayName must be a string")
        if page.get("pageType") != PAGE_TYPE_CANVAS:
            errors.append(
                f"{where}: pageType must be {PAGE_TYPE_CANVAS!r}, got {page.get('pageType')!r}"
            )
        layout = page.get("layout")
        if not isinstance(layout, list):
            errors.append(f"{where}: layout must be a list")
            continue
        if not layout:
            errors.append(
                f"{where}: layout is empty — a page with no widgets imports as a blank "
                "canvas; drop the page or give it content"
            )
        if len(layout) > MAX_WIDGETS_PER_PAGE:
            errors.append(
                f"{where}: {len(layout)} widgets exceed the {MAX_WIDGETS_PER_PAGE} cap"
            )
        _check_overlaps(where, layout, errors)
        for j, entry in enumerate(layout):
            spot = f"{where}.layout[{j}]"
            if not isinstance(entry, dict):
                errors.append(f"{spot} is not an object")
                continue
            widget = entry.get("widget")
            if not isinstance(widget, dict):
                errors.append(f"{spot}: layout entry has no widget object")
            else:
                _check_widget_shape(spot, widget, errors)
                if isinstance(widget.get("name"), str) and _ID_RE.fullmatch(widget["name"]):
                    ids.append(widget["name"])
            _check_position(spot, entry.get("position"), errors)

    duplicates = sorted({value for value in ids if ids.count(value) > 1})
    if duplicates:
        errors.append(f"duplicate element id(s) in the document: {duplicates}")
    return errors


# ----------------------------------------------------- layer 2: widget lint


def _lint_widgets(document: _Document) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    table = widget_types()
    unverified_seen: set[str] = set()
    for where, widget in document.widgets():
        spec = widget.get("spec") or {}
        widget_type = str(spec.get("widgetType", ""))
        info = table.get(widget_type)
        if info is None:
            errors.append(
                f"{where}: widgetType {widget_type!r} is not in the pinned Lakeview "
                "format table — the emitter never invents a widget type"
            )
            continue
        if spec.get("version") != info["specVersion"]:
            errors.append(
                f"{where}: widgetType {widget_type!r} carries spec.version "
                f"{spec.get('version')!r}; the pinned version is {info['specVersion']}"
            )
        allowed = set(info["encodings"])
        encodings = spec.get("encodings") or {}
        for channel in sorted(encodings):
            if channel not in allowed:
                errors.append(
                    f"{where}: encoding channel {channel!r} is not pinned for widget "
                    f"type {widget_type!r} (pinned: {sorted(allowed)})"
                )
        for alternatives in REQUIRED_CHANNELS.get(widget_type, ()):
            if not any(_binding_entries(encodings.get(c)) for c in alternatives):
                named = " or ".join(repr(c) for c in alternatives)
                errors.append(
                    f"{where}: widget type {widget_type!r} needs a {named} encoding — "
                    "without it the widget renders as an empty box"
                )
        query = ((widget.get("queries") or [{}])[0].get("query")) or {}
        if not [f for f in query.get("fields") or [] if isinstance(f, dict)]:
            # A parameter-only query is the corpus's filter-widget shape; this
            # emitter never produces one, so a fieldless query here is a bug.
            if not query.get("parameters"):
                errors.append(
                    f"{where}: the widget query projects no fields — it would return "
                    "nothing to render"
                )
        # Array-channel entries name the query they read from; a `fields` entry
        # pointing at a query name the widget does not declare resolves to nothing.
        query_names = {
            entry.get("name")
            for entry in widget.get("queries") or []
            if isinstance(entry, dict)
        }
        keywords_by_query = _keywords_by_query(widget)
        for channel in sorted(encodings):
            if not isinstance(encodings.get(channel), list):
                continue
            for entry in _binding_entries(encodings[channel]):
                query_name = entry.get("queryName")
                if channel != "fields" and query_name is None:
                    continue
                if query_name not in query_names:
                    errors.append(
                        f"{where}: encoding {channel!r} entry "
                        f"{entry.get('fieldName') or entry.get('parameterName')!r} has "
                        f"queryName {query_name!r}, which is not one of this widget's "
                        f"queries ({sorted(n for n in query_names if n is not None)})"
                    )
                    continue
                # A `parameterName` binding reads its value from the query it
                # names, so that query must actually bind that keyword —
                # otherwise the control renders and changes nothing.
                parameter_name = entry.get("parameterName")
                if parameter_name is None:
                    continue
                bound = keywords_by_query.get(str(query_name), set())
                if parameter_name not in bound:
                    errors.append(
                        f"{where}: encoding {channel!r} binds parameterName "
                        f"{parameter_name!r} through query {query_name!r}, whose "
                        f"parameters are {sorted(bound)} — the control would move "
                        "nothing"
                    )
        if not info["verified"] and widget_type not in unverified_seen:
            unverified_seen.add(widget_type)
            warnings.append(
                f"widget type {widget_type!r} is pinned from Databricks' docs, not "
                "from an exported dashboard — verify how it renders"
            )
    return errors, warnings


# ------------------------------------------------------ layer 3: SQL parse


def _parse(sql: str) -> exp.Expression:
    return sqlglot.parse_one(sql, read=SQL_DIALECT)


def _is_aggregate(tree: exp.Expression) -> bool:
    return any(True for _ in tree.find_all(exp.AggFunc))


def _sql_errors(
    document: _Document, spec_dict: dict[str, Any]
) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    for dataset in document.datasets:
        query = dataset.get("query")
        label = dataset.get("displayName") or dataset.get("name")
        if not isinstance(query, str):
            continue
        try:
            tree = _parse(query)
        except ParseError as exc:
            errors.append(
                f"dataset {label!r}: query does not parse as Databricks SQL: "
                f"{str(exc).splitlines()[0]}"
            )
            continue
        if not isinstance(tree, (exp.Select, exp.Union, exp.Subquery)):
            errors.append(
                f"dataset {label!r}: query must be a SELECT — an AI/BI dataset is "
                f"read-only, got {type(tree).__name__.upper()}"
            )
            continue
        # Semantic lint, not syntax: `SELECT SUM(x), y FROM t` parses fine and
        # then fails with MISSING_GROUP_BY the first time the dashboard opens. An
        # aggregate belongs in a WIDGET's field expression, not in the row-level
        # dataset SELECT (module docstring of compiler/lakeview.py, two tiers).
        if isinstance(tree, exp.Select) and not tree.args.get("group"):
            aggregated = sorted(
                {
                    projection.alias_or_name or projection.sql(dialect=SQL_DIALECT)
                    for projection in tree.expressions
                    if _is_aggregate(projection)
                }
            )
            if aggregated:
                errors.append(
                    f"dataset {label!r}: projection {aggregated} is an ungrouped "
                    "aggregate (no GROUP BY) — the query fails with MISSING_GROUP_BY "
                    "on the first dashboard load; a dataset SELECT is row-level, so "
                    "declare the aggregate as a measure calculated field instead"
                )
    for where, widget in document.widgets():
        widget_spec = widget.get("spec") or {}
        widget_type = str(widget_spec.get("widgetType", ""))
        query = ((widget.get("queries") or [{}])[0].get("query")) or {}
        parsed: list[exp.Expression] = []
        for field in query.get("fields") or []:
            if not isinstance(field, dict) or not isinstance(field.get("expression"), str):
                continue
            try:
                parsed.append(_parse(field["expression"]))
            except ParseError as exc:
                errors.append(
                    f"{where}: field {field.get('name')!r} expression does not parse "
                    f"as Databricks SQL: {str(exc).splitlines()[0]}"
                )
        # The mirror of the dataset check, one tier up: an aggregating widget
        # query whose fields carry no aggregate at all groups by everything and
        # renders one mark per source row.
        if (
            parsed
            and widget_type in _AGGREGATING_TYPES
            and query.get("disaggregated") is False
            and not any(_is_aggregate(tree) for tree in parsed)
        ):
            warnings.append(
                f"{where}: widget type {widget_type!r} aggregates "
                "(`disaggregated: false`) but none of its field expressions is an "
                "aggregate — the visual will plot one mark per source row; wrap the "
                "measure (e.g. SUM(...)) or set disaggregated"
            )
    # The authored formulas themselves: a structurally perfect artifact can still
    # carry a translated sql_expression that no warehouse will run.
    for ds in spec_dict.get("datasources") or []:
        if not isinstance(ds, dict):
            continue
        for calc in ds.get("calculated_fields") or []:
            if not isinstance(calc, dict) or calc.get("formula_language") != "sql":
                continue
            formula = calc.get("formula")
            if not isinstance(formula, str):
                continue
            try:
                _parse(formula)
            except ParseError as exc:
                errors.append(
                    f"datasource {ds.get('id')!r}: calculated field "
                    f"{calc.get('name')!r} sql_expression does not parse as "
                    f"Databricks SQL: {str(exc).splitlines()[0]}"
                )
    return errors, warnings


# ------------------------------------------------------ layer 4: cross-refs


def _dataset_columns(query: str) -> set[str] | None:
    """Output column names of a dataset SELECT, or None when they cannot be
    resolved statically (a parse failure — layer 3 already said so — or a
    `SELECT *`, whose projection depends on the warehouse)."""
    try:
        tree = _parse(query)
    except ParseError:
        return None
    if not isinstance(tree, exp.Select):
        return None
    if any(isinstance(projection, exp.Star) for projection in tree.expressions):
        return None
    return {name for name in tree.named_selects if name}


def _expression_columns(expression: str) -> set[str] | None:
    try:
        tree = _parse(expression)
    except ParseError:
        return None
    return {column.name for column in tree.find_all(exp.Column) if column.name}


def _cross_refs(document: _Document) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    by_id = {
        str(d.get("name")): d for d in document.datasets if isinstance(d.get("name"), str)
    }
    columns_cache: dict[str, set[str] | None] = {}

    for where, widget in document.widgets():
        query = ((widget.get("queries") or [{}])[0].get("query")) or {}
        dataset_name = query.get("datasetName")
        dataset = by_id.get(str(dataset_name))
        if dataset is None:
            errors.append(
                f"{where}: datasetName {dataset_name!r} matches no declared dataset — "
                "the widget would render blank"
            )
        fields = [f for f in query.get("fields") or [] if isinstance(f, dict)]
        available = {f.get("name") for f in fields}
        for channel, binding in sorted((widget.get("spec") or {}).get("encodings", {}).items()):
            for entry in _binding_entries(binding):
                field_name = entry.get("fieldName")
                if field_name is not None and field_name not in available:
                    errors.append(
                        f"{where}: encoding {channel!r} references fieldName "
                        f"{field_name!r}, which is not one of the widget's query "
                        "fields — the visual would render blank"
                    )
        if dataset is None or not isinstance(dataset.get("query"), str):
            continue
        key = str(dataset_name)
        if key not in columns_cache:
            columns_cache[key] = _dataset_columns(dataset["query"])
        known = columns_cache[key]
        if known is None:
            continue  # SELECT * or unparseable — nothing to resolve against
        for field in fields:
            referenced = _expression_columns(str(field.get("expression", "")))
            if referenced is None:
                continue
            for column in sorted(referenced - known):
                # `known` came back as a CONCRETE projection list (the None cases
                # — `SELECT *`, an unparseable query — returned above), so a
                # column outside it does not exist on the dataset: the widget's
                # query fails at load. That is an error, not a "verify it".
                errors.append(
                    f"{where}: field {field.get('name')!r} references column "
                    f"{column!r}, which dataset "
                    f"{dataset.get('displayName') or dataset_name!r} does not "
                    "project — the widget's query would fail at load"
                )
    errors += _parameter_refs(document)
    return errors, warnings


def _keywords_by_query(widget: dict[str, Any]) -> dict[str, set[str]]:
    """query name -> the parameter keywords that query binds."""
    out: dict[str, set[str]] = {}
    for entry in widget.get("queries") or []:
        if not isinstance(entry, dict) or not isinstance(entry.get("query"), dict):
            continue
        out[str(entry.get("name"))] = {
            str(p["keyword"])
            for p in entry["query"].get("parameters") or []
            if isinstance(p, dict) and isinstance(p.get("keyword"), str)
        }
    return out


def _parameter_refs(document: _Document) -> list[str]:
    """Layer-4 parameter resolution: every keyword a widget query binds must be
    declared on THAT query's dataset (AI/BI resolves a parameter per dataset,
    so a keyword bound against the wrong dataset is a control wired to nothing),
    and a parameter widget's `widgetType` must be the one the pinned form ->
    widget table gives for the parameter's own form."""
    errors: list[str] = []
    pins = parameter_types()
    declared: dict[str, dict[str, dict[str, Any]]] = {}
    for dataset in document.datasets:
        name = dataset.get("name")
        if not isinstance(name, str):
            continue
        declared[name] = {
            str(p["keyword"]): p
            for p in dataset.get("parameters") or []
            if isinstance(p, dict) and isinstance(p.get("keyword"), str)
        }

    for where, widget in document.widgets():
        widget_type = str((widget.get("spec") or {}).get("widgetType", ""))
        for entry in widget.get("queries") or []:
            if not _is_parameter_query(entry):
                continue
            query = entry["query"]
            dataset_name = str(query.get("datasetName"))
            if dataset_name not in declared:
                errors.append(
                    f"{where}: parameter query {entry.get('name')!r} names dataset "
                    f"{dataset_name!r}, which is not a declared dataset"
                )
                continue
            for parameter in query.get("parameters") or []:
                if not isinstance(parameter, dict):
                    continue
                keyword = parameter.get("keyword")
                pinned = declared[dataset_name].get(str(keyword))
                if pinned is None:
                    errors.append(
                        f"{where}: query {entry.get('name')!r} binds parameter "
                        f"{keyword!r}, which dataset {dataset_name!r} does not "
                        f"declare (declared: {sorted(declared[dataset_name])}) — the "
                        "dataset's query would fail at load"
                    )
                    continue
                form = parameter_form(
                    str(pinned.get("dataType")), pinned.get("complexType")
                )
                expected = pins["filterWidgets"].get(form)
                if expected is None:
                    errors.append(
                        f"{where}: parameter {keyword!r} has form {form!r}, which no "
                        "pinned filter widget binds — declare it on the dataset only"
                    )
                elif widget_type != expected:
                    errors.append(
                        f"{where}: parameter {keyword!r} ({form}) is bound through a "
                        f"{widget_type!r} widget; the pinned widget for that form is "
                        f"{expected!r}"
                    )
    return errors


def _binding_entries(binding: Any) -> list[dict[str, Any]]:
    """Encoding bindings come in three pinned shapes: a single object, a list of
    objects (columns/rows/fields), and combo's primary/secondary series holder."""
    if isinstance(binding, list):
        return [entry for entry in binding if isinstance(entry, dict)]
    if not isinstance(binding, dict):
        return []
    if "fieldName" in binding:
        return [binding]
    out: list[dict[str, Any]] = []
    for series in ("primary", "secondary"):
        holder = binding.get(series)
        if isinstance(holder, dict):
            out += [f for f in holder.get("fields") or [] if isinstance(f, dict)]
    return out


# ---------------------------------------------------------------- entry point


def validate_lakeview_artifact(
    spec_dict: dict[str, Any],
    lvdash_text: str,
) -> tuple[ValidationReport, list[str]]:
    """Run the layered validation pipeline over a compiled `.lvdash.json`.

    Returns (report, warnings). Warnings never flip `report.passed` — see the
    module docstring for why they travel beside the report rather than in it.
    """
    layers: list[LayerResult] = []
    warnings: list[str] = []

    try:
        doc = json.loads(lvdash_text)
    except json.JSONDecodeError as exc:
        layers.append(
            LayerResult(1, "json-structure", False, [f"artifact is not valid JSON: {exc}"])
        )
        return ValidationReport(layers=layers, xsd_version=LAKEVIEW_FORMAT_VERSION), warnings
    if not isinstance(doc, dict):
        layers.append(
            LayerResult(1, "json-structure", False, ["artifact must be a JSON object"])
        )
        return ValidationReport(layers=layers, xsd_version=LAKEVIEW_FORMAT_VERSION), warnings

    structure_errors = _check_structure(doc)
    layers.append(LayerResult(1, "json-structure", not structure_errors, structure_errors))
    if structure_errors:
        # Nothing coherent left to lint, parse, or cross-reference.
        return ValidationReport(layers=layers, xsd_version=LAKEVIEW_FORMAT_VERSION), warnings

    document = _Document(doc)

    lint_errors, lint_warnings = _lint_widgets(document)
    warnings += lint_warnings
    layers.append(LayerResult(2, "widget-lint", not lint_errors, lint_errors))

    sql_errors, sql_warnings = _sql_errors(document, spec_dict)
    warnings += sql_warnings
    layers.append(LayerResult(3, "sql-parse", not sql_errors, sql_errors))

    ref_errors, ref_warnings = _cross_refs(document)
    warnings += ref_warnings
    layers.append(LayerResult(4, "cross-refs", not ref_errors, ref_errors))

    return ValidationReport(layers=layers, xsd_version=LAKEVIEW_FORMAT_VERSION), warnings
