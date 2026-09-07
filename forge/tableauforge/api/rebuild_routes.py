"""Rebuild API routes (Linetria addition — see forge/UPSTREAM.md and Linetria's
docs/specs/2026-07-22-build-tab-tableauforge.md §5.3): /draft-rebuild-spec and
/generate-rebuild.

Router-factory design mirrors db_routes: ``build_rebuild_router(store,
settings)`` returns an APIRouter for ``api.main`` to mount.

Statelessness contract: forge keeps nothing between draft and build, so
/generate-rebuild accepts optional ``translation`` / ``llm_usage`` passthrough
fields (the same pattern as /generate's llm_usage_json form field) and echoes
them into the response merged with anything the build itself produced.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from typing import Any, Literal, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from tableauforge.api.store import ArtifactStore
from tableauforge.config import MissingApiKeyError, OllamaUnavailableError, Settings
from tableauforge.generator import GenerationFailed, generate_rebuild
from tableauforge.llm.usage import merge_usage

try:  # same guarded import as api.main (do NOT import from there — circular)
    import anthropic

    ANTHROPIC_API_ERRORS: tuple[type[Exception], ...] = (anthropic.AnthropicError,)
except ImportError:  # pragma: no cover - anthropic is a main dependency
    ANTHROPIC_API_ERRORS = ()


#: Build target -> the artifact kind the store rows carry. One map instead of a
#: chain of ternaries, so a new target cannot land a row under the wrong kind.
_ARTIFACT_KIND_FOR_TARGET: dict[str, str] = {
    "tableau": "twb",
    "power_bi": "pbit",
    "databricks": "lvdash",
}

#: Vision-input caps (Task B3 spec 2026-07-27): a rebuild request may attach a
#: handful of captured dashboard screenshots as authoring context.
MAX_REBUILD_IMAGES = 4
MAX_REBUILD_IMAGE_BYTES = 5 * 1024 * 1024  # decoded


class RebuildImage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    element: str
    media_type: Literal["image/png", "image/jpeg", "image/webp"]
    data: str


def _validate_images(images: Optional[list[RebuildImage]]) -> None:
    if not images:
        return
    if len(images) > MAX_REBUILD_IMAGES:
        raise HTTPException(
            status_code=422,
            detail=f"at most {MAX_REBUILD_IMAGES} images per rebuild request",
        )
    for img in images:
        if len(img.data) * 3 // 4 > MAX_REBUILD_IMAGE_BYTES:
            raise HTTPException(
                status_code=422,
                detail=f"image for '{img.element}' exceeds the "
                       f"{MAX_REBUILD_IMAGE_BYTES // (1024 * 1024)}MB cap",
            )


class DraftRebuildBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    brief: dict[str, Any]
    workbook_name: Optional[str] = None
    instructions: Optional[str] = None
    target: Literal["tableau", "power_bi", "databricks"] = "tableau"
    images: Optional[list[RebuildImage]] = None


class GenerateRebuildBody(DraftRebuildBody):
    spec_json: Optional[dict[str, Any]] = None
    translation: Optional[list[dict[str, Any]]] = None
    llm_usage: Optional[dict[str, Any]] = None


def _authoring_llm() -> Any:
    """Construction is side-effect-free; the SDK (and API key) is only touched
    when the generator actually authors via the LLM."""
    try:
        from tableauforge.llm.client import LlmClient

        return LlmClient()
    except Exception:  # noqa: BLE001 - parallel module may be missing
        return None


_NO_KEY_DETAIL = (
    "Authoring a rebuild spec requires a Claude API key. Add one on the "
    "Settings page or set ANTHROPIC_API_KEY; compiling an existing spec "
    "needs no key."
)


def build_rebuild_router(store: ArtifactStore, settings: Any) -> APIRouter:
    router = APIRouter()

    @router.post("/draft-rebuild-spec")
    def draft_rebuild_spec_endpoint(body: DraftRebuildBody) -> dict[str, Any]:
        from tableauforge.llm.rebuild_author import (
            RebuildAuthoringError,
            author_rebuild_spec,
        )

        _validate_images(body.images)
        llm = _authoring_llm()
        if llm is None:
            # SDK missing: same user-facing condition as a missing key.
            raise HTTPException(status_code=503, detail=_NO_KEY_DETAIL)
        try:
            authored = author_rebuild_spec(
                body.brief,
                workbook_name=body.workbook_name,
                instructions=body.instructions,
                llm=llm,
                settings=Settings.from_env(),
                target=body.target,
                images=[i.model_dump() for i in body.images or []] or None,
            )
        except OllamaUnavailableError as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        except MissingApiKeyError:
            raise HTTPException(status_code=503, detail=_NO_KEY_DETAIL)
        except ANTHROPIC_API_ERRORS as exc:
            raise HTTPException(status_code=502, detail=f"Claude API call failed: {exc}")
        except RebuildAuthoringError as exc:
            return JSONResponse(
                status_code=422,
                content={"detail": "rebuild authoring failed", "errors": exc.errors},
            )
        return {
            "spec": authored["spec"],
            "translation": authored["translation"],
            "warnings": authored.get("warnings", []),
            "llm_usage": llm.usage_summary() if llm is not None else None,
        }

    @router.post("/generate-rebuild")
    def generate_rebuild_endpoint(body: GenerateRebuildBody):
        from tableauforge.llm.rebuild_author import RebuildAuthoringError

        _validate_images(body.images)
        llm: Any = None
        if body.spec_json is None:
            llm = _authoring_llm()
        with tempfile.TemporaryDirectory(prefix="tf-generate-rebuild-") as tmp:
            out_dir = Path(tmp) / "out"
            out_dir.mkdir()
            try:
                result, translation = generate_rebuild(
                    brief=body.brief,
                    out_dir=out_dir,
                    llm=llm,
                    spec=body.spec_json,
                    workbook_name=body.workbook_name,
                    instructions=body.instructions,
                    target=body.target,
                    images=[i.model_dump() for i in body.images or []] or None,
                )
            except OllamaUnavailableError as exc:
                raise HTTPException(status_code=503, detail=str(exc))
            except MissingApiKeyError:
                raise HTTPException(status_code=503, detail=_NO_KEY_DETAIL)
            except ANTHROPIC_API_ERRORS as exc:
                raise HTTPException(status_code=502, detail=f"Claude API call failed: {exc}")
            except RebuildAuthoringError as exc:
                return JSONResponse(
                    status_code=422,
                    content={"detail": "rebuild authoring failed", "errors": exc.errors},
                )
            except ValueError as exc:
                # Covers SpecValidationError and "needs a spec or an LlmClient".
                raise HTTPException(status_code=422, detail=str(exc))
            except GenerationFailed as exc:
                report = getattr(exc, "report", None)
                return JSONResponse(
                    status_code=422,
                    content={
                        "detail": "generation failed",
                        "report": report.to_dict() if report is not None else None,
                    },
                )
            artifact_src = Path(result.artifact_path or result.twb_path)
            dest_dir = store.artifacts_dir / result.artifact_id
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / artifact_src.name
            shutil.copyfile(artifact_src, dest)

        # Stateless passthrough: a spec_json build carries the draft's
        # translation; an authoring build produced its own.
        final_translation = translation if translation else (body.translation or [])
        report_dict = result.report.to_dict()
        llm_usage = merge_usage(
            body.llm_usage, llm.usage_summary() if llm is not None else None
        )
        store.save_artifact(
            artifact_id=result.artifact_id,
            workbook_name=body.workbook_name
            or result.spec.get("workbook", {}).get("name", artifact_src.stem),
            kind=_ARTIFACT_KIND_FOR_TARGET[body.target],
            path=str(dest),
            spec=result.spec,
            report=report_dict,
            llm_usage=llm_usage,
        )
        return {
            "artifact_id": result.artifact_id,
            "spec": result.spec,
            "report": report_dict,
            "translation": final_translation,
            "download_url": f"/download/{result.artifact_id}",
            "llm_usage": llm_usage,
            "polish": getattr(result, "polish_log", None),
            "field_resolutions": getattr(result, "field_resolutions", []),
            # Compile-time caveats (import-mode fallback, composite sources)
            # surface to the caller, not just the server log. `warnings` is
            # review-worthy only — the caller flips a run to needs-review on it —
            # while `notes` is informational (a non-Databricks source, a
            # re-flowed layout): true, printed, never a reason to re-check.
            "warnings": getattr(result, "compile_warnings", []) or [],
            "notes": getattr(result, "compile_notes", []) or [],
            # Non-empty only when the target had to split the report across
            # several documents (databricks: >15 pages). The download is then a
            # zip of these; the list is what lets a caller name them.
            "parts": getattr(result, "artifact_parts", []) or [],
        }

    return router
