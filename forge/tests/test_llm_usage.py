"""LLM token-usage counter tests (per-dashboard input/output token tracking):
the usage helpers, LlmClient call recording, ArtifactStore persistence and
migration, and the /generate endpoint's prior-usage merge.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import pytest
from fastapi.testclient import TestClient

import tableauforge.api.main as main_mod
from tableauforge.api.main import Settings, create_app
from tableauforge.api.store import ArtifactStore
from tableauforge.llm.client import LlmClient
from tableauforge.llm.usage import merge_usage, summarize_usage

ROOT = Path(__file__).resolve().parents[1]
SALES_CSV = ROOT / "examples" / "sales.csv"


# --- usage helpers -------------------------------------------------------------------


def test_summarize_usage_totals_and_cleaning() -> None:
    summary = summarize_usage(
        [
            {"purpose": "spec_author", "model": "m", "input_tokens": 100,
             "output_tokens": 20},
            {"purpose": "design_review", "model": "m", "input_tokens": "50",
             "output_tokens": -5},  # coerced / clamped
            "not-a-dict",  # dropped
        ]
    )
    assert summary["input_tokens"] == 150
    assert summary["output_tokens"] == 20
    assert len(summary["calls"]) == 2


def test_merge_usage_combines_calls_and_recomputes_totals() -> None:
    a = summarize_usage(
        [{"purpose": "spec_author", "model": "m", "input_tokens": 100, "output_tokens": 10}]
    )
    b = summarize_usage(
        [{"purpose": "refine", "model": "m", "input_tokens": 30, "output_tokens": 5}]
    )
    merged = merge_usage(a, b)
    assert merged is not None
    assert merged["input_tokens"] == 130
    assert merged["output_tokens"] == 15
    assert [c["purpose"] for c in merged["calls"]] == ["spec_author", "refine"]


def test_merge_usage_preserves_totals_without_calls() -> None:
    merged = merge_usage({"input_tokens": 500, "output_tokens": 40, "calls": []}, None)
    assert merged is not None
    assert merged["input_tokens"] == 500
    assert merged["output_tokens"] == 40
    assert merged["calls"][0]["purpose"] == "untracked"


def test_merge_usage_none_when_nothing_given() -> None:
    assert merge_usage(None, None) is None
    assert merge_usage() is None


# --- LlmClient records one entry per round trip --------------------------------------


class FakeStream:
    def __init__(self, message: Any):
        self._message = message

    def __enter__(self) -> "FakeStream":
        return self

    def __exit__(self, *exc: Any) -> None:
        return None

    def get_final_message(self) -> Any:
        return self._message


def make_message(text: str, input_tokens: int, output_tokens: int,
                 stop_reason: str = "end_turn") -> Any:
    return SimpleNamespace(
        content=[SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(input_tokens=input_tokens, output_tokens=output_tokens),
        stop_reason=stop_reason,
    )


class FakeSdk:
    """Duck-typed anthropic client: scripted messages, records each request."""

    def __init__(self, messages: list[Any]):
        self._queue = list(messages)
        self.requests: list[dict[str, Any]] = []
        self.messages = SimpleNamespace(stream=self._stream)

    def _stream(self, **kwargs: Any) -> FakeStream:
        self.requests.append(kwargs)
        return FakeStream(self._queue.pop(0))


def test_call_json_records_usage_per_call() -> None:
    sdk = FakeSdk([make_message('{"ok": 1}', 120, 34)])
    client = LlmClient(client=sdk)
    result = client.call_json(
        system="s", user_content="u", model="test-model", purpose="spec_author"
    )
    assert result == {"ok": 1}
    assert client.usage_calls == [
        {"purpose": "spec_author", "model": "test-model",
         "input_tokens": 120, "output_tokens": 34}
    ]
    summary = client.usage_summary()
    assert summary["input_tokens"] == 120
    assert summary["output_tokens"] == 34


def test_call_json_counts_refusal_fallback_as_two_calls() -> None:
    sdk = FakeSdk([
        make_message("", 10, 1, stop_reason="refusal"),
        make_message('{"ok": 2}', 200, 50),
    ])
    client = LlmClient(client=sdk)
    result = client.call_json(
        system="s", user_content="u", model="test-model",
        fallback_model="fallback-model", purpose="refine",
    )
    assert result == {"ok": 2}
    assert [c["model"] for c in client.usage_calls] == ["test-model", "fallback-model"]
    assert client.usage_summary()["input_tokens"] == 210


# --- ArtifactStore persistence + migration --------------------------------------------


USAGE = {
    "input_tokens": 900,
    "output_tokens": 120,
    "calls": [
        {"purpose": "spec_author", "model": "m", "input_tokens": 900,
         "output_tokens": 120}
    ],
}


def _save(store: ArtifactStore, artifact_id: str, **kwargs: Any) -> dict[str, Any]:
    return store.save_artifact(
        artifact_id=artifact_id,
        workbook_name="W",
        kind="twb",
        path="x.twb",
        spec={"spec_version": "1.0"},
        report={"passed": True},
        **kwargs,
    )


def test_store_roundtrips_llm_usage(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path / "artifacts")
    row = _save(store, "a1", llm_usage=USAGE)
    assert row["llm_usage"] == USAGE
    assert _save(store, "a2")["llm_usage"] is None  # optional stays optional


def test_store_migrates_pre_usage_database(tmp_path: Path) -> None:
    """A forge.db created before the feature gains the column on open."""
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    conn = sqlite3.connect(artifacts / "forge.db")
    with conn:
        conn.execute(
            "CREATE TABLE artifacts (id TEXT PRIMARY KEY, workbook_name TEXT NOT NULL,"
            " kind TEXT NOT NULL, path TEXT NOT NULL, spec_json TEXT NOT NULL,"
            " report_json TEXT NOT NULL, created_at TEXT NOT NULL)"
        )
        conn.execute(
            "INSERT INTO artifacts VALUES ('old', 'W', 'twb', 'x.twb', '{}', '{}',"
            " '2026-01-01T00:00:00Z')"
        )
    conn.close()

    store = ArtifactStore(artifacts)
    old = store.get_artifact("old")
    assert old is not None and old["llm_usage"] is None
    assert _save(store, "new", llm_usage=USAGE)["llm_usage"] == USAGE


# --- /generate endpoint: prior usage merged and persisted ------------------------------
