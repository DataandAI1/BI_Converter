"""JSON Schema gate for DashboardSpec — the contract the LLM output must pass."""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).parent / "dashboard_spec_v1.schema.json"


class SpecValidationError(ValueError):
    """Raised when a spec fails JSON Schema validation. Carries all errors for LLM retry feedback."""

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__("DashboardSpec failed schema validation:\n" + "\n".join(errors))


@lru_cache(maxsize=1)
def load_schema() -> dict[str, Any]:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    return Draft202012Validator(load_schema())


def normalize_zone_grid(spec: dict[str, Any]) -> None:
    """Rescale out-of-bounds dashboard zone geometry onto the 0-100 grid, in place.

    Smaller local models frequently lay zones out in pixels or stacked rows
    (y=130, 160, …) despite the prompt's percentage contract. The relative
    layout is still meaningful — project it linearly onto the grid instead of
    failing authoring over geometry arithmetic can fix. In-bounds layouts are
    untouched; zones with non-numeric coordinates are left for validation.
    """
    for dash in spec.get("dashboards") or []:
        if not isinstance(dash, dict):
            continue
        zones = [
            z
            for z in dash.get("zones") or []
            if isinstance(z, dict)
            and all(isinstance(z.get(k), (int, float)) for k in ("x", "y", "w", "h"))
        ]
        if not zones:
            continue
        for axis, size in (("x", "w"), ("y", "h")):
            low = min(z[axis] for z in zones)
            if low < 0:
                for z in zones:
                    z[axis] -= low
            extent = max(z[axis] + z[size] for z in zones)
            if extent > 100:
                scale = 100 / extent
                for z in zones:
                    z[axis] = round(z[axis] * scale, 2)
                    z[size] = round(z[size] * scale, 2)


#: Longest schema-legal identifier (pattern is ^[a-z][a-z0-9_]{0,63}$).
_MAX_ID_LEN = 64
#: Near-miss keys a model reaches for instead of a text zone's `text`.
_ZONE_TEXT_ALIASES = ("content", "label", "title", "caption", "value")


@lru_cache(maxsize=1)
def _identifier_re() -> re.Pattern[str]:
    return re.compile(load_schema()["$defs"]["identifier"]["pattern"])


def _slugify_identifier(value: str) -> str:
    """Arbitrary model text -> a schema-legal snake_case identifier."""
    slug = re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")
    if not slug:
        return "id"
    if slug[0].isdigit():
        slug = f"id_{slug}"
    return slug[:_MAX_ID_LEN].rstrip("_") or "id"


def _canonicalize_ids(items: Any, title_key: str) -> dict[str, str]:
    """Slugify one collection's ids in place; return every name that should
    resolve to the final id (original id, its slug, and the object's title)."""
    objects = [i for i in items or [] if isinstance(i, dict)]
    # Reserve ids that are already legal first, so a slugified sibling can never
    # steal one and silently re-point its references.
    taken = {
        i["id"]
        for i in objects
        if isinstance(i.get("id"), str) and _identifier_re().match(i["id"])
    }
    lookup: dict[str, str] = {}
    for obj in objects:
        old = obj.get("id")
        if not isinstance(old, str):
            continue
        if _identifier_re().match(old):
            final = old
        else:
            base = _slugify_identifier(old)
            final, n = base, 2
            while final in taken:
                final = f"{base[: _MAX_ID_LEN - 3]}_{n}"
                n += 1
            taken.add(final)
            obj["id"] = final
        lookup[old] = final
        lookup.setdefault(_slugify_identifier(old), final)
        title = obj.get(title_key)
        if isinstance(title, str) and title.strip():
            lookup.setdefault(_slugify_identifier(title), final)
    return lookup


def repair_identifiers(spec: dict[str, Any]) -> None:
    """Make every id schema-legal and every id reference point at a real object,
    in place.

    Two model habits break the identifier contract, and undoing them is
    mechanical — cheaper and more reliable than spending an authoring retry:

    * a definition id that isn't snake_case ('platform-overview'), and
    * a dashboard zone naming its worksheet by TITLE rather than id ('Ease of
      Biz Correlation Sheet') — the single largest error class in real
      local-model output (21 of 59 schema errors across three sampled specs).

    Definition ids (datasource/worksheet/dashboard) are slugified and kept
    unique; the reference sites (worksheet.datasource, zone.worksheet) are
    rewritten to match, resolving by original id, slug, or title. A reference
    that resolves to nothing is left as-is for repair_zones to downgrade or the
    validator to report — guessing which worksheet was meant would be inventing
    layout, not repairing it.
    """
    ds_lookup = _canonicalize_ids(spec.get("datasources"), "name")
    ws_lookup = _canonicalize_ids(spec.get("worksheets"), "title")
    _canonicalize_ids(spec.get("dashboards"), "title")

    def resolve(value: Any, lookup: dict[str, str]) -> Any:
        if not isinstance(value, str):
            return value
        return lookup.get(value) or lookup.get(_slugify_identifier(value)) or value

    for ws in spec.get("worksheets") or []:
        if isinstance(ws, dict) and "datasource" in ws:
            ws["datasource"] = resolve(ws["datasource"], ds_lookup)
    for dash in spec.get("dashboards") or []:
        if not isinstance(dash, dict):
            continue
        for zone in dash.get("zones") or []:
            if isinstance(zone, dict) and "worksheet" in zone:
                zone["worksheet"] = resolve(zone["worksheet"], ws_lookup)


def repair_zones(spec: dict[str, Any]) -> None:
    """Give every dashboard zone the shape its ``kind`` requires, in place.

    The zone schema is conditional — a 'worksheet' zone must carry ``worksheet``,
    a 'text' zone must carry ``text`` — and additionalProperties is false, so a
    zone that files its caption under ``label``, omits ``kind``, or points at a
    worksheet that doesn't exist fails validation several times over. Repair what
    is unambiguous, then downgrade whatever is left to 'blank': the slot keeps
    its place in the layout and nothing is invented.
    """
    allowed = set(load_schema()["$defs"]["zone"]["properties"])
    known_ws = {
        ws["id"]
        for ws in spec.get("worksheets") or []
        if isinstance(ws, dict) and isinstance(ws.get("id"), str)
    }
    for dash in spec.get("dashboards") or []:
        if not isinstance(dash, dict):
            continue
        for zone in dash.get("zones") or []:
            if not isinstance(zone, dict):
                continue
            # Salvage a caption filed under a near-miss key, but only for zones
            # that aren't already a working worksheet zone — a worksheet zone's
            # stray 'title' is noise, not the text of a text zone.
            wants_text = zone.get("kind") == "text" or (
                zone.get("kind") is None and not isinstance(zone.get("worksheet"), str)
            )
            if wants_text and not isinstance(zone.get("text"), str):
                for alias in _ZONE_TEXT_ALIASES:
                    value = zone.get(alias)
                    if isinstance(value, str) and value.strip():
                        zone["text"] = value
                        break
            # additionalProperties is false, and an explicit null means "absent".
            for key in [k for k, v in list(zone.items()) if k not in allowed or v is None]:
                zone.pop(key, None)

            has_ws = zone.get("worksheet") in known_ws
            has_text = isinstance(zone.get("text"), str) and bool(zone["text"].strip())
            if not has_ws:
                # A dangling reference would fail the compiler's worksheet lookup
                # even if the schema let it through.
                zone.pop("worksheet", None)
            kind = zone.get("kind")
            if (
                kind not in ("worksheet", "text", "blank")
                or (kind == "worksheet" and not has_ws)
                or (kind == "text" and not has_text)
            ):
                zone["kind"] = "worksheet" if has_ws else ("text" if has_text else "blank")


def prune_unknown_root_keys(spec: dict[str, Any]) -> None:
    """Salvage a spec whose only sin is extra keys at the root, in place.

    Smaller local models place ``shared_filters`` at the spec root instead of
    inside a dashboard — when there is exactly one dashboard the intent is
    unambiguous, so relocate it (unless that dashboard already declares its
    own). Any other unknown root key is dropped: the root schema is
    additionalProperties:false, and failing a whole authoring round over a
    stray key the compiler would never read helps nobody.
    """
    known = set(load_schema().get("properties", {}).keys())
    extras = [k for k in list(spec.keys()) if k not in known]
    for key in extras:
        value = spec.pop(key)
        if key == "shared_filters" and isinstance(value, list):
            dashboards = spec.get("dashboards")
            if (
                isinstance(dashboards, list)
                and len(dashboards) == 1
                and isinstance(dashboards[0], dict)
                and not dashboards[0].get("shared_filters")
            ):
                dashboards[0]["shared_filters"] = value
    # Models confuse the zone-only advisory 'confidence' with worksheets —
    # purely metadata, never compiled, so stripping it loses nothing.
    for ws in spec.get("worksheets") or []:
        if isinstance(ws, dict):
            ws.pop("confidence", None)


def _short_message(err: Any) -> str:
    """jsonschema messages embed the offending instance — for a 28-worksheet
    array that is pages of JSON, which drowns the actual verdict, bloats build_run
    errors, and (fed back on retry) can blow the LLM prompt past its context.
    Rewrite the known offenders and hard-cap the rest."""
    if err.validator == "maxItems" and isinstance(err.instance, list):
        return (
            f"array has {len(err.instance)} items, more than the maximum "
            f"of {err.validator_value}"
        )
    message = str(err.message)
    if len(message) > 240:
        # Keep the tail — jsonschema puts the verdict after the instance dump.
        message = message[:130] + " … " + message[-90:]
    return message


def validate_spec(spec: dict[str, Any]) -> list[str]:
    """Return a list of human-readable validation errors (empty if valid)."""
    errors = []
    for err in sorted(_validator().iter_errors(spec), key=lambda e: list(e.absolute_path)):
        path = "$" + "".join(
            f"[{p}]" if isinstance(p, int) else f".{p}" for p in err.absolute_path
        )
        errors.append(f"{path}: {_short_message(err)}")
    return errors


def assert_valid_spec(spec: dict[str, Any]) -> None:
    errors = validate_spec(spec)
    if errors:
        raise SpecValidationError(errors)
