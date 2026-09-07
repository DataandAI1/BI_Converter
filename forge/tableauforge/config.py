"""Runtime configuration from environment variables.

GOAL §3.2: model strings are config values, never hardcoded at call sites.
ANTHROPIC_API_KEY is required lazily — only when an actual Claude call happens —
so compiling an existing spec works fully offline with no key set.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

# Claude Fable 5: adaptive thinking is always on (no thinking config), and
# effort is the primary quality/latency control (platform.claude.com docs,
# "Prompting Claude Fable 5" + "Effort", fetched 2026-06-12). Generation
# favors quality over speed, so effort defaults to high and requests may run
# for minutes; xhigh/max are available via TABLEAUFORGE_EFFORT.
DEFAULT_MODEL = "claude-fable-5"
#: Fable 5 safety classifiers can return stop_reason "refusal" on benign work;
#: the documented remedy is falling back to Opus 4.8 for that request.
DEFAULT_FALLBACK_MODEL = "claude-opus-4-8"
DEFAULT_EFFORT = "high"
VALID_EFFORT_LEVELS = ("low", "medium", "high", "xhigh", "max")

#: Models offered by the Settings page picker. supports_effort mirrors the
#: platform docs ("Effort", fetched 2026-06-12): the effort parameter is
#: accepted by Fable 5 / Opus 4.8 / Sonnet 4.6 but NOT by Haiku — sending
#: output_config to an unsupported model would 400 the request.
AVAILABLE_MODELS: tuple[dict, ...] = (
    {
        "id": "claude-fable-5",
        "label": "Claude Fable 5",
        "description": "Most capable; best dashboards. Generation can take minutes.",
        "supports_effort": True,
    },
    {
        "id": "claude-opus-4-8",
        "label": "Claude Opus 4.8",
        "description": "Very capable; also the automatic fallback when Fable 5 declines a request.",
        "supports_effort": True,
    },
    {
        "id": "claude-sonnet-4-6",
        "label": "Claude Sonnet 4.6",
        "description": "Fast and balanced; good for quick iterations.",
        "supports_effort": True,
    },
    {
        "id": "claude-haiku-4-5-20251001",
        "label": "Claude Haiku 4.5",
        "description": "Fastest and cheapest; simpler dashboards.",
        "supports_effort": False,
    },
)


def supports_effort(model: str) -> bool:
    """Whether the Messages API accepts output_config effort for this model.

    Unknown/custom model ids default to True (current frontier models accept
    effort; the picker's catalog covers the rest).
    """
    for entry in AVAILABLE_MODELS:
        if entry["id"] == model:
            return bool(entry["supports_effort"])
    return True
DEFAULT_ARTIFACTS_DIR = "./artifacts"
DEFAULT_MAX_SPEC_RETRIES = 3

# LLM provider: "claude" (Anthropic API, needs a key) or "ollama" (local server,
# no key). Like the model, this is runtime-switchable via the Settings page —
# the endpoints mutate the env vars below, so read them at call time.
VALID_PROVIDERS = ("claude", "ollama")
DEFAULT_PROVIDER = "claude"
DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434"
DEFAULT_OLLAMA_MODEL = "llama3.1"


def provider_from_env(env: Mapping[str, str] | None = None) -> str:
    """Active LLM provider. Unknown values fall back to Claude (the endpoints
    422 bad values at set time; a hand-set env var must not break every call)."""
    env = os.environ if env is None else env
    value = env.get("TABLEAUFORGE_PROVIDER", DEFAULT_PROVIDER).strip().lower()
    return value if value in VALID_PROVIDERS else DEFAULT_PROVIDER


def ollama_base_url_from_env(env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    return env.get("OLLAMA_BASE_URL", "").strip() or DEFAULT_OLLAMA_BASE_URL


def ollama_model_from_env(env: Mapping[str, str] | None = None) -> str:
    env = os.environ if env is None else env
    return env.get("TABLEAUFORGE_OLLAMA_MODEL", "").strip() or DEFAULT_OLLAMA_MODEL


#: Upper bound for the per-request context window (options.num_ctx) sent to
#: Ollama. Requests size num_ctx to the prompt (rebuild briefs run tens of
#: thousands of tokens) but never past this cap — KV-cache memory scales with
#: it. Raise via env (or the Settings page) on machines with headroom.
DEFAULT_OLLAMA_NUM_CTX_CAP = 32768
#: Floor for a custom num_ctx cap. A smaller window leaves no room for both a
#: rebuild brief and its JSON answer, so values below this are refused (endpoint)
#: or clamped up (a hand-set env var must not break every call).
MIN_OLLAMA_NUM_CTX = 2048


def ollama_think_from_env(env: Mapping[str, str] | None = None) -> bool:
    """Whether an Ollama reasoning model may emit `thinking` on JSON calls.

    Default OFF. forge never reads `message.thinking`, but the model generates it
    into the SAME budget as the answer, so a talkative model spends the context
    window reasoning and returns truncated — or entirely empty — JSON. Measured
    on a 4-screenshot Power BI rebuild (2026-07-31): thinking on gave 0/3
    parseable answers (worst attempt: 30,288 chars of thinking, 4,480 of answer,
    done_reason=length), thinking off gave 3/3 complete envelopes in half the
    wall-clock. Set TABLEAUFORGE_OLLAMA_THINK=1 to turn it back on — reasoning
    can still help spec quality on smaller briefs that leave room for both.
    """
    env = os.environ if env is None else env
    return env.get("TABLEAUFORGE_OLLAMA_THINK", "").strip().lower() in (
        "1", "true", "yes", "on",
    )


def ollama_num_ctx_cap_from_env(env: Mapping[str, str] | None = None) -> int:
    env = os.environ if env is None else env
    raw = env.get("TABLEAUFORGE_OLLAMA_NUM_CTX", "").strip()
    if not raw:
        return DEFAULT_OLLAMA_NUM_CTX_CAP
    try:
        value = int(raw)
    except ValueError:
        return DEFAULT_OLLAMA_NUM_CTX_CAP
    return max(MIN_OLLAMA_NUM_CTX, value)


class MissingApiKeyError(RuntimeError):
    """Raised when an LLM call is attempted without ANTHROPIC_API_KEY set."""


class OllamaUnavailableError(RuntimeError):
    """Raised when the Ollama provider is selected but the local server (or the
    chosen model) can't serve the request. Maps to 503 like MissingApiKeyError —
    a service-level gap, not a server bug."""


@dataclass(frozen=True)
class Settings:
    """Application settings. Build from the environment with from_env(); construct directly in tests."""

    model: str = DEFAULT_MODEL
    vision_model: str = DEFAULT_MODEL
    fallback_model: str = DEFAULT_FALLBACK_MODEL
    effort: str = DEFAULT_EFFORT
    field_building_pass: bool = True
    design_pass: bool = True
    polish_pass: bool = True
    artifacts_dir: Path = Path(DEFAULT_ARTIFACTS_DIR)
    max_spec_retries: int = DEFAULT_MAX_SPEC_RETRIES

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        model = env.get("TABLEAUFORGE_MODEL", DEFAULT_MODEL)
        raw_retries = env.get("TABLEAUFORGE_MAX_SPEC_RETRIES", str(DEFAULT_MAX_SPEC_RETRIES))
        try:
            max_spec_retries = int(raw_retries)
        except ValueError as exc:
            raise ValueError(
                f"TABLEAUFORGE_MAX_SPEC_RETRIES must be an integer, got {raw_retries!r}"
            ) from exc
        if max_spec_retries < 1:
            raise ValueError(
                f"TABLEAUFORGE_MAX_SPEC_RETRIES must be >= 1, got {max_spec_retries}"
            )
        effort = env.get("TABLEAUFORGE_EFFORT", DEFAULT_EFFORT).strip().lower()
        if effort not in VALID_EFFORT_LEVELS:
            raise ValueError(
                f"TABLEAUFORGE_EFFORT must be one of {VALID_EFFORT_LEVELS}, got {effort!r}"
            )
        field_building_pass = env.get(
            "TABLEAUFORGE_FIELD_BUILDING_PASS", "1"
        ).strip().lower() not in ("0", "false", "no", "off")
        design_pass = env.get("TABLEAUFORGE_DESIGN_PASS", "1").strip().lower() not in (
            "0", "false", "no", "off",
        )
        polish_pass = env.get("TABLEAUFORGE_POLISH_PASS", "1").strip().lower() not in (
            "0", "false", "no", "off",
        )
        return cls(
            model=model,
            vision_model=env.get("TABLEAUFORGE_VISION_MODEL", model),
            fallback_model=env.get("TABLEAUFORGE_FALLBACK_MODEL", DEFAULT_FALLBACK_MODEL),
            effort=effort,
            field_building_pass=field_building_pass,
            design_pass=design_pass,
            polish_pass=polish_pass,
            artifacts_dir=Path(env.get("TABLEAUFORGE_ARTIFACTS_DIR", DEFAULT_ARTIFACTS_DIR)),
            max_spec_retries=max_spec_retries,
        )


def require_api_key(env: Mapping[str, str] | None = None) -> str:
    """Return ANTHROPIC_API_KEY or raise. Called only at LLM call time, never at import."""
    env = os.environ if env is None else env
    key = env.get("ANTHROPIC_API_KEY", "").strip()
    if not key:
        raise MissingApiKeyError(
            "ANTHROPIC_API_KEY is not set. It is required only for Claude API calls "
            "(rebuild authoring); compiling "
            "an existing spec needs no key."
        )
    return key
