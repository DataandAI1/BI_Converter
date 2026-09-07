"""Tests for tableauforge.llm.client and the config it depends on. No network ever."""

from __future__ import annotations

import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

from tableauforge.config import (
    MissingApiKeyError,
    OllamaUnavailableError,
    Settings,
    ollama_base_url_from_env,
    ollama_model_from_env,
    provider_from_env,
)
from tableauforge.llm.client import (
    LlmClient,
    LlmJsonError,
    estimate_prompt_tokens,
    extract_json,
)


def _response(text: str, input_tokens: int = 12, output_tokens: int = 34) -> SimpleNamespace:
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens),
    )


class FakeStream:
    """Context manager mirroring anthropic's MessageStreamManager."""

    def __init__(self, response: SimpleNamespace):
        self._response = response

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_final_message(self):
        return self._response


class FakeMessages:
    def __init__(self, outer: "FakeAnthropic"):
        self._outer = outer

    def stream(self, **kwargs):
        self._outer.requests.append(kwargs)
        return FakeStream(self._outer.response)


class FakeAnthropic:
    """Stands in for anthropic.Anthropic; records every messages.stream call
    (the client streams everything — SDK requirement for long requests)."""

    def __init__(self, response: SimpleNamespace):
        self.response = response
        self.requests: list[dict] = []
        self.messages = FakeMessages(self)


def test_call_json_happy_path_and_request_shape():
    fake = FakeAnthropic(_response('{"a": 1}'))
    client = LlmClient(client=fake)

    out = client.call_json(system="You are a test.", user_content="hello", model="test-model")

    assert out == {"a": 1}
    (req,) = fake.requests
    assert req["model"] == "test-model"
    assert req["max_tokens"] == 32000
    assert req["messages"] == [{"role": "user", "content": "hello"}]
    assert req["system"].startswith("You are a test.")
    assert "JSON object" in req["system"]  # JSON-only demand appended


def test_call_json_strips_markdown_fences():
    fake = FakeAnthropic(_response('```json\n{"a": {"b": 2}}\n```'))
    out = LlmClient(client=fake).call_json(system="s", user_content="u", model="m")
    assert out == {"a": {"b": 2}}


def test_call_json_slices_json_out_of_prose():
    fake = FakeAnthropic(_response('Sure, here you go: {"a": [1, 2]} hope that helps!'))
    out = LlmClient(client=fake).call_json(system="s", user_content="u", model="m")
    assert out == {"a": [1, 2]}


def test_call_json_parse_failure_raises_with_raw_text():
    fake = FakeAnthropic(_response("no json here at all"))
    with pytest.raises(LlmJsonError) as ei:
        LlmClient(client=fake).call_json(system="s", user_content="u", model="m")
    assert ei.value.raw_text == "no json here at all"


def test_call_json_invalid_json_between_braces_raises():
    fake = FakeAnthropic(_response('{"a": not valid}'))
    with pytest.raises(LlmJsonError) as ei:
        LlmClient(client=fake).call_json(system="s", user_content="u", model="m")
    assert '{"a": not valid}' in ei.value.raw_text


def test_call_json_logs_token_usage(caplog):
    fake = FakeAnthropic(_response('{"ok": true}', input_tokens=111, output_tokens=222))
    with caplog.at_level(logging.INFO, logger="tableauforge.llm.client"):
        LlmClient(client=fake).call_json(system="s", user_content="u", model="logged-model")
    assert "input_tokens=111" in caplog.text
    assert "output_tokens=222" in caplog.text
    assert "logged-model" in caplog.text


def test_call_json_passes_list_content_through():
    fake = FakeAnthropic(_response("{}"))
    blocks = [{"type": "text", "text": "look at this"}]
    LlmClient(client=fake).call_json(system="s", user_content=blocks, model="m")
    assert fake.requests[0]["messages"][0]["content"] is blocks


def test_injected_client_needs_no_api_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    fake = FakeAnthropic(_response("{}"))
    assert LlmClient(client=fake).call_json(system="s", user_content="u", model="m") == {}


def test_missing_api_key_raises_only_at_call_time(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    client = LlmClient()  # constructing is fine
    with pytest.raises(MissingApiKeyError):
        client.call_json(system="s", user_content="u", model="m")


def test_extract_json_rejects_empty_object_text():
    with pytest.raises(LlmJsonError):
        extract_json("null")


def test_extract_json_recovers_the_first_object_when_the_model_appends_another():
    """Observed with local (Ollama) models on rebuild authoring: the answer is a
    complete JSON object, then the model keeps going and emits a second one on
    the same line. Slicing first-'{' to last-'}' turned that into
    "Extra data: line 1 column N" and threw a usable answer away."""
    text = '{"spec": {"id": "first"}, "translation": []}{"spec": {"id": "second"}}'
    assert extract_json(text) == {"spec": {"id": "first"}, "translation": []}


def test_extract_json_ignores_trailing_prose_containing_braces():
    """rfind('}') used to land on a brace inside the commentary, not on the
    object's own closing brace."""
    text = '{"a": 1}\n\nNote: ids look like {this} in the schema.'
    assert extract_json(text) == {"a": 1}


def test_settings_defaults(monkeypatch):
    for var in (
        "TABLEAUFORGE_MODEL",
        "TABLEAUFORGE_VISION_MODEL",
        "TABLEAUFORGE_ARTIFACTS_DIR",
        "TABLEAUFORGE_MAX_SPEC_RETRIES",
    ):
        monkeypatch.delenv(var, raising=False)
    settings = Settings.from_env()
    assert settings.model == "claude-fable-5"
    assert settings.vision_model == "claude-fable-5"
    assert settings.artifacts_dir == Path("./artifacts")
    assert settings.max_spec_retries == 3


def test_settings_env_overrides_and_vision_default():
    env = {"TABLEAUFORGE_MODEL": "model-x", "TABLEAUFORGE_MAX_SPEC_RETRIES": "5"}
    settings = Settings.from_env(env)
    assert settings.model == "model-x"
    assert settings.vision_model == "model-x"  # defaults to the text model
    assert settings.max_spec_retries == 5

    settings = Settings.from_env({**env, "TABLEAUFORGE_VISION_MODEL": "vision-y"})
    assert settings.vision_model == "vision-y"


def test_settings_rejects_bad_retry_values():
    with pytest.raises(ValueError):
        Settings.from_env({"TABLEAUFORGE_MAX_SPEC_RETRIES": "many"})
    with pytest.raises(ValueError):
        Settings.from_env({"TABLEAUFORGE_MAX_SPEC_RETRIES": "0"})


# --- Ollama provider ------------------------------------------------------------


class FakeOllamaResponse:
    def __init__(self, status_code: int = 200, body: dict | None = None, text: str = ""):
        self.status_code = status_code
        self._body = body or {}
        self.text = text

    def json(self) -> dict:
        return self._body


def _ollama_env(monkeypatch: pytest.MonkeyPatch, model: str = "llama3.1") -> None:
    monkeypatch.setenv("TABLEAUFORGE_PROVIDER", "ollama")
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://fake-ollama:11434")
    monkeypatch.setenv("TABLEAUFORGE_OLLAMA_MODEL", model)


def test_provider_config_defaults_and_fallback(monkeypatch):
    for var in ("TABLEAUFORGE_PROVIDER", "OLLAMA_BASE_URL", "TABLEAUFORGE_OLLAMA_MODEL"):
        monkeypatch.delenv(var, raising=False)
    assert provider_from_env() == "claude"
    assert ollama_base_url_from_env() == "http://localhost:11434"
    assert ollama_model_from_env() == "llama3.1"
    # A hand-set junk value must not break every LLM call — fall back to claude.
    monkeypatch.setenv("TABLEAUFORGE_PROVIDER", "gpt-in-a-box")
    assert provider_from_env() == "claude"


def test_ollama_call_json_request_shape_and_usage(monkeypatch):
    _ollama_env(monkeypatch, model="qwen3:8b")
    posts: list[tuple[str, dict]] = []

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        posts.append((url, payload))
        return FakeOllamaResponse(
            body={
                "message": {"role": "assistant", "content": '{"a": 1}'},
                "prompt_eval_count": 55,
                "eval_count": 66,
            }
        )

    client = LlmClient(http_post=fake_post)
    out = client.call_json(
        system="You are a test.",
        user_content="hello",
        model="claude-fable-5",  # Claude concept — ignored on the Ollama path
        effort="high",
        fallback_model="claude-opus-4-8",
        purpose="spec_author",
    )

    assert out == {"a": 1}
    ((url, payload),) = posts
    assert url == "http://fake-ollama:11434/api/chat"
    assert payload["model"] == "qwen3:8b"
    assert payload["stream"] is False
    assert payload["format"] == "json"
    options = payload["options"]
    # Strict-JSON sampling beats the Modelfile (qwen ships presence_penalty 1.5,
    # which punishes the repeated keys a large spec needs).
    assert options["temperature"] == 0.2
    assert options["presence_penalty"] == 0
    # Small prompt -> window is the output reserve (16384) + prompt estimate,
    # and generation is capped to the room the window actually leaves.
    assert 16384 <= options["num_ctx"] <= 16500
    assert options["num_predict"] == options["num_ctx"] - estimate_prompt_tokens(
        "You are a test.", "hello"
    )
    system_msg, user_msg = payload["messages"]
    assert system_msg["role"] == "system"
    assert "JSON object" in system_msg["content"]  # JSON-only demand appended
    assert user_msg == {"role": "user", "content": "hello"}
    assert client.usage_calls == [
        {
            "purpose": "spec_author",
            "model": "qwen3:8b",
            "input_tokens": 55,
            "output_tokens": 66,
        }
    ]


def test_ollama_translates_image_blocks(monkeypatch):
    """Anthropic-style vision content becomes Ollama's images list."""
    _ollama_env(monkeypatch)
    posts: list[dict] = []

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        posts.append(payload)
        return FakeOllamaResponse(body={"message": {"content": "{}"}})

    blocks = [
        {
            "type": "image",
            "source": {"type": "base64", "media_type": "image/png", "data": "aGVsbG8="},
        },
        {"type": "text", "text": "describe the layout"},
    ]
    LlmClient(http_post=fake_post).call_json(system="s", user_content=blocks, model="m")

    user_msg = posts[0]["messages"][1]
    assert user_msg["content"] == "describe the layout"
    assert user_msg["images"] == ["aGVsbG8="]


def test_ollama_connection_failure_raises_unavailable(monkeypatch):
    _ollama_env(monkeypatch)

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        raise ConnectionError("refused")

    with pytest.raises(OllamaUnavailableError) as ei:
        LlmClient(http_post=fake_post).call_json(system="s", user_content="u", model="m")
    assert "ollama serve" in str(ei.value)
    assert "http://fake-ollama:11434" in str(ei.value)


def test_ollama_read_timeout_is_not_reported_as_unreachable(monkeypatch):
    """A slow-but-working model (read timeout) must not tell the user to start
    an Ollama server that is already running."""
    import httpx

    _ollama_env(monkeypatch, model="big-model:70b")

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        raise httpx.ReadTimeout("timed out")

    with pytest.raises(OllamaUnavailableError) as ei:
        LlmClient(http_post=fake_post).call_json(system="s", user_content="u", model="m")
    assert "didn't finish" in str(ei.value)
    assert "big-model:70b" in str(ei.value)
    assert "ollama serve" not in str(ei.value)


def test_ollama_missing_model_raises_unavailable_with_pull_hint(monkeypatch):
    _ollama_env(monkeypatch, model="nonexistent:1b")

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        return FakeOllamaResponse(status_code=404, text='{"error":"model not found"}')

    with pytest.raises(OllamaUnavailableError) as ei:
        LlmClient(http_post=fake_post).call_json(system="s", user_content="u", model="m")
    assert "ollama pull nonexistent:1b" in str(ei.value)


def test_ollama_num_ctx_scales_with_prompt_and_respects_cap(monkeypatch):
    """Big briefs must get a window sized to the prompt, clamped to the cap, and
    generation capped to the room left — prompt + output share one window."""
    _ollama_env(monkeypatch)
    posts: list[dict] = []

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        posts.append(payload)
        return FakeOllamaResponse(body={"message": {"content": "{}"}})

    big_prompt = "x" * 90_000  # est ≈ 25.7k tokens at 3.5 chars/token
    LlmClient(http_post=fake_post).call_json(system="s", user_content=big_prompt, model="m")
    options = posts[0]["options"]
    assert options["num_ctx"] == 32768  # default cap reached
    assert options["num_predict"] == 32768 - estimate_prompt_tokens("s", big_prompt)

    monkeypatch.setenv("TABLEAUFORGE_OLLAMA_NUM_CTX", "16000")
    mid_prompt = "x" * 30_000  # est ≈ 8.6k tokens
    LlmClient(http_post=fake_post).call_json(system="s", user_content=mid_prompt, model="m")
    options = posts[1]["options"]
    assert options["num_ctx"] == 16000  # clamped to the env cap
    assert options["num_predict"] == 16000 - estimate_prompt_tokens("s", mid_prompt)


def test_ollama_requests_disable_reasoning(monkeypatch):
    """`thinking` is generated into the same budget as the answer and forge never
    reads it. Left on, this model returned 0/3 parseable rebuild answers; off,
    3/3."""
    _ollama_env(monkeypatch)
    posts: list[dict] = []

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        posts.append(payload)
        return FakeOllamaResponse(body={"message": {"content": "{}"}})

    LlmClient(http_post=fake_post).call_json(system="s", user_content="u", model="m")
    assert posts[0]["think"] is False

    # Reversible: reasoning can still help spec quality on briefs small enough to
    # leave room for both it and the answer.
    monkeypatch.setenv("TABLEAUFORGE_OLLAMA_THINK", "1")
    LlmClient(http_post=fake_post).call_json(system="s", user_content="u", model="m")
    assert posts[1]["think"] is True


def test_ollama_retries_without_think_when_the_server_rejects_it(monkeypatch):
    """Older servers / non-reasoning models reject the field; that must not fail a
    call that would otherwise work."""
    _ollama_env(monkeypatch)
    posts: list[dict] = []

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        posts.append(dict(payload))
        if "think" in payload:
            return FakeOllamaResponse(
                status_code=400, text='{"error":"model does not support thinking"}'
            )
        return FakeOllamaResponse(body={"message": {"content": '{"ok": true}'}})

    out = LlmClient(http_post=fake_post).call_json(system="s", user_content="u", model="m")

    assert out == {"ok": True}
    assert len(posts) == 2
    assert "think" not in posts[1]


def test_ollama_num_ctx_budgets_for_attached_images(monkeypatch):
    """Vision input costs real prompt tokens. While images were excluded from the
    estimate, a 4-screenshot rebuild sized the window for a 12.4k-token prompt
    that was really 18.9k and promised 16,384 output tokens with under 10k left —
    generation then died on the context wall mid-JSON."""
    from tableauforge.llm.client import OLLAMA_IMAGE_TOKENS

    _ollama_env(monkeypatch)
    posts: list[dict] = []

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        posts.append(payload)
        return FakeOllamaResponse(body={"message": {"content": "{}"}})

    text = "x" * 30_000
    blocks = [{"type": "text", "text": text}] + [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGk="}}
        for _ in range(4)
    ]
    LlmClient(http_post=fake_post).call_json(system="s", user_content=blocks, model="m")

    est = estimate_prompt_tokens("s", text, 4)
    assert est - estimate_prompt_tokens("s", text) == 4 * OLLAMA_IMAGE_TOKENS
    options = posts[0]["options"]
    assert options["num_ctx"] == min(est + 16384, 32768)
    # The headline regression: generation is confined to the room actually left
    # once the images are paid for, never the full 16,384.
    assert options["num_predict"] == options["num_ctx"] - est


def test_ollama_reasoning_only_response_names_the_real_cause(monkeypatch):
    """All budget spent on `thinking` leaves `content` empty. The bare 'no message
    content' named the symptom and hid every actionable cause."""
    _ollama_env(monkeypatch)

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        return FakeOllamaResponse(
            body={
                "message": {"content": "", "thinking": "let me think..." * 500},
                "done_reason": "length",
                "prompt_eval_count": 19000,
            }
        )

    with pytest.raises(LlmJsonError) as ei:
        LlmClient(http_post=fake_post).call_json(system="s", user_content="u", model="m")
    message = str(ei.value)
    assert "thinking" in message
    assert "TABLEAUFORGE_OLLAMA_NUM_CTX" in message
    assert "19000" in message  # the prompt size that squeezed the answer out


def test_ollama_truncated_output_names_the_limit(monkeypatch):
    """JSON cut off because the window/num_predict filled must say so — the
    retry loop (and the user) should see 'limit', not a bare parse error."""
    _ollama_env(monkeypatch)

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        return FakeOllamaResponse(
            body={
                "message": {"content": '{"spec": {"workbook": '},  # cut mid-JSON
                "done_reason": "length",
            }
        )

    with pytest.raises(LlmJsonError) as ei:
        LlmClient(http_post=fake_post).call_json(system="s", user_content="u", model="m")
    assert "done_reason=length" in str(ei.value)
    assert "context window" in str(ei.value)


def test_ollama_rejects_prompt_beyond_context_cap(monkeypatch):
    """A prompt that can't fit even optimistically fails fast with guidance
    instead of burning model-minutes on truncated garbage."""
    _ollama_env(monkeypatch)
    monkeypatch.setenv("TABLEAUFORGE_OLLAMA_NUM_CTX", "2048")

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        raise AssertionError("must fail before any request is sent")

    with pytest.raises(OllamaUnavailableError) as ei:
        LlmClient(http_post=fake_post).call_json(
            system="s", user_content="y" * 20_000, model="m"
        )
    assert "TABLEAUFORGE_OLLAMA_NUM_CTX" in str(ei.value)


def test_ollama_http_error_surfaces_status_and_body(monkeypatch):
    _ollama_env(monkeypatch)

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        return FakeOllamaResponse(status_code=500, text="boom")

    with pytest.raises(RuntimeError) as ei:
        LlmClient(http_post=fake_post).call_json(system="s", user_content="u", model="m")
    assert "HTTP 500" in str(ei.value)
    assert "boom" in str(ei.value)


def test_ollama_needs_no_anthropic_key(monkeypatch):
    _ollama_env(monkeypatch)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        return FakeOllamaResponse(body={"message": {"content": '{"ok": true}'}})

    assert LlmClient(http_post=fake_post).call_json(
        system="s", user_content="u", model="m"
    ) == {"ok": True}


def test_claude_path_unaffected_when_provider_unset(monkeypatch):
    monkeypatch.delenv("TABLEAUFORGE_PROVIDER", raising=False)
    fake = FakeAnthropic(_response('{"a": 1}'))
    assert LlmClient(client=fake).call_json(system="s", user_content="u", model="m") == {"a": 1}
    assert len(fake.requests) == 1


def test_prompt_token_estimate_stays_close_to_measured_reality():
    """The estimator sizes num_ctx AND, by subtraction, the generation budget —
    so every percent it over-counts is a percent of the ANSWER thrown away.

    These three pairs are Ollama's own prompt_eval_count for real rebuild
    prompts (system prompt + brief JSON, qwen tokenizer). The old chars/3
    over-counted by 23-28%: on run fcd87443 it declared a 19,110-token prompt
    that was really 14,895, leaving the answer 13,658 tokens of a 32,768 window
    that had 17,873 free. The answer needed ~11,055 and overran the cut budget
    three attempts running.

    Must stay an OVER-estimate (a window smaller than the prompt makes Ollama
    truncate the brief silently) but a close one.
    """
    for chars, measured in ((58_101, 14_895), (58_272, 15_754), (40_662, 11_054)):
        est = estimate_prompt_tokens("", "x" * chars)
        assert est >= measured, f"{est} would undersize the window for {measured}"
        assert est <= measured * 1.15, f"{est} over-counts {measured} by >15%"


def test_ollama_truncation_error_reports_the_budget_arithmetic(monkeypatch):
    """'the context window is too small' was the wrong diagnosis for fcd87443 —
    the window had 4,215 tokens free and the generation cap was what bit. The
    message must carry prompt/generated/window/num_predict so the next one is
    readable without a database dive, and name a num_ctx that would fit."""
    _ollama_env(monkeypatch)

    def fake_post(url: str, payload: dict) -> FakeOllamaResponse:
        return FakeOllamaResponse(
            body={
                "message": {"content": '{"spec": {"workbook": '},
                "done_reason": "length",
                "prompt_eval_count": 14895,
                "eval_count": 13658,
            }
        )

    with pytest.raises(LlmJsonError) as ei:
        LlmClient(http_post=fake_post).call_json(system="s", user_content="u", model="m")
    message = str(ei.value)
    assert "done_reason=length" in message
    assert "14895" in message and "13658" in message
    # 14,895 + 2x13,658 = 42,211 -> the next 4,096 boundary.
    assert "45056" in message
