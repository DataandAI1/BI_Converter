"""Typed DashboardSpec models. Mirrors dashboard_spec_v1.schema.json; a test keeps them in sync.

The JSON Schema is the LLM-facing contract gate; these models are what the compiler consumes.
Always run assert_valid_spec() on raw dicts first — pydantic here is for typing, not gating.
"""

from __future__ import annotations

import re
from typing import Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field as PField, model_validator

_HEX_COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}")

Datatype = Literal["string", "integer", "real", "boolean", "date", "datetime"]
Aggregation = Literal["sum", "avg", "min", "max", "count", "countd", "median", "none"]
DatePart = Literal["year", "quarter", "month", "week", "day", "exact"]
#: The first six are the cross-target vocabulary every compiler understands; the
#: last five are Lakeview's richer chart set, mapped by compiler/lakeview.py only
#: (compile_twb and compile_pbit reject them as unsupported).
ChartType = Literal[
    "bar",
    "line",
    "area",
    "text_table",
    "scatter",
    "dual_axis_bar_line",
    "counter",
    "pie",
    "heatmap",
    "pivot",
    "combo",
]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Field(_Model):
    name: str
    datatype: Datatype
    role: Literal["dimension", "measure"]
    default_aggregation: Optional[Aggregation] = None
    caption: Optional[str] = None


class CalculatedField(_Model):
    name: str
    formula: str
    datatype: Datatype
    role: Literal["dimension", "measure"]
    #: Language the formula is written in. Each compiler accepts exactly one
    #: (twb: tableau_calc, pbit: dax, lvdash: sql) — no silent cross-compilation.
    formula_language: Literal["tableau_calc", "dax", "sql"] = "tableau_calc"
    template: Optional[
        Literal["yoy_growth", "pytd", "qtd", "running_total", "percent_of_total", "custom"]
    ] = None


class CsvSource(_Model):
    table_name: str


class DatabaseSource(_Model):
    dialect: Literal["postgres", "mysql", "snowflake", "sqlserver", "databricks"]
    host: str
    port: Optional[int] = None
    database: str
    db_schema: Optional[str] = None
    table: str
    username: Optional[str] = None
    warehouse: Optional[str] = None
    # Databricks SQL warehouse HTTP path (databricks dialect only; schema-enforced).
    http_path: Optional[str] = None


class PublishedSource(_Model):
    """A datasource published on Tableau Cloud/Server, reached via sqlproxy.

    No credential fields by design (GOAL §2): Desktop prompts the user on
    open. content_url is optional — the compiler derives it from
    datasource_name using Tableau's publish-time rule when omitted.
    """

    server: str
    site: Optional[str] = None
    datasource_luid: Optional[str] = None
    datasource_name: str
    content_url: Optional[str] = None


#: Parameter datatypes the Databricks AI/BI format pins for a dataset parameter
#: (spec/lakeview_parameter_types.json, mirrored from lakeview-format.ts). It is
#: deliberately NOT the spec's own `Datatype`: Lakeview has DECIMAL where the
#: spec has `real`, and has no boolean parameter at all.
ParameterDatatype = Literal["string", "integer", "decimal", "date", "datetime"]

_PARAM_NAME_RE = re.compile(r"[a-z][a-z0-9_]{0,63}")


class DashboardParameter(_Model):
    """One dashboard parameter, declared on the datasource whose dataset SQL
    reads it as ``:name``.

    Single-value only by design: the pinned MULTI/RANGE complex forms exist in
    the format but nothing in the authored lane can ground a default value list
    or a min/max pair, so the author never emits them.
    """

    name: str
    display_name: Optional[str] = None
    datatype: ParameterDatatype
    #: The parameter's default, as the literal text the format carries.
    default: str

    @model_validator(mode="after")
    def _check_name(self) -> "DashboardParameter":
        if not _PARAM_NAME_RE.fullmatch(self.name):
            raise ValueError(
                f"parameter name {self.name!r} must be snake_case matching "
                "^[a-z][a-z0-9_]{0,63}$ — it is the SQL `:keyword` the dataset reads"
            )
        return self


class Datasource(_Model):
    id: str
    name: str
    kind: Literal["embedded_csv", "live_database", "published_datasource"]
    csv: Optional[CsvSource] = None
    database: Optional[DatabaseSource] = None
    published: Optional[PublishedSource] = None
    fields: list[Field]
    calculated_fields: list[CalculatedField] = PField(default_factory=list)
    #: Dashboard parameters this datasource's dataset declares. Only the
    #: databricks target compiles them; the other compilers ignore the list.
    parameters: list[DashboardParameter] = PField(default_factory=list)

    @model_validator(mode="after")
    def _check_source(self) -> "Datasource":
        if self.kind == "embedded_csv" and self.csv is None:
            raise ValueError(f"datasource {self.id!r}: kind embedded_csv requires csv")
        if self.kind == "live_database" and self.database is None:
            raise ValueError(f"datasource {self.id!r}: kind live_database requires database")
        if self.kind == "published_datasource" and self.published is None:
            raise ValueError(
                f"datasource {self.id!r}: kind published_datasource requires published"
            )
        names = [p.name for p in self.parameters]
        duplicates = sorted({n for n in names if names.count(n) > 1})
        if duplicates:
            raise ValueError(
                f"datasource {self.id!r}: duplicate parameter name(s) {duplicates} — "
                "one `:keyword` resolves to one parameter per dataset"
            )
        return self

    def field_map(self) -> dict[str, Field | CalculatedField]:
        out: dict[str, Field | CalculatedField] = {f.name: f for f in self.fields}
        out.update({c.name: c for c in self.calculated_fields})
        return out


class FieldRef(_Model):
    field: str
    aggregation: Optional[Aggregation] = None
    date_part: Optional[DatePart] = None
    as_discrete: Optional[bool] = None


class Sort(_Model):
    """Sort for the worksheet's first dimension pill.

    Kinds (resolved from the fields when type='auto'):
    - alphabetic: by the dimension's own values (`by` omitted or equal to it).
    - computed:   by another field (`by`); measures use their aggregation,
                  dimensions sort by COUNT — Tableau's own sort-by-field default.
    - manual:     explicit member order via `values`.
    """

    by: Optional[str] = None
    order: Literal["asc", "desc"]
    type: Literal["auto", "alphabetic", "computed", "manual"] = "auto"
    values: list[str] = PField(default_factory=list)

    @model_validator(mode="after")
    def _check_kind(self) -> "Sort":
        if self.type == "manual" and not self.values:
            raise ValueError("sort type 'manual' requires a non-empty values list")
        if self.type == "computed" and not self.by:
            raise ValueError("sort type 'computed' requires 'by'")
        if self.type == "alphabetic" and self.values:
            raise ValueError("sort type 'alphabetic' takes no values list")
        return self


class Chart(_Model):
    type: ChartType
    rows: list[FieldRef]
    cols: list[FieldRef]
    color: Optional[FieldRef] = None
    size: Optional[FieldRef] = None
    label: Optional[FieldRef] = None
    detail: list[FieldRef] = PField(default_factory=list)
    tooltip: list[FieldRef] = PField(default_factory=list)
    secondary_rows: list[FieldRef] = PField(default_factory=list)
    sort: Optional[Sort] = None

    def all_field_refs(self) -> list[FieldRef]:
        refs = list(self.rows) + list(self.cols)
        for opt in (self.color, self.size, self.label):
            if opt is not None:
                refs.append(opt)
        refs += self.detail + self.tooltip + self.secondary_rows
        return refs


class Filter(_Model):
    field: str
    filter_type: Literal["categorical", "range", "relative_date"]
    values: list[Any] = PField(default_factory=list)
    min: Optional[Any] = None
    max: Optional[Any] = None
    date_part: Optional[DatePart] = None
    show_quick_filter: bool = False


class Worksheet(_Model):
    id: str
    title: str
    datasource: str
    chart: Chart
    filters: list[Filter] = PField(default_factory=list)


class DashboardSize(_Model):
    width: int
    height: int


class Zone(_Model):
    kind: Literal["worksheet", "text", "blank"]
    worksheet: Optional[str] = None
    text: Optional[str] = None
    x: float
    y: float
    w: float
    h: float
    confidence: Optional[float] = None

    @model_validator(mode="after")
    def _check_ref(self) -> "Zone":
        if self.kind == "worksheet" and not self.worksheet:
            raise ValueError("zone of kind worksheet requires a worksheet id")
        if self.kind == "text" and self.text is None:
            raise ValueError("zone of kind text requires text")
        return self


class Dashboard(_Model):
    id: str
    title: str
    size: DashboardSize
    zones: list[Zone]
    shared_filters: list[Filter] = PField(default_factory=list)


class WorkbookMeta(_Model):
    name: str
    theme: Optional[Literal["default", "midnight", "slate", "sunrise"]] = None
    #: Override mark color with a layout-preset accent (hex like "#4e79a7").
    #: Applied as a workbook-level mark style rule; wins over the theme accent.
    accent: Optional[str] = None
    #: The layout preset this spec was last arranged with (provenance only;
    #: the zones themselves are authoritative for compilation).
    layout_template: Optional[str] = None

    @model_validator(mode="after")
    def _check_accent(self) -> "WorkbookMeta":
        if self.accent is not None and not _HEX_COLOR_RE.fullmatch(self.accent):
            raise ValueError(f"accent must be a hex color like '#4e79a7', got {self.accent!r}")
        return self


class DashboardSpec(_Model):
    spec_version: Literal["1.0"]
    workbook: WorkbookMeta
    datasources: list[Datasource]
    worksheets: list[Worksheet]
    dashboards: list[Dashboard] = PField(default_factory=list)

    def datasource_by_id(self, ds_id: str) -> Datasource:
        for ds in self.datasources:
            if ds.id == ds_id:
                return ds
        raise KeyError(f"unknown datasource id: {ds_id}")

    def worksheet_by_id(self, ws_id: str) -> Worksheet:
        for ws in self.worksheets:
            if ws.id == ws_id:
                return ws
        raise KeyError(f"unknown worksheet id: {ws_id}")
