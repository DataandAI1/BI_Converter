"""FastAPI app factory: the forge's HTTP surface.

The forge owns exactly one job — LLM authoring and spec compilation — and this module is
its front door. Upstream (TableauForge, via Linetria) it carried 24 routes across a CSV/
database designer flow, a Tableau MCP connector, wireframe analysis, and three build
targets. BI_Converter keeps 7 (spec §4.3):

    GET  /healthz                       liveness; the shell answers 502 with a start hint
    GET  /settings                      provider/model status, secrets masked
    POST /settings/{provider,model,api-key}   provider configuration
    POST /draft-rebuild-spec            brief (+ screenshots) -> {spec, translation, warnings}
    POST /generate-rebuild              spec -> compiled .lvdash.json artifact
    POST /validate                      validate a spec, or an emitted artifact
    GET  /artifacts/{id}, /download/{id}      artifact retrieval

The forge stays STATELESS with respect to conversion: the shell round-trips the brief,
spec, and translation report between calls. Only artifacts are held, in ArtifactStore.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from fastapi.responses import FileResponse

from tableauforge import __version__
from tableauforge.api.rebuild_routes import build_rebuild_router
from tableauforge.api.store import ArtifactStore
from tableauforge.config import (
    AVAILABLE_MODELS,
    MIN_OLLAMA_NUM_CTX,
    VALID_PROVIDERS,
    ollama_base_url_from_env,
    ollama_model_from_env,
    ollama_num_ctx_cap_from_env,
    provider_from_env,
)
from tableauforge.config import Settings as ForgeSettings


class ApiKeyIn(BaseModel):
    """Request body for POST /settings/api-key."""

    api_key: str


class ModelIn(BaseModel):
    """Request body for POST /settings/model."""

    model: str


class ProviderIn(BaseModel):
    """Request body for POST /settings/provider.

    ollama_base_url / ollama_model / ollama_num_ctx are optional: omitting (or blanking)
    them keeps the current values, so switching provider does not wipe the Ollama
    connection details.
    """

    provider: str
    ollama_base_url: Optional[str] = None
    ollama_model: Optional[str] = None
    #: Context-window cap (options.num_ctx) for Ollama requests. Requests still size
    #: num_ctx to the prompt but never above this — raise it for large reports when the
    #: machine has the memory.
    ollama_num_ctx: Optional[int] = None


class ValidateIn(BaseModel):
    """Request body for POST /validate.

    Either half may be given. A `spec` alone is checked against the DashboardSpec JSON
    Schema plus the deterministic field-reference precheck; adding `artifact` (the text of
    a `.lvdash.json`) runs the full four-layer artifact validation the build itself runs.
    """

    spec: Optional[dict[str, Any]] = None
    artifact: Optional[str] = None


def _mask_api_key(key: str) -> str:
    """Mask a key for display — the secret is never echoed back in full.

    Short keys are fully masked; longer ones show a 5-char prefix and 4-char suffix so a
    user can confirm *which* key is set without exposing it.
    """
    key = key.strip()
    if len(key) <= 8:
        return "•" * len(key)
    return f"{key[:5]}…{key[-4:]}"


@dataclass(frozen=True)
class Settings:
    """API configuration. artifacts_dir holds forge.db plus persisted artifact files."""

    artifacts_dir: Path = Path("artifacts") / "api"


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    """Build the forge API. Pass Settings to redirect persistence (tests do)."""
    settings = settings or Settings()
    store = ArtifactStore(settings.artifacts_dir)

    app = FastAPI(title="BI_Converter forge", version=__version__)
    app.state.settings = settings
    app.state.store = store
    # True once the key has been set via POST /settings/api-key (this process, or a
    # previous one via the saved settings file), so GET /settings can distinguish a
    # UI-provided key from a host/env one.
    app.state.runtime_api_key = False
    app.state.runtime_model = False
    app.state.runtime_provider = False

    # Settings set through the UI are persisted next to the artifact store, so they
    # survive restarts instead of silently reverting.
    settings_file = store.artifacts_dir / "settings.json"

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
            # One flag for UI gates: LLM features work (a local server needs no key).
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
        return _settings_payload()

    @app.post("/settings/api-key")
    def set_api_key(body: ApiKeyIn) -> dict[str, Any]:
        """Set ANTHROPIC_API_KEY (used at LLM call time) and persist it.

        Takes effect immediately for every subsequent LLM call and is saved to the
        artifact store directory, so it survives restarts.
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
        """Switch the model used for authoring; persisted like the key."""
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

        Persisted like the key/model. Blank/omitted Ollama fields keep their current
        values, so a provider flip never wipes the connection details.
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

    @app.post("/validate")
    def validate_endpoint(body: ValidateIn) -> dict[str, Any]:
        """Validate a DashboardSpec, an emitted `.lvdash.json`, or both together.

        Spec-only is schema plus the deterministic field-reference precheck — the same two
        gates authoring runs. With an artifact, the full four-layer artifact validation
        runs instead, which is what the build itself gates on.
        """
        from tableauforge.spec.models import DashboardSpec
        from tableauforge.spec.precheck import precheck_field_references
        from tableauforge.spec.schema import validate_spec

        if body.spec is None and body.artifact is None:
            raise HTTPException(status_code=422, detail="provide a spec, an artifact, or both")

        if body.artifact is not None:
            if body.spec is None:
                raise HTTPException(
                    status_code=422,
                    detail="validating an artifact needs the spec it was compiled from",
                )
            from tableauforge.validate.lakeview import validate_lakeview_artifact

            report, warnings = validate_lakeview_artifact(body.spec, body.artifact)
            return {
                "valid": report.passed,
                "report": report.to_dict(),
                "warnings": warnings,
            }

        errors = validate_spec(body.spec)
        if not errors:
            errors = precheck_field_references(DashboardSpec.model_validate(body.spec))
        return {"valid": not errors, "errors": errors}

    @app.get("/artifacts/{artifact_id}")
    def artifact_detail(artifact_id: str) -> dict[str, Any]:
        row = store.get_artifact(artifact_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"unknown artifact id: {artifact_id}")
        return {
            "id": row["id"],
            "workbook_name": row["workbook_name"],
            "kind": row["kind"],
            # The stored filename, not just the kind: a split build is a `.lvdash.zip` and
            # an unsplit one a `.lvdash.json`, and both store kind 'lvdash'.
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
        return FileResponse(path, filename=path.name, media_type="application/octet-stream")

    app.include_router(build_rebuild_router(store, settings))
    return app


#: Module-level app for `uvicorn tableauforge.api.main:app`.
app = create_app()
