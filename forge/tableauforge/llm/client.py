"""Thin wrapper over the LLM providers (GOAL §3.2): the Anthropic Messages API
by default, or a local Ollama server when TABLEAUFORGE_PROVIDER=ollama.

Every call demands JSON-only output, parses the response defensively, and logs
token usage per request. The underlying transports are injectable so tests
never touch the network.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from tableauforge.config import (
    OllamaUnavailableError,
    ollama_base_url_from_env,
    ollama_model_from_env,
    ollama_num_ctx_cap_from_env,
    ollama_think_from_env,
    provider_from_env,
    require_api_key,
    supports_effort,
)

logger = logging.getLogger(__name__)

_JSON_ONLY_DIRECTIVE = (
    "Respond with exactly one JSON object and nothing else: "
    "no markdown fences, no prose, no explanations."
)

#: Tokens to budget per attached image when sizing the Ollama context window.
#: Vision encoders resize to a fixed patch budget, so the cost is roughly
#: constant per image rather than proportional to its bytes — measured on real
#: rebuild requests as ~1,610-1,620 tokens each across screenshots ranging from
#: 90KB to 590KB (4 images = 6,484 and 6,441 tokens on two runs). Counting them
#: matters: while images were excluded from the estimate entirely, a 4-screenshot
#: rebuild sized num_ctx for a 12.4k-token prompt that was really 18.9k, promised
#: the model 16,384 output tokens when under 10k remained, and generation died on
#: the context wall mid-JSON (2026-07-31).
OLLAMA_IMAGE_TOKENS = 1650

#: Characters per token for the text half of an Ollama prompt. Deliberately an
#: OVER-estimate of the token count (a low divisor): num_ctx is sized from it,
#: and a window smaller than the real prompt makes Ollama silently truncate the
#: brief. But over-estimating is not free either — it is charged twice if the
#: generation budget is also derived from it, so keep it close to measured.
#:
#: Measured against Ollama's own prompt_eval_count on three real rebuild
#: prompts (system prompt + brief JSON, qwen-family tokenizer):
#:   58,101 chars -> 14,895 tokens (3.90 c/t)
#:   58,272 chars -> 15,754 tokens (3.70 c/t)
#:   40,662 chars -> 11,054 tokens (3.68 c/t)
#: The original /3 over-counted by 23-28%, which on a capped window is pure
#: output budget thrown away. 3.5 still over-counts (safely) by ~10%.
OLLAMA_CHARS_PER_TOKEN = 3.5


def estimate_prompt_tokens(system: str, text: str, image_count: int = 0) -> int:
    """Conservative (deliberately high) estimate of an Ollama prompt's tokens.

    Shared by the client (which sizes num_ctx) and by callers that must decide
    what to put IN the prompt (rebuild_author's retry guard) so the two cannot
    drift — they used to disagree by a whole system prompt plus every image.
    """
    chars = len(system) + len(text)
    return int(chars / OLLAMA_CHARS_PER_TOKEN) + image_count * OLLAMA_IMAGE_TOKENS


def _round_up_context(tokens: int) -> int:
    """Round a token count up to the next 4,096 — context windows are set in
    round numbers, and the Settings page takes one integer."""
    return max(8192, -(-tokens // 4096) * 4096)


class LlmJsonError(ValueError):
    """Model response could not be parsed as JSON. Carries the raw text for debugging/retry."""

    def __init__(self, message: str, raw_text: str):
        self.raw_text = raw_text
        super().__init__(f"{message}\n--- raw model output ---\n{raw_text}")


#: Module-level so repeated calls reuse one scanner (json.loads builds a fresh
#: decoder per call).
_DECODER = json.JSONDecoder()


def extract_json(text: str) -> dict[str, Any]:
    """Parse model output defensively: strip markdown fences, then decode the
    FIRST complete JSON value starting at the first '{' and ignore anything
    that follows it.

    Trailing content is a routine model whim, and the answer in front of it is
    perfectly good. Ollama-served local models are the frequent offender: once
    the JSON grammar is satisfied they sometimes keep generating and append a
    second copy of the object on the same line. Slicing first-'{' to *last*-'}'
    folded that tail back into the parse and failed the entire call with
    "Extra data: line 1 column N" — discarding a usable answer and burning
    every authoring retry (observed on a Power BI rebuild, 2026-07-28). The
    same slice also tripped over ordinary commentary containing braces.
    raw_decode stops at the end of the first value, so every input the old
    slice accepted still parses to the same object.
    """
    cleaned = text.strip()
    if cleaned.startswith("```"):
        lines = cleaned.splitlines()[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        cleaned = "\n".join(lines).strip()
    start = cleaned.find("{")
    if start == -1:
        raise LlmJsonError("no JSON object found in model response", text)
    try:
        parsed, _end = _DECODER.raw_decode(cleaned, start)
    except json.JSONDecodeError as exc:
        raise LlmJsonError(f"model response is not valid JSON: {exc}", text) from exc
    if not isinstance(parsed, dict):
        raise LlmJsonError("model response JSON is not an object", text)
    return parsed


def _is_model_unavailable(exc: Exception) -> bool:
    """True when an API error means the requested model isn't available to this
    account (HTTP 404 not_found), so a fallback model should be tried."""
    status = getattr(exc, "status_code", None)
    if status == 404:
        return True
    text = str(exc).lower()
    return "not_found_error" in text or "is not available" in text


class LlmClient:
    """LLM provider wrapper. Pass ``client`` (Anthropic SDK) or ``http_post``
    (Ollama transport) to inject fakes in tests.

    Every round trip is appended to ``usage_calls`` (purpose, model, token
    counts) so callers can report what a whole generation cost — including
    retries and fallback re-requests, which each count as their own call.
    """

    def __init__(self, client: Any | None = None, http_post: Any | None = None):
        self._client = client
        self._http_post = http_post
        self.usage_calls: list[dict[str, Any]] = []

    def _sdk(self) -> Any:
        if self._client is None:
            import anthropic

            self._client = anthropic.Anthropic(api_key=require_api_key())
        return self._client

    def _request(self, kwargs: dict[str, Any]) -> Any:
        """One Messages-API round trip via streaming.

        Streaming is the SDK-prescribed transport for requests that can run
        past 10 minutes (anthropic-sdk-python#long-requests) — at our generous
        max_tokens the non-streaming path is rejected outright. We accumulate
        and return only the final message; quality over latency.
        """
        with self._sdk().messages.stream(**kwargs) as stream:
            return stream.get_final_message()

    def _request_recorded(self, kwargs: dict[str, Any], purpose: str | None) -> Any:
        """_request plus a usage_calls entry for the round trip that completed."""
        message = self._request(kwargs)
        usage = getattr(message, "usage", None)
        self.usage_calls.append(
            {
                "purpose": purpose or "llm_call",
                "model": str(kwargs.get("model")),
                "input_tokens": int(getattr(usage, "input_tokens", 0) or 0),
                "output_tokens": int(getattr(usage, "output_tokens", 0) or 0),
            }
        )
        return message

    def usage_summary(self) -> dict[str, Any]:
        """Totals + per-call breakdown for every round trip this client made."""
        from tableauforge.llm.usage import summarize_usage

        return summarize_usage(self.usage_calls)

    # ---- Ollama provider -----------------------------------------------------

    def _post(self, url: str, payload: dict[str, Any]) -> Any:
        """One POST to the local Ollama server. Injectable via ``http_post``."""
        if self._http_post is not None:
            return self._http_post(url, payload)
        import httpx

        # Local models can legitimately chew for a long while on a big spec;
        # only the connect phase gets a short leash.
        return httpx.post(url, json=payload, timeout=httpx.Timeout(600.0, connect=5.0))

    def _ollama_json(
        self,
        system: str,
        user_content: str | list[dict[str, Any]],
        max_tokens: int,
        purpose: str | None,
    ) -> dict[str, Any]:
        """One /api/chat round trip against Ollama whose answer must be JSON.

        Anthropic-style content blocks are translated in place: text blocks
        join into the prompt, image blocks become the message's ``images``
        (base64) — so the vision path works with vision-capable local models
        (llava, qwen2.5vl, …) without touching any caller.
        """
        base = ollama_base_url_from_env().rstrip("/")
        model = ollama_model_from_env()
        if isinstance(user_content, str):
            text, images = user_content, []
        else:
            parts: list[str] = []
            images = []
            for block in user_content:
                kind = block.get("type")
                if kind == "text":
                    parts.append(str(block.get("text", "")))
                elif kind == "image":
                    images.append(str(block.get("source", {}).get("data", "")))
            text = "\n\n".join(p for p in parts if p)
        message: dict[str, Any] = {"role": "user", "content": text}
        if images:
            message["images"] = images
        # Context sizing: Ollama's runtime default num_ctx varies by install and
        # silently truncates oversized prompts, and prompt + generation share one
        # window — a near-full prompt cuts the JSON off mid-token (observed:
        # 28,325 in + 4,443 out = the window, then "Expecting ',' delimiter").
        # Size the window to the prompt plus an output reserve, cap generation to
        # the room actually left, and refuse outright when no room remains —
        # a truncated brief only yields garbage after N model-minutes.
        cap = ollama_num_ctx_cap_from_env()
        est_prompt_tokens = estimate_prompt_tokens(system, text, len(images))
        num_ctx = min(max(8192, est_prompt_tokens + min(max_tokens, 16384)), cap)
        room = num_ctx - est_prompt_tokens
        # 4096 floor: a DashboardSpec answer realistically needs that much; a
        # squeaked-past smaller budget just burns model-minutes into truncation.
        if room < 4096:
            raise OllamaUnavailableError(
                f"the prompt (~{est_prompt_tokens} tokens estimated"
                f"{f', including {len(images)} image(s)' if images else ''}) leaves no "
                f"room for a response inside the context cap ({cap}) — reduce the "
                "report's tables/columns, turn off visual capture for this build, "
                "raise TABLEAUFORGE_OLLAMA_NUM_CTX, or switch the provider to Claude "
                "on the Settings page."
            )
        payload: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": f"{system.rstrip()}\n\n{_JSON_ONLY_DIRECTIVE}"},
                message,
            ],
            "stream": False,
            "format": "json",
            # Reasoning off by default — it shares the generation budget with the
            # answer and forge never reads it (see ollama_think_from_env for the
            # measurements). Servers/models that reject the field fall back below.
            "think": ollama_think_from_env(),
            # Sampling overrides beat the model's Modelfile: strict-JSON output
            # wants near-greedy decoding, and a presence penalty (qwen ships 1.5)
            # progressively punishes the repeated keys a large spec requires.
            "options": {
                "num_predict": min(max_tokens, room),
                "num_ctx": num_ctx,
                "temperature": 0.2,
                "presence_penalty": 0,
            },
        }
        # Runtime dep (pyproject): needed for the exception taxonomy below even
        # when the transport itself is injected.
        import httpx

        def send(body: dict[str, Any]) -> Any:
            try:
                return self._post(f"{base}/api/chat", body)
            except (httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout) as exc:
                # The server took the request and is (probably still) generating —
                # "start ollama serve" would be actively wrong advice here.
                raise OllamaUnavailableError(
                    f"Ollama at {base} accepted the request but didn't finish within "
                    f"10 minutes — the model {model!r} may be too slow for this "
                    "hardware. Try a smaller/faster model, or switch the provider "
                    "back to Claude on the Settings page."
                ) from exc
            except Exception as exc:  # noqa: BLE001 - anything else means "not reachable"
                raise OllamaUnavailableError(
                    f"Ollama is not reachable at {base} — start it with `ollama serve` "
                    "(https://ollama.com), or switch the provider back to Claude on the "
                    "Settings page."
                ) from exc

        response = send(payload)
        # Older servers and non-reasoning models can reject the `think` field. When
        # that is the only objection, drop it and retry rather than failing a call
        # that would otherwise succeed.
        if response.status_code >= 400 and "think" in str(getattr(response, "text", "")).lower():
            logger.info("Ollama rejected the 'think' field; retrying without it")
            payload.pop("think", None)
            response = send(payload)
        if response.status_code == 404:
            raise OllamaUnavailableError(
                f"Ollama model {model!r} is not installed — run `ollama pull {model}` "
                "or pick an installed model on the Settings page."
            )
        if response.status_code >= 400:
            snippet = str(getattr(response, "text", ""))[:500]
            raise RuntimeError(f"Ollama request failed (HTTP {response.status_code}): {snippet}")
        data = response.json()
        self.usage_calls.append(
            {
                "purpose": purpose or "llm_call",
                "model": model,
                "input_tokens": int(data.get("prompt_eval_count") or 0),
                "output_tokens": int(data.get("eval_count") or 0),
            }
        )
        message_out = data.get("message") or {}
        logger.info(
            "ollama request model=%s input_tokens=%s output_tokens=%s done_reason=%s "
            "num_ctx=%s num_predict=%s est_prompt_tokens=%s images=%s "
            "content_chars=%s thinking_chars=%s",
            model,
            data.get("prompt_eval_count"),
            data.get("eval_count"),
            data.get("done_reason"),
            num_ctx,
            payload["options"]["num_predict"],
            est_prompt_tokens,
            len(images),
            len(str(message_out.get("content") or "")),
            len(str(message_out.get("thinking") or "")),
        )
        text_out = str(message_out.get("content") or "")
        thinking_out = str(message_out.get("thinking") or "")
        if not text_out:
            # A reasoning model emits its chain of thought into `thinking`, which
            # shares the generation budget with the answer and which forge never
            # reads. When it runs long the answer never starts, and the bare
            # "no message content" reported here named the symptom while hiding
            # every actionable cause (observed: 30,288 chars of thinking, 4,480 of
            # answer, done_reason=length — 2026-07-31).
            if thinking_out or str(data.get("done_reason") or "") == "length":
                raise LlmJsonError(
                    f"Ollama returned no answer content: the model spent its "
                    f"generation budget on reasoning ({len(thinking_out)} chars of "
                    f"'thinking', done_reason={data.get('done_reason')}) and never "
                    f"emitted JSON. Its prompt was {data.get('prompt_eval_count')} "
                    f"tokens of a {num_ctx} context window"
                    f"{f' ({len(images)} image(s) attached)' if images else ''} — "
                    "raise TABLEAUFORGE_OLLAMA_NUM_CTX, turn off visual capture for "
                    "this build, choose a model with terser reasoning, or switch the "
                    "provider to Claude on the Settings page.",
                    "",
                )
            raise LlmJsonError("Ollama response contained no message content", "")
        try:
            return extract_json(text_out)
        except LlmJsonError:
            if str(data.get("done_reason") or "") == "length":
                # Fed back through the retry loop / surfaced to the user: the
                # window (or num_predict) ran out mid-JSON, not a model whim.
                # Carry the arithmetic. "the context window is too small" was
                # true of the budget but not always of the WINDOW — run
                # fcd87443 was cut off at 13,658 generated tokens inside a
                # 32,768 window holding a 14,895-token prompt, i.e. with 4,215
                # tokens still unused — and the advice it implied (shrink the
                # report) was the wrong move. Report what was actually spent so
                # the next one is diagnosable from the message alone.
                actual_prompt = int(data.get("prompt_eval_count") or 0)
                generated = int(data.get("eval_count") or 0)
                suggested = _round_up_context(actual_prompt + 2 * max(generated, 4096))
                raise LlmJsonError(
                    "Ollama output was cut off by the token/context limit "
                    "(done_reason=length) before the JSON completed: "
                    f"{generated} tokens generated after a {actual_prompt}-token "
                    f"prompt, in a {num_ctx}-token window with num_predict="
                    f"{payload['options']['num_predict']}"
                    f"{f' ({len(images)} image(s) attached)' if images else ''}. "
                    f"Raise the context window (num_ctx) to about {suggested} on the "
                    "Settings page, turn off visual capture for this build, or switch "
                    "the provider to Claude.",
                    text_out,
                )
            raise

    def call_json(
        self,
        system: str,
        user_content: str | list[dict[str, Any]],
        model: str,
        max_tokens: int = 32000,
        effort: str | None = None,
        fallback_model: str | None = None,
        purpose: str | None = None,
    ) -> dict[str, Any]:
        """One Messages-API round trip whose answer must be a single JSON object.

        Fable 5 notes (platform.claude.com "Effort" / "Prompting Claude Fable 5"):
        adaptive thinking is always on and counts against max_tokens, so the
        default is generous — quality over speed. ``effort`` rides in
        output_config; ``fallback_model`` handles two cases that both resolve to
        Opus 4.8 per Anthropic's guidance: a stop_reason "refusal" (Fable 5
        safety classifiers declining benign work) and a model-unavailable 404
        (accounts without Fable 5 access — the 404 itself recommends Opus 4.8).

        With TABLEAUFORGE_PROVIDER=ollama the call goes to the local Ollama
        server instead; ``model``/``effort``/``fallback_model`` are Claude
        concepts and are ignored there (the Ollama model comes from settings).
        """
        if provider_from_env() == "ollama":
            return self._ollama_json(system, user_content, max_tokens, purpose)
        kwargs: dict[str, Any] = dict(
            model=model,
            max_tokens=max_tokens,
            system=f"{system.rstrip()}\n\n{_JSON_ONLY_DIRECTIVE}",
            messages=[{"role": "user", "content": user_content}],
        )
        if effort and supports_effort(model):
            kwargs["output_config"] = {"effort": effort}
        try:
            message = self._request_recorded(kwargs, purpose)
        except Exception as exc:  # noqa: BLE001 - inspect, then re-raise if not handled
            if fallback_model and _is_model_unavailable(exc):
                logger.warning(
                    "model %s unavailable (%s); falling back to %s",
                    model, type(exc).__name__, fallback_model,
                )
                kwargs["model"] = fallback_model
                if "output_config" in kwargs and not supports_effort(fallback_model):
                    kwargs.pop("output_config")
                message = self._request_recorded(kwargs, purpose)
            else:
                raise
        if getattr(message, "stop_reason", None) == "refusal" and fallback_model:
            logger.warning(
                "model %s returned stop_reason=refusal; falling back to %s",
                model, fallback_model,
            )
            kwargs["model"] = fallback_model
            if "output_config" in kwargs and not supports_effort(fallback_model):
                kwargs.pop("output_config")
            message = self._request_recorded(kwargs, purpose)
        usage = getattr(message, "usage", None)
        logger.info(
            "claude request model=%s effort=%s input_tokens=%s output_tokens=%s",
            kwargs["model"],
            effort,
            getattr(usage, "input_tokens", None),
            getattr(usage, "output_tokens", None),
        )
        text = "".join(
            block.text
            for block in getattr(message, "content", [])
            if getattr(block, "type", None) == "text"
        )
        if not text:
            raise LlmJsonError("model response contained no text blocks", "")
        return extract_json(text)
