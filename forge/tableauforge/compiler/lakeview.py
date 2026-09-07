"""Deterministic DashboardSpec -> Databricks AI/BI (Lakeview) `.lvdash.json` compiler.

Cardinal rule (GOAL §3.1) unchanged: no LLM *creativity* enters this module — it
renders the validated DashboardSpec only, exactly like compiler/twb.py and
compiler/pbit.py. The authored SQL (a calculated field's ``formula``) is spec
data, not free-form output: it is placed verbatim, never rewritten, and
validate/lakeview.py parses every one of them with sqlglot.

Determinism: same spec in, byte-identical JSON out. Ids are the first 8 lowercase
hex characters of ``sha1(workbook name + '::' + logical name)`` — the identical
scheme the server's TypeScript emitter uses (server/src/migration/bi/
lakeview-emit.ts::lakeviewId), so both lanes produce stable, diffable documents.

Structural family (shared with that TypeScript emitter, and the reason the two
stay interchangeable downstream):

- the document is ``{"datasets": [...], "pages": [...]}``;
- a dataset is ``{name, displayName, query}`` with ``query`` a plain SQL string
  (never the ``queryLines`` array form — the corpus's verified shape is the
  string), plus ``parameters`` when the datasource declares any;
- a dashboard parameter rides its DATASET (the SELECT reads it as ``:keyword``)
  and is driven by a ``filter-*`` widget whose queries are one per dataset —
  the shape ``spec/lakeview_parameter_types.json`` pins and
  lakeview-emit.ts::buildParameterFilterWidget emits in the other lane;
- a page is ``PAGE_TYPE_CANVAS`` with a ``layout`` of ``{widget, position}``
  entries on a 12-column integer grid;
- a widget carries exactly one query named ``main_query`` whose ``fields`` are
  ``{name, expression}`` pairs, plus a ``spec`` whose ``version`` and legal
  ``encodings`` channels come from the pinned widget table
  (``spec/lakeview_widget_types.json``, mirrored from the canonical TypeScript
  table and kept in lockstep by a server unit test);
- no ``uiSettings`` — the ``genieSpace`` shape is unverified in the Phase-0
  corpus, so the emitter never invents it.

Two-tier expression model, which is what makes an AI/BI dashboard work at all:
a dataset SELECT is row-level (raw columns plus row-level SQL calculated
columns), while aggregation happens in the WIDGET's field expressions
(``SUM(`Sales`)``). An aggregate calculated field is therefore a widget
expression, never a dataset projection — ``SUM(...)`` in an ungrouped SELECT
would not even parse.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from tableauforge.compiler.twb import CompileError, UnsupportedFeatureError
from tableauforge.spec.models import (
    CalculatedField,
    Chart,
    Dashboard,
    DashboardParameter,
    DashboardSpec,
    Datasource,
    Field,
    FieldRef,
    Filter,
    Worksheet,
    Zone,
)

__all__ = [
    "CompileError",
    "UnsupportedFeatureError",
    "FILTER_WIDGET_FOR_DATATYPE",
    "GRID_COLUMNS",
    "LakeviewPart",
    "MAIN_QUERY",
    "MAX_DATASETS",
    "MAX_PAGES",
    "MAX_WIDGETS_PER_PAGE",
    "PAGE_TYPE_CANVAS",
    "WIDGET_TYPE_FOR_CHART",
    "compile_caveats",
    "compile_lakeview",
    "compile_lakeview_parts",
    "compile_notes",
    "compile_warnings",
    "lakeview_id",
    "parameter_form",
    "parameter_query_name",
    "parameter_types",
    "part_title",
    "widget_types",
]

#: The single `queries[].name` this emitter uses (corpus convention, and the
#: name filter widgets' `fields[].queryName` entries reference).
MAIN_QUERY = "main_query"
#: The corpus's content-page type. A `PAGE_TYPE_GLOBAL_FILTERS` page is never emitted.
PAGE_TYPE_CANVAS = "PAGE_TYPE_CANVAS"

#: Lakeview's grid is 12 columns wide (expanded from 6 in Feb 2026).
GRID_COLUMNS = 12
#: Grid rows are much finer than columns: a full-height zone is 12 x ROW_SCALE rows.
_ROW_SCALE = 4
_MIN_HEIGHT = 4
#: A page holding a single widget gives it the whole canvas.
_FULL_HEIGHT = GRID_COLUMNS * _ROW_SCALE

#: Compile-time caps (plan 2026-08-10 global constraints). Exceeding one is
#: never a truncation: silently dropping a page or a dataset would ship a
#: dashboard missing content nobody was told about. A report too big for ONE
#: dashboard is split across several instead (compile_lakeview_parts) — the page
#: and dataset caps bound a document, not a report. MAX_WIDGETS_PER_PAGE is the
#: one cap a split cannot relieve (a widget belongs to its dashboard's page), so
#: exceeding it stays an error.
MAX_PAGES = 15
MAX_WIDGETS_PER_PAGE = 100
MAX_DATASETS = 100

#: How many pages early a part may close when the next page shares no dataset
#: with it. Splitting on a datasource seam keeps a part's pages about one body of
#: data — the "logical" in a logical split — at the cost of slightly uneven parts.
_SEAM_SLACK = 2

#: spec chart type -> pinned Lakeview `widgetType`. Every value must exist in the
#: pinned table; an unmapped chart type is an error, never a silent degrade to
#: `table` (the migration pack's emitter degrades because it reads uncontrolled
#: catalog marks — here the chart type came from a schema-validated spec).
WIDGET_TYPE_FOR_CHART: dict[str, str] = {
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

#: Channels whose pinned shape is a LIST of field entries rather than a single
#: binding (`table`/`pivot` columns+rows, the filter widgets' fields) — corpus-derived.
_ARRAY_CHANNELS = frozenset({"columns", "fields", "rows"})

#: forge aggregation -> Databricks SQL. Every entry in the spec's Aggregation
#: vocabulary maps to a real Databricks aggregate function — `median` included
#: (Databricks SQL has a native `MEDIAN`), so nothing in the vocabulary is
#: silently approximated here.
_AGG_SQL: dict[str, str] = {
    "sum": "SUM({})",
    "avg": "AVG({})",
    "min": "MIN({})",
    "max": "MAX({})",
    "count": "COUNT({})",
    "countd": "COUNT(DISTINCT {})",
    "median": "MEDIAN({})",
}

#: Databricks' default schema when a connection block carries none (mirrors
#: compiler/pbit.py's _DEFAULT_SCHEMA entry for the same dialect).
_DEFAULT_SCHEMA = "default"

_WIDGET_TYPES_PATH = Path(__file__).resolve().parents[1] / "spec" / "lakeview_widget_types.json"
_PARAMETER_TYPES_PATH = (
    Path(__file__).resolve().parents[1] / "spec" / "lakeview_parameter_types.json"
)


@lru_cache(maxsize=1)
def widget_types() -> dict[str, dict[str, Any]]:
    """The pinned `widgetType` -> {specVersion, encodings, verified} table.

    Hand-mirrored from the canonical TypeScript table
    (server/src/migration/bi/lakeview-format.ts); the two are deep-equal-checked
    by server/test/unit/lakeview-format-mirror.test.ts, so this file is never a
    second source of truth, only a second reader.
    """
    return json.loads(_WIDGET_TYPES_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def parameter_types() -> dict[str, Any]:
    """The pinned dataset-parameter table: ``{dataTypes, complexTypes,
    filterWidgets}``.

    Hand-mirrored from the canonical TypeScript pins
    (server/src/migration/bi/lakeview-format.ts:
    LAKEVIEW_PARAMETER_DATA_TYPES / _COMPLEX_TYPES / _FILTER_WIDGETS), the same
    way widget_types() mirrors the widget table — and deep-equal-checked by the
    same server test (server/test/unit/lakeview-format-mirror.test.ts), so this
    file is a second reader, never a second source of truth.
    """
    return json.loads(_PARAMETER_TYPES_PATH.read_text(encoding="utf-8"))


def parameter_form(data_type: str, complex_type: str | None = None) -> str:
    """``dataType`` or ``dataType:complexType`` — the key of the pinned
    form -> filter-widget table (mirrors lakeview-format.ts's
    ``lakeviewParameterForm``)."""
    return f"{data_type}:{complex_type}" if complex_type else data_type


def parameter_query_name(dataset_name: str, keyword: str) -> str:
    """The corpus's parameter-query naming — one query per dataset a parameter
    widget drives (mirrors lakeview-emit.ts's ``parameterQueryName``)."""
    return f"parameter_{dataset_name}_{keyword}"


def lakeview_id(slug: str, logical_name: str) -> str:
    """Deterministic Databricks-style id: 8 lowercase hex characters.

    Byte-identical to the TypeScript emitter's `lakeviewId` — sha1 over
    ``f"{slug}::{logical_name}"``, sliced to 8 hex characters. The separator must
    stay printable ASCII: a control byte would make both modules binary to git.
    """
    digest = hashlib.sha1(f"{slug}::{logical_name}".encode("utf-8")).hexdigest()
    return digest[:8]


def _backtick(ident: str) -> str:
    return "`" + ident.replace("`", "``") + "`"


# ------------------------------------------------------------------- gates


def _used_datasources(spec: DashboardSpec) -> list[Datasource]:
    """Only worksheet-bound datasources become datasets: an unread dataset still
    runs its query against the warehouse on every dashboard open (the same orphan
    lesson compile_twb/compile_pbit carry)."""
    used = {ws.datasource for ws in spec.worksheets}
    return [ds for ds in spec.datasources if ds.id in used]


def _gate_datasource_kind(ds: Datasource) -> None:
    if ds.kind != "live_database":
        raise CompileError(
            f"datasource {ds.id!r}: kind {ds.kind!r} is not supported by the "
            "databricks target — an AI/BI dataset is a live-database SELECT"
        )


def _gate_formula_language(ds: Datasource) -> None:
    for calc in ds.calculated_fields:
        if calc.formula_language != "sql":
            raise CompileError(
                f"datasource {ds.id!r}: calculated field {calc.name!r} is "
                f"formula_language {calc.formula_language!r}; compile_lakeview "
                "accepts sql only — use the tableau or power_bi target instead"
            )


def _table_fqn(ds: Datasource) -> str:
    """The dataset's three-part backticked Unity Catalog name."""
    db = ds.database
    assert db is not None  # _gate_datasource_kind ran first
    schema = db.db_schema or _DEFAULT_SCHEMA
    return f"{_backtick(db.database)}.{_backtick(schema)}.{_backtick(db.table)}"


# ---------------------------------------------------------------- datasets


def _dataset_query(ds: Datasource) -> str:
    """Row-level SELECT: every raw column plus every row-level (dimension) SQL
    calculated field as an aliased expression. Aggregate calculated fields are
    deliberately absent — they are widget expressions (see the module docstring)."""
    projections = [f"  {_backtick(f.name)}" for f in ds.fields]
    projections += [
        f"  {calc.formula} AS {_backtick(calc.name)}"
        for calc in ds.calculated_fields
        if calc.role != "measure"
    ]
    if not projections:
        projections = ["  *"]
    return "SELECT\n" + ",\n".join(projections) + f"\nFROM {_table_fqn(ds)}"


# ------------------------------------------------------ dataset parameters

#: A quoted SQL run — single-quoted literal or backticked identifier. Stripped
#: before hunting for `:keyword` references so `'12:30'` and `` `Ratio:Net` ``
#: are never read as parameters.
_SQL_QUOTED_RE = re.compile(r"'(?:[^']|'')*'|`(?:[^`]|``)*`")
#: A `:keyword` parameter reference. The lookbehind keeps `a:b` and the second
#: colon of a `::` cast out, and the name shape is the spec's own parameter id.
_PARAM_REF_RE = re.compile(r"(?<![:\w]):([a-z][a-z0-9_]*)")


def _parameter_refs(sql: str) -> list[str]:
    """Every `:keyword` the SQL reads, first-seen order."""
    return list(dict.fromkeys(_PARAM_REF_RE.findall(_SQL_QUOTED_RE.sub(" ", sql))))


def _parameter_data_type(param: DashboardParameter) -> str:
    """The spec datatype as its pinned Lakeview ``dataType``.

    An uppercase of the spec vocabulary — which is why that vocabulary says
    `decimal`, not the spec-wide `real`. A value the pinned table does not carry
    is a compile error, never an invented dataType.
    """
    data_type = param.datatype.upper()
    if data_type not in parameter_types()["dataTypes"]:
        raise CompileError(
            f"parameter {param.name!r}: datatype {param.datatype!r} has no pinned "
            f"Lakeview dataType (pinned: {parameter_types()['dataTypes']})"
        )
    return data_type


def _parameter_json(param: DashboardParameter) -> dict[str, Any]:
    """One `datasets[].parameters[]` entry, in the corpus's key order.

    Single-value only: `complexType` is absent and the default rides the
    `values` selection shape (the `range` shape is the RANGE form's, which the
    authored lane never emits — see spec/models.py::DashboardParameter).
    """
    data_type = _parameter_data_type(param)
    return {
        "displayName": param.display_name or param.name,
        "keyword": param.name,
        "dataType": data_type,
        "defaultSelection": {
            "values": {"dataType": data_type, "values": [{"value": param.default}]}
        },
    }


def _gate_parameter_refs(ds: Datasource) -> None:
    """A dataset SELECT may only read `:keyword`s its OWN dataset declares.

    An undeclared reference is not a cosmetic problem: AI/BI resolves a
    parameter per dataset, so the query fails at load with no parameter of that
    name — and the dashboard imports looking complete.
    """
    declared = {p.name for p in ds.parameters}
    for name in _parameter_refs(_dataset_query(ds)):
        if name not in declared:
            raise CompileError(
                f"datasource {ds.id!r}: dataset SQL references parameter :{name}, "
                f"which is not declared on that datasource (declared: "
                f"{sorted(declared)}) — an AI/BI parameter is resolved per dataset"
            )
    for calc in ds.calculated_fields:
        if calc.role != "measure":
            continue
        refs = _parameter_refs(calc.formula)
        if refs:
            raise CompileError(
                f"datasource {ds.id!r}: aggregate calculated field {calc.name!r} "
                f"reads parameter(s) {refs} — an aggregate is a WIDGET expression "
                "and only a dataset query binds parameters; move the reference into "
                "a row-level (dimension) calculated field"
            )


def _unread_parameters(ds: Datasource) -> list[str]:
    """Parameters this datasource declares that its own dataset SQL never reads.

    Not an error — the declaration is legal and the control renders — but the
    control changes nothing, which is exactly the sort of live-looking-but-inert
    thing this target's caveats exist to say out loud.
    """
    read = set(_parameter_refs(_dataset_query(ds)))
    return [p.name for p in ds.parameters if p.name not in read]


def _datasets(spec: DashboardSpec, used: list[Datasource]) -> list[dict[str, Any]]:
    # No cap check here: the cap bounds a DOCUMENT, and a spec may legitimately
    # bind more datasources than one document may hold (compile_lakeview_parts
    # gives each part only the datasets its own pages query). The entry points
    # enforce it per emitted document.
    slug = spec.workbook.name
    out: list[dict[str, Any]] = []
    # A brief can legitimately carry two datasources with the SAME name (an
    # embedded 'Orders' and a published 'Orders'), and duplicate dataset
    # displayNames are fatal to the validator — so the whole build died on a
    # collision the compiler can simply disambiguate. First one keeps the plain
    # name (nothing about a collision-free build's bytes moves); later ones
    # carry the datasource id that actually tells them apart.
    seen_names: set[str] = set()
    for ds in used:
        display_name = ds.name if ds.name not in seen_names else f"{ds.name} ({ds.id})"
        seen_names.add(display_name)
        seen_names.add(ds.name)
        dataset: dict[str, Any] = {
            "name": lakeview_id(slug, f"dataset:{ds.id}"),
            "displayName": display_name,
            "query": _dataset_query(ds),
        }
        # Parameters ride the DATASET, not the dashboard: the key is omitted
        # entirely when the datasource declares none, so nothing about a
        # parameter-free build's bytes moves.
        if ds.parameters:
            dataset["parameters"] = [_parameter_json(p) for p in ds.parameters]
        out.append(dataset)
    return out


# ----------------------------------------------------------- query fields


class _QueryField:
    """One `queries[].query.fields[]` entry: the widget-side handle, its SQL
    expression over the dataset, and the scale type its encodings declare."""

    def __init__(self, name: str, expression: str, scale_type: str, is_measure: bool):
        self.name = name
        self.expression = expression
        self.scale_type = scale_type
        self.is_measure = is_measure


_SCALE_FOR_DATATYPE = {"date": "temporal", "datetime": "temporal"}


def _resolve(ref: FieldRef, ds: Datasource, ws_title: str) -> _QueryField:
    """A spec FieldRef -> its widget query field.

    Aggregation lives here, not in the dataset: a measure reference becomes
    ``SUM(`Sales`)``; a dimension reference is the bare backticked column (or the
    row-level calculated column's alias, which the dataset already projects).
    """
    field: Field | CalculatedField | None = ds.field_map().get(ref.field)
    if field is None:
        raise CompileError(
            f"worksheet {ws_title!r} references field {ref.field!r} not present "
            f"in datasource {ds.id!r}"
        )
    if ref.date_part is not None:
        # Tableau's shelf-level date grouping has no Lakeview encoding equivalent;
        # a translated ref would silently plot the raw date.
        raise UnsupportedFeatureError(
            f"date_part {ref.date_part!r} on {ref.field!r} is not supported for "
            "the databricks target — declare a SQL calculated column (e.g. "
            "DATE_TRUNC('MONTH', `Order Date`)) and reference it instead"
        )
    is_calc = isinstance(field, CalculatedField)
    if is_calc and field.role == "measure":
        # An aggregate SQL measure carries its own aggregation — never re-wrap it.
        return _QueryField(field.name, field.formula, "quantitative", True)

    source = _backtick(field.name)
    agg = ref.aggregation or (
        getattr(field, "default_aggregation", None) if field.role == "measure" else None
    )
    if agg in (None, "none"):
        scale = "quantitative" if field.role == "measure" else _SCALE_FOR_DATATYPE.get(
            field.datatype, "categorical"
        )
        return _QueryField(field.name, source, scale, field.role == "measure")
    template = _AGG_SQL.get(agg)
    if template is None:
        raise UnsupportedFeatureError(
            f"aggregation {agg!r} on {ref.field!r} is not supported by the "
            "databricks target"
        )
    return _QueryField(f"{agg}({field.name})", template.format(source), "quantitative", True)


# ------------------------------------------------------------------ widgets


class _WidgetPlan:
    """A worksheet resolved to widgetType + query fields + encoding channels."""

    def __init__(self, ws: Worksheet, spec: DashboardSpec):
        self.title = ws.title
        self.ds = spec.datasource_by_id(ws.datasource)
        chart = ws.chart
        widget_type = WIDGET_TYPE_FOR_CHART.get(chart.type)
        if widget_type is None:
            raise UnsupportedFeatureError(
                f"chart type {chart.type!r} is not supported by the databricks target"
            )
        info = widget_types().get(widget_type)
        if info is None:
            raise CompileError(
                f"widget type {widget_type!r} is not in the pinned Lakeview format "
                "table — the chart map and spec/lakeview_widget_types.json disagree"
            )
        self.widget_type = widget_type
        self.spec_version = int(info["specVersion"])
        self.allowed: set[str] = set(info["encodings"])
        self.verified = bool(info["verified"])
        self.fields: list[_QueryField] = []
        self._by_name: dict[str, _QueryField] = {}
        self._resolved: dict[int, _QueryField] = {}
        self._offered: set[int] = set()
        self.encodings: dict[str, Any] = {}
        self.notes: list[str] = []
        self.disaggregated = False
        self._plan(chart)
        self._note_unplaced(chart)

    # -- field/channel plumbing ------------------------------------------------

    def _field(self, ref: FieldRef) -> _QueryField:
        """Resolve a ref WITHOUT projecting it. Shelf classification ("is this a
        measure?") must never add a query field on its own: an expression no
        encoding references is dead weight the warehouse still computes on every
        widget refresh."""
        resolved = self._resolved.get(id(ref))
        if resolved is None:
            resolved = _resolve(ref, self.ds, self.title)
            self._resolved[id(ref)] = resolved
        return resolved

    def _project(self, field: _QueryField) -> None:
        """Add a resolved field to the widget's query, once per output name — a
        field bound to two channels rides one query field."""
        if field.name not in self._by_name:
            self._by_name[field.name] = field
            self.fields.append(field)

    def _note_unplaced(self, chart: Chart) -> None:
        """Shelf entries this widget type had no home for at all. `_bind` reports
        the ones it was offered and dropped; these were never offered, and would
        otherwise vanish silently."""
        for ref in chart.all_field_refs():
            if id(ref) in self._offered:
                continue
            self.notes.append(
                f"worksheet {self.title!r}: field {ref.field!r} has no pinned channel "
                f"on widget type {self.widget_type!r} — dropped; re-apply it in the "
                "AI/BI editor"
            )

    def _bind(self, channel: str, ref: FieldRef | None, series: str = "primary") -> None:
        """Bind one field to one pinned channel. A channel the pinned table does
        not list for this widget type is reported and dropped, never guessed onto
        the wire (mirrors the TypeScript emitter's rule).

        ``series`` only matters for combo's `y` holder, whose corpus shape carries
        a `primary` AND a `secondary` field list (jobs-system-tables.lvdash.json)
        — that is what carries a Tableau dual axis across without collapsing the
        second measure onto the first axis.
        """
        if ref is None:
            return
        self._offered.add(id(ref))
        field = self._field(ref)
        if channel not in self.allowed:
            self.notes.append(
                f"worksheet {self.title!r}: encoding channel {channel!r} (field "
                f"{field.name!r}) is not a pinned channel for widget type "
                f"{self.widget_type!r} — dropped; re-add it in the AI/BI editor"
            )
            return
        entry = {"fieldName": field.name, "displayName": field.name}
        if self.widget_type == "combo" and channel == "y":
            # The corpus's combo `y` is a primary/secondary series holder, not a
            # single binding.
            holder = self.encodings.setdefault(
                "y", {"primary": {"fields": []}, "scale": {"type": "quantitative"}}
            )
            holder.setdefault(series, {"fields": []})["fields"].append(entry)
            self._project(field)
            return
        if channel in _ARRAY_CHANNELS:
            self.encodings.setdefault(channel, []).append(entry)
            self._project(field)
            return
        if channel in self.encodings:
            self.notes.append(
                f"worksheet {self.title!r}: encoding channel {channel!r} on widget "
                f"type {self.widget_type!r} takes one field — {field.name!r} was dropped"
            )
            return
        self._project(field)
        self.encodings[channel] = {
            "fieldName": field.name,
            "scale": {"type": field.scale_type},
        }

    # -- per-widget-type shelf mapping ----------------------------------------

    def _measures(self, chart: Chart) -> list[FieldRef]:
        return [r for r in chart.all_field_refs() if self._field(r).is_measure]

    def _dimensions(self, refs: list[FieldRef]) -> list[FieldRef]:
        return [r for r in refs if not self._field(r).is_measure]

    def _first(self, *candidates: list[FieldRef]) -> FieldRef | None:
        for group in candidates:
            if group:
                return group[0]
        return None

    def _plan(self, chart: Chart) -> None:
        wt = self.widget_type
        if wt == "table":
            refs = (
                list(chart.rows)
                + list(chart.cols)
                + ([chart.label] if chart.label else [])
                + chart.detail
                + chart.tooltip
            )
            for ref in refs:
                self._bind("columns", ref)
            # A table of pure dimensions shows rows; any aggregate makes it a summary.
            self.disaggregated = not any(f.is_measure for f in self.fields)
            return
        if wt == "counter":
            self._bind(
                "value",
                self._first(
                    [chart.label] if chart.label else [],
                    self._measures(chart),
                    list(chart.rows),
                    list(chart.cols),
                ),
            )
            return
        if wt == "pie":
            self._bind("angle", self._first(self._measures(chart)))
            self._bind("color", self._first(self._dimensions(chart.all_field_refs())))
            self._bind("label", chart.label if chart.label else None)
            return
        if wt == "pivot":
            for ref in self._dimensions(list(chart.rows)):
                self._bind("rows", ref)
            for ref in self._dimensions(list(chart.cols)):
                self._bind("columns", ref)
            self._bind("cell", self._first(self._measures(chart)))
            return
        if wt == "combo":
            self._bind(
                "x",
                self._first(self._dimensions(list(chart.cols)), list(chart.cols), list(chart.rows)),
            )
            for ref in chart.rows:
                if self._field(ref).is_measure:
                    self._bind("y", ref)
            # Dual axis: the second axis's measures are their own series on the
            # corpus-pinned `y.secondary` holder, never folded onto `y.primary`.
            for ref in chart.secondary_rows:
                if self._field(ref).is_measure:
                    self._bind("y", ref, series="secondary")
            return
        # bar / line / area / scatter / heatmap: an x/y pair plus the optional
        # color and label channels the pinned table allows for that type.
        self._bind(
            "x", self._first(self._dimensions(list(chart.cols)), list(chart.cols), list(chart.rows))
        )
        self._bind(
            "y",
            self._first(
                [r for r in chart.rows if self._field(r).is_measure],
                list(chart.rows),
                self._measures(chart),
            ),
        )
        if chart.color is not None:
            self._bind("color", chart.color)
        if chart.label is not None:
            self._bind("label", chart.label)

    # -- emitted JSON ----------------------------------------------------------

    def widget(self, slug: str, logical_name: str, dataset_name: str) -> dict[str, Any]:
        spec: dict[str, Any] = {
            "version": self.spec_version,
            "widgetType": self.widget_type,
            "encodings": self.encodings,
            "frame": {"showTitle": True, "title": self.title},
        }
        return {
            "name": lakeview_id(slug, logical_name),
            "queries": [
                {
                    "name": MAIN_QUERY,
                    "query": {
                        "datasetName": dataset_name,
                        "fields": [
                            {"name": f.name, "expression": f.expression} for f in self.fields
                        ],
                        "disaggregated": self.disaggregated,
                    },
                }
            ],
            "spec": spec,
        }


# ------------------------------------------------------------------- layout


def _scale_zone(zone: Zone) -> dict[str, int]:
    """A 0-100 percentage zone -> integer 12-column grid position.

    Columns snap CUMULATIVELY: both edges are rounded onto the 12-column grid and
    the width is their difference. Rounding each zone's x and w independently (the
    obvious way, and what this did before) stacks the error — a 0/30/60 row of
    30%-wide zones became three 4-wide widgets ending at 4/8/12 and overlapping,
    so `_place` shoved the second and third onto their own rows. Snapping the
    edges tiles them 0-4, 4-7, 7-11 instead: adjacent zones share a boundary and
    the row survives the trip to the grid.

    Rows snap CUMULATIVELY too, and on the ROW grid. Rows are 4x finer than
    columns (Lakeview's grid), but y and h used to be rounded against the 12
    COLUMN grid and only then multiplied by the row scale — which threw away
    three quarters of the vertical resolution (every height a multiple of 4
    rows) and stacked the same rounding error the columns had, so a tidy
    0/30/60 column of 30%-tall zones came out overlapping and `_place` shoved
    the later ones down the canvas for no reason. Height floors at 4.
    """
    x1 = min(max(0, round(zone.x / 100 * GRID_COLUMNS)), GRID_COLUMNS - 1)
    x2 = min(GRID_COLUMNS, max(x1 + 1, round((zone.x + zone.w) / 100 * GRID_COLUMNS)))
    y1 = max(0, round(zone.y / 100 * GRID_COLUMNS * _ROW_SCALE))
    y2 = max(
        y1 + _MIN_HEIGHT,
        round((zone.y + zone.h) / 100 * GRID_COLUMNS * _ROW_SCALE),
    )
    return {"x": x1, "y": y1, "width": x2 - x1, "height": y2 - y1}


def _overlaps(a: dict[str, int], b: dict[str, int]) -> bool:
    return (
        a["x"] < b["x"] + b["width"]
        and b["x"] < a["x"] + a["width"]
        and a["y"] < b["y"] + b["height"]
        and b["y"] < a["y"] + a["height"]
    )


def _place(
    positions: list[dict[str, int]], labels: list[str] | None = None
) -> tuple[list[dict[str, int]], list[str]]:
    """Resolve overlaps by pushing the later widget below whatever it collides
    with, in reading order (top-left first, then input order). Terminates: each
    pass can only move a widget further down.

    Returns (positions, notes). A widget the placer had to move no longer sits
    where the authored (or observed) layout put it, so it says so — informational,
    not review-worthy: the dashboard is complete, just re-flowed.
    """
    notes: list[str] = []
    order = sorted(
        range(len(positions)),
        key=lambda i: (positions[i]["y"], positions[i]["x"], i),
    )
    placed: list[dict[str, int]] = []
    for index in order:
        pos = positions[index]
        before = pos["y"]
        while True:
            hits = [p for p in placed if _overlaps(pos, p)]
            if not hits:
                break
            pos["y"] = max(p["y"] + p["height"] for p in hits)
        if pos["y"] != before and labels is not None:
            notes.append(
                f"{labels[index]!r} overlapped an earlier widget and was moved down the "
                f"canvas (grid row {before} -> {pos['y']}) — the layout was re-flowed, "
                "nothing was dropped"
            )
        placed.append(pos)
    # Every page starts at the top of its own canvas.
    if positions:
        shift = min(p["y"] for p in positions)
        for pos in positions:
            pos["y"] -= shift
    return positions, notes


# ------------------------------------------------------------ filter widgets

#: A filter widget's slot on the canvas: AI/BI filters ride a top row of the page
#: (identical geometry to the deterministic lane's `rebuild-databricks.ts`, so
#: both lanes' dashboards read the same).
_FILTER_WIDTH = 3
_FILTER_HEIGHT = 4
_FILTERS_PER_ROW = 4

#: spec Filter -> pinned Lakeview filter `widgetType`. A categorical filter is a
#: multi-select (the corpus's commonest filter, 13 instances); a range filter's
#: widget depends on what it ranges OVER — numbers get the slider, dates get the
#: date-range picker. Nothing else has a verified shape, so nothing else is emitted.
FILTER_WIDGET_FOR_DATATYPE: dict[str, str] = {
    "integer": "range-slider",
    "real": "range-slider",
    "date": "filter-date-range-picker",
    "datetime": "filter-date-range-picker",
}


@dataclass(frozen=True)
class _FilterPlan:
    """One resolved filter widget: which dataset it queries, which column, and
    which pinned filter widget type renders it."""

    ds_id: str
    widget_type: str
    field_name: str
    expression: str
    title: str

    @property
    def key(self) -> tuple[str, str]:
        return (self.ds_id, self.field_name)


def _resolve_filter(
    filt: Filter,
    candidates: list[Datasource],
    where: str,
    warnings: list[str],
    notes: list[str],
) -> _FilterPlan | None:
    """A spec Filter -> its filter widget plan, or None with a WARNING saying why
    it could not be emitted (a filter that vanishes silently is a wrong dashboard).

    Emitting one is itself a NOTE: the widget carries the field, never the source
    selection — AI/BI filter widgets have no verified default-selection shape this
    emitter would be entitled to invent, so the dashboard opens unfiltered.
    """
    if filt.filter_type == "relative_date":
        # A non-emittable filter, exactly like the aggregate and non-numeric-range
        # cases below — NOT a reason to throw away a whole authored build after
        # the fact. (It used to raise, and compile_caveats swallows the exception,
        # so the raise also hid every other caveat this dashboard had.)
        warnings.append(
            f"{where}: relative_date filter on {filt.field!r} was not emitted — "
            "the databricks target has no relative-date filter widget; express the "
            "window as a row-level SQL calculated column (e.g. `Order Date` >= "
            "DATE_SUB(CURRENT_DATE(), 90)) and filter on that instead"
        )
        return None
    for ds in candidates:
        field = ds.field_map().get(filt.field)
        if field is None:
            continue
        if isinstance(field, CalculatedField) and field.role == "measure":
            warnings.append(
                f"{where}: filter on aggregate calculated field {filt.field!r} was not "
                "emitted — an AI/BI filter widget filters a dataset column, and an "
                "aggregate is a widget expression; fold the restriction into the dataset SQL"
            )
            return None
        if filt.filter_type == "categorical":
            widget_type = "filter-multi-select"
        else:
            widget_type = FILTER_WIDGET_FOR_DATATYPE.get(field.datatype, "")
            if not widget_type:
                warnings.append(
                    f"{where}: range filter on {filt.field!r} ({field.datatype}) was not "
                    "emitted — AI/BI's range widgets need a numeric or date column; "
                    "re-express it as a categorical filter or fold it into the dataset SQL"
                )
                return None
        notes.append(
            f"{where}: filter on {filt.field!r} was emitted as an AI/BI "
            f"{widget_type!r} widget; the original selection was not carried, so the "
            "dashboard opens unfiltered"
        )
        return _FilterPlan(
            ds_id=ds.id,
            widget_type=widget_type,
            field_name=field.name,
            expression=_backtick(field.name),
            title=filt.field,
        )
    warnings.append(
        f"{where}: filter field {filt.field!r} is not a field of any datasource this "
        "page queries — no filter widget was emitted"
    )
    return None


def _filter_plans_for(
    dash: Dashboard | None,
    worksheets: list[Worksheet],
    spec: DashboardSpec,
    warnings: list[str],
    notes: list[str],
) -> list[_FilterPlan]:
    """Every filter widget one page carries: the dashboard's shared filters (all
    of them — a shared filter IS a dashboard control) followed by each placed
    worksheet's `show_quick_filter` filters, deduplicated per (dataset, column).

    A worksheet filter WITHOUT show_quick_filter is a sheet-level value
    restriction with no on-canvas control; it is not emitted, and that is a
    warning — the numbers on the rebuilt widget are unrestricted.
    """
    plans: list[_FilterPlan] = []
    seen: set[tuple[str, str]] = set()
    ds_by_ws = {ws.id: spec.datasource_by_id(ws.datasource) for ws in worksheets}
    page_datasources: list[Datasource] = []
    for ws in worksheets:
        ds = ds_by_ws[ws.id]
        if ds not in page_datasources:
            page_datasources.append(ds)

    def add(plan: _FilterPlan | None) -> None:
        if plan is not None and plan.key not in seen:
            seen.add(plan.key)
            plans.append(plan)

    if dash is not None:
        for filt in dash.shared_filters:
            add(
                _resolve_filter(
                    filt, page_datasources, f"dashboard {dash.title!r}", warnings, notes
                )
            )
    for ws in worksheets:
        for filt in ws.filters:
            where = f"worksheet {ws.title!r}"
            if not filt.show_quick_filter:
                warnings.append(
                    f"{where}: filter on {filt.field!r} has no quick filter, so it was "
                    "not emitted as an AI/BI widget and its value restriction was not "
                    "carried — fold it into the dataset SQL if the numbers depend on it"
                )
                continue
            add(_resolve_filter(filt, [ds_by_ws[ws.id]], where, warnings, notes))
    return plans


def _filter_widget(
    slug: str, logical_name: str, dataset_name: str, plan: _FilterPlan
) -> dict[str, Any]:
    """One filter widget, in the corpus's verified shape: a `fields` array whose
    entries carry `queryName` (the widget's own query name), and a query that
    projects the column being filtered.

    The corpus's real exports also carry a `<field>_associativity`
    `COUNT_IF(\\`associative_filter_predicate_group\\`)` field alongside; that column
    exists only inside AI/BI's own filter-association machinery, so — exactly as
    the TypeScript emitter does — this emitter omits it.
    """
    info = widget_types()[plan.widget_type]
    return {
        "name": lakeview_id(slug, logical_name),
        "queries": [
            {
                "name": MAIN_QUERY,
                "query": {
                    "datasetName": dataset_name,
                    "fields": [{"name": plan.field_name, "expression": plan.expression}],
                    "disaggregated": False,
                },
            }
        ],
        "spec": {
            "version": int(info["specVersion"]),
            "widgetType": plan.widget_type,
            "encodings": {
                "fields": [
                    {
                        "fieldName": plan.field_name,
                        "displayName": plan.field_name,
                        "queryName": MAIN_QUERY,
                    }
                ]
            },
            "frame": {"showTitle": True, "title": plan.title},
        },
    }


# --------------------------------------------------------- parameter widgets


@dataclass(frozen=True)
class _ParameterPlan:
    """One resolved dashboard parameter on one page: the keyword, the pinned
    filter widget that binds it (empty when the form has none), and every
    datasource of the page that declares it."""

    keyword: str
    title: str
    data_type: str
    widget_type: str
    ds_ids: tuple[str, ...]


def _parameter_plans(
    page_datasources: list[Datasource], where: str, notes: list[str]
) -> list[_ParameterPlan]:
    """Every parameter widget one page carries, in first-declared order.

    ONE widget per keyword, however many of the page's datasources declare it:
    a parameter widget's corpus shape is a per-dataset query list, so a keyword
    shared by three datasets is one control that drives all three — two widgets
    with the same keyword would be two controls that silently disagree.

    A keyword declared twice with DIFFERENT datatypes cannot be one control, and
    guessing which one wins would ship a dashboard whose control filters some of
    its datasets and not others — that is an error. A form with no pinned filter
    widget (plain DATETIME) still gets its dataset declaration; it just has no
    on-canvas control, and says so.
    """
    widgets: dict[str, str] = parameter_types()["filterWidgets"]
    order: list[str] = []
    by_keyword: dict[str, dict[str, Any]] = {}
    for ds in page_datasources:
        for param in ds.parameters:
            data_type = _parameter_data_type(param)
            seen = by_keyword.get(param.name)
            if seen is None:
                order.append(param.name)
                by_keyword[param.name] = {
                    "title": param.display_name or param.name,
                    "data_type": data_type,
                    "ds_ids": [ds.id],
                }
                continue
            if seen["data_type"] != data_type:
                raise CompileError(
                    f"{where}: parameter {param.name!r} is declared as "
                    f"{seen['data_type']} and as {data_type} on datasources this page "
                    "queries — one parameter control cannot bind two datatypes; "
                    "rename one of them"
                )
            seen["ds_ids"].append(ds.id)
    plans: list[_ParameterPlan] = []
    for keyword in order:
        entry = by_keyword[keyword]
        widget_type = widgets.get(parameter_form(entry["data_type"]), "")
        if not widget_type:
            notes.append(
                f"{where}: parameter {keyword!r} ({entry['data_type']}) is declared on "
                "its dataset(s) and defaults as authored, but no AI/BI filter widget "
                "is pinned for that form — the dashboard has no on-canvas control for "
                "it; add one in the AI/BI editor if readers must change it"
            )
        plans.append(
            _ParameterPlan(
                keyword=keyword,
                title=str(entry["title"]),
                data_type=str(entry["data_type"]),
                widget_type=widget_type,
                ds_ids=tuple(entry["ds_ids"]),
            )
        )
    return plans


def _parameter_widget(
    slug: str, logical_name: str, plan: _ParameterPlan, dataset_names: list[str]
) -> dict[str, Any]:
    """One parameter filter widget, in the corpus's verified shape: one query
    per dataset it drives (named `parameter_<datasetName>_<keyword>`, carrying
    `parameters: [{name, keyword}]` and NO `fields`), and an `encodings.fields`
    list of `{parameterName, queryName}` entries — byte-for-byte the shape
    lakeview-emit.ts::buildParameterFilterWidget emits in the other lane."""
    info = widget_types()[plan.widget_type]
    return {
        "name": lakeview_id(slug, logical_name),
        "queries": [
            {
                "name": parameter_query_name(dataset_name, plan.keyword),
                "query": {
                    "datasetName": dataset_name,
                    "parameters": [{"name": plan.keyword, "keyword": plan.keyword}],
                    "disaggregated": False,
                },
            }
            for dataset_name in dataset_names
        ],
        "spec": {
            "version": int(info["specVersion"]),
            "widgetType": plan.widget_type,
            "encodings": {
                "fields": [
                    {
                        "parameterName": plan.keyword,
                        "queryName": parameter_query_name(dataset_name, plan.keyword),
                    }
                    for dataset_name in dataset_names
                ]
            },
            "frame": {"showTitle": True, "title": plan.title},
        },
    }


def _positions(
    filter_count: int, zones: list[Zone], labels: list[str]
) -> tuple[list[dict[str, int]], list[str]]:
    """Grid positions for one page's widgets: the filter row(s) first (4 per row,
    3 columns wide, 4 rows tall), then the charts, shifted below them.

    ``filter_count`` counts EVERY top-row widget — the parameter controls first,
    then the field quick filters — because both share that row in the
    deterministic lane too."""
    filter_positions = [
        {
            "x": (i % _FILTERS_PER_ROW) * _FILTER_WIDTH,
            "y": (i // _FILTERS_PER_ROW) * _FILTER_HEIGHT,
            "width": _FILTER_WIDTH,
            "height": _FILTER_HEIGHT,
        }
        for i in range(filter_count)
    ]
    offset = -(-filter_count // _FILTERS_PER_ROW) * _FILTER_HEIGHT
    charts, notes = _place([_scale_zone(z) for z in zones], labels)
    for pos in charts:
        pos["y"] += offset
    return filter_positions + charts, notes


# -------------------------------------------------------------------- pages


@dataclass(frozen=True)
class LakeviewPart:
    """One compiled `.lvdash.json` document. A report that fits AI/BI's caps
    compiles to exactly one part; a bigger one compiles to several, each a
    complete, independently importable dashboard.

    ``index``/``total`` are 1-based and human-facing ("2 of 3"); ``title`` is the
    dashboard name (and the filename stem callers build on).
    """

    index: int
    total: int
    title: str
    text: str
    page_titles: tuple[str, ...]
    dataset_count: int

    @property
    def page_count(self) -> int:
        return len(self.page_titles)


@dataclass(frozen=True)
class _PageRecord:
    """One emitted page plus the dataset names its widgets query — the unit the
    partitioner moves between documents."""

    page: dict[str, Any]
    datasets: tuple[str, ...]

    @property
    def title(self) -> str:
        return str(self.page["displayName"])


def _page_records(spec: DashboardSpec, dataset_by_ds: dict[str, str]) -> list[_PageRecord]:
    slug = spec.workbook.name
    records: list[_PageRecord] = []
    on_dashboard: set[str] = set()

    for dash in spec.dashboards:
        placed: list[tuple[int, Zone, Worksheet]] = []
        for i, zone in enumerate(dash.zones):
            if zone.kind != "worksheet" or not zone.worksheet:
                continue  # text/blank zones: reported by compile_warnings
            ws = spec.worksheet_by_id(zone.worksheet)
            on_dashboard.add(ws.id)
            placed.append((i, zone, ws))
        if not placed:
            continue

        entries: list[dict[str, Any]] = []
        used_datasets: list[str] = []
        # Parameter controls, then field filters, own the top row of the canvas;
        # charts are pushed below them (the deterministic lane's geometry).
        page_datasources: list[Datasource] = []
        for _, _, ws in placed:
            ds = spec.datasource_by_id(ws.datasource)
            if ds not in page_datasources:
                page_datasources.append(ds)
        parameters = _parameter_plans(page_datasources, f"dashboard {dash.title!r}", [])
        parameter_widgets = 0
        for pplan in parameters:
            if not pplan.widget_type:
                continue  # declared on its dataset, no pinned control — noted
            names = [dataset_by_ds[ds_id] for ds_id in pplan.ds_ids]
            entries.append(
                _parameter_widget(slug, f"param:{dash.id}:{pplan.keyword}", pplan, names)
            )
            used_datasets += names
            parameter_widgets += 1
        filters = _filter_plans_for(dash, [ws for _, _, ws in placed], spec, [], [])
        for plan in filters:
            entries.append(
                _filter_widget(
                    slug,
                    f"filter:{dash.id}:{plan.ds_id}:{plan.field_name}",
                    dataset_by_ds[plan.ds_id],
                    plan,
                )
            )
            used_datasets.append(dataset_by_ds[plan.ds_id])
        for i, _zone, ws in placed:
            entries.append(
                _WidgetPlan(ws, spec).widget(
                    slug, f"widget:{dash.id}:{ws.id}:{i}", dataset_by_ds[ws.datasource]
                )
            )
            used_datasets.append(dataset_by_ds[ws.datasource])
        positions, _moved = _positions(
            parameter_widgets + len(filters),
            [z for _, z, _ in placed],
            [ws.title for _, _, ws in placed],
        )
        # The one cap a split cannot relieve: these widgets are one dashboard's
        # single canvas, so there is no second page to move any of them to.
        if len(entries) > MAX_WIDGETS_PER_PAGE:
            raise CompileError(
                f"dashboard {dash.title!r} places {len(entries)} widgets; an AI/BI "
                f"page holds at most {MAX_WIDGETS_PER_PAGE} — split the dashboard"
            )
        records.append(
            _PageRecord(
                page={
                    "name": lakeview_id(slug, f"page:{dash.id}"),
                    "displayName": dash.title,
                    "pageType": PAGE_TYPE_CANVAS,
                    "layout": [
                        {"widget": widget, "position": position}
                        for widget, position in zip(entries, positions)
                    ],
                },
                datasets=tuple(dict.fromkeys(used_datasets)),
            )
        )

    # Tableau-sheet-as-tab analog (compile_pbit's standalone sections): every
    # worksheet no dashboard places gets its own full-canvas page.
    for ws in spec.worksheets:
        if ws.id in on_dashboard:
            continue
        plan = _WidgetPlan(ws, spec)
        sheet_ds = spec.datasource_by_id(ws.datasource)
        parameters = [
            p
            for p in _parameter_plans([sheet_ds], f"worksheet {ws.title!r}", [])
            if p.widget_type
        ]
        filters = _filter_plans_for(None, [ws], spec, [], [])
        top_widgets: list[dict[str, Any]] = [
            _parameter_widget(
                slug,
                f"param:sheet:{ws.id}:{pplan.keyword}",
                pplan,
                [dataset_by_ds[ds_id] for ds_id in pplan.ds_ids],
            )
            for pplan in parameters
        ] + [
            _filter_widget(
                slug,
                f"filter:sheet:{ws.id}:{fp.ds_id}:{fp.field_name}",
                dataset_by_ds[fp.ds_id],
                fp,
            )
            for fp in filters
        ]
        rows = -(-len(top_widgets) // _FILTERS_PER_ROW) * _FILTER_HEIGHT
        layout = [
            {
                "widget": widget,
                "position": {
                    "x": (i % _FILTERS_PER_ROW) * _FILTER_WIDTH,
                    "y": (i // _FILTERS_PER_ROW) * _FILTER_HEIGHT,
                    "width": _FILTER_WIDTH,
                    "height": _FILTER_HEIGHT,
                },
            }
            for i, widget in enumerate(top_widgets)
        ]
        layout.append(
            {
                "widget": plan.widget(
                    slug, f"widget:sheet:{ws.id}", dataset_by_ds[ws.datasource]
                ),
                "position": {
                    "x": 0,
                    "y": rows,
                    "width": GRID_COLUMNS,
                    "height": max(_MIN_HEIGHT, _FULL_HEIGHT - rows),
                },
            }
        )
        records.append(
            _PageRecord(
                page={
                    "name": lakeview_id(slug, f"page:sheet:{ws.id}"),
                    "displayName": ws.title,
                    "pageType": PAGE_TYPE_CANVAS,
                    "layout": layout,
                },
                datasets=tuple(
                    dict.fromkeys(
                        [dataset_by_ds[fp.ds_id] for fp in filters]
                        + [dataset_by_ds[ws.datasource]]
                    )
                ),
            )
        )

    return records


# ----------------------------------------------------------------- splitting


def _partition(records: list[_PageRecord]) -> list[list[_PageRecord]]:
    """Group pages into the fewest documents that each satisfy the AI/BI caps.

    Order is preserved (a reader's page order survives the split), parts come out
    evenly sized rather than "15, 15, 3" — a nearly-full dashboard leaves the
    person who imports it no room to add a page — and a part prefers to close on
    a *datasource seam*: where the next page queries none of the data this part
    already holds. That is what makes the split logical rather than arithmetic —
    pages over one body of data land in one dashboard, and a part carries only
    the datasets its own pages query.

    Deterministic: same records in, same grouping out.
    """
    if not records:
        return [[]]
    total = len(records)
    if total <= MAX_PAGES and len({n for r in records for n in r.datasets}) <= MAX_DATASETS:
        return [list(records)]

    # Rebalance as the split proceeds: the even target is recomputed from what is
    # LEFT, not once from the whole report. Computing it once let an early seam
    # cut leave the remainder mis-sized — 30 pages on 30 distinct datasources
    # (every page a seam) came out 13/13/4 instead of 15/15, because a seam fired
    # at the slack floor without asking whether the tail still fit in the parts
    # that remained. It has to ask, so the seam rule below carries that check.
    parts: list[list[_PageRecord]] = []
    current: list[_PageRecord] = []
    held: set[str] = set()
    index = 0
    remaining = total
    remaining_parts = max(1, math.ceil(remaining / MAX_PAGES))
    target = math.ceil(remaining / remaining_parts)
    first_target = target

    def close() -> None:
        nonlocal current, held, remaining, remaining_parts, target
        parts.append(current)
        remaining -= len(current)
        current, held = [], set()
        remaining_parts = max(1, math.ceil(remaining / MAX_PAGES)) if remaining else 1
        target = math.ceil(remaining / remaining_parts) if remaining else 1

    for record in records:
        wants = set(record.datasets)
        over_pages = len(current) >= target
        over_datasets = len(held | wants) > MAX_DATASETS
        # A seam may close a part up to _SEAM_SLACK pages early, but only when
        # everything still unplaced fits in the parts that would be left —
        # otherwise "logical" costs an extra document.
        tail = total - index
        seam = (
            len(current) >= max(1, target - _SEAM_SLACK)
            and held.isdisjoint(wants)
            and tail <= max(0, remaining_parts - 1) * MAX_PAGES
        )
        if current and (over_pages or over_datasets or seam):
            close()
        current.append(record)
        held |= wants
        index += 1
    if current:
        parts.append(current)

    # A dataset-cap cut can still leave a stub at the end; fold it back when the
    # part before it has room, so the split never ships a one-page dashboard next
    # to a fourteen-page one.
    if len(parts) > 1 and len(parts[-1]) * 2 <= first_target:
        merged = parts[-2] + parts[-1]
        if (
            len(merged) <= MAX_PAGES
            and len({n for r in merged for n in r.datasets}) <= MAX_DATASETS
        ):
            parts[-2:] = [merged]

    for part in parts:
        names = {n for r in part for n in r.datasets}
        if len(names) > MAX_DATASETS:
            # One page alone querying >100 datasets: nothing left to split. A
            # widget queries exactly one dataset, so reaching this needs >100
            # widgets on a page — _page_records rejects that first. Kept as a
            # guard: the invariant "no emitted document breaks a cap" should not
            # rest on another function's ordering.
            raise CompileError(
                f"page {part[0].title!r} queries {len(names)} datasets; an AI/BI "
                f"dashboard supports at most {MAX_DATASETS} — reduce the report's "
                "datasources"
            )
    return parts


# ---------------------------------------------------------------- warnings


def compile_caveats(spec: DashboardSpec) -> tuple[list[str], list[str]]:
    """Deterministic compile-time caveats for this spec, split into (warnings,
    notes): what the `.lvdash.json` cannot carry, said out loud.

    The split is the point. A WARNING is review-worthy — something the source
    report had that the dashboard does not (a dropped shelf field, a filter that
    could not be emitted, a text zone, a widget type nobody has seen render). A
    NOTE is informational — true, worth printing, but not a reason to make a
    person re-check the build. The dialect caveat is the archetype: it fires on
    every non-Databricks source, i.e. on every migration this target exists to
    serve, so as a warning it made literally every run `complete_with_warnings`
    and drowned the warnings that meant something.

    Recomputes the widget plans rather than reading them off a compile, so the
    caller can surface caveats before (or without) compiling — the same contract
    compiler/pbit.py::compile_warnings has.
    """
    warnings: list[str] = []
    notes: list[str] = []
    used = _used_datasources(spec)
    for ds in used:
        if ds.kind == "live_database" and ds.database is not None:
            if ds.database.dialect != "databricks":
                notes.append(
                    f"datasource {ds.id!r}: the source is {ds.database.dialect!r}, not "
                    "databricks — the dataset SELECTs assume its tables are reachable "
                    "from the AI/BI workspace's Unity Catalog (federate or ingest them first)"
                )
        for name in _unread_parameters(ds):
            warnings.append(
                f"parameter ':{name}' is declared on dataset {ds.name!r} but no "
                "dataset SQL reads it — its control changes nothing; reference it "
                "from a row-level calculated column or drop the declaration"
            )
    on_dashboard: set[str] = set()
    for dash in spec.dashboards:
        text_zones = [z for z in dash.zones if z.kind == "text"]
        if text_zones:
            warnings.append(
                f"dashboard {dash.title!r}: {len(text_zones)} text zone(s) were not "
                "emitted — the `text` widget has no verified wire shape in the pinned "
                "format table; re-add the headings in the AI/BI editor"
            )
        placed: list[tuple[Zone, Worksheet]] = []
        for zone in dash.zones:
            if zone.kind != "worksheet" or not zone.worksheet:
                continue
            try:
                ws = spec.worksheet_by_id(zone.worksheet)
            except KeyError:
                continue  # the compile itself reports it
            on_dashboard.add(ws.id)
            placed.append((zone, ws))
        if not placed:
            continue
        try:
            page_datasources: list[Datasource] = []
            for _, ws in placed:
                ds = spec.datasource_by_id(ws.datasource)
                if ds not in page_datasources:
                    page_datasources.append(ds)
            parameters = _parameter_plans(
                page_datasources, f"dashboard {dash.title!r}", notes
            )
            filters = _filter_plans_for(
                dash, [ws for _, ws in placed], spec, warnings, notes
            )
            _, moved = _positions(
                len([p for p in parameters if p.widget_type]) + len(filters),
                [z for z, _ in placed],
                [ws.title for _, ws in placed],
            )
        except (CompileError, UnsupportedFeatureError, KeyError):
            continue  # the compile itself reports it, loudly
        notes += [f"dashboard {dash.title!r}: {note}" for note in moved]
    for ws in spec.worksheets:
        if ws.id in on_dashboard:
            continue
        try:
            _parameter_plans(
                [spec.datasource_by_id(ws.datasource)], f"worksheet {ws.title!r}", notes
            )
            _filter_plans_for(None, [ws], spec, warnings, notes)
        except (CompileError, UnsupportedFeatureError, KeyError):
            continue
    # Channel drops and unverified widget types come from the plans themselves.
    for ws in spec.worksheets:
        try:
            plan = _WidgetPlan(ws, spec)
        except (CompileError, UnsupportedFeatureError, KeyError):
            continue  # the compile itself reports it, loudly
        warnings += plan.notes
        if not plan.verified:
            warnings.append(
                f"worksheet {ws.title!r}: widget type {plan.widget_type!r} is pinned "
                "from Databricks' docs, not from an exported dashboard — verify how "
                "it renders"
            )
    # A worksheet placed on two dashboards reports its filters twice; say each
    # thing once, in the order it was first said.
    return list(dict.fromkeys(warnings)), list(dict.fromkeys(notes))


def compile_warnings(spec: DashboardSpec) -> list[str]:
    """Review-worthy compile-time caveats — see compile_caveats for the split."""
    return compile_caveats(spec)[0]


def compile_notes(spec: DashboardSpec) -> list[str]:
    """Informational compile-time caveats — see compile_caveats for the split."""
    return compile_caveats(spec)[1]


# -------------------------------------------------------------- entry point


def part_title(workbook_name: str, index: int, total: int) -> str:
    """The name of one document of a split report. Single-part reports keep the
    workbook name unchanged, so nothing about an unsplit build moves."""
    return workbook_name if total <= 1 else f"{workbook_name} ({index} of {total})"


def compile_lakeview_parts(spec: DashboardSpec) -> list[LakeviewPart]:
    """Render a DashboardSpec to one `.lvdash.json` document per dashboard the
    report needs — one part for anything that fits AI/BI's caps, several for a
    report that does not (see _partition for how the split is chosen).

    Always returns at least one part. Deterministic: same spec -> same parts,
    byte for byte.
    """
    titles = [ws.title for ws in spec.worksheets]
    if len(titles) != len(set(titles)):
        raise CompileError(f"worksheet titles must be unique, got {titles}")

    used = _used_datasources(spec)
    # Kind-gate only worksheet-bound datasources — orphans never become datasets
    # (_used_datasources), mirroring compile_pbit's documented orphan tolerance.
    # The formula-language gate stays spec-wide: a spec is authored for exactly
    # one target, so a wrong-language calc anywhere is an error.
    for ds in used:
        _gate_datasource_kind(ds)
        _gate_parameter_refs(ds)
    for ds in spec.datasources:
        _gate_formula_language(ds)
    datasets = _datasets(spec, used)
    dataset_by_ds = {ds.id: dataset["name"] for ds, dataset in zip(used, datasets)}

    groups = _partition(_page_records(spec, dataset_by_ds))
    total = len(groups)
    parts: list[LakeviewPart] = []
    for index, group in enumerate(groups, start=1):
        # A part carries only the datasets its own pages query; an unsplit
        # report keeps every dataset, orphan-tolerant exactly as before.
        wanted = {name for record in group for name in record.datasets}
        part_datasets = (
            datasets if total == 1 else [d for d in datasets if d["name"] in wanted]
        )
        doc = {"datasets": part_datasets, "pages": [record.page for record in group]}
        parts.append(
            LakeviewPart(
                index=index,
                total=total,
                title=part_title(spec.workbook.name, index, total),
                text=json.dumps(doc, indent=2, ensure_ascii=False) + "\n",
                page_titles=tuple(record.title for record in group),
                dataset_count=len(part_datasets),
            )
        )
    return parts


def compile_lakeview(spec: DashboardSpec) -> str:
    """Render a DashboardSpec to a SINGLE `.lvdash.json` text. Deterministic:
    same spec -> same bytes (two-space indent + trailing newline, matching the
    TypeScript emitter's `JSON.stringify(doc, null, 2) + '\\n'`).

    A report too big for one dashboard is an error here, not a truncation — call
    compile_lakeview_parts() when several documents are an acceptable answer.
    """
    parts = compile_lakeview_parts(spec)
    if len(parts) > 1:
        pages = sum(len(p.page_titles) for p in parts)
        # The SPEC's dataset count, not the largest part's: a part is by
        # construction within the cap, so reporting it said "the 100-dataset cap
        # ... the largest single part needs 51", which reads as nonsense.
        datasets = len(_used_datasources(spec))
        if pages > MAX_PAGES:
            raise CompileError(
                f"spec produces {pages} pages; an AI/BI dashboard holds at most "
                f"{MAX_PAGES} — split the report (compile_lakeview_parts() splits "
                f"it into {len(parts)})"
            )
        raise CompileError(
            f"spec binds {datasets} datasources, more than the "
            f"{MAX_DATASETS}-dataset cap allows in one dashboard — split the "
            f"report (compile_lakeview_parts() splits it into {len(parts)})"
        )
    return parts[0].text
