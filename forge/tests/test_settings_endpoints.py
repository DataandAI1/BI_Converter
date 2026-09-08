"""Settings endpoints: the provider configuration the web UI's Settings dialog drives.

The catalog must carry the current Claude lineup (the picker is populated from it and
POST /settings/model refuses anything outside it), a key must never be echoed back in
full, and a provider switch must persist so a forge restart does not silently revert.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from tableauforge.api.main import Settings, create_app

ENV_VARS = (
    "ANTHROPIC_API_KEY",
    "TABLEAUFORGE_MODEL",
    "TABLEAUFORGE_PROVIDER",
    "OLLAMA_BASE_URL",
    "TABLEAUFORGE_OLLAMA_MODEL",
    "TABLEAUFORGE_OLLAMA_NUM_CTX",
)


@pytest.fixture
def client(tmp_path, monkeypatch):
    # The endpoints write os.environ; monkeypatch restores every var afterwards.
    for var in ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    app = create_app(Settings(artifacts_dir=tmp_path / "api"))
    return TestClient(app)


def test_catalog_offers_the_current_claude_lineup(client):
    ids = [m["id"] for m in client.get("/settings").json()["available_models"]]
    for current in ("claude-fable-5-1", "claude-opus-5", "claude-sonnet-5"):
        assert current in ids
    assert ids[0] == "claude-fable-5-1"


def test_model_switch_accepts_catalog_ids_and_refuses_others(client):
    ok = client.post("/settings/model", json={"model": "claude-opus-5"})
    assert ok.status_code == 200
    assert ok.json()["model"] == "claude-opus-5"
    assert ok.json()["model_source"] == "runtime"

    bad = client.post("/settings/model", json={"model": "gpt-4"})
    assert bad.status_code == 422
    assert "claude-opus-5" in bad.json()["detail"]


def test_api_key_is_only_ever_shown_masked(client):
    assert client.get("/settings").json()["llm_ready"] is False
    res = client.post("/settings/api-key", json={"api_key": "sk-ant-verysecret-1234"})
    body = res.json()
    assert body["api_key_configured"] is True
    assert body["llm_ready"] is True
    assert body["api_key_masked"] == "sk-an…1234"
    assert "verysecret" not in json.dumps(body)

    cleared = client.delete("/settings/api-key").json()
    assert cleared["api_key_configured"] is False
    assert cleared["llm_ready"] is False


def test_provider_switch_to_ollama_persists(client, tmp_path):
    res = client.post(
        "/settings/provider",
        json={
            "provider": "ollama",
            "ollama_base_url": "http://gpu-box:11434/",
            "ollama_model": "qwen3:32b",
        },
    )
    body = res.json()
    assert body["provider"] == "ollama"
    assert body["ollama_base_url"] == "http://gpu-box:11434"
    assert body["ollama_model"] == "qwen3:32b"
    # No key, but a local server needs none.
    assert body["llm_ready"] is True

    saved = json.loads((tmp_path / "api" / "settings.json").read_text(encoding="utf-8"))
    assert saved["provider"] == "ollama"
    assert saved["ollama_model"] == "qwen3:32b"

    assert client.post("/settings/provider", json={"provider": "openai"}).status_code == 422
