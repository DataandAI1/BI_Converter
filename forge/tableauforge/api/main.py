"""FastAPI app factory: HTTP surface over profiling, generation, and validation (GOAL §3.3).

The API never authors XML and never talks to Tableau — it orchestrates the
deterministic pipeline modules and persists artifacts via ArtifactStore.

The generator and the full validation pipeline are parallel modules; they are
bound lazily as module globals (``generate``, ``GenerationFailed``,
``validate_artifact``) so this module imports — and the non-LLM endpoints
work — without them, and so tests can monkeypatch them.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from tableauforge import __version__
from tableauforge.api.db_routes import build_db_router
from tableauforge.api.rebuild_routes import build_rebuild_router
from tableauforge.api.store import ArtifactStore
from tableauforge.tableau_mcp import TableauMcpConfig, TableauMcpService

try:  # pragma: no cover - keeps the core API alive if the connector breaks
    from tableauforge.api.tableau_routes import build_tableau_router
except Exception:  # noqa: BLE001
    import logging as _logging

    _logging.getLogger(__name__).warning(
        "Tableau connector routes unavailable (/tableau/*, /generate-tableau)",
        exc_info=True,
    )
    build_tableau_router = None
from tableauforge.config import (
    AVAILABLE_MODELS,
    MIN_OLLAMA_NUM_CTX,
    VALID_PROVIDERS,
    MissingApiKeyError,
    OllamaUnavailableError,
    ollama_base_url_from_env,
    ollama_model_from_env,
    ollama_num_ctx_cap_from_env,
    provider_from_env,
)
from tableauforge.config import Settings as ForgeSettings
from tableauforge.llm.client import LlmClient
from tableauforge.llm.spec_author import SpecAuthoringError
from tableauforge.llm.usage import merge_usage
from tableauforge.llm.wireframe_analyst import (
    SUPPORTED_MEDIA_TYPES,
    WireframeAnalysisError,
    analyze_wireframe,
)

try:  # pragma: no cover - import guard mirrors the SDK's optionality
    import anthropic as _anthropic

    #: Network/auth/server failures from the Claude SDK -> 502, never a raw 500.
    ANTHROPIC_API_ERRORS: tuple[type[Exception], ...] = (_anthropic.AnthropicError,)
except Exception:  # noqa: BLE001
    ANTHROPIC_API_ERRORS = ()
from tableauforge.profiler.csv_profiler import profile_csv
from tableauforge.templates import apply_template, list_palettes, list_templates
from tableauforge.validate.xsd import XSD_VERSION, validate_twb_xml

try:  # pragma: no cover - exercised only once the parallel module lands
    from tableauforge.generator import GenerationFailed, draft_spec, generate
except Exception:  # noqa: BLE001 - tolerate a missing/partial parallel module
    generate = None
    draft_spec = None

    class GenerationFailed(RuntimeError):  # type: ignore[no-redef]
        """Mirror of tableauforge.generator.GenerationFailed (carries .report)."""

        def __init__(self, message: str = "generation failed", report: Any = None):
            super().__init__(message)
            self.report = report


try:  # pragma: no cover - exercised only once the parallel module lands
    from tableauforge.validate.pipeline import validate_artifact
except Exception:  # noqa: BLE001
    validate_artifact = None


#: Upload cap for /analyze-wireframe images (GOAL §4 Phase 3): larger uploads are 413.
MAX_WIREFRAME_BYTES = 8 * 1024 * 1024


class ApiKeyIn(BaseModel):
    """Request body for POST /settings/api-key."""

    api_key: str


class ModelIn(BaseModel):
    """Request body for POST /settings/model."""

    model: str


class ProviderIn(BaseModel):
    """Request body for POST /settings/provider.

    ollama_base_url / ollama_model / ollama_num_ctx are optional: omitting (or
    blanking) them keeps the current values, so switching provider doesn't wipe
    the Ollama connection details."""

    provider: str
    ollama_base_url: Optional[str] = None
    ollama_model: Optional[str] = None
    #: Context-window cap (options.num_ctx) for Ollama requests. Requests still
    #: size num_ctx to the prompt but never above this — raise it for large
    #: reports when the machine has the memory.
    ollama_num_ctx: Optional[int] = None


class TableauSettingsIn(BaseModel):
    """Request body for POST /settings/tableau.

    pat_value is optional on edit: omitting it keeps the stored secret so the
    UI can change server/site/PAT-name without re-entering the token.
    """

    server: str
    site_name: str = ""
    pat_name: str
    pat_value: Optional[str] = None


class TemplateApplyIn(BaseModel):
    """Request body for POST /apply-template."""

    spec: dict[str, Any]
    template_id: str
    accent: Optional[str] = None


class SpecValidateIn(BaseModel):
    """Request body for POST /validate-spec."""

    spec: dict[str, Any]


class RefineIn(BaseModel):
    """Request body for POST /refine-spec."""

    spec: dict[str, Any]
    instruction: str
    profile: Optional[dict[str, Any]] = None


def _mask_api_key(key: str) -> str:
    """Mask a key for display — the secret is never echoed back in full.

    Short keys are fully masked; longer ones show a 5-char prefix and 4-char
    suffix so a user can confirm *which* key is set without exposing it.
    """
    key = key.strip()
    if len(key) <= 8:
        return "•" * len(key)
    return f"{key[:5]}…{key[-4:]}"


@dataclass(frozen=True)
class Settings:
    """API configuration. artifacts_dir holds forge.db plus persisted artifact files."""

    artifacts_dir: Path = Path("artifacts") / "api"


def _report_to_dict(report: Any) -> dict[str, Any]:
    """Normalize a validation report (object with .to_dict() or plain dict)."""
    if hasattr(report, "to_dict"):
        return report.to_dict()
    if isinstance(report, dict):
        return report
    raise TypeError(f"unsupported report object: {type(report)!r}")


def _read_twb_bytes(path: Path) -> bytes:
    """TWB bytes from a .twb file, or the first .twb entry inside a .twbx archive."""
    if path.suffix.lower() == ".twbx":
        with zipfile.ZipFile(path) as zf:
            twb_names = sorted(n for n in zf.namelist() if n.lower().endswith(".twb"))
            if not twb_names:
                raise ValueError(f"no .twb found inside {path.name}")
            return zf.read(twb_names[0])
    return path.read_bytes()


def xsd_only_report(path: Path) -> dict[str, Any]:
    """Layer-2-only validation report (GOAL §5): XSD against the pinned schema.

    Used when no spec_json accompanies a /validate upload — the spec-aware
    layers (structural lint, round-trip) need the spec to check against.
    """
    try:
        twb_bytes = _read_twb_bytes(path)
    except (zipfile.BadZipFile, ValueError, OSError) as exc:
        errors = [str(exc)]
    else:
        errors = validate_twb_xml(twb_bytes)
    return {
        "passed": not errors,
        "layers": [
            {
                "layer": 2,
                "name": "xsd",
                "passed": not errors,
                "errors": errors,
                "xsd_version": XSD_VERSION,
            }
        ],
    }


def _compiler_structural_issue_details(spec: dict[str, Any]) -> list[dict[str, Any]]:
    """Structural rules the deterministic compiler (compiler/twb.py) enforces but
    the JSON Schema and typing models cannot express. Surfaced by /validate-spec so
    the editor can warn before the build instead of only failing at /generate.

    Kept intentionally light: only the dual-axis shape, which the structure editor
    can produce. The "both axes must be measures" check needs field roles and stays
    in the compiler.
    """
    issues: list[dict[str, Any]] = []
    for ws in spec.get("worksheets", []) or []:
        chart = ws.get("chart") or {}
        ctype = chart.get("type")
        rows = chart.get("rows") or []
        secondary = chart.get("secondary_rows") or []
        title = ws.get("title") or ws.get("id") or "worksheet"
        message: Optional[str] = None
        if ctype == "dual_axis_bar_line":
            if len(rows) != 1 or len(secondary) != 1:
                message = (
                    f"worksheet {title!r}: dual_axis_bar_line needs exactly one rows "
                    "measure and one secondary_rows measure"
                )
        elif secondary:
            message = (
                f"worksheet {title!r}: secondary_rows is only valid for a "
                "dual_axis_bar_line chart"
            )
        if message:
            issues.append(
                {"message": message, "worksheet_id": ws.get("id"), "zone_index": None}
            )
    return issues


def _compiler_structural_issues(spec: dict[str, Any]) -> list[str]:
    return [i["message"] for i in _compiler_structural_issue_details(spec)]


_WS_PATH_RE = re.compile(r"^\$\.worksheets\[(\d+)\]")
_ZONE_PATH_RE = re.compile(r"^\$\.dashboards\[\d+\]\.zones\[(\d+)\]")


def _locus_from_path(spec: dict[str, Any], message: str) -> tuple[Optional[str], Optional[int]]:
    """Map a `$.worksheets[i]...` / `$.dashboards[j].zones[k]...` error string to
    the offending worksheet id / zone index so the studio can badge the tile."""
    ws_id: Optional[str] = None
    zone_index: Optional[int] = None
    m = _WS_PATH_RE.match(message)
    if m:
        try:
            ws = (spec.get("worksheets") or [])[int(m.group(1))]
            ws_id = ws.get("id") if isinstance(ws, dict) else None
        except (IndexError, TypeError):
            ws_id = None
    m = _ZONE_PATH_RE.match(message)
    if m:
        zone_index = int(m.group(1))
    return ws_id, zone_index


def _parse_spec_json(spec_json: str) -> dict[str, Any]:
    try:
        spec = json.loads(spec_json)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=422, detail=f"spec_json is not valid JSON: {exc}")
    if not isinstance(spec, dict):
        raise HTTPException(status_code=422, detail="spec_json must be a JSON object")
    return spec


def _parse_llm_usage_json(llm_usage_json: Optional[str]) -> Optional[dict[str, Any]]:
    """Prior-request usage the client accumulated (draft/refine happen in
    earlier HTTP requests than the build). Malformed input is a client error."""
    if not llm_usage_json:
        return None
    try:
        usage = json.loads(llm_usage_json)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=422, detail=f"llm_usage_json is not valid JSON: {exc}"
        )
    if not isinstance(usage, dict):
        raise HTTPException(status_code=422, detail="llm_usage_json must be a JSON object")
    return usage


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    """Build the TableauForge API. Pass Settings to redirect persistence (tests do)."""
    settings = settings or Settings()
    store = ArtifactStore(settings.artifacts_dir)

    app = FastAPI(title="TableauForge", version=__version__)
    app.state.settings = settings
    app.state.store = store
    # True once the key has been set via POST /settings/api-key (this process
    # or a previous one via the saved settings file), so GET /settings can
    # distinguish a UI-provided key from a host/env one.
    app.state.runtime_api_key = False

    # Settings set through the UI (API key, model choice) are persisted next
    # to the artifact store (the docker-compose bind mount), so they survive
    # container restarts instead of silently reverting after every restart.
    settings_file = store.artifacts_dir / "settings.json"
    app.state.runtime_model = False
    app.state.runtime_tableau = False
    app.state.runtime_provider = False

    # One persistent MCP session against tableau-mcp for the whole app: the
    # PAT concurrency rule forbids a session per request (see tableau_mcp).
    tableau_mcp = TableauMcpService()
    app.state.tableau_mcp = tableau_mcp

    #: settings.json key -> env var consumed by TableauMcpConfig.from_env().
    _TABLEAU_KEYS = {
        "tableau_server": "TABLEAU_MCP_SERVER",
        "tableau_site_name": "TABLEAU_MCP_SITE_NAME",
        "tableau_pat_name": "TABLEAU_MCP_PAT_NAME",
        "tableau_pat_value": "TABLEAU_MCP_PAT_VALUE",
    }

    def _read_saved() -> dict[str, Any]:
        try:
            saved = json.loads(settings_file.read_text(encoding="utf-8"))
            return saved if isinstance(saved, dict) else {}
        except (OSError, ValueError):
            return {}

    def _write_saved(**updates: Optional[str]) -> None:
        saved = _read_saved()
        for k, v in updates.items():
            if v is None:
                saved.pop(k, None)
            else:
                saved[k] = v
        settings_file.parent.mkdir(parents=True, exist_ok=True)
        settings_file.write_text(json.dumps(saved), encoding="utf-8")

    def _load_runtime_settings() -> None:
        saved = _read_saved()
        # Explicit env values outrank saved ones.
        key = str(saved.get("anthropic_api_key", "")).strip()
        if key and not os.environ.get("ANTHROPIC_API_KEY", "").strip():
            os.environ["ANTHROPIC_API_KEY"] = key
            app.state.runtime_api_key = True
        model = str(saved.get("model", "")).strip()
        if model and not os.environ.get("TABLEAUFORGE_MODEL", "").strip():
            os.environ["TABLEAUFORGE_MODEL"] = model
            app.state.runtime_model = True
        provider = str(saved.get("provider", "")).strip().lower()
        if provider in VALID_PROVIDERS and not os.environ.get(
            "TABLEAUFORGE_PROVIDER", ""
        ).strip():
            os.environ["TABLEAUFORGE_PROVIDER"] = provider
            app.state.runtime_provider = True
        for saved_key, env_var in (
            ("ollama_base_url", "OLLAMA_BASE_URL"),
            ("ollama_model", "TABLEAUFORGE_OLLAMA_MODEL"),
            ("ollama_num_ctx", "TABLEAUFORGE_OLLAMA_NUM_CTX"),
        ):
            value = str(saved.get(saved_key, "")).strip()
            if value and not os.environ.get(env_var, "").strip():
                os.environ[env_var] = value
        for saved_key, env_var in _TABLEAU_KEYS.items():
            value = str(saved.get(saved_key, "")).strip()
            if value and not os.environ.get(env_var, "").strip():
                os.environ[env_var] = value
                app.state.runtime_tableau = True

    _load_runtime_settings()

    def _settings_payload() -> dict[str, Any]:
        """Current LLM-provider status. Raw secrets are never returned — only masked."""
        key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
        configured = bool(key)
        source: Optional[str] = None
        if configured:
            source = "runtime" if app.state.runtime_api_key else "env"
        model_source: Optional[str] = None
        if os.environ.get("TABLEAUFORGE_MODEL", "").strip():
            model_source = "runtime" if app.state.runtime_model else "env"
        provider = provider_from_env()
        provider_source: Optional[str] = None
        if os.environ.get("TABLEAUFORGE_PROVIDER", "").strip():
            provider_source = "runtime" if app.state.runtime_provider else "env"
        return {
            "provider": provider,
            "provider_source": provider_source,
            "ollama_base_url": ollama_base_url_from_env(),
            "ollama_model": ollama_model_from_env(),
            "ollama_num_ctx": ollama_num_ctx_cap_from_env(),
            # One flag for UI gates: LLM features work (local server needs no key).
            "llm_ready": provider == "ollama" or configured,
            "api_key_configured": configured,
            "api_key_masked": _mask_api_key(key) if configured else None,
            "api_key_source": source,
            "model": ForgeSettings.from_env().model,
            "model_source": model_source,
            "available_models": [dict(m) for m in AVAILABLE_MODELS],
        }

    @app.get("/healthz")
    def healthz() -> dict[str, str]:
        return {"status": "ok", "version": __version__}

    @app.get("/settings")
    def get_settings() -> dict[str, Any]:
        """Report whether the Claude API key is configured (masked) and the model."""
        return _settings_payload()

    @app.post("/settings/api-key")
    def set_api_key(body: ApiKeyIn) -> dict[str, Any]:
        """Set ANTHROPIC_API_KEY (used at LLM call time) and persist it.

        Takes effect immediately for every subsequent LLM call and is saved to
        the artifact store directory, so it survives restarts.
        """
        key = body.api_key.strip()
        if not key:
            raise HTTPException(status_code=422, detail="api_key must not be empty")
        os.environ["ANTHROPIC_API_KEY"] = key
        app.state.runtime_api_key = True
        try:
            _write_saved(anthropic_api_key=key)
        except OSError:
            pass  # key still active for this process; persistence is best-effort
        return _settings_payload()

    @app.delete("/settings/api-key")
    def clear_api_key() -> dict[str, Any]:
        """Clear a runtime-set key, including the persisted copy."""
        os.environ.pop("ANTHROPIC_API_KEY", None)
        app.state.runtime_api_key = False
        try:
            _write_saved(anthropic_api_key=None)
        except OSError:
            pass
        return _settings_payload()

    @app.post("/settings/model")
    def set_model(body: ModelIn) -> dict[str, Any]:
        """Switch the Claude model used for all LLM roles; persisted like the key."""
        model = body.model.strip()
        if model not in {m["id"] for m in AVAILABLE_MODELS}:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"unknown model {model!r}; available: "
                    + ", ".join(m["id"] for m in AVAILABLE_MODELS)
                ),
            )
        os.environ["TABLEAUFORGE_MODEL"] = model
        app.state.runtime_model = True
        try:
            _write_saved(model=model)
        except OSError:
            pass
        return _settings_payload()

    @app.post("/settings/provider")
    def set_provider(body: ProviderIn) -> dict[str, Any]:
        """Switch between Claude (Anthropic API) and a local Ollama server.

        Persisted like the key/model. Blank/omitted Ollama fields keep their
        current values so a provider flip never wipes the connection details.
        """
        provider = body.provider.strip().lower()
        if provider not in VALID_PROVIDERS:
            raise HTTPException(
                status_code=422,
                detail=f"unknown provider {provider!r}; available: "
                + ", ".join(VALID_PROVIDERS),
            )
        updates: dict[str, Optional[str]] = {"provider": provider}
        os.environ["TABLEAUFORGE_PROVIDER"] = provider
        app.state.runtime_provider = True
        base_url = (body.ollama_base_url or "").strip().rstrip("/")
        if base_url:
            os.environ["OLLAMA_BASE_URL"] = base_url
            updates["ollama_base_url"] = base_url
        ollama_model = (body.ollama_model or "").strip()
        if ollama_model:
            os.environ["TABLEAUFORGE_OLLAMA_MODEL"] = ollama_model
            updates["ollama_model"] = ollama_model
        if body.ollama_num_ctx is not None:
            if body.ollama_num_ctx < MIN_OLLAMA_NUM_CTX:
                raise HTTPException(
                    status_code=422,
                    detail=f"ollama_num_ctx must be at least {MIN_OLLAMA_NUM_CTX} "
                    "— a smaller context window leaves no room for both a rebuild "
                    "brief and its response.",
                )
            os.environ["TABLEAUFORGE_OLLAMA_NUM_CTX"] = str(body.ollama_num_ctx)
            updates["ollama_num_ctx"] = str(body.ollama_num_ctx)
        try:
            _write_saved(**updates)
        except OSError:
            pass  # still active for this process; persistence is best-effort
        return _settings_payload()

    @app.get("/ollama/models")
    def list_ollama_models() -> dict[str, Any]:
        """Installed models on the configured Ollama server (its /api/tags),
        so the Settings picker can offer real choices. Unreachable is a normal
        answer here — reported, never an error."""
        base = ollama_base_url_from_env().rstrip("/")
        try:
            import httpx

            response = httpx.get(f"{base}/api/tags", timeout=3.0)
            response.raise_for_status()
            models = [
                {"id": str(m.get("name", "")), "size_bytes": m.get("size")}
                for m in response.json().get("models", [])
                if m.get("name")
            ]
            return {"reachable": True, "models": models}
        except Exception:  # noqa: BLE001 - "not running" is an expected state
            return {"reachable": False, "models": []}

    def _tableau_payload() -> dict[str, Any]:
        """Tableau connection status. The PAT value is never returned — only masked."""
        config = TableauMcpConfig.from_env()
        source: Optional[str] = None
        if config.configured:
            source = "runtime" if app.state.runtime_tableau else "env"
        return {
            "configured": config.configured,
            "server": config.server or None,
            "site_name": config.site_name or None,
            "pat_name": config.pat_name or None,
            "pat_value_masked": _mask_api_key(config.pat_value) if config.pat_value else None,
            "source": source,
        }

    @app.get("/tableau/status")
    def tableau_status() -> dict[str, Any]:
        return _tableau_payload()

    @app.post("/settings/tableau")
    def set_tableau_settings(body: TableauSettingsIn) -> dict[str, Any]:
        """Set the Tableau Cloud/Server connection used by the MCP connector.

        Persisted like the Claude key; the running MCP session (if any) is
        reset so the next call signs in with the new values.
        """
        server = body.server.strip()
        pat_name = body.pat_name.strip()
        if not server or not pat_name:
            raise HTTPException(
                status_code=422, detail="server and pat_name must not be empty"
            )
        pat_value = (body.pat_value or "").strip()
        if not pat_value:
            # Editing without re-typing the secret keeps the stored one.
            pat_value = os.environ.get("TABLEAU_MCP_PAT_VALUE", "").strip()
        if not pat_value:
            raise HTTPException(status_code=422, detail="pat_value must not be empty")
        values = {
            "tableau_server": server,
            "tableau_site_name": body.site_name.strip(),
            "tableau_pat_name": pat_name,
            "tableau_pat_value": pat_value,
        }
        for saved_key, env_var in _TABLEAU_KEYS.items():
            os.environ[env_var] = values[saved_key]
        app.state.runtime_tableau = True
        try:
            _write_saved(**values)
        except OSError:
            pass  # settings still active for this process; persistence is best-effort
        tableau_mcp.reset()
        return _tableau_payload()

    @app.delete("/settings/tableau")
    def clear_tableau_settings() -> dict[str, Any]:
        """Clear the Tableau connection, including the persisted copy."""
        for env_var in _TABLEAU_KEYS.values():
            os.environ.pop(env_var, None)
        app.state.runtime_tableau = False
        try:
            _write_saved(**{saved_key: None for saved_key in _TABLEAU_KEYS})
        except OSError:
            pass
        tableau_mcp.reset()
        return _tableau_payload()

    @app.post("/profile")
    def profile_endpoint(file: UploadFile = File(...)) -> dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="tf-profile-") as tmp:
            dest = Path(tmp) / (Path(file.filename or "upload.csv").name)
            dest.write_bytes(file.file.read())
            try:
                return profile_csv(dest)
            except Exception as exc:  # noqa: BLE001 - surface parse problems as 422
                raise HTTPException(status_code=422, detail=f"could not profile CSV: {exc}")

    def _analyze_upload(image: UploadFile, llm: Optional[LlmClient] = None) -> dict[str, Any]:
        """Shared by /analyze-wireframe and /generate: validate + run vision analysis.

        Pass an LlmClient to have the vision call's token usage land on the
        caller's usage tally (the /generate flow does); otherwise a throwaway
        client is used."""
        media_type = (image.content_type or "").lower()
        if media_type not in SUPPORTED_MEDIA_TYPES:
            raise HTTPException(
                status_code=415,
                detail=(
                    f"unsupported image type {media_type or 'unknown'!r}; "
                    f"supported: {', '.join(SUPPORTED_MEDIA_TYPES)}"
                ),
            )
        image_bytes = image.file.read(MAX_WIREFRAME_BYTES + 1)
        if len(image_bytes) > MAX_WIREFRAME_BYTES:
            raise HTTPException(
                status_code=413,
                detail=(
                    f"image exceeds the {MAX_WIREFRAME_BYTES // (1024 * 1024)} MB "
                    "wireframe upload limit"
                ),
            )
        if not image_bytes:
            raise HTTPException(status_code=422, detail="image upload is empty")
        # Construction is side-effect-free; the SDK (and API key) is only
        # touched inside the vision call itself.
        if llm is None:
            llm = LlmClient()
        try:
            return analyze_wireframe(image_bytes, media_type, llm, ForgeSettings.from_env())
        except (MissingApiKeyError, OllamaUnavailableError) as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        except WireframeAnalysisError as exc:
            raise HTTPException(
                status_code=422,
                detail=(
                    "wireframe analysis failed the output contract after retry: "
                    + "; ".join(exc.errors)
                ),
            )

    @app.post("/analyze-wireframe")
    def analyze_wireframe_endpoint(image: UploadFile = File(...)) -> dict[str, Any]:
        return _analyze_upload(image)

    @app.post("/generate")
    def generate_endpoint(
        csv: UploadFile = File(...),
        text: str = Form(""),
        workbook_name: Optional[str] = Form(None),
        spec_json: Optional[str] = Form(None),
        image: Optional[UploadFile] = File(None),
        wireframe_analysis_json: Optional[str] = Form(None),
        llm_usage_json: Optional[str] = Form(None),
    ):
        if generate is None:
            raise HTTPException(
                status_code=503, detail="generation engine not available yet"
            )
        spec: Optional[dict[str, Any]] = (
            _parse_spec_json(spec_json) if spec_json else None
        )
        # Token usage accumulated by the client over earlier requests of the
        # same dashboard (draft + refines); merged with this request's calls.
        prior_usage = _parse_llm_usage_json(llm_usage_json)
        llm: Any = None
        if spec is None:
            # Construction is side-effect-free; the SDK (and API key) is only
            # touched if the generator actually authors a spec via the LLM.
            try:
                from tableauforge.llm.client import LlmClient

                llm = LlmClient()
            except Exception:  # noqa: BLE001 - parallel module may be missing
                llm = None
        # The one-sentence flow (GOAL §1): CSV + wireframe + text in one request.
        # A pre-computed analysis (from /analyze-wireframe) wins over re-analyzing.
        wireframe_analysis: Optional[dict[str, Any]] = None
        if wireframe_analysis_json:
            wireframe_analysis = _parse_spec_json(wireframe_analysis_json)
        elif image is not None and image.filename and spec is None:
            wireframe_analysis = _analyze_upload(image, llm)
        with tempfile.TemporaryDirectory(prefix="tf-generate-") as tmp:
            workdir = Path(tmp)
            csv_path = workdir / (Path(csv.filename or "data.csv").name)
            csv_path.write_bytes(csv.file.read())
            out_dir = workdir / "out"
            out_dir.mkdir()
            try:
                result = generate(
                    csv_path=csv_path,
                    user_text=text,
                    out_dir=out_dir,
                    llm=llm,
                    spec=spec,
                    workbook_name=workbook_name,
                    wireframe_analysis=wireframe_analysis,
                )
            except OllamaUnavailableError as exc:
                raise HTTPException(status_code=503, detail=str(exc))
            except MissingApiKeyError:
                # The text -> spec path needs an LLM; without one that's a
                # service-level gap, not a server bug (was a 500 before).
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "Generating from a text description requires a Claude "
                        "API key. Add one on the Settings page (gear icon) or "
                        "set ANTHROPIC_API_KEY, then retry — or switch the "
                        "provider to a local Ollama server there. Compiling an "
                        "existing DashboardSpec JSON needs no key."
                    ),
                )
            except SpecAuthoringError as exc:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Claude could not produce a valid DashboardSpec after "
                        f"retries: {'; '.join(exc.errors or ['unknown error'])}"
                    ),
                )
            except ANTHROPIC_API_ERRORS as exc:
                raise HTTPException(
                    status_code=502,
                    detail=f"Claude API call failed: {exc}",
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
                        "report": _report_to_dict(report) if report is not None else None,
                    },
                )
            artifact_src = Path(result.twbx_path or result.twb_path)
            kind = "twbx" if artifact_src.suffix.lower() == ".twbx" else "twb"
            dest_dir = store.artifacts_dir / result.artifact_id
            dest_dir.mkdir(parents=True, exist_ok=True)
            dest = dest_dir / artifact_src.name
            shutil.copyfile(artifact_src, dest)

        report_dict = _report_to_dict(result.report)
        llm_usage = merge_usage(
            prior_usage, llm.usage_summary() if llm is not None else None
        )
        store.save_artifact(
            artifact_id=result.artifact_id,
            workbook_name=workbook_name
            or result.spec.get("workbook", {}).get("name", artifact_src.stem),
            kind=kind,
            path=str(dest),
            spec=result.spec,
            report=report_dict,
            llm_usage=llm_usage,
        )
        return {
            "artifact_id": result.artifact_id,
            "spec": result.spec,
            "report": report_dict,
            "download_url": f"/download/{result.artifact_id}",
            "llm_usage": llm_usage,
            "polish": getattr(result, "polish_log", None),
            "field_resolutions": getattr(result, "field_resolutions", []),
        }

    @app.get("/templates")
    def templates_endpoint() -> dict[str, Any]:
        """Layout archetypes + accent palettes for the layout editor."""
        return {"templates": list_templates(), "palettes": list_palettes()}

    @app.post("/draft-spec")
    def draft_spec_endpoint(
        csv: UploadFile = File(...),
        text: str = Form(""),
        workbook_name: Optional[str] = Form(None),
        image: Optional[UploadFile] = File(None),
        wireframe_analysis_json: Optional[str] = Form(None),
    ) -> dict[str, Any]:
        """Author + design-pass a DashboardSpec WITHOUT compiling it, so the
        layout editor can show/edit/template it before the final build."""
        if draft_spec is None:
            raise HTTPException(status_code=503, detail="generation engine not available yet")
        from tableauforge.llm.client import LlmClient

        llm = LlmClient()
        wireframe_analysis: Optional[dict[str, Any]] = None
        if wireframe_analysis_json:
            wireframe_analysis = _parse_spec_json(wireframe_analysis_json)
        elif image is not None and image.filename:
            wireframe_analysis = _analyze_upload(image, llm)
        with tempfile.TemporaryDirectory(prefix="tf-draft-") as tmp:
            csv_path = Path(tmp) / (Path(csv.filename or "data.csv").name)
            csv_path.write_bytes(csv.file.read())
            try:
                spec = draft_spec(
                    csv_path=csv_path,
                    user_text=text,
                    llm=llm,
                    workbook_name=workbook_name,
                    wireframe_analysis=wireframe_analysis,
                )
            except OllamaUnavailableError as exc:
                raise HTTPException(status_code=503, detail=str(exc))
            except MissingApiKeyError:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "Drafting a dashboard from a text description requires a "
                        "Claude API key. Add one on the Settings page, or set "
                        "ANTHROPIC_API_KEY — or switch the provider to a local "
                        "Ollama server there."
                    ),
                )
            except SpecAuthoringError as exc:
                raise HTTPException(
                    status_code=422,
                    detail=(
                        "Claude could not produce a valid DashboardSpec after "
                        f"retries: {'; '.join(exc.errors or ['unknown error'])}"
                    ),
                )
            except ANTHROPIC_API_ERRORS as exc:
                raise HTTPException(status_code=502, detail=f"Claude API call failed: {exc}")
            except ValueError as exc:
                raise HTTPException(status_code=422, detail=str(exc))
        return {"spec": spec, "llm_usage": llm.usage_summary()}

    @app.post("/apply-template")
    def apply_template_endpoint(body: TemplateApplyIn) -> dict[str, Any]:
        """Re-arrange a spec's worksheets into a layout preset (no data change)."""
        try:
            spec = apply_template(body.spec, body.template_id, accent=body.accent)
        except KeyError as exc:
            raise HTTPException(status_code=422, detail=str(exc).strip('"'))
        # Surface a malformed result early (e.g. hand-edited spec).
        try:
            _parse_spec_json(json.dumps(spec))
        except HTTPException:
            raise HTTPException(status_code=422, detail="resulting spec is invalid")
        return {"spec": spec}

    @app.post("/refine-spec")
    def refine_spec_endpoint(body: RefineIn) -> dict[str, Any]:
        """Apply ONE user instruction to the current spec via the Spec Refiner
        role. Same gates as authoring (schema + field cross-check with retry
        feedback); failure is a 502, never a silently-wrong spec."""
        from tableauforge.llm.refiner import SpecRefineError, refine_spec
        from tableauforge.spec.schema import validate_spec as _validate_spec

        instruction = body.instruction.strip()
        if not instruction:
            raise HTTPException(status_code=422, detail="instruction must not be empty")
        schema_errors = list(_validate_spec(body.spec))
        if schema_errors:
            raise HTTPException(
                status_code=422,
                detail="current spec failed schema validation: "
                + "; ".join(schema_errors[:5]),
            )
        llm = LlmClient()
        try:
            refined = refine_spec(
                body.spec,
                instruction,
                llm=llm,
                settings=ForgeSettings.from_env(),
                profile=body.profile,
            )
        except (MissingApiKeyError, OllamaUnavailableError) as exc:
            raise HTTPException(status_code=503, detail=str(exc))
        except SpecRefineError as exc:
            raise HTTPException(
                status_code=502,
                detail=(
                    "Claude could not apply the instruction: "
                    + "; ".join(exc.errors[:5] or [str(exc)])
                ),
            )
        except ANTHROPIC_API_ERRORS as exc:
            raise HTTPException(status_code=502, detail=f"Claude API call failed: {exc}")
        return {"spec": refined, "llm_usage": llm.usage_summary()}

    @app.post("/preview-data")
    def preview_data_endpoint(
        csv: UploadFile = File(...),
        spec_json: str = Form(...),
    ) -> dict[str, Any]:
        """Deterministic per-worksheet preview aggregation for the studio's
        WYSIWYG tiles. Pure pandas — no LLM, no compile, no Hyper, no key."""
        from tableauforge.preview.data import PreviewError, preview_rows
        from tableauforge.profiler.csv_profiler import load_dataframe
        from tableauforge.spec.schema import validate_spec as _validate_spec

        spec = _parse_spec_json(spec_json)
        schema_errors = list(_validate_spec(spec))
        if schema_errors:
            raise HTTPException(
                status_code=422,
                detail="spec failed schema validation: " + "; ".join(schema_errors[:5]),
            )
        with tempfile.TemporaryDirectory(prefix="tf-preview-") as tmp:
            csv_path = Path(tmp) / (Path(csv.filename or "data.csv").name)
            csv_path.write_bytes(csv.file.read())
            try:
                df = load_dataframe(csv_path)
            except Exception as exc:  # noqa: BLE001 - parse problems are client errors
                raise HTTPException(status_code=422, detail=f"could not read CSV: {exc}")
            try:
                worksheets = preview_rows(spec, df)
            except PreviewError as exc:
                raise HTTPException(status_code=422, detail=str(exc))
        return {"worksheets": worksheets}

    @app.post("/validate-spec")
    def validate_spec_endpoint(body: SpecValidateIn) -> dict[str, Any]:
        """Validate a DashboardSpec (JSON Schema + pydantic model) WITHOUT compiling
        or building a file. Used by the layout/structure editor for inline feedback.
        Always returns HTTP 200 with {valid, errors, errors_detail}; errors is the
        flat string list (backwards-compatible), errors_detail additionally maps
        each error to the offending worksheet id / zone index when derivable so
        the studio can badge the exact tile."""
        from tableauforge.spec.schema import validate_spec

        details: list[dict[str, Any]] = []
        for msg in validate_spec(body.spec):
            ws_id, zone_index = _locus_from_path(body.spec, msg)
            details.append({"message": msg, "worksheet_id": ws_id, "zone_index": zone_index})
        if not details:
            # Catch cross-field model rules the JSON Schema can't express
            # (sort consistency, zone kind/worksheet refs, etc.).
            try:
                from tableauforge.spec.models import DashboardSpec as _DS
                _DS.model_validate(body.spec)
            except Exception as exc:  # pydantic ValidationError or ValueError
                errors_fn = getattr(exc, "errors", None)
                if callable(errors_fn):
                    for e in errors_fn():
                        loc = tuple(e.get("loc", ()))
                        path = "$." + ".".join(str(p) for p in loc)
                        ws_id = None
                        zone_index = None
                        if len(loc) >= 2 and loc[0] == "worksheets" and isinstance(loc[1], int):
                            try:
                                ws_id = (body.spec.get("worksheets") or [])[loc[1]].get("id")
                            except (IndexError, TypeError, AttributeError):
                                ws_id = None
                        if (
                            len(loc) >= 4
                            and loc[0] == "dashboards"
                            and loc[2] == "zones"
                            and isinstance(loc[3], int)
                        ):
                            zone_index = loc[3]
                        details.append(
                            {
                                "message": f"{path}: {e.get('msg')}",
                                "worksheet_id": ws_id,
                                "zone_index": zone_index,
                            }
                        )
                else:
                    details.append(
                        {"message": str(exc), "worksheet_id": None, "zone_index": None}
                    )
            # Compiler-only structural rules (twb.py) that aren't in the schema or
            # the typing model, surfaced here so the editor warns pre-build instead
            # of only 422-ing at build time.
            details.extend(_compiler_structural_issue_details(body.spec))
        return {
            "valid": not details,
            "errors": [d["message"] for d in details],
            "errors_detail": details,
        }

    @app.post("/validate")
    def validate_endpoint(
        file: UploadFile = File(...),
        spec_json: Optional[str] = Form(None),
    ) -> dict[str, Any]:
        suffix = Path(file.filename or "").suffix.lower()
        if suffix not in (".twb", ".twbx"):
            raise HTTPException(status_code=422, detail="expected a .twb or .twbx upload")
        with tempfile.TemporaryDirectory(prefix="tf-validate-") as tmp:
            path = Path(tmp) / (Path(file.filename or f"artifact{suffix}").name)
            path.write_bytes(file.file.read())
            if spec_json:
                if validate_artifact is None:
                    raise HTTPException(
                        status_code=501,
                        detail="spec-aware validation arrives with tableauforge.validate.pipeline",
                    )
                spec = _parse_spec_json(spec_json)
                try:
                    twb_bytes = _read_twb_bytes(path)
                except (zipfile.BadZipFile, ValueError, OSError):
                    return xsd_only_report(path)  # carries the read error
                return _report_to_dict(
                    validate_artifact(
                        spec_dict=spec,
                        twb_bytes=twb_bytes,
                        twb_path=path if suffix == ".twb" else None,
                        twbx_path=path if suffix == ".twbx" else None,
                    )
                )
            return xsd_only_report(path)

    @app.get("/artifacts/{artifact_id}")
    def artifact_detail(artifact_id: str) -> dict[str, Any]:
        row = store.get_artifact(artifact_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"unknown artifact id: {artifact_id}")
        return {
            "id": row["id"],
            "workbook_name": row["workbook_name"],
            "kind": row["kind"],
            # The stored filename, not just the kind: a split databricks build
            # is a `.lvdash.zip` and an unsplit one a `.lvdash.json`, and both
            # store kind 'lvdash' — without this the gallery cannot tell them
            # apart (nor a .twb from a .twbx by anything but the kind).
            "path": row["path"],
            "created_at": row["created_at"],
            "spec": row["spec"],
            "report": row["report"],
            "download_url": f"/download/{row['id']}",
            "llm_usage": row.get("llm_usage"),
        }

    @app.get("/download/{artifact_id}")
    def download(artifact_id: str) -> FileResponse:
        row = store.get_artifact(artifact_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"unknown artifact id: {artifact_id}")
        path = Path(row["path"])
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"artifact file missing: {path.name}")
        return FileResponse(
            path, filename=path.name, media_type="application/octet-stream"
        )

    @app.get("/artifacts")
    def artifacts() -> dict[str, list[dict[str, Any]]]:
        return {
            "artifacts": [
                {
                    "id": r["id"],
                    "workbook_name": r["workbook_name"],
                    "kind": r["kind"],
                    # See artifact_detail: the filename is what distinguishes a
                    # split `.lvdash.zip` from a single `.lvdash.json`.
                    "path": r["path"],
                    "created_at": r["created_at"],
                    "download_url": f"/download/{r['id']}",
                    "llm_usage": r.get("llm_usage"),
                }
                for r in store.list_artifacts()
            ]
        }

    app.include_router(build_db_router(store, settings))
    app.include_router(build_rebuild_router(store, settings))
    if build_tableau_router is not None:
        app.include_router(build_tableau_router(store, settings, tableau_mcp))

    # Serve the built frontend when packaged (Docker sets TABLEAUFORGE_STATIC_DIR).
    # Mounted last so API routes always win.
    static_dir = os.environ.get("TABLEAUFORGE_STATIC_DIR")
    if static_dir and Path(static_dir).is_dir():
        from fastapi.staticfiles import StaticFiles

        app.mount("/", StaticFiles(directory=static_dir, html=True), name="static")

    return app
