"""Rebuild Author (Linetria addition — see forge/UPSTREAM.md): rebuild brief ->
DashboardSpec + per-calculation translation report.

Mirrors spec_author's retry-with-validator-errors loop, with two extra gates:
the response envelope is {"spec", "translation", "warnings"} (forge is
stateless — the caller round-trips the translation), and the translation
report must cover every brief calculation with an honest status. Zone
confidence is provenance-aware (spec 2026-07-27 §6): invented layout is
stamped AI-proposed by clamping every dashboard zone's confidence to ≤ 0.65
(the schema's "surface to the user" threshold is < 0.7), while a zone that
reproduces a brief-observed layout keeps observed-grade confidence — up to
0.95 for a .twb-sourced layout, 0.8 for one read off a screenshot. "warnings"
is the layout fidelity check: a report-only (never retried) comparison of the
authored dashboard against any observed layout.
"""

from __future__ import annotations

import copy
import json
import logging
import re
from typing import Any

from tableauforge.compiler.lakeview import _parameter_refs
from tableauforge.config import (
    Settings,
    ollama_num_ctx_cap_from_env,
    provider_from_env,
)
from tableauforge.llm import load_system_prompt
from tableauforge.llm.client import (
    LlmClient,
    LlmJsonError,
    estimate_prompt_tokens,
)
from tableauforge.llm.field_checks import SCHEMA_PLACEHOLDER, _cross_check_fields_multi
from tableauforge.spec.field_resolution import canonicalize_field_names
from tableauforge.spec.schema import (
    load_schema,
    normalize_zone_grid,
    prune_unknown_root_keys,
    repair_enums,
    repair_identifiers,
    repair_titles,
    repair_unknown_keys,
    repair_zones,
    validate_spec,
)

logger = logging.getLogger(__name__)

#: Invented-layout marker: every dashboard zone's confidence is clamped to this.
MAX_REBUILD_ZONE_CONFIDENCE = 0.65
#: A zone that reproduces an OBSERVED (.twb-sourced) layout may keep
#: confidence up to this ceiling — still short of 1.0 because the rebuild is
#: still a fresh authoring pass, not a byte-identical copy.
MAX_OBSERVED_ZONE_CONFIDENCE = 0.95
#: An observed layout read off a rendered screenshot (screenshot_analysis)
#: caps lower than a .twb-sourced one — it's an LLM's read of pixels, not
#: exact geometry.
MAX_SCREENSHOT_ZONE_CONFIDENCE = 0.8
#: Per-coordinate tolerance (percentage points, 0-100 grid) for treating an
#: authored zone as reproducing an observed one.
ZONE_MATCH_TOLERANCE = 10.0

TRANSLATION_STATUSES = ("translated", "approximated", "needs_review", "skipped")
#: Statuses whose translated formula lands in the spec as a calculated field.
DECLARED_STATUSES = ("translated", "approximated")

#: The authoring contract: prompt role, translation-entry formula key, and the
#: formula_language every declared calculated field must carry. Upstream this was a
#: registry of three targets; BI_Converter converts to Databricks only (spec §4.4), so
#: the table collapses to one entry — kept as a table because the three values are read
#: from four call sites and belong together.
_TARGETS: dict[str, dict[str, str]] = {
    "databricks": {
        "prompt": "rebuild_author_databricks",
        "formula_key": "sql_expression",
        "formula_language": "sql",
    },
}


def _target_contract(target: str) -> dict[str, str]:
    contract = _TARGETS.get(target)
    if contract is None:
        raise ValueError(
            f"unknown rebuild target {target!r}; expected one of {sorted(_TARGETS)}"
        )
    return contract


class RebuildAuthoringError(RuntimeError):
    """All rebuild-authoring attempts failed validation."""

    def __init__(self, message: str, errors: list[str], raw: dict[str, Any] | None):
        self.errors = errors
        self.raw = raw
        super().__init__(message + "\n" + "\n".join(errors))


#: Connection shapes the rebuild author is explicitly forbidden to emit (prompt
#: rule 2: "Set 'fields': [] and DO NOT emit a 'database'/'connection' value").
#: Linetria fills them from the brief in force_brief_datasources BEFORE
#: validate_spec runs, so the model never authors one.
_UNAUTHORED_DATASOURCE_KEYS = ("csv", "database", "published")


def rebuild_schema_view() -> dict[str, Any]:
    """The DashboardSpec schema as the REBUILD author needs to see it.

    Two things, both of which shrink the prompt and remove a contradiction the
    model was being asked to resolve:

    * Drop the connection shapes rule 2 forbids (``csv``/``database``/
      ``published``, the ``kind``-conditional ``allOf`` that requires them, and
      the now-unreachable ``kind`` values). The full schema described 4.2k chars
      of connection syntax the model must never produce.
    * Relax ``fields.minItems`` to 0, because rule 2 asks for ``"fields": []``
      while the real schema demands at least one. That contradiction was
      harmless only because ``force_brief_datasources`` refills the datasource
      before ``validate_spec`` sees it — but the model still had to read it.

    Validation is unaffected: ``validate_spec`` keeps using the full
    ``load_schema()``. This is a prompt view, not a second contract.
    """
    schema = copy.deepcopy(load_schema())
    ds = schema.get("$defs", {}).get("datasource")
    if not isinstance(ds, dict):
        return schema
    props = ds.get("properties")
    if isinstance(props, dict):
        for key in _UNAUTHORED_DATASOURCE_KEYS:
            props.pop(key, None)
        kind = props.get("kind")
        if isinstance(kind, dict) and "live_database" in (kind.get("enum") or []):
            kind["enum"] = ["live_database"]
        fields = props.get("fields")
        if isinstance(fields, dict):
            fields["minItems"] = 0
    ds.pop("allOf", None)
    return schema


def render_system_prompt(target: str = "databricks") -> str:
    prompt_name = _target_contract(target)["prompt"]
    system = load_system_prompt(prompt_name)
    if SCHEMA_PLACEHOLDER not in system:
        raise ValueError(
            f"prompts/{prompt_name}.md is missing the {SCHEMA_PLACEHOLDER} placeholder"
        )
    # Compact, not indent=2: pretty-printing the schema cost 8,700 chars (~2,500
    # tokens) of every single attempt, and on a capped local context window that
    # is output budget the answer never got back. Models read compact JSON
    # Schema fine.
    return system.replace(
        SCHEMA_PLACEHOLDER, json.dumps(rebuild_schema_view(), separators=(",", ":"))
    )


def _brief_fields_by_ds(brief: dict[str, Any]) -> dict[str, set[str]]:
    return {
        str(ds["id"]): {
            str(f["name"]) for f in ds.get("fields") or [] if isinstance(f, dict) and "name" in f
        }
        for ds in brief.get("datasources") or []
        if isinstance(ds, dict) and "id" in ds
    }


def _brief_roles_by_ds(brief: dict[str, Any]) -> dict[str, dict[str, str]]:
    return {
        str(ds["id"]): {
            str(f["name"]): str(f["role"])
            for f in ds.get("fields") or []
            if isinstance(f, dict) and "name" in f and "role" in f
        }
        for ds in brief.get("datasources") or []
        if isinstance(ds, dict) and "id" in ds
    }


def _brief_calculations(brief: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """name -> calculation entry across every brief datasource."""
    calcs: dict[str, dict[str, Any]] = {}
    for ds in brief.get("datasources") or []:
        for c in ds.get("calculations") or []:
            if isinstance(c, dict) and "name" in c:
                calcs[str(c["name"])] = c
    return calcs


def _undeclared_calc_hints(
    spec: dict[str, Any],
    translation: list[Any],
    calc_ds_by_name: dict[str, str],
) -> dict[str, dict[str, str]]:
    """ds_id -> {brief calc name -> translation status} for every brief calc the
    spec does NOT declare under that datasource's calculated_fields. Feeds the
    cross-check's targeted error for a shelf reference to one of them (a brief
    calc the model left undeclared — correctly, for needs_review — but still
    put on a shelf because the brief element used it). Status is "(no
    translation entry)" when the report omitted the calc altogether."""
    declared: set[str] = {
        str(c["name"])
        for ds in spec.get("datasources") or []
        if isinstance(ds, dict)
        for c in ds.get("calculated_fields") or []
        if isinstance(c, dict) and "name" in c
    }
    status_by_name: dict[str, str] = {}
    for entry in translation:
        if isinstance(entry, dict) and "name" in entry:
            status_by_name[str(entry["name"])] = str(entry.get("status", "?"))
    out: dict[str, dict[str, str]] = {}
    for name, ds_id in calc_ds_by_name.items():
        if name in declared:
            continue
        out.setdefault(ds_id, {})[name] = status_by_name.get(
            name, "(no translation entry)"
        )
    return out


def _brief_calc_ds_by_name(brief: dict[str, Any]) -> dict[str, str]:
    """calc name -> owning brief datasource id (first occurrence wins), so a
    deterministically-injected calculated field lands under the right
    datasource."""
    out: dict[str, str] = {}
    for ds in brief.get("datasources") or []:
        if not isinstance(ds, dict) or "id" not in ds:
            continue
        ds_id = str(ds["id"])
        for c in ds.get("calculations") or []:
            if isinstance(c, dict) and "name" in c:
                out.setdefault(str(c["name"]), ds_id)
    return out


#: Formula tokens that mark an aggregate (measure-returning) calculation. Used
#: only to pick a schema-valid role/datatype for a synthesized calc field — the
#: field is normally unreferenced (a referenced-but-undeclared calc trips the
#: earlier field cross-check first), so a wrong guess never reaches the compiler.
_AGGREGATE_TOKENS = (
    "SUM", "COUNT", "COUNTD", "AVG", "AVERAGE", "MIN", "MAX", "MEDIAN",
    "TOTAL", "STDEV", "STDEVP", "VAR", "VARP", "SUMX", "COUNTX", "AVERAGEX",
)


#: Row-level functions whose result is a date/timestamp. A synthesized calc that
#: is really a date-grouping column (`DATE_TRUNC('MONTH', `Order Date`)` — the
#: exact shape the prompt tells the model to write, because this target has no
#: shelf-level date_part) must land with a temporal datatype: the compiler picks
#: the encoding's `scale.type` from it, so `string` turns a time axis into a
#: categorical one that sorts alphabetically.
_TEMPORAL_TOP_LEVEL: dict[str, str] = {
    "DATE_TRUNC": "datetime",
    "TO_DATE": "date",
    "DATE_ADD": "date",
    "DATEADD": "datetime",
    "TO_TIMESTAMP": "datetime",
}
_TOP_LEVEL_CALL_RE = re.compile(r"\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(")
_TOP_LEVEL_CAST_RE = re.compile(
    r"\s*CAST\s*\(.*\bAS\s+(DATE|TIMESTAMP(?:_NTZ|_LTZ)?)\s*\)\s*$",
    re.IGNORECASE | re.DOTALL,
)


def _temporal_datatype(formula: str) -> str | None:
    """`date`/`datetime` when the formula's TOP-LEVEL call returns one, else None.

    Top-level only: `YEAR(DATE_TRUNC(...))` returns an integer, and
    `CONCAT(TO_DATE(x), '!')` a string — looking anywhere in the formula would
    mislabel both.
    """
    cast = _TOP_LEVEL_CAST_RE.match(formula or "")
    if cast is not None:
        return "date" if cast.group(1).upper() == "DATE" else "datetime"
    call = _TOP_LEVEL_CALL_RE.match(formula or "")
    if call is None:
        return None
    return _TEMPORAL_TOP_LEVEL.get(call.group(1).upper())


def _infer_calc_role_datatype(
    formula: str, brief_calc: dict[str, Any] | None
) -> tuple[str, str]:
    """Best-effort (role, datatype) for a synthesized calculated field:
    aggregation-looking formulas (or a brief 'aggregation' derivation) are
    measures returning a real; a row-level formula that returns a date/timestamp
    is a temporal dimension; everything else a string dimension."""
    upper = (formula or "").upper()
    deriv: list[str] = []
    if isinstance(brief_calc, dict) and isinstance(brief_calc.get("derivation_type"), list):
        deriv = [str(x).lower() for x in brief_calc["derivation_type"]]
    is_aggregate = "aggregation" in deriv or any(
        f"{token}(" in upper for token in _AGGREGATE_TOKENS
    )
    if is_aggregate:
        return ("measure", "real")
    temporal = _temporal_datatype(formula)
    return ("dimension", temporal or "string")


def _reconcile_translation_calcs(
    spec: dict[str, Any],
    translation: list[Any],
    brief_calcs: dict[str, dict[str, Any]],
    calc_ds_by_name: dict[str, str],
    target: str,
) -> None:
    """Deterministically reconcile the translation report with the spec's
    calculated_fields, in the repair-don't-retry spirit of _coerce_envelope and
    spec_author._inject_calculated_fields: a brief calc reported
    'translated'/'approximated' — with its target-language formula right there in
    the entry — but missing from every datasource's calculated_fields is
    synthesized and injected under its owning datasource. This absorbs the
    dominant local-model rebuild failure (the report author declares the field in
    the translation but forgets the spec) without burning a retry or failing the
    whole build. Idempotent: runs every attempt and is a no-op once the model
    declares the field itself. Entries the model got right, entries with no
    formula to synthesize from, and skipped/needs_review entries are left for the
    validator to judge."""
    contract = _target_contract(target)
    formula_key = contract["formula_key"]
    expected_language = contract["formula_language"]

    spec_ds = [ds for ds in spec.get("datasources") or [] if isinstance(ds, dict)]
    if not spec_ds:
        return
    ds_by_id = {str(ds.get("id")): ds for ds in spec_ds}
    declared: set[str] = {
        str(c["name"])
        for ds in spec_ds
        for c in ds.get("calculated_fields") or []
        if isinstance(c, dict) and "name" in c
    }
    for entry in translation:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name", ""))
        if (
            name in declared
            or name not in brief_calcs
            or entry.get("status") not in DECLARED_STATUSES
        ):
            continue
        formula = entry.get(formula_key)
        if not isinstance(formula, str) or not formula.strip():
            continue  # nothing to synthesize from — a real error the validator keeps
        role, datatype = _infer_calc_role_datatype(formula, brief_calcs.get(name))
        target_ds = ds_by_id.get(calc_ds_by_name.get(name, "")) or spec_ds[0]
        existing = target_ds.get("calculated_fields")
        if not isinstance(existing, list):
            existing = []
            target_ds["calculated_fields"] = existing
        existing.append({
            "name": name,
            "formula": formula,
            "datatype": datatype,
            "role": role,
            "formula_language": expected_language,
        })
        declared.add(name)


def _coerce_envelope(raw: Any) -> Any:
    """Deterministically repair classic model envelope mistakes before
    validation: an omitted translation (legitimate when the brief has no
    calculations — _validate_translation still enforces coverage when it has
    some), double-JSON-encoded values, a bare DashboardSpec at the root, and a
    translation object keyed by calc name. Unrecognized shapes pass through
    untouched for _validate_envelope to reject."""
    if not isinstance(raw, dict):
        return raw
    out = dict(raw)
    for key in ("spec", "translation"):
        value = out.get(key)
        if isinstance(value, str):
            try:
                out[key] = json.loads(value)
            except ValueError:
                pass
    if "spec" not in out and {"workbook", "worksheets"} <= set(out):
        translation = out.pop("translation", None)
        out = {"spec": out, "translation": translation}
    translation = out.get("translation")
    if translation is None:
        out["translation"] = []
    elif isinstance(translation, dict):
        entries = []
        for name, entry in translation.items():
            if isinstance(entry, dict):
                entries.append(entry if "name" in entry else {"name": name, **entry})
        out["translation"] = entries
    return out


def _user_blocks(
    payload_json: str, images: list[dict[str, Any]] | None
) -> str | list[dict[str, Any]]:
    """Text-only payloads stay plain strings (unchanged token accounting); with
    screenshots the content becomes Anthropic-style blocks — LlmClient already
    translates these for Ollama vision models (client.py user_content handling)."""
    if not images:
        return payload_json
    blocks: list[dict[str, Any]] = [{"type": "text", "text": payload_json}]
    for img in images:
        blocks.append({
            "type": "text",
            "text": f"Rendered screenshot of dashboard '{img['element']}':",
        })
        blocks.append({
            "type": "image",
            "source": {"type": "base64", "media_type": img["media_type"], "data": img["data"]},
        })
    return blocks


def _validate_envelope(raw: Any) -> list[str]:
    if not isinstance(raw, dict):
        return ["response must be a JSON object with 'spec' and 'translation' keys"]
    errors: list[str] = []
    if not isinstance(raw.get("spec"), dict):
        errors.append("'spec' must be a JSON object (the DashboardSpec)")
    if not isinstance(raw.get("translation"), list):
        errors.append("'translation' must be a list of translation entries")
    return errors


def _validate_translation(
    translation: list[Any],
    brief_calcs: dict[str, dict[str, Any]],
    spec: dict[str, Any],
    target: str = "databricks",
) -> list[str]:
    """The report must cover every brief calculation exactly once with an honest
    status, and declared statuses must actually be declared in the spec — as
    calculated fields written in the target's formula language."""
    contract = _target_contract(target)
    formula_key = contract["formula_key"]
    expected_language = contract["formula_language"]
    errors: list[str] = []
    seen: dict[str, int] = {}
    declared: dict[str, dict[str, Any]] = {
        str(c["name"]): c
        for ds in spec.get("datasources") or []
        for c in ds.get("calculated_fields") or []
        if isinstance(c, dict) and "name" in c
    }
    for entry in translation:
        if not isinstance(entry, dict):
            errors.append("every translation entry must be an object")
            continue
        name = str(entry.get("name", ""))
        seen[name] = seen.get(name, 0) + 1
        if name not in brief_calcs:
            errors.append(
                f"translation entry {name!r} is not a calculation in the brief; "
                f"brief calculations: {sorted(brief_calcs)}"
            )
            continue
        status = entry.get("status")
        if status not in TRANSLATION_STATUSES:
            errors.append(
                f"translation entry {name!r} has invalid status {status!r}; "
                f"allowed: {list(TRANSLATION_STATUSES)}"
            )
            continue
        if status in DECLARED_STATUSES:
            if not entry.get(formula_key):
                errors.append(f"translation entry {name!r} ({status}) needs {formula_key!r}")
            if name not in declared:
                errors.append(
                    f"translation entry {name!r} is {status} but not declared under any "
                    "datasource's calculated_fields"
                )
            else:
                language = declared[name].get("formula_language") or "tableau_calc"
                if language != expected_language:
                    errors.append(
                        f"translation entry {name!r} is declared with "
                        f"formula_language {language!r}; the {target} target "
                        f"requires {expected_language!r}"
                    )
        else:
            if not entry.get("reason"):
                errors.append(f"translation entry {name!r} ({status}) needs a 'reason'")
            if name in declared:
                errors.append(
                    f"translation entry {name!r} is {status} and must NOT be declared "
                    "in the spec's calculated_fields"
                )
    for name, count in seen.items():
        if count > 1:
            errors.append(f"translation entry {name!r} appears {count} times; exactly once required")
    for name in brief_calcs:
        if name not in seen:
            errors.append(f"brief calculation {name!r} is missing from the translation report")
    return errors


def _calc_language_errors(spec: dict[str, Any], target: str) -> list[str]:
    """Every declared calculated field must be written in the target's formula
    language — the compiler for that target rejects anything else."""
    expected = _target_contract(target)["formula_language"]
    errors: list[str] = []
    for ds in spec.get("datasources") or []:
        if not isinstance(ds, dict):
            continue
        for calc in ds.get("calculated_fields") or []:
            if not isinstance(calc, dict):
                continue
            language = calc.get("formula_language") or "tableau_calc"
            if language != expected:
                errors.append(
                    f"calculated field {calc.get('name')!r} in datasource "
                    f"{ds.get('id')!r} has formula_language {language!r}; the "
                    f"{target} target requires {expected!r} on every calculated field"
                )
    return errors


#: A Tableau/DAX field reference that survived into a "Databricks SQL" answer.
#: sqlglot's databricks reader happily parses `SUM([Sales])` — as
#: `SUM(ARRAY(Sales))` — so a parse alone would wave the commonest
#: untranslated-formula failure straight through to the compiler. The pattern is
#: deliberately narrow (identifier characters and spaces only) so real array
#: indexing (`col[0]`, `map['key']`, `arr[i + 1]`) never trips it, and the
#: lookbehind rejects a bracket that FOLLOWS a value — `arr[idx]`,
#: `` `m`[key] ``, `SPLIT(s, ',')[part]` are subscripts, and a Tableau reference
#: never sits directly after an identifier character, `]`, `)` or a quoted run.
_BRACKET_REF_RE = re.compile(r"(?<![A-Za-z0-9_\]\)\x00])\[[A-Za-z_][A-Za-z0-9_ ]*\]")

#: A quoted SQL run — single-quoted literal or backticked identifier. Masked out
#: (character for character, so offsets survive) before the bracket hunt, or
#: `'[Unassigned]'` reads as a field reference and correct SQL costs a retry.
#: Mirrors compiler/lakeview.py::_SQL_QUOTED_RE, which does the same thing before
#: hunting `:keyword`s; kept local because that module is a compiler, not a
#: lexical-utility library, and the two hunts want different substitutions.
_SQL_QUOTED_RE = re.compile(r"'(?:[^']|'')*'|`(?:[^`]|``)*`")


def _mask_quoted(sql: str) -> str:
    """Every quoted run replaced by NUL padding of the same length."""
    return _SQL_QUOTED_RE.sub(lambda m: "\x00" * len(m.group(0)), sql)

#: sqlglot dialect for the databricks target's authoring gate — the same one
#: validate/lakeview.py's layer 3 uses, so the loop rejects exactly what the
#: post-compile validator would have failed the whole build over.
SQL_DIALECT = "databricks"


def _sql_expression_error(expression: str, where: str) -> str | None:
    """One authored Databricks SQL expression -> the retry-visible error it
    should produce, or None when it is fine."""
    import sqlglot
    from sqlglot.errors import SqlglotError

    bracket = _BRACKET_REF_RE.search(_mask_quoted(expression))
    if bracket is not None:
        return (
            f"{where}: {bracket.group(0)} is a Tableau/DAX-style field reference, not "
            "Databricks SQL — quote columns with backticks instead (e.g. "
            f"`{bracket.group(0)[1:-1]}`) and rewrite the whole expression as "
            "Databricks SQL"
        )
    try:
        sqlglot.parse_one(expression, read=SQL_DIALECT)
    except SqlglotError as exc:
        return (
            f"{where}: expression does not parse as Databricks SQL "
            f"({str(exc).splitlines()[0]}) — rewrite it"
        )
    except ValueError as exc:
        # sqlglot raises plain ValueErrors for some malformed input
        # (e.g. 'Cannot convert empty name into var.').
        return (
            f"{where}: expression does not parse as Databricks SQL "
            f"({str(exc).splitlines()[0]}) — rewrite it"
        )
    return None


def _sql_gate_errors(spec: dict[str, Any], translation: list[Any]) -> list[str]:
    """Parse every authored SQL expression with sqlglot, INSIDE the retry loop.

    Without this the prompt's promise ("every expression is parsed with sqlglot's
    databricks dialect; anything that does not parse costs a retry") was simply
    untrue: a bad `sql_expression` sailed through authoring, reached
    validate/lakeview.py's layer 3 after compilation, and failed the whole build
    with every retry unspent. Both surfaces are checked — the spec's declared
    calculated fields (what actually compiles) and the translation report's
    `sql_expression` values (what the user reads) — because they can disagree.
    """
    errors: list[str] = []
    for ds in spec.get("datasources") or []:
        if not isinstance(ds, dict):
            continue
        for calc in ds.get("calculated_fields") or []:
            if not isinstance(calc, dict) or calc.get("formula_language") != "sql":
                continue
            formula = calc.get("formula")
            if not isinstance(formula, str) or not formula.strip():
                continue
            error = _sql_expression_error(
                formula,
                f"calculated field {calc.get('name')!r} in datasource {ds.get('id')!r}",
            )
            if error is not None:
                errors.append(error)
    for entry in translation:
        if not isinstance(entry, dict):
            continue
        expression = entry.get("sql_expression")
        if not isinstance(expression, str) or not expression.strip():
            continue
        error = _sql_expression_error(
            expression,
            f"translation entry {str(entry.get('name', ''))!r}: 'sql_expression'",
        )
        if error is not None:
            errors.append(error)
    errors += _databricks_semantic_errors(spec)
    return errors


# ---------------------------------------------- databricks pre-compile gate
#
# Everything below mirrors a compiler/lakeview.py refusal. The compiler runs
# AFTER authoring, so each of these used to detonate the whole build with every
# retry unspent; here they cost one retry and the model gets told what to fix.

#: Chart shelves that hold a single fieldRef, and those that hold a list.
_SINGLE_SHELVES = ("color", "size", "label")
_LIST_SHELVES = ("rows", "cols", "detail", "tooltip", "secondary_rows")


def _formula_aggregates(formula: str) -> bool:
    """True when this Databricks SQL expression contains an aggregate function.

    An unparseable formula answers False: the parse gate above already reported
    it, and one mistake should produce one error.
    """
    import sqlglot
    from sqlglot import exp
    from sqlglot.errors import SqlglotError

    try:
        tree = sqlglot.parse_one(formula, read=SQL_DIALECT)
    except (SqlglotError, ValueError):
        return False
    return tree is not None and any(True for _ in tree.find_all(exp.AggFunc))


def _shelf_refs(chart: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """(shelf name, fieldRef) for every field reference on a chart."""
    refs: list[tuple[str, dict[str, Any]]] = []
    for shelf in _SINGLE_SHELVES:
        value = chart.get(shelf)
        if isinstance(value, dict):
            refs.append((shelf, value))
    for shelf in _LIST_SHELVES:
        for value in chart.get(shelf) or []:
            if isinstance(value, dict):
                refs.append((shelf, value))
    return refs


def _calc_semantic_errors(ds: dict[str, Any]) -> list[str]:
    """One datasource's calculated fields against the compiler's SQL rules."""
    ds_id = ds.get("id")
    declared = sorted(
        str(p.get("name"))
        for p in ds.get("parameters") or []
        if isinstance(p, dict) and p.get("name")
    )
    errors: list[str] = []
    for calc in ds.get("calculated_fields") or []:
        if not isinstance(calc, dict) or calc.get("formula_language") != "sql":
            continue
        formula = calc.get("formula")
        if not isinstance(formula, str) or not formula.strip():
            continue
        where = f"calculated field {calc.get('name')!r} in datasource {ds_id!r}"
        refs = _parameter_refs(formula)
        if calc.get("role") == "measure":
            # An aggregate is a WIDGET expression; only a dataset query binds a
            # parameter, so `:kw` there compiles into something nothing resolves.
            if refs:
                errors.append(
                    f"{where}: an aggregate calculated field may not read parameter(s) "
                    f"{', '.join(':' + n for n in refs)} — only a dataset query binds "
                    "parameters; move the reference into a row-level (dimension) "
                    "calculated field"
                )
            continue
        # A row-level calc is PROJECTED INTO the dataset SELECT, so an aggregate
        # there is a SQL error at dashboard load.
        if _formula_aggregates(formula):
            errors.append(
                f"{where}: role is {calc.get('role')!r} but the formula aggregates — "
                "a row-level calculated field is projected into the dataset SELECT, "
                "where an aggregate is illegal; either drop the aggregate or declare "
                "the field with role 'measure'"
            )
        undeclared = [name for name in refs if name not in declared]
        if undeclared:
            errors.append(
                f"{where}: the formula reads parameter(s) "
                f"{', '.join(':' + n for n in undeclared)}, which are not declared on "
                f"that datasource (declared: {declared}) — an AI/BI parameter is "
                "resolved per dataset, so declare each one in the datasource's "
                "'parameters'"
            )
    return errors


def _parameter_datatype_errors(spec: dict[str, Any]) -> list[str]:
    """One keyword declared with two datatypes on datasources ONE PAGE queries
    cannot be one control, and the compiler refuses to guess which wins."""
    ds_by_id = {
        str(ds.get("id")): ds
        for ds in spec.get("datasources") or []
        if isinstance(ds, dict)
    }
    ws_ds = {
        str(ws.get("id")): str(ws.get("datasource"))
        for ws in spec.get("worksheets") or []
        if isinstance(ws, dict)
    }
    pages: list[tuple[str, list[str]]] = []
    on_dashboard: set[str] = set()
    for dash in spec.get("dashboards") or []:
        if not isinstance(dash, dict):
            continue
        ids: list[str] = []
        for zone in dash.get("zones") or []:
            if not isinstance(zone, dict) or zone.get("kind") != "worksheet":
                continue
            ws_id = str(zone.get("worksheet"))
            on_dashboard.add(ws_id)
            ds_id = ws_ds.get(ws_id)
            if ds_id is not None and ds_id not in ids:
                ids.append(ds_id)
        pages.append((f"dashboard {dash.get('title')!r}", ids))
    for ws_id, ds_id in ws_ds.items():
        if ws_id not in on_dashboard:
            pages.append((f"worksheet {ws_id!r}", [ds_id]))

    errors: list[str] = []
    for where, ds_ids in pages:
        seen: dict[str, str] = {}
        for ds_id in ds_ids:
            ds = ds_by_id.get(ds_id)
            if ds is None:
                continue
            for param in ds.get("parameters") or []:
                if not isinstance(param, dict):
                    continue
                name, datatype = str(param.get("name")), str(param.get("datatype"))
                first = seen.setdefault(name, datatype)
                if first != datatype:
                    errors.append(
                        f"{where}: parameter {name!r} is declared as {first!r} and as "
                        f"{datatype!r} on datasources this page queries — one "
                        "parameter control cannot bind two datatypes; rename one"
                    )
    return list(dict.fromkeys(errors))


def _databricks_semantic_errors(spec: dict[str, Any]) -> list[str]:
    """Every compiler refusal this target can see before compiling: aggregates
    in row-level calcs, undeclared/misplaced `:keyword`s, shelf date_parts and
    relative_date filters."""
    errors: list[str] = []
    for ds in spec.get("datasources") or []:
        if isinstance(ds, dict):
            errors += _calc_semantic_errors(ds)
    errors += _parameter_datatype_errors(spec)

    def _filter_errors(where: str, filters: Any) -> None:
        for filt in filters or []:
            if not isinstance(filt, dict):
                continue
            field = filt.get("field")
            if filt.get("filter_type") == "relative_date":
                errors.append(
                    f"{where}: relative_date filter on {field!r} cannot be emitted by "
                    "the databricks target — express the window as a row-level SQL "
                    "calculated column (e.g. `Order Date` >= "
                    "DATE_SUB(CURRENT_DATE(), 90)) and filter on that instead"
                )
            if filt.get("date_part"):
                errors.append(
                    f"{where}: date_part {filt.get('date_part')!r} on filter field "
                    f"{field!r} is not supported by the databricks target — declare a "
                    "SQL calculated column (e.g. DATE_TRUNC('MONTH', `Order Date`)) "
                    "and filter on that instead"
                )

    for ws in spec.get("worksheets") or []:
        if not isinstance(ws, dict):
            continue
        where_ws = f"worksheet {str(ws.get('title') or ws.get('id'))!r}"
        chart = ws.get("chart")
        if isinstance(chart, dict):
            for shelf, ref in _shelf_refs(chart):
                if ref.get("date_part"):
                    errors.append(
                        f"{where_ws}: date_part {ref.get('date_part')!r} on "
                        f"{str(ref.get('field'))!r} ({shelf} shelf) is not supported "
                        "by the databricks target — declare a SQL calculated column "
                        "(e.g. DATE_TRUNC('MONTH', `Order Date`)) and reference it "
                        "instead"
                    )
        _filter_errors(where_ws, ws.get("filters"))
    for dash in spec.get("dashboards") or []:
        if isinstance(dash, dict):
            _filter_errors(
                f"dashboard {str(dash.get('title') or dash.get('id'))!r}",
                dash.get("shared_filters"),
            )
    return errors


def _observed_layouts(brief: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Dashboard title (lowercased, workbook prefix stripped) -> observed layout.
    Brief element names may be 'Workbook / Dash' display names — match on the
    final segment."""
    out: dict[str, dict[str, Any]] = {}
    for el in (brief.get("report") or {}).get("elements") or []:
        layout = el.get("layout") if isinstance(el, dict) else None
        if not isinstance(layout, dict) or not layout.get("observed"):
            continue
        name = str(el.get("name") or "")
        title = name.split("/")[-1].strip().lower()
        if title:
            out[title] = layout
    return out


def _zone_matches(z: dict[str, Any], obs: dict[str, Any], ws_title: str | None) -> bool:
    if str(obs.get("worksheet") or "").lower() != (ws_title or "").lower():
        return False
    return all(
        abs(float(z.get(k, -1000)) - float(obs.get(k, 1000))) <= ZONE_MATCH_TOLERANCE
        for k in ("x", "y", "w", "h")
    )


def _clamp_zone_confidence(
    spec: dict[str, Any], brief: dict[str, Any], has_images: bool,
) -> None:
    """Provenance-aware confidence (spec 2026-07-27 §6): zones reproducing an
    OBSERVED layout keep observed-grade confidence; screenshot-only runs cap at
    0.8; everything else stays at the invented-layout clamp."""
    observed = _observed_layouts(brief)
    titles = {str(w.get("id")): str(w.get("title") or "") for w in spec.get("worksheets") or []}
    for dash in spec.get("dashboards") or []:
        layout = observed.get(str(dash.get("title") or "").strip().lower())
        obs_zones = (layout or {}).get("zones") or []
        source = (layout or {}).get("source")
        for zone in dash.get("zones") or []:
            if not isinstance(zone, dict):
                continue
            cap = MAX_REBUILD_ZONE_CONFIDENCE
            if layout is not None and zone.get("kind") == "worksheet":
                ws_title = titles.get(str(zone.get("worksheet")))
                match = next((o for o in obs_zones if _zone_matches(zone, o, ws_title)), None)
                if match is not None:
                    if source == "twb":
                        cap = MAX_OBSERVED_ZONE_CONFIDENCE
                    else:  # screenshot_analysis — honor the analyst's own confidence
                        cap = min(float(match.get("confidence") or MAX_SCREENSHOT_ZONE_CONFIDENCE),
                                  MAX_SCREENSHOT_ZONE_CONFIDENCE)
            elif has_images and layout is not None:
                cap = MAX_SCREENSHOT_ZONE_CONFIDENCE
            current = zone.get("confidence")
            if not isinstance(current, (int, float)) or current > cap:
                zone["confidence"] = cap


#: Shelves the schema caps, and the cap. Kept in sync with $defs.chart by
#: test_shelf_caps_match_the_schema.
_SHELF_CAPS = ("rows", "cols")


def trim_overfull_shelves(spec: dict[str, Any]) -> list[str]:
    """Cut rows/cols shelves back to the schema's limit, in place, reporting
    what was dropped (repair-don't-retry, like repair_zones/normalize_zone_grid).

    The prompt asks for minimal shelves ("1-3 fields is normal") and states the
    cap, but a wide source element still draws 7-14 field refs onto one shelf,
    and a schema error the model then reproduces verbatim on every retry burns
    the whole build (observed on the cnx customer intelligence rebuild: 25
    errors, identical across all 3 attempts). Trimming enacts what the prompt
    already asked for and returns a build warning per shelf rather than
    discarding the other 27 worksheets along with it."""
    cap = (
        load_schema().get("$defs", {}).get("chart", {})
        .get("properties", {}).get("rows", {}).get("maxItems")
    )
    warnings: list[str] = []
    if not isinstance(cap, int):
        return warnings
    for ws in spec.get("worksheets") or []:
        chart = ws.get("chart") if isinstance(ws, dict) else None
        if not isinstance(chart, dict):
            continue
        for shelf in _SHELF_CAPS:
            refs = chart.get(shelf)
            if not isinstance(refs, list) or len(refs) <= cap:
                continue
            dropped = [_ref_label(r) for r in refs[cap:]]
            chart[shelf] = refs[:cap]
            warnings.append(
                f"worksheet '{ws.get('id')}' put {len(refs)} fields on '{shelf}' "
                f"(the limit is {cap}); kept the first {cap} and dropped "
                f"{', '.join(dropped)} — add them back in the rebuilt report if "
                "the chart needs them"
            )
    return warnings


def _ref_label(ref: Any) -> str:
    if isinstance(ref, dict):
        return str(ref.get("field") or ref.get("name") or ref)
    return str(ref)


def _layout_fidelity_check(spec: dict[str, Any], brief: dict[str, Any]) -> list[str]:
    """Report-only comparison (never a retry trigger): observed worksheets the
    authored dashboard dropped, and zones drifting past tolerance."""
    warnings: list[str] = []
    observed = _observed_layouts(brief)
    titles = {str(w.get("id")): str(w.get("title") or "") for w in spec.get("worksheets") or []}
    for dash in spec.get("dashboards") or []:
        layout = observed.get(str(dash.get("title") or "").strip().lower())
        if layout is None:
            continue
        zones = [z for z in dash.get("zones") or [] if isinstance(z, dict)]
        for obs in layout.get("zones") or []:
            ws = str(obs.get("worksheet") or "")
            if not ws:
                continue
            placed = [z for z in zones if z.get("kind") == "worksheet"
                      and titles.get(str(z.get("worksheet")), "").lower() == ws.lower()]
            if not placed:
                warnings.append(
                    f"dashboard '{dash.get('title')}': observed worksheet '{ws}' is "
                    f"missing from the authored layout")
            elif not any(_zone_matches(z, obs, ws) for z in placed):
                warnings.append(
                    f"dashboard '{dash.get('title')}': zone for '{ws}' deviates more than "
                    f"{ZONE_MATCH_TOLERANCE:.0f}pp from the observed geometry")
    return warnings


def force_brief_datasources(spec: dict[str, Any], brief: dict[str, Any]) -> None:
    """Deterministically overwrite every spec datasource's connection and raw
    fields with the brief's truth (mirrors generate_from_db forcing
    profile-derived fields): the LLM's job is worksheets/dashboards/calcs, never
    connection details."""
    by_id = {
        str(ds["id"]): ds
        for ds in brief.get("datasources") or []
        if isinstance(ds, dict) and "id" in ds
    }
    for ds in spec.get("datasources") or []:
        src = by_id.get(str(ds.get("id")))
        if src is None:
            continue
        ds["kind"] = "live_database"
        ds.pop("csv", None)
        ds.pop("published", None)
        ds["database"] = copy.deepcopy(src.get("connection"))
        # BI docs can define several local fields over one physical column
        # (same name, different captions/datatypes — e.g. a date column read
        # both as date and as string). The workbook gets ONE column per name,
        # so keep the first occurrence — duplicates would compile last-wins
        # and then fail the round-trip datatype check.
        fields: list[dict[str, Any]] = []
        seen: set[str] = set()
        for f in src.get("fields") or []:
            name = str(f.get("name")) if isinstance(f, dict) else None
            if name is None or name in seen:
                continue
            seen.add(name)
            fields.append(copy.deepcopy(f))
        ds["fields"] = fields


def _retry_prompt_fits(
    system: str,
    payload_json: str,
    images: list[dict[str, Any]] | None,
    previous: dict[str, Any],
) -> bool:
    """Can this retry prompt still leave room for a complete answer?

    Only Ollama has a window small enough to care (Claude's is 200k), so the
    Claude path always keeps ``previous_attempt``. The room demanded is the size
    of the previous attempt itself: the model is being asked to re-emit an
    object of roughly that size, so a window that cannot hold one is a window
    that should be spending its tokens on the answer rather than on a copy of
    the last one. Floored at the client's own 4,096-token refusal threshold."""
    if provider_from_env() != "ollama":
        return True
    needed = max(
        4096, estimate_prompt_tokens("", json.dumps(previous, separators=(",", ":")))
    )
    est = estimate_prompt_tokens(system, payload_json, len(images or []))
    return est + needed <= ollama_num_ctx_cap_from_env()


#: How many never-referenced columns a datasource keeps in the MODEL'S COPY of
#: the brief. The referenced ones are always kept in full; this is the tail the
#: model may draw on for a judgement call (a better label, a missing dimension).
#: Sized to bound a wide table (the cnx report's 171-column model drops to 92)
#: while leaving the model somewhere to look; not tuned against a corpus.
BRIEF_UNREFERENCED_FIELD_TAIL = 40


def _referenced_field_names(brief: dict[str, Any]) -> str:
    """Everything the brief says about what its elements actually use, as one
    blob to test field names against.

    Substring matching over everything but the field list itself, deliberately:
    element field lists, calculation formulas, observed visual/layout blocks and
    free-text notes all name fields in different syntaxes ("Close Date",
    [Close Date], sum:Close Date:qk). Matching too generously keeps a field that
    could have been dropped; matching too precisely drops one the model needed.
    Only the first is recoverable."""
    parts: list[str] = [json.dumps(brief.get("report") or {}, default=str)]
    for ds in brief.get("datasources") or []:
        if isinstance(ds, dict):
            # Everything about the datasource EXCEPT the field list being
            # filtered: calculations, parameters, notes, connection and any key
            # a later brief_version adds. Anything that names a column keeps it.
            parts.append(
                json.dumps({k: v for k, v in ds.items() if k != "fields"}, default=str)
            )
    return "\n".join(parts)


def prompt_brief(brief: dict[str, Any]) -> dict[str, Any]:
    """The brief as the MODEL sees it: referenced columns first, the rest capped.

    A rebuild brief carries every column of every table, but the elements use a
    fraction of them — the cnx customer intelligence report referenced 47 of
    171, and the other 124 cost 10,232 characters (~2,900 tokens) of a prompt
    whose answer then had nowhere to go. The model is never asked to echo the
    field list back (prompt rule 2), so those columns bought nothing.

    Only the prompt copy is trimmed. ``force_brief_datasources`` and every
    cross-check still read the FULL brief, so the compiled datasource keeps
    declaring all 171 columns and a worksheet may still legitimately reference
    one that was trimmed — it just has to have been named somewhere in the
    brief for the model to know about it. Untrimmed briefs are returned with
    their datasources unchanged."""
    referenced = _referenced_field_names(brief)
    out = dict(brief)
    datasources: list[Any] = []
    for ds in brief.get("datasources") or []:
        fields = ds.get("fields") if isinstance(ds, dict) else None
        if not isinstance(ds, dict) or not isinstance(fields, list):
            datasources.append(ds)
            continue
        kept: list[Any] = []
        tail: list[Any] = []
        for f in fields:
            name = str(f.get("name", "")) if isinstance(f, dict) else ""
            (kept if name and name in referenced else tail).append(f)
        dropped = len(tail) - BRIEF_UNREFERENCED_FIELD_TAIL
        if dropped <= 0:
            datasources.append(ds)
            continue
        trimmed = dict(ds)
        trimmed["fields"] = kept + tail[:BRIEF_UNREFERENCED_FIELD_TAIL]
        # Say what was withheld and why, so a model that cannot find the column
        # it wants asks for the closest listed one instead of inventing a name
        # the cross-check will reject.
        trimmed["fields_note"] = (
            f"{dropped} further column(s) of this table are not listed here because no "
            "element references them; they still exist in the connection. Use the "
            "columns listed above."
        )
        datasources.append(trimmed)
    out["datasources"] = datasources
    return out


def author_rebuild_spec(
    brief: dict[str, Any],
    *,
    workbook_name: str | None,
    instructions: str | None,
    llm: LlmClient,
    settings: Settings,
    target: str = "databricks",
    images: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Author {"spec", "translation", "warnings"} from a rebuild brief, retrying
    with validator errors fed back, up to settings.max_spec_retries attempts.
    "warnings" is the layout fidelity check against any brief-observed layout
    (empty when the brief has none). When ``images`` (captured dashboard
    screenshots) are supplied, the LLM user content is a labelled block list
    instead of plain JSON text — see ``_user_blocks``."""
    _target_contract(target)
    fields_by_ds = _brief_fields_by_ds(brief)
    roles_by_ds = _brief_roles_by_ds(brief)
    brief_calcs = _brief_calculations(brief)
    calc_ds_by_name = _brief_calc_ds_by_name(brief)

    # Fail fast, before any paid Claude call: a brief with NO datasources cannot
    # produce a valid spec at all (every worksheet must reference one), so the
    # model would burn every retry authoring something the validator refuses. The
    # real-world source is a report container the catalog resolved no datasource
    # for — say that, rather than charging three LLM calls to discover it.
    if not fields_by_ds:
        raise ValueError(
            "brief has no datasources — a rebuild spec needs at least one "
            "(every worksheet references a datasource by id). The catalogued "
            "report resolved no datasource: re-run extraction for it, or pick a "
            "report whose datasources are catalogued."
        )
    # The schema caps datasources at 8 and the cross-check demands a bijection
    # with brief datasource ids, so an oversized brief can never validate no
    # matter how many retries burn.
    if len(fields_by_ds) > 8:
        raise ValueError(
            f"brief has {len(fields_by_ds)} datasources; the rebuild spec supports "
            "at most 8 — reduce the model's tables or split the report"
        )

    system = render_system_prompt(target)
    payload: dict[str, Any] = {"brief": prompt_brief(brief)}
    if workbook_name:
        payload["workbook_name"] = workbook_name
    if instructions:
        payload["instructions"] = instructions

    attempts = max(1, settings.max_spec_retries)
    user_content = _user_blocks(json.dumps(payload, separators=(",", ": ")), images)
    last_errors: list[str] = []
    last_raw: dict[str, Any] | None = None
    repair_warnings: list[str] = []
    field_resolutions: list[dict[str, Any]] = []

    for attempt in range(1, attempts + 1):
        raw: dict[str, Any] | None
        try:
            raw = llm.call_json(
                system=system,
                user_content=user_content,
                model=settings.model,
                effort=settings.effort,
                fallback_model=settings.fallback_model,
                purpose="rebuild_author",
            )
        except LlmJsonError as exc:
            raw = None
            errors = [
                "response was not a single parseable JSON object; "
                f"return exactly one JSON object (parser said: {exc.args[0].splitlines()[0]})"
            ]
        else:
            raw = _coerce_envelope(raw)
            errors = _validate_envelope(raw)
            if not errors:
                spec = raw["spec"]
                if isinstance(spec, dict):
                    prune_unknown_root_keys(spec)
                    # Identifiers are canonicalized BEFORE the brief is forced in:
                    # force_brief_datasources binds spec datasources to brief ones
                    # by id, so a datasource the model called 'world-indicators'
                    # has to become 'world_indicators' first or it silently fails
                    # to bind and then fails validation for a missing connection.
                    # Casing first: repair_zones decides what a zone is by its `kind`,
                    # so 'Text' has to become 'text' before that repair can salvage
                    # the zone's caption. Then near-miss shelf keys, stray keys and
                    # duplicate titles — each mechanical to undo, and each formerly a
                    # whole retry (or, for titles, a compile failure after the last one).
                    repair_enums(spec)
                    repair_identifiers(spec)
                    repair_zones(spec)
                    normalize_zone_grid(spec)
                    repair_warnings = repair_unknown_keys(spec) + trim_overfull_shelves(spec)
                    repair_titles(spec)
                force_brief_datasources(spec, brief)
                errors = validate_spec(spec)
                if not errors:
                    # Deterministically inject any calc the translation reports
                    # as translated/approximated but the spec forgot to declare,
                    # BEFORE the cross-check so worksheet references to it pass.
                    _reconcile_translation_calcs(
                        spec, raw["translation"], brief_calcs, calc_ds_by_name, target
                    )
                    # A near-miss field name ('region' for 'Region') is a rename
                    # the resolver already knows how to make; renaming here means
                    # the cross-check below only reports names that match nothing.
                    field_resolutions = [
                        r.to_dict() for r in canonicalize_field_names(spec)
                    ]
                if not errors:
                    # Language is checked by _calc_language_errors below.
                    errors = _cross_check_fields_multi(
                        spec, fields_by_ds, roles_by_ds,
                        check_tableau_language=False,
                        undeclared_calc_hints=_undeclared_calc_hints(
                            spec, raw["translation"], calc_ds_by_name
                        ),
                    )
                if not errors:
                    errors = _calc_language_errors(spec, target)
                if not errors and target == "databricks":
                    # sqlglot parses every authored expression HERE, so a bad one
                    # costs a retry instead of failing the build at post-compile
                    # validation.
                    errors = _sql_gate_errors(spec, raw["translation"])
                if not errors:
                    errors = _validate_translation(
                        raw["translation"], brief_calcs, spec, target
                    )

        if not errors:
            assert raw is not None
            _clamp_zone_confidence(raw["spec"], brief, has_images=bool(images))
            fidelity = _layout_fidelity_check(raw["spec"], brief)
            logger.info("rebuild spec authored on attempt %d/%d", attempt, attempts)
            return {
                "spec": raw["spec"],
                "translation": raw["translation"],
                "warnings": repair_warnings + fidelity,
                "field_resolutions": field_resolutions,
            }

        last_errors, last_raw = errors, raw
        logger.info(
            "rebuild attempt %d/%d failed validation with %d error(s): %s",
            attempt, attempts, len(errors), "; ".join(errors[:3]),
        )
        retry_payload = dict(payload)
        retry_payload["previous_attempt"] = raw
        # Bounded: a pathological attempt can produce dozens of errors, and the
        # retry prompt must stay within the (local-model) context window.
        retry_payload["validation_errors"] = errors[:20] + (
            [f"(+{len(errors) - 20} more errors omitted)"] if len(errors) > 20 else []
        )
        retry_payload["instruction"] = (
            "Your previous response failed validation. Fix every listed error and "
            "return the complete corrected JSON object with 'spec' and 'translation'."
        )
        # Same budget concern for the prior output itself: embedding a huge
        # previous_attempt on top of a big brief is how retries blow the window
        # mid-generation (observed: a kept-prev retry left ~2.8k tokens of output
        # room and truncated). The old guard measured the PAYLOAD against 60k
        # chars, which ignored the system prompt (36k chars on the databricks
        # target) and every attached image — so it kept a previous_attempt that
        # pushed run ee362cc4 to ~29k tokens of a 32,768 window and the call was
        # refused before it was sent. Measure the whole prompt the way the client
        # will, and drop the prior attempt when it does not leave room for a
        # complete answer. The validator errors alone still say what to fix.
        retry_json = json.dumps(retry_payload, separators=(",", ": "))
        if raw is not None and not _retry_prompt_fits(system, retry_json, images, raw):
            retry_payload.pop("previous_attempt", None)
            retry_payload["validation_errors"] = list(
                retry_payload["validation_errors"]
            ) + ["(previous attempt omitted for size — regenerate the full corrected object)"]
            retry_json = json.dumps(retry_payload, separators=(",", ": "))
        user_content = _user_blocks(retry_json, images)

    raise RebuildAuthoringError(
        f"failed to author a valid rebuild spec after {attempts} attempt(s)",
        errors=last_errors,
        raw=last_raw,
    )
