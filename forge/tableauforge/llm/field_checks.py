"""Field cross-checking shared by the rebuild author.

Upstream these lived in ``llm/spec_author.py`` alongside the designer flow's one-shot
authoring loop. BI_Converter drops that flow (spec §4.2/§4.4 coupling 2), but its field
checks are the LLM lane's honesty gate: a worksheet may reference only fields its
datasource actually profiles, plus the calculated fields the spec itself declares. So the
checks move here and the author goes away.
"""

from __future__ import annotations

from typing import Any

#: Placeholder an authoring prompt carries where the DashboardSpec JSON Schema is injected.
SCHEMA_PLACEHOLDER = "{{DASHBOARD_SPEC_SCHEMA}}"

_DATE_PART_LOOKALIKES = {
    "month", "year", "quarter", "week", "day", "date", "weekday",
    "monthyear", "yearmonth", "monthofyear", "dayofweek", "dayofmonth",
    "hour", "minute", "second",
}


def _date_part_hint(name: str) -> str:
    """Point authoring at the date_part mechanism when a missing field looks like
    a date part. The field of that name genuinely does not exist; Tableau derives
    it from a date field via date_part (on the shelf AND in filters) or an
    explicit calculated field."""
    if name.strip().lower().replace(" ", "").replace("_", "") not in _DATE_PART_LOOKALIKES:
        return ""
    return (
        f" — {name!r} is a date part, not a field: put a \"date_part\" on the date "
        f"field instead (works on shelves AND filters, e.g. a categorical filter "
        f'with {{"field": "<date field>", "date_part": "month"}}), or declare a '
        f"calculated field named {name!r} under that datasource's calculated_fields"
    )

def _worksheet_field_names(ws: dict[str, Any]) -> list[str]:
    """All field names a worksheet references, gathered defensively from a raw dict."""
    chart = ws.get("chart") or {}
    refs: list[Any] = []
    for key in ("rows", "cols", "detail", "tooltip", "secondary_rows"):
        refs.extend(chart.get(key) or [])
    for key in ("color", "size", "label"):
        if chart.get(key):
            refs.append(chart[key])
    names = [str(r["field"]) for r in refs if isinstance(r, dict) and "field" in r]
    sort = chart.get("sort") or {}
    if isinstance(sort, dict) and sort.get("by"):
        names.append(str(sort["by"]))
    for flt in ws.get("filters") or []:
        if isinstance(flt, dict) and flt.get("field"):
            names.append(str(flt["field"]))
    return names

def _shared_filter_names(spec: dict[str, Any]) -> list[str]:
    """Field names used by every dashboard's shared_filters. The compiler merges
    these into each worksheet on the dashboard (_effective_filters), so a bare
    'Month' here 422s at compile just like a worksheet filter — but the
    worksheet-only walk above never sees it. Checked against the union of legal
    fields; per-datasource scoping is enforced by the build-time gate."""
    names: list[str] = []
    for dash in spec.get("dashboards", []) or []:
        for flt in dash.get("shared_filters", []) or []:
            if isinstance(flt, dict) and flt.get("field"):
                names.append(str(flt["field"]))
    return names

def _worksheet_field_refs(ws: dict[str, Any]) -> list[dict[str, Any]]:
    """All FieldRef dicts a worksheet's chart carries (shelves + encodings)."""
    chart = ws.get("chart") or {}
    refs: list[Any] = []
    for key in ("rows", "cols", "detail", "tooltip", "secondary_rows"):
        refs.extend(chart.get(key) or [])
    for key in ("color", "size", "label"):
        if chart.get(key):
            refs.append(chart[key])
    return [r for r in refs if isinstance(r, dict) and "field" in r]

def _tableau_calc_language_errors(spec: dict[str, Any]) -> list[str]:
    """Every declared calculated field must be tableau_calc: these authoring
    loops (spec author, refiner, design reviewer) all compile through the
    Tableau target, whose compiler rejects any other language — catching it
    here makes the mistake retry-visible instead of a compile-time 422."""
    errors: list[str] = []
    for ds in spec.get("datasources", []) or []:
        if not isinstance(ds, dict):
            continue
        for calc in ds.get("calculated_fields") or []:
            if not isinstance(calc, dict):
                continue
            language = calc.get("formula_language", "tableau_calc")
            if language != "tableau_calc":
                errors.append(
                    f"datasource {ds.get('id')!r}: calculated field "
                    f"{calc.get('name')!r} has formula_language {language!r}; "
                    "this spec targets Tableau — use tableau_calc or omit "
                    "formula_language"
                )
    return errors

def _cross_check_fields_multi(
    spec: dict[str, Any],
    fields_by_ds: dict[str, set[str]],
    profile_roles_by_ds: dict[str, dict[str, str]] | None = None,
    extra_calc_by_ds: dict[str, set[str]] | None = None,
    check_tableau_language: bool = True,
    undeclared_calc_hints: dict[str, dict[str, str]] | None = None,
) -> list[str]:
    """Multi-datasource variant of _cross_check_fields: the spec must declare
    exactly one datasource per selected source (ids given by the caller), and
    every worksheet may reference only fields from ITS datasource's profile
    (plus calculated fields declared on that same datasource).

    ``profile_roles_by_ds`` (ds_id -> {name -> role}) is authoritative per the
    same reasoning as the single-source check: profile roles are what the
    compiler enforces, so they win over the LLM's declared roles.

    ``check_tableau_language`` covers callers that compile through the Tableau
    target; rebuild_author disables it because it runs its own target-aware
    language gate (its power_bi path requires dax, not tableau_calc).

    ``undeclared_calc_hints`` (ds_id -> {calc name -> status}) names the
    source-report calculations the caller KNOWS about but the spec does not
    declare — with the status the model gave each in its translation report.
    A worksheet reference to one of those is not an invented field, and the
    generic "does not exist; available fields: [...]" (whose list omits every
    brief calc) sends the model in circles: it must either translate-and-
    declare the calc or take it off the shelf. Say exactly that."""
    profile_roles_by_ds = profile_roles_by_ds or {}
    extra_calc_by_ds = extra_calc_by_ds or {}
    undeclared_calc_hints = undeclared_calc_hints or {}
    errors: list[str] = []
    spec_ds = [ds for ds in spec.get("datasources", []) if isinstance(ds, dict)]
    spec_ids = [str(ds.get("id")) for ds in spec_ds]
    for ds_id in spec_ids:
        if ds_id not in fields_by_ds:
            errors.append(
                f"datasource {ds_id!r} is not one of the selected datasources; "
                f"declare exactly one datasource per selected source, with these "
                f"exact ids: {sorted(fields_by_ds)}"
            )
    for ds_id in fields_by_ds:
        if ds_id not in spec_ids:
            errors.append(
                f"selected datasource {ds_id!r} is missing from the spec; declare "
                "one datasource entry for every selected source"
            )

    calc_by_ds: dict[str, set[str]] = {}
    roles_by_ds: dict[str, dict[str, str]] = {}
    for ds in spec_ds:
        ds_id = str(ds.get("id"))
        calc_by_ds[ds_id] = {
            str(c["name"])
            for c in ds.get("calculated_fields") or []
            if isinstance(c, dict) and "name" in c
        }
        roles: dict[str, str] = {}
        for f in list(ds.get("fields") or []) + list(ds.get("calculated_fields") or []):
            if isinstance(f, dict) and "name" in f and "role" in f:
                roles[str(f["name"])] = str(f["role"])
        # Profile roles are authoritative for profiled fields (see docstring).
        roles.update(profile_roles_by_ds.get(ds_id, {}))
        roles_by_ds[ds_id] = roles

    for ws in spec.get("worksheets", []):
        ws_id = ws.get("id", "?")
        ds_id = str(ws.get("datasource"))
        if ds_id not in fields_by_ds:
            errors.append(
                f"worksheet {ws_id!r} references unknown datasource {ds_id!r}; "
                f"valid datasource ids: {sorted(fields_by_ds)}"
            )
            continue
        allowed = (
            fields_by_ds[ds_id]
            | calc_by_ds.get(ds_id, set())
            | extra_calc_by_ds.get(ds_id, set())
        )
        roles = roles_by_ds.get(ds_id, {})
        hints = undeclared_calc_hints.get(ds_id, {})
        for name in _worksheet_field_names(ws):
            if name in allowed:
                continue
            if name in hints:
                errors.append(
                    f"worksheet {ws_id!r} references {name!r}, a brief calculation "
                    f"on datasource {ds_id!r} that the spec does not declare "
                    f"(your translation status for it: {hints[name]}). Either "
                    f"translate it — status translated/approximated with a formula, "
                    f"declared under that datasource's calculated_fields — or, when "
                    f"it stays needs_review/skipped, remove it from the worksheet; "
                    f"if that leaves the worksheet with no fields, drop the worksheet "
                    f"and every dashboard zone that shows it."
                )
                continue
            errors.append(
                f"worksheet {ws_id!r} references field {name!r} which does not "
                f"exist in its datasource {ds_id!r}; available fields there: "
                f"{sorted(allowed)}"
            )
        for ref in _worksheet_field_refs(ws):
            name = str(ref["field"])
            agg = ref.get("aggregation")
            if agg and roles.get(name) == "dimension" and agg not in ("none", "count", "countd"):
                errors.append(
                    f"worksheet {ws_id!r}: dimension {name!r} cannot use aggregation "
                    f"{agg!r} (dimensions allow only count/countd). To aggregate its "
                    f"values, declare a row-level calculated field (e.g. "
                    f'"FLOAT([{name}])", role measure) and put the aggregation on '
                    f"the shelf reference to that calculated field."
                )
    # Shared filters are merged into every worksheet on their dashboard at compile
    # time and so must resolve there; the union check catches a field that exists
    # in no source at all (per-datasource scoping is enforced by the build gate).
    known_anywhere: set[str] = set()
    for names in fields_by_ds.values():
        known_anywhere |= names
    for names in calc_by_ds.values():
        known_anywhere |= names
    for names in extra_calc_by_ds.values():
        known_anywhere |= names
    for name in _shared_filter_names(spec):
        if name not in known_anywhere:
            errors.append(
                f"a dashboard shared_filter references field {name!r} which exists "
                f"in none of the selected datasources"
                + _date_part_hint(name)
            )
    if check_tableau_language:
        errors += _tableau_calc_language_errors(spec)
    return list(dict.fromkeys(errors))
