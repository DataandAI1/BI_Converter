"""Deterministic pre-compile field-reference gate.

Upstream this lived in ``compiler/twb.py``, the Tableau-XML compiler BI_Converter drops
(spec §4.2). The gate itself has nothing to do with Tableau XML: it walks a DashboardSpec
and reports every field a worksheet references that does not resolve in that worksheet's
own datasource. That is the LLM lane's honesty guarantee — an authored spec that names a
field nobody has must fail loudly before it compiles into a dashboard that renders empty —
so it moves here and the compiler goes away.
"""

from __future__ import annotations

from tableauforge.spec.models import DashboardSpec, Datasource, Filter, Worksheet

def _effective_filters(ws: Worksheet, spec: DashboardSpec) -> list[Filter]:
    """Worksheet filters plus the shared filters of every dashboard containing it.

    A dashboard shared_filter is merged into a worksheet ONLY when its field
    exists in that worksheet's own datasource. This is Tableau's own semantics —
    a global quick filter applies only to sheets that carry the field — and it is
    what stops a shared filter defined over one datasource (say 'Channel' on the
    CES source) from fanning out onto worksheets bound to a different datasource
    that has no such field, which would otherwise raise "unknown field 'Channel'"
    for every one of them. A shared filter that resolves in none of a dashboard's
    datasources reaches nothing here; ``precheck_field_references`` surfaces that
    separately so the silent no-op cannot hide an authoring slip."""
    filters = list(ws.filters)
    seen = {(f.field, f.filter_type, f.date_part) for f in filters}
    fmap = spec.datasource_by_id(ws.datasource).field_map()
    for dash in spec.dashboards:
        on_dash = any(z.kind == "worksheet" and z.worksheet == ws.id for z in dash.zones)
        if not on_dash:
            continue
        for sf in dash.shared_filters:
            if sf.field not in fmap:
                continue
            key = (sf.field, sf.filter_type, sf.date_part)
            if key not in seen:
                seen.add(key)
                filters.append(sf)
    return filters

#: Names that name a *part of a date* rather than a stored column. The dominant
#: authoring mistake is referencing one of these as a bare field when the
#: datasource only carries a raw date column — Tableau derives them with a
#: date_part on that date field (or an explicit calculated field), so no field
#: of this name exists and the compiler raises "unknown field 'Month'".
_DATE_PART_LOOKALIKES = {
    "month", "year", "quarter", "week", "day", "date", "weekday",
    "monthyear", "yearmonth", "monthofyear", "dayofweek", "dayofmonth",
    "hour", "minute", "second",
}


def _unknown_field_hint(name: str, ds: Datasource) -> str:
    """An actionable tail for an unknown-field error. When the datasource has a
    date column and the missing name looks like a date part, point authoring at
    the date_part mechanism instead of an invented field."""
    date_fields = [f.name for f in ds.fields if f.datatype in ("date", "datetime")]
    if not date_fields:
        return ""
    normalized = name.strip().lower().replace(" ", "").replace("_", "")
    example = date_fields[0]
    if normalized in _DATE_PART_LOOKALIKES:
        return (
            f" — {name!r} is a date part, not a stored field: reference the date "
            f'field with a date_part (e.g. {{"field": {example!r}, "date_part": '
            f'"month"}}), or declare a calculated field named {name!r} in this '
            f"datasource's calculated_fields"
        )
    return (
        f" — to group or filter by part of a date, put a date_part on a date "
        f"field ({date_fields}); do not invent a field named {name!r}"
    )

def precheck_field_references(spec: DashboardSpec) -> list[str]:
    """Deterministic pre-compile gate: every field a worksheet references — on a
    shelf, an encoding, sort.by, a worksheet filter, or a dashboard shared_filter
    that reaches it — must resolve in that worksheet's OWN datasource, exactly as
    ``compile_twb`` resolves it (``Datasource.field_map()`` per worksheet).

    Run this before compile on every spec path (LLM-authored, hand-edited,
    refined, single- or multi-source). It turns the compiler's first-failure
    ``CompileError`` — surfaced to users as a raw HTTP 422 like "filter
    references unknown field 'Month'" — into the complete, actionable list of bad
    references, and it is the only field check that also covers dashboard
    shared_filters and enforces per-datasource scoping for multi-datasource
    workbooks. Returns [] when the spec is compile-safe reference-wise.
    """
    errors: list[str] = []
    for ws in spec.worksheets:
        try:
            ds = spec.datasource_by_id(ws.datasource)
        except KeyError:
            errors.append(
                f"worksheet {ws.id!r} references unknown datasource "
                f"{ws.datasource!r}; declared datasource ids: "
                f"{sorted(d.id for d in spec.datasources)}"
            )
            continue
        fmap = ds.field_map()
        refs: list[tuple[str, str]] = [("chart", r.field) for r in ws.chart.all_field_refs()]
        if ws.chart.sort and ws.chart.sort.by:
            refs.append(("sort.by", ws.chart.sort.by))
        refs += [("filter", f.field) for f in _effective_filters(ws, spec)]
        for kind, name in refs:
            if name not in fmap:
                errors.append(
                    f"worksheet {ws.id!r}: {kind} references unknown field "
                    f"{name!r} in datasource {ds.id!r}"
                    f"{_unknown_field_hint(name, ds)}"
                )

    # Shared filters are scoped per worksheet-datasource by _effective_filters (a
    # global filter only reaches sheets carrying the field), so the worksheet loop
    # above no longer sees a shared filter that resolves in some datasource but not
    # this one — which is correct. But a shared filter that resolves in NONE of the
    # datasources its dashboard touches reaches nothing at all; scoping would
    # silently swallow it, so surface it here as the authoring slip it almost
    # always is.
    errors += _shared_filter_reachability_errors(spec)
    return list(dict.fromkeys(errors))

def _shared_filter_reachability_errors(spec: DashboardSpec) -> list[str]:
    """A dashboard shared_filter must resolve in at least one datasource used by a
    worksheet on that dashboard; otherwise it is dead and reported."""
    errors: list[str] = []
    ws_by_id = {ws.id: ws for ws in spec.worksheets}
    for dash in spec.dashboards:
        reachable: list[Datasource] = []
        for z in dash.zones:
            if z.kind != "worksheet" or not z.worksheet:
                continue
            ws = ws_by_id.get(z.worksheet)
            if ws is None:
                continue
            try:
                ds = spec.datasource_by_id(ws.datasource)
            except KeyError:
                continue
            if ds not in reachable:
                reachable.append(ds)
        for sf in dash.shared_filters:
            if any(sf.field in ds.field_map() for ds in reachable):
                continue
            hint = next(
                (h for ds in reachable if (h := _unknown_field_hint(sf.field, ds))), ""
            )
            errors.append(
                f"dashboard {dash.id!r}: shared_filter references field {sf.field!r} "
                f"which exists in none of this dashboard's datasources "
                f"({sorted({ds.id for ds in reachable})}){hint}"
            )
    return errors
