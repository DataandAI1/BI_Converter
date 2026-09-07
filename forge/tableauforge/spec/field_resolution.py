"""Deterministic field-reference resolution — the repair layer between an
authored DashboardSpec and the compile-time field gate.

Authoring is best-effort: the Spec Author (and any hand edit or refine pass)
routinely references a *concept* the user asked for — "channel type", "Fiscal
Year", "Vendor" — that is not a literal column in the datasource. The old
behavior was a hard wall: ``precheck_field_references`` raised one HTTP 422
listing every bad reference and the whole build produced nothing, no matter how
small the slip (a lower-cased "channel" for "Channel", a bare "Month" that is
really a date part).

This pass runs after the generator has forced each datasource onto its real
profile-derived fields, and BEFORE the gate. For every field reference in the
spec — chart shelves and encodings, sort keys, worksheet filters, dashboard
shared filters — it applies three deterministic strategies, in order:

1. **Canonicalize** a near-miss name to the real field (case / whitespace /
   underscore-insensitive), e.g. ``channel type`` -> ``Channel Type``.
2. **Derive a date part** when the name denotes part of a date (``Month``,
   ``Year``, ...) and the datasource carries a date field — rewriting the
   reference to that date field with a ``date_part``, which is how Tableau
   actually groups by a date part.
3. **Drop** what cannot be resolved, but only where dropping is safe: a filter
   (the sheet still renders, unfiltered), an optional encoding (color/size/
   label/detail/tooltip), or a sort key. A shelf reference (rows/cols/
   secondary_rows) is structural — a chart cannot render without it — so it is
   left in place for the gate to reject loudly.

Every action is recorded as a :class:`FieldResolution` so the build can persist
exactly what it repaired or dropped. The pass mutates the spec dict in place and
is fully deterministic: no randomness, stable ordering, clean spec -> no actions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field as _dc_field
from typing import Any

#: A part-of-a-date name normalizes to one of these; the value is the DatePart
#: the compiler/schema accepts. Only the parts Tableau expresses as a single
#: date_part are here — 'weekday', 'monthyear', etc. cannot be one date_part, so
#: they fall through to the drop strategy rather than deriving something wrong.
_DATE_PART_BY_NORM: dict[str, str] = {
    "year": "year",
    "quarter": "quarter",
    "month": "month",
    "week": "week",
    "day": "day",
}

#: Chart encodings that are additive — the mark still renders without them, so an
#: unresolvable reference here is dropped rather than failing the build.
_SINGLE_ENCODINGS = ("color", "size", "label")
_LIST_ENCODINGS = ("detail", "tooltip")
#: Structural shelves: a chart is defined by these, so an unresolvable reference
#: is left for the gate to reject instead of silently gutting the chart.
_STRUCTURAL_SHELVES = ("rows", "cols", "secondary_rows")

_DATE_TYPES = ("date", "datetime")


def _norm(name: Any) -> str:
    """Case/whitespace/underscore-insensitive key for near-miss matching."""
    return re.sub(r"[\s_]+", "", str(name).strip().lower())


@dataclass
class FieldResolution:
    """One deterministic repair or drop applied to a field reference."""

    scope: str          #: "worksheet:<id>" or "dashboard:<id>"
    location: str       #: "rows" | "color" | "filter" | "sort.by" | "shared_filter" | ...
    datasource: str     #: datasource id the reference was resolved against
    original: str       #: the field name as authored
    action: str         #: "renamed" | "date_part" | "dropped" | "unresolved"
    resolved: str | None #: the field name after repair (rename/derive), else None
    reason: str         #: human-readable explanation

    def to_dict(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "location": self.location,
            "datasource": self.datasource,
            "original": self.original,
            "action": self.action,
            "resolved": self.resolved,
            "reason": self.reason,
        }


@dataclass
class _DsIndex:
    """Resolution index for one datasource: exact names, a normalized lookup
    (ambiguous keys mapped to None), and the first date field for derivations."""

    ds_id: str
    exact: set[str]
    norm_to_name: dict[str, str | None]
    date_field: str | None
    date_fields: list[str] = _dc_field(default_factory=list)
    #: Whether strategy 2 (derive a date part) is legal for the build target.
    #: The power_bi and databricks compilers have no date_part rendering, so
    #: deriving one there would either compile wrong or die post-hoc in the
    #: compiler's gate; the name must instead fall through to the drop/gate
    #: behavior.
    derive_date_parts: bool = True


def _index_datasource(ds: dict[str, Any], derive_date_parts: bool = True) -> _DsIndex:
    names: list[str] = []
    date_fields: list[str] = []
    for f in list(ds.get("fields") or []) + list(ds.get("calculated_fields") or []):
        if not isinstance(f, dict) or "name" not in f:
            continue
        name = str(f["name"])
        names.append(name)
        if str(f.get("datatype")) in _DATE_TYPES:
            date_fields.append(name)
    norm_to_name: dict[str, str | None] = {}
    for name in names:
        key = _norm(name)
        if key in norm_to_name and norm_to_name[key] != name:
            norm_to_name[key] = None  # ambiguous: two fields collapse to one key
        else:
            norm_to_name.setdefault(key, name)
    return _DsIndex(
        ds_id=str(ds.get("id")),
        exact=set(names),
        norm_to_name=norm_to_name,
        date_field=date_fields[0] if date_fields else None,
        date_fields=date_fields,
        derive_date_parts=derive_date_parts,
    )


@dataclass
class _NameResolution:
    kind: str               #: "exact" | "rename" | "date_part" | "none"
    field: str | None = None    #: canonical field (rename) or date field (date_part)
    date_part: str | None = None


def _resolve_name(name: str, idx: _DsIndex) -> _NameResolution:
    """Resolve one field name against a datasource index, exact > rename > date_part."""
    if name in idx.exact:
        return _NameResolution("exact", field=name)
    canonical = idx.norm_to_name.get(_norm(name))
    if canonical and canonical != name:
        return _NameResolution("rename", field=canonical)
    part = _DATE_PART_BY_NORM.get(_norm(name))
    if part and idx.date_field and idx.derive_date_parts:
        return _NameResolution("date_part", field=idx.date_field, date_part=part)
    return _NameResolution("none")


def _resolve_field_ref(
    ref: dict[str, Any], idx: _DsIndex, scope: str, location: str
) -> tuple[bool, FieldResolution | None]:
    """Repair one FieldRef dict in place. Returns (resolved, action-or-None).

    ``resolved`` is False only when the name cannot be resolved at all — the
    caller decides whether to drop (encodings) or leave for the gate (shelves)."""
    name = str(ref.get("field", ""))
    res = _resolve_name(name, idx)
    if res.kind == "exact":
        return True, None
    if res.kind == "rename":
        ref["field"] = res.field
        return True, FieldResolution(
            scope, location, idx.ds_id, name, "renamed", res.field,
            f"matched real field {res.field!r} (case/whitespace-insensitive)",
        )
    if res.kind == "date_part":
        ref["field"] = res.field
        ref["date_part"] = res.date_part
        ref.pop("aggregation", None)  # a date part is a dimension, never aggregated
        return True, FieldResolution(
            scope, location, idx.ds_id, name, "date_part", res.field,
            f"derived date_part {res.date_part!r} on date field {res.field!r}",
        )
    return False, None


def _resolve_filter(
    flt: dict[str, Any], idx: _DsIndex, scope: str, location: str
) -> tuple[bool, FieldResolution | None]:
    """Repair one Filter dict in place. Returns (keep, action-or-None); keep is
    False when the filter is unresolvable and should be dropped by the caller."""
    name = str(flt.get("field", ""))
    res = _resolve_name(name, idx)
    if res.kind == "exact":
        return True, None
    if res.kind == "rename":
        flt["field"] = res.field
        return True, FieldResolution(
            scope, location, idx.ds_id, name, "renamed", res.field,
            f"matched real field {res.field!r} (case/whitespace-insensitive)",
        )
    if res.kind == "date_part":
        flt["field"] = res.field
        flt["date_part"] = res.date_part
        flt["filter_type"] = "categorical"  # a date-part filter is categorical
        return True, FieldResolution(
            scope, location, idx.ds_id, name, "date_part", res.field,
            f"derived date_part {res.date_part!r} on date field {res.field!r}",
        )
    return False, None


def _resolve_worksheet(
    ws: dict[str, Any], idx: _DsIndex, actions: list[FieldResolution]
) -> None:
    scope = f"worksheet:{ws.get('id')}"
    chart = ws.get("chart") or {}

    for shelf in _STRUCTURAL_SHELVES:
        for ref in chart.get(shelf) or []:
            if not isinstance(ref, dict):
                continue
            resolved, action = _resolve_field_ref(ref, idx, scope, shelf)
            if action:
                actions.append(action)
            elif not resolved:
                # Structural: leave it for the gate to reject loudly.
                actions.append(FieldResolution(
                    scope, shelf, idx.ds_id, str(ref.get("field", "")),
                    "unresolved", None,
                    "no matching field; a chart shelf cannot be dropped safely",
                ))

    for enc in _SINGLE_ENCODINGS:
        ref = chart.get(enc)
        if not isinstance(ref, dict):
            continue
        resolved, action = _resolve_field_ref(ref, idx, scope, enc)
        if action:
            actions.append(action)
        elif not resolved:
            # Remove the key entirely (rather than set null): the schema types an
            # encoding as a fieldRef object, so a persisted null would fail a
            # later re-validation (editor/refine paths).
            del chart[enc]
            actions.append(FieldResolution(
                scope, enc, idx.ds_id, str(ref.get("field", "")),
                "dropped", None, "no matching field; optional encoding dropped",
            ))

    for enc in _LIST_ENCODINGS:
        kept: list[Any] = []
        for ref in chart.get(enc) or []:
            if not isinstance(ref, dict):
                kept.append(ref)
                continue
            resolved, action = _resolve_field_ref(ref, idx, scope, enc)
            if action:
                actions.append(action)
            if resolved:
                kept.append(ref)
            else:
                actions.append(FieldResolution(
                    scope, enc, idx.ds_id, str(ref.get("field", "")),
                    "dropped", None, "no matching field; optional encoding dropped",
                ))
        if enc in chart:
            chart[enc] = kept

    sort = chart.get("sort")
    if isinstance(sort, dict) and sort.get("by"):
        by = str(sort["by"])
        res = _resolve_name(by, idx)
        if res.kind == "rename":
            sort["by"] = res.field
            actions.append(FieldResolution(
                scope, "sort.by", idx.ds_id, by, "renamed", res.field,
                f"matched real field {res.field!r} (case/whitespace-insensitive)",
            ))
        elif res.kind in ("none", "date_part"):
            # A sort key cannot carry a date_part; if it does not resolve to a
            # real field, drop the sort — the sheet still renders in default order.
            # Remove the key (not set null): the schema types sort as an object.
            chart.pop("sort", None)
            actions.append(FieldResolution(
                scope, "sort.by", idx.ds_id, by, "dropped", None,
                "no matching field for sort key; sort dropped",
            ))

    kept_filters: list[Any] = []
    for flt in ws.get("filters") or []:
        if not isinstance(flt, dict):
            kept_filters.append(flt)
            continue
        keep, action = _resolve_filter(flt, idx, scope, "filter")
        if action:
            actions.append(action)
        if keep:
            kept_filters.append(flt)
        else:
            actions.append(FieldResolution(
                scope, "filter", idx.ds_id, str(flt.get("field", "")),
                "dropped", None,
                "no matching field; filter dropped (sheet renders unfiltered)",
            ))
    if "filters" in ws:
        ws["filters"] = kept_filters


def _resolve_shared_filters(
    spec: dict[str, Any],
    indexes: dict[str, _DsIndex],
    actions: list[FieldResolution],
) -> None:
    """A dashboard shared filter is scoped per worksheet-datasource at compile
    time (it only reaches sheets carrying the field). Here we canonicalize a
    near-miss shared-filter name to a real field where every datasource that has
    it agrees, and drop a shared filter that resolves in none of the datasources
    its dashboard touches."""
    ws_ds = {str(ws.get("id")): str(ws.get("datasource")) for ws in spec.get("worksheets", [])}
    for dash in spec.get("dashboards", []) or []:
        reachable_ids: list[str] = []
        for z in dash.get("zones") or []:
            if isinstance(z, dict) and z.get("kind") == "worksheet" and z.get("worksheet"):
                ds_id = ws_ds.get(str(z["worksheet"]))
                if ds_id and ds_id not in reachable_ids:
                    reachable_ids.append(ds_id)
        reachable = [indexes[i] for i in reachable_ids if i in indexes]
        scope = f"dashboard:{dash.get('id')}"

        kept: list[Any] = []
        for flt in dash.get("shared_filters") or []:
            if not isinstance(flt, dict):
                kept.append(flt)
                continue
            name = str(flt.get("field", ""))
            # Already an exact field in some reachable datasource: keep as-is.
            if any(name in idx.exact for idx in reachable):
                kept.append(flt)
                continue
            # A single, unambiguous canonical among reachable datasources: rename.
            canonicals = {
                idx.norm_to_name.get(_norm(name))
                for idx in reachable
                if idx.norm_to_name.get(_norm(name))
            }
            if len(canonicals) == 1:
                canonical = canonicals.pop()
                target = next(
                    idx.ds_id for idx in reachable
                    if idx.norm_to_name.get(_norm(name)) == canonical
                )
                flt["field"] = canonical
                actions.append(FieldResolution(
                    scope, "shared_filter", target, name, "renamed", canonical,
                    f"matched real field {canonical!r} (case/whitespace-insensitive)",
                ))
                kept.append(flt)
                continue
            # Resolves in no reachable datasource: drop it.
            actions.append(FieldResolution(
                scope, "shared_filter",
                ",".join(reachable_ids), name, "dropped", None,
                "no matching field in any datasource on this dashboard; "
                "shared filter dropped",
            ))
        if "shared_filters" in dash:
            dash["shared_filters"] = kept


def resolve_field_references(
    spec: dict[str, Any], target: str = "tableau"
) -> list[FieldResolution]:
    """Repair every field reference in ``spec`` in place against the real fields
    of each datasource; return the list of actions taken ([] for a clean spec).

    Must run after datasource fields are forced to the profile-derived list and
    before ``precheck_field_references``: every rename/derive/drop here is what
    keeps a build alive that would otherwise 422 on a near-miss name, a bare
    date part, or a filter over a concept the data does not carry.

    ``target`` gates the date-part derivation strategy: the power_bi and
    databricks compilers both reject date_part refs (neither format has a
    shelf-level date-grouping equivalent), so deriving one there would trade a
    clear retryable gate error for a post-hoc compile failure."""
    derive_date_parts = target not in ("power_bi", "databricks")
    indexes = {
        str(ds.get("id")): _index_datasource(ds, derive_date_parts)
        for ds in spec.get("datasources", []) or []
        if isinstance(ds, dict)
    }
    actions: list[FieldResolution] = []
    for ws in spec.get("worksheets", []) or []:
        if not isinstance(ws, dict):
            continue
        idx = indexes.get(str(ws.get("datasource")))
        if idx is None:
            continue  # unknown datasource: the gate reports it with better context
        _resolve_worksheet(ws, idx, actions)
    _resolve_shared_filters(spec, indexes, actions)
    return actions
