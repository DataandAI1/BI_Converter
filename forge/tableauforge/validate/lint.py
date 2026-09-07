"""Layer 3: structural lint — checks the XSD cannot express (GOAL §5.3).

Parses compiled TWB XML with lxml and cross-checks internal references against
each other and against the originating DashboardSpec:

- every column-instance in a worksheet's datasource-dependencies references a
  column declared for that datasource (or a spec calculated field),
- every shelf (rows/cols) token ``[ds].[instance]`` resolves to a declared
  column-instance in that worksheet's dependencies,
- every encoding column attribute resolves the same way,
- every dashboard zone with a name attribute references a real worksheet,
- calculated-field formulas pass a sanity parse (balanced parens/brackets,
  balanced quotes, non-empty),
- worksheet names are unique,
- datasource ids referenced by worksheets exist in the spec.
"""

from __future__ import annotations

import re

from lxml import etree

from tableauforge.compiler.calculations import is_aggregate_formula
from tableauforge.spec.models import DashboardSpec

# [datasource].[instance] token as rendered on shelves and in encodings.
_FIELD_TOKEN = re.compile(r"\[([^\]]+)\]\.\[([^\]]+)\]")


def _strip_brackets(name: str) -> str:
    if name.startswith("[") and name.endswith("]"):
        return name[1:-1]
    return name


def _formula_issues(formula: str) -> list[str]:
    """Sanity-parse a calculated-field formula. Not a grammar — a tripwire."""
    if not formula.strip():
        return ["formula is empty"]

    issues: list[str] = []
    depth = 0
    closed_without_open = False
    quote: str | None = None
    in_bracket = False
    stray_bracket_close = False

    for ch in formula:
        if quote is not None:
            if ch == quote:
                quote = None
        elif in_bracket:
            if ch == "]":
                in_bracket = False
        elif ch in ("'", '"'):
            quote = ch
        elif ch == "[":
            in_bracket = True
        elif ch == "]":
            stray_bracket_close = True
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth < 0:
                closed_without_open = True
                depth = 0

    if closed_without_open:
        issues.append("unbalanced parentheses: ')' without matching '('")
    if depth > 0:
        issues.append("unbalanced parentheses: unclosed '('")
    if quote is not None:
        issues.append(f"unterminated string literal (started with {quote})")
    if in_bracket:
        issues.append("unterminated field reference: '[' without closing ']'")
    if stray_bracket_close:
        issues.append("unbalanced brackets: ']' without matching '['")
    return issues


def lint_twb(twb_bytes: bytes, spec: DashboardSpec) -> list[str]:
    """Structural lint of compiled TWB XML against itself and the spec.

    Returns human-readable error strings; empty list means pass.
    """
    try:
        root = etree.fromstring(twb_bytes)
    except etree.XMLSyntaxError as exc:
        return [f"structural lint: not well-formed XML: {exc}"]

    errors: list[str] = []
    spec_ds_ids = {ds.id for ds in spec.datasources}
    spec_field_names = {ds.id: set(ds.field_map()) for ds in spec.datasources}

    # Columns declared at workbook level, per datasource id: names (brackets
    # stripped) and captions (calculated fields are keyed by caption).
    declared_columns: dict[str, set[str]] = {}
    for ds_el in root.iterfind("datasources/datasource"):
        names: set[str] = set()
        for col in ds_el.iterfind("column"):
            names.add(_strip_brackets(col.get("name", "")))
            caption = col.get("caption")
            if caption:
                names.add(caption)
        declared_columns[ds_el.get("name", "")] = names

    # Worksheet names must be unique.
    ws_names = [w.get("name", "") for w in root.iterfind("worksheets/worksheet")]
    for name in sorted({n for n in ws_names if ws_names.count(n) > 1}):
        errors.append(f"duplicate worksheet name: {name!r}")

    for ws_el in root.iterfind("worksheets/worksheet"):
        ws_name = ws_el.get("name", "?")

        # Datasources the worksheet claims to use must exist in the spec.
        for vds in ws_el.iterfind(".//view/datasources/datasource"):
            ds_id = vds.get("name", "")
            if ds_id not in spec_ds_ids:
                errors.append(
                    f"worksheet {ws_name!r}: references unknown datasource {ds_id!r}"
                )

        # Declared column-instances, keyed (datasource id, instance name).
        instances: set[tuple[str, str]] = set()
        for deps in ws_el.iterfind(".//datasource-dependencies"):
            dep_ds = deps.get("datasource", "")
            if dep_ds not in spec_ds_ids:
                errors.append(
                    f"worksheet {ws_name!r}: datasource-dependencies references "
                    f"unknown datasource {dep_ds!r}"
                )
            dep_cols: set[str] = set()
            for col in deps.iterfind("column"):
                dep_cols.add(_strip_brackets(col.get("name", "")))
                caption = col.get("caption")
                if caption:
                    dep_cols.add(caption)
            valid_columns = (
                declared_columns.get(dep_ds, set())
                | spec_field_names.get(dep_ds, set())
                | dep_cols
            )
            calc_formulas = {
                _strip_brackets(col.get("name", "")): calc.get("formula", "")
                for col in deps.iterfind("column")
                for calc in col.iterfind("calculation")
            }
            for inst in deps.iterfind("column-instance"):
                column_ref = _strip_brackets(inst.get("column", ""))
                if column_ref not in valid_columns:
                    errors.append(
                        f"worksheet {ws_name!r}: column-instance "
                        f"{inst.get('name')!r} references undeclared column "
                        f"[{column_ref}] in datasource {dep_ds!r}"
                    )
                # Aggregate-of-aggregate: an instance that re-aggregates a
                # calculated field whose formula is already aggregated (e.g.
                # [sum:...] over COUNT(...)) cannot be evaluated by Tableau —
                # the pane renders blank. Such instances must use derivation
                # User (KeyMoments regression, 2026-06-12).
                formula = calc_formulas.get(column_ref, "")
                if (
                    formula
                    and is_aggregate_formula(formula)
                    and inst.get("derivation") not in ("User", "None")
                ):
                    errors.append(
                        f"worksheet {ws_name!r}: column-instance "
                        f"{inst.get('name')!r} re-aggregates the already-"
                        f"aggregated calculated field [{column_ref}] "
                        f"(formula {formula!r}) — the pane would render blank"
                    )
                instances.add((dep_ds, _strip_brackets(inst.get("name", ""))))

        # Shelf tokens must resolve to declared column-instances.
        for shelf in ("rows", "cols"):
            shelf_el = ws_el.find(f"table/{shelf}")
            text = shelf_el.text or "" if shelf_el is not None else ""
            for ds_id, instance in _FIELD_TOKEN.findall(text):
                if (ds_id, instance) not in instances:
                    errors.append(
                        f"worksheet {ws_name!r}: {shelf} shelf token "
                        f"[{ds_id}].[{instance}] does not resolve to a declared "
                        f"column-instance"
                    )

        # Sort references (alphabetic/manual/computed) must resolve to declared
        # column-instances, including the computed sort's using= field.
        for sort_tag in ("alphabetic-sort", "manual-sort", "computed-sort"):
            for sort_el in ws_el.iterfind(f"table/view/{sort_tag}"):
                for attr in ("column", "using"):
                    token = sort_el.get(attr)
                    if not token:
                        continue
                    match = _FIELD_TOKEN.fullmatch(token)
                    if match is None:
                        errors.append(
                            f"worksheet {ws_name!r}: {sort_tag} {attr} "
                            f"{token!r} is not a [ds].[instance] token"
                        )
                        continue
                    ds_id, instance = match.groups()
                    if (ds_id, instance) not in instances:
                        errors.append(
                            f"worksheet {ws_name!r}: {sort_tag} {attr} "
                            f"{token!r} does not resolve to a declared column-instance"
                        )

        # Encoding columns must resolve the same way.
        for enc in ws_el.iterfind(".//panes/pane/encodings/*"):
            column = enc.get("column", "")
            match = _FIELD_TOKEN.fullmatch(column)
            if match is None:
                errors.append(
                    f"worksheet {ws_name!r}: {enc.tag} encoding has malformed "
                    f"column reference {column!r}"
                )
                continue
            ds_id, instance = match.groups()
            if (ds_id, instance) not in instances:
                errors.append(
                    f"worksheet {ws_name!r}: {enc.tag} encoding column "
                    f"{column!r} does not resolve to a declared column-instance"
                )

    # Dashboard zones with a name attribute must point at real worksheets.
    ws_name_set = set(ws_names)
    for dash_el in root.iterfind("dashboards/dashboard"):
        dash_name = dash_el.get("name", "?")
        for zone in dash_el.iterfind(".//zone"):
            zone_name = zone.get("name")
            if zone_name is not None and zone_name not in ws_name_set:
                errors.append(
                    f"dashboard {dash_name!r}: zone references unknown "
                    f"worksheet {zone_name!r}"
                )

    # Every embedded formula must pass the sanity parse.
    for calc_el in root.iter("calculation"):
        formula = calc_el.get("formula")
        if formula is None:
            continue
        parent = calc_el.getparent()
        owner = "calculation"
        if parent is not None:
            owner = parent.get("caption") or parent.get("name") or parent.tag
        for issue in _formula_issues(formula):
            errors.append(f"calculated field {owner!r}: {issue}")

    return errors
