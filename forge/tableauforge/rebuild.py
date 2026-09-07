"""Rebuild orchestrator: rebuild brief -> authored DashboardSpec -> `.lvdash.json`.

Upstream this was one branch of ``generator.py``'s ``generate_rebuild``, which served three
targets and shared a module with the CSV/database designer flow. BI_Converter keeps the
Databricks branch only (spec §4.2), so the module is the pipeline and nothing else:

    author (unless the caller supplies a spec)
      -> force the brief's connections and fields back onto the spec
      -> resolve field references deterministically, then gate on what did not resolve
      -> compile to one or more `.lvdash.json` documents
      -> validate every emitted document
      -> persist spec, translation, and validation report beside the artifact

Determinism: artifact ids are uuid5 of (workbook name + canonical spec JSON). No
wall-clock timestamps and no random values — the LLM is the only nondeterminism, and it
runs before the id is computed.
"""

from __future__ import annotations

import copy
import json
import logging
import uuid
from dataclasses import dataclass, field as _dc_field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from tableauforge.spec.models import DashboardSpec
from tableauforge.spec.precheck import precheck_field_references
from tableauforge.spec.schema import assert_valid_spec

if TYPE_CHECKING:
    from tableauforge.compiler.lakeview import LakeviewPart
    from tableauforge.llm.client import LlmClient
    from tableauforge.validate.pipeline import ValidationReport

logger = logging.getLogger(__name__)

#: The same fixed namespace the compiler uses for its stable uuids.
_UUID_NS = uuid.UUID("6ba7b810-9dad-11d1-80b4-00c04fd430c8")

_INVALID_FILENAME_CHARS = set('<>:"/\\|?*')


class GenerationFailed(RuntimeError):
    """The artifact failed validation. Artifacts were still written, for debugging."""

    def __init__(self, report: "ValidationReport", result: "GenerationResult"):
        self.report = report
        self.result = result
        super().__init__(
            f"generation failed validation (artifact_id={result.artifact_id}); "
            "artifacts were written for debugging"
        )


class SpecFieldError(ValueError):
    """A spec references fields that do not resolve in their datasource.

    Raised BEFORE compile so the API returns one clear 422 listing every bad reference
    instead of the compiler's first-failure ``CompileError``. A subclass of ValueError so
    the routes already map it to HTTP 422 via ``str(exc)``.
    """

    def __init__(self, errors: list[str]):
        self.errors = errors
        super().__init__(
            "spec references fields that do not exist in their datasource:\n"
            + "\n".join(errors)
        )


@dataclass
class GenerationResult:
    spec: dict[str, Any]
    report: "ValidationReport"
    artifact_id: str
    #: The primary artifact file: a `.lvdash.json`, or the `.lvdash.zip` bundling a
    #: report that needed more than one dashboard.
    artifact_path: Path | None = None
    #: Deterministic field-reference repairs/drops applied before compile (renamed
    #: near-miss names, derived date parts, dropped impossible filters/encodings).
    #: Empty when every reference resolved exactly. See spec.field_resolution.
    field_resolutions: list[dict[str, Any]] = _dc_field(default_factory=list)
    #: REVIEW-WORTHY compile-time caveats: something the source report had that the
    #: artifact does not. Informational caveats live in compile_notes, so a caller can
    #: compute needs_review from the warnings alone.
    compile_warnings: list[str] = _dc_field(default_factory=list)
    #: Informational compile-time caveats — true and worth printing, but not a reason to
    #: make a person re-check the build (a re-flowed layout, a non-Databricks source).
    compile_notes: list[str] = _dc_field(default_factory=list)
    #: One entry per emitted document when a report does not fit one dashboard (the AI/BI
    #: cap is 15 pages). Empty for an unsplit build — `artifact_path` is then the whole
    #: answer; when non-empty it is the zip bundling these, and each entry is
    #: `{name, title, index, total, pages, datasets}`.
    artifact_parts: list[dict[str, Any]] = _dc_field(default_factory=list)


def _gate_field_references(model: DashboardSpec) -> None:
    """Fail fast on unknown field references, before compile."""
    errors = precheck_field_references(model)
    if errors:
        raise SpecFieldError(errors)


def _resolve_and_gate(spec: dict[str, Any]) -> list[dict[str, Any]]:
    """Deterministically repair every field reference in ``spec`` (in place), then gate on
    whatever could not be repaired.

    The resolver (``spec.field_resolution``) canonicalizes near-miss names, derives date
    parts, and drops references that cannot exist but are safe to omit (filters, optional
    encodings, sort keys). What survives is a spec whose only remaining bad references are
    structural — a chart shelf on a nonexistent field — and those still raise
    ``SpecFieldError``, so a genuinely unbuildable chart fails loudly instead of shipping
    empty. Returns the repair/drop actions for persistence and debugging. Must run AFTER
    datasource fields are forced onto the brief-derived list.
    """
    from tableauforge.spec.field_resolution import resolve_field_references

    resolutions = [r.to_dict() for r in resolve_field_references(spec, target="databricks")]
    _gate_field_references(DashboardSpec.model_validate(spec))
    return resolutions


def _safe_filename(name: str) -> str:
    """Filesystem-safe deterministic stem for artifact files."""
    cleaned = "".join(
        "_" if (c in _INVALID_FILENAME_CHARS or ord(c) < 32) else c for c in name
    )
    return cleaned.strip().rstrip(".") or "dashboard"


def _merge_reports(
    reports: list["ValidationReport"], parts: list["LakeviewPart"]
) -> "ValidationReport":
    """Fold one validation report per emitted document into the single report a build
    carries. A layer passes only when it passed for EVERY part, and each error names the
    part it came from — a split build must not be able to report 'passed' while one of its
    dashboards is broken.
    """
    from tableauforge.validate.pipeline import LayerResult, ValidationReport

    if len(reports) == 1:
        return reports[0]
    merged: dict[tuple[int, str], LayerResult] = {}
    for report, part in zip(reports, parts):
        for layer in report.layers:
            key = (layer.layer, layer.name)
            existing = merged.get(key)
            errors = [f"{part.title}: {e}" for e in layer.errors]
            if existing is None:
                merged[key] = LayerResult(layer.layer, layer.name, layer.passed, errors)
            else:
                existing.passed = existing.passed and layer.passed
                existing.errors.extend(errors)
    return ValidationReport(
        layers=[merged[key] for key in sorted(merged)],
        xsd_version=reports[0].xsd_version,
    )


def _write_deterministic_zip(target: Path, entries: list[tuple[str, bytes]]) -> None:
    """Write a byte-reproducible zip: sorted entries, DOS-epoch timestamps, fixed 0644
    permissions, deflate. Upstream this lived in ``compiler/twbx.py`` and was shared by
    every forge archive emitter; the split-dashboard bundle is now the only one left."""
    import zipfile

    epoch = (1980, 1, 1, 0, 0, 0)
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for arcname, data in sorted(entries, key=lambda e: e[0]):
            info = zipfile.ZipInfo(arcname, date_time=epoch)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)


def _zip_lakeview_parts(
    target: Path, part_files: list[tuple[Path, "LakeviewPart"]], *, workbook: str
) -> None:
    """Bundle a split report's dashboards into one deterministic zip, with a README that
    says what to do with several files where one was expected."""
    total = len(part_files)
    listing = "\n".join(
        f"- {path.name} — {part.page_count} page(s), {part.dataset_count} dataset(s): "
        + ", ".join(part.page_titles)
        for path, part in part_files
    )
    readme = (
        f"{workbook} — {total} Databricks AI/BI dashboards\n\n"
        f"This report needed more pages than one AI/BI dashboard can hold "
        f"(the limit is 15), so it was split into {total} dashboards. Each file\n"
        f"below is complete on its own: import them one at a time in Databricks\n"
        f"(Dashboards > Create dashboard > File > Import dashboard from file) and\n"
        f"pick the same SQL warehouse for each.\n\n"
        f"{listing}\n\n"
        f"Pages kept their original order across the split, and each dashboard\n"
        f"declares only the datasets its own pages query.\n"
    )
    entries: list[tuple[str, bytes]] = [("README.txt", readme.encode("utf-8"))]
    entries += [(path.name, path.read_bytes()) for path, _ in part_files]
    _write_deterministic_zip(target, entries)


def _write_resolution_log(base: Path, resolutions: list[dict[str, Any]]) -> None:
    """Persist the deterministic field-reference repairs next to spec.json, so the artifact
    directory explains every rename/derive/drop that kept the build alive. Also logs a
    one-line summary when anything was dropped, so a silently repaired build stays visible.
    """
    if not resolutions:
        return
    (base / "resolution_log.json").write_text(
        json.dumps(resolutions, indent=2, sort_keys=True), encoding="utf-8"
    )
    dropped = [r for r in resolutions if r.get("action") in ("dropped", "unresolved")]
    if dropped:
        logger.warning(
            "field resolution dropped/left %d reference(s): %s",
            len(dropped),
            "; ".join(f"{r['scope']} {r['location']} {r['original']!r}" for r in dropped),
        )


def generate_rebuild(
    brief: dict[str, Any],
    out_dir: Path,
    llm: "LlmClient | None" = None,
    spec: dict[str, Any] | None = None,
    workbook_name: str | None = None,
    instructions: str | None = None,
    images: list[dict[str, Any]] | None = None,
) -> tuple[GenerationResult, list[dict[str, Any]]]:
    """Rebuild brief -> author (unless a spec is given) -> force brief connections/fields
    -> compile -> validate -> persist a `.lvdash.json` artifact.

    Returns (result, translation). With a caller-supplied spec the translation is [] — the
    forge is stateless with respect to conversion, so the shell round-trips the draft's
    translation report (spec §4.3). No live introspection happens: the brief's fields are
    the schema truth, so there is no drift gate on this path. ``images`` (captured
    dashboard screenshots) is authoring context only, and has no effect on the
    caller-supplied-spec path.
    """
    from tableauforge.compiler.lakeview import (
        MAX_PAGES as MAX_LAKEVIEW_PAGES,
        compile_caveats as lakeview_caveats,
        compile_lakeview_parts,
    )
    from tableauforge.llm.rebuild_author import force_brief_datasources
    from tableauforge.validate.lakeview import validate_lakeview_artifact
    from tableauforge.validate.pipeline import ValidationReport

    out_dir = Path(out_dir)
    translation: list[dict[str, Any]] = []
    # Layout-fidelity warnings from authoring (empty on the caller-supplied-spec path —
    # there is no authoring to compare against an observed layout). Folded into the same
    # warnings channel as the compile-time ones, so callers see everything through one key.
    authoring_warnings: list[str] = []

    if spec is None:
        if llm is None:
            raise ValueError(
                "generate_rebuild() needs either a precompiled spec or an LlmClient to "
                "author one"
            )
        from tableauforge.config import Settings
        from tableauforge.llm.rebuild_author import author_rebuild_spec

        authored = author_rebuild_spec(
            brief,
            workbook_name=workbook_name,
            instructions=instructions,
            llm=llm,
            settings=Settings.from_env(),
            target="databricks",
            images=images,
        )
        spec = authored["spec"]
        translation = authored["translation"]
        authoring_warnings = authored.get("warnings") or []
    spec = copy.deepcopy(spec)

    if workbook_name is not None:
        spec.setdefault("workbook", {})["name"] = workbook_name

    # Connection and raw-field truth always comes from the brief, on the
    # caller-supplied-spec path too (an edited spec may not have touched datasources).
    force_brief_datasources(spec, brief)

    assert_valid_spec(spec)
    resolutions = _resolve_and_gate(spec)
    model = DashboardSpec.model_validate(spec)

    spec_json = json.dumps(spec, indent=2, sort_keys=True)
    artifact_id = str(uuid.uuid5(_UUID_NS, f"artifact:{model.workbook.name}:{spec_json}"))
    base = out_dir / artifact_id
    base.mkdir(parents=True, exist_ok=True)

    stem = _safe_filename(model.workbook.name)
    warnings, notes = lakeview_caveats(model)
    warnings = list(authoring_warnings) + warnings
    artifact_parts: list[dict[str, Any]] = []

    # A report bigger than one AI/BI dashboard compiles to several — each a complete,
    # importable document — rather than failing the build.
    parts = compile_lakeview_parts(model)
    part_files: list[tuple[Path, "LakeviewPart"]] = []
    reports: list[ValidationReport] = []
    for part in parts:
        # The `.lvdash.json` double suffix is the format's own (Databricks' importer keys
        # on it), so the stem keeps no extra extension. An unsplit build's part title IS
        # the workbook name, so its filename is byte-for-byte what it always was.
        part_path = base / f"{_safe_filename(part.title)}.lvdash.json"
        part_path.write_text(part.text, encoding="utf-8", newline="")
        part_files.append((part_path, part))
        part_report, validation_warnings = validate_lakeview_artifact(spec, part.text)
        reports.append(part_report)
        # Layer-2/4 warnings (docs-pinned widget types, unresolvable column references)
        # are build caveats, not failures — same channel as the compile-time ones.
        warnings += [
            f"{part.title}: {w}" if part.total > 1 else w for w in validation_warnings
        ]
    report = _merge_reports(reports, [p for _, p in part_files])

    if len(parts) == 1:
        artifact_path = part_files[0][0]
    else:
        # Several dashboards are several files: the artifact becomes the zip that carries
        # them, so nothing a build produced is left undelivered.
        artifact_path = base / f"{stem}.lvdash.zip"
        _zip_lakeview_parts(artifact_path, part_files, workbook=model.workbook.name)
        artifact_parts = [
            {
                "name": path.name,
                "title": part.title,
                "index": part.index,
                "total": part.total,
                "pages": part.page_count,
                "datasets": part.dataset_count,
            }
            for path, part in part_files
        ]
        warnings.insert(
            0,
            f"this report's {sum(p.page_count for p in parts)} pages do not fit one "
            f"AI/BI dashboard (the cap is {MAX_LAKEVIEW_PAGES}), so it was split into "
            f"{len(parts)} dashboards "
            f"({', '.join(f'{p.title} — {p.page_count} page(s)' for _, p in part_files)}); "
            "the download is a .zip of the .lvdash.json files — import each one",
        )
    for warning in warnings:
        logger.warning("rebuild artifact %s: %s", artifact_id, warning)
    for note in notes:
        logger.info("rebuild artifact %s: %s", artifact_id, note)

    (base / "spec.json").write_text(spec_json, encoding="utf-8")
    (base / "validation_report.json").write_text(
        json.dumps(report.to_dict(), indent=2, sort_keys=True), encoding="utf-8"
    )
    (base / "translation.json").write_text(
        json.dumps(translation, indent=2, sort_keys=True), encoding="utf-8"
    )
    _write_resolution_log(base, resolutions)

    result = GenerationResult(
        spec=spec,
        report=report,
        artifact_id=artifact_id,
        artifact_path=artifact_path,
        field_resolutions=resolutions,
        compile_warnings=warnings,
        compile_notes=notes,
        artifact_parts=artifact_parts,
    )
    if not report.passed:
        failed = [
            f"{layer.get('name', layer.get('layer'))}: "
            + "; ".join(layer.get("errors") or [])[:300]
            for layer in report.to_dict().get("layers", [])
            if not layer.get("passed")
        ]
        logger.warning(
            "rebuild artifact %s failed validation — %s", artifact_id, " | ".join(failed)
        )
        raise GenerationFailed(report, result)
    logger.info("rebuild artifact %s generated at %s", artifact_id, base)
    return result, translation
