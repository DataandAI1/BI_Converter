"""Rebuild endpoint tests (Linetria addition): /draft-rebuild-spec and
/generate-rebuild. The spec_json path runs the REAL compile + validation
pipeline with zero LLM; authoring paths stub the client at the call_json seam.
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import tableauforge.api.rebuild_routes as rebuild_routes
from tableauforge.api.main import Settings
from tableauforge.api.rebuild_routes import build_rebuild_router
from tableauforge.api.store import ArtifactStore

CONNECTION: dict[str, Any] = {
    "dialect": "sqlserver",
    "host": "sql.example.internal",
    "database": "analytics",
    "db_schema": "dbo",
    "table": "orders",
}

BRIEF: dict[str, Any] = {
    "brief_version": "1",
    "report": {
        "name": "Revenue Ops Weekly",
        "platform": "tableau",
        "fqn": "ws::reports.revenue_ops_weekly",
        "elements": [
            {"name": "Revenue Ops Weekly", "kind": "bi_report", "fields": ["Region", "Sales"]}
        ],
        "notes": ["pages_not_captured"],
    },
    "datasources": [
        {
            "id": "orders_ds",
            "name": "orders",
            "connection": CONNECTION,
            "fields": [
                {"name": "Region", "datatype": "string", "role": "dimension"},
                {"name": "Sales", "datatype": "real", "role": "measure",
                 "default_aggregation": "sum"},
            ],
            "calculations": [
                {"name": "Total Sales", "formula": "SUM(orders[Sales])",
                 "language": "dax", "derivation_type": ["aggregation"], "flags": []}
            ],
            "notes": [],
        }
    ],
    "notes": [],
}

VALID_SPEC: dict[str, Any] = {
    "spec_version": "1.0",
    "workbook": {"name": "Revenue Ops Weekly"},
    "datasources": [
        {
            "id": "orders_ds",
            "name": "orders",
            "kind": "live_database",
            "database": CONNECTION,
            "fields": [
                {"name": "Region", "datatype": "string", "role": "dimension"},
                {"name": "Sales", "datatype": "real", "role": "measure",
                 "default_aggregation": "sum"},
            ],
        }
    ],
    "worksheets": [
        {
            "id": "sales_by_region",
            "title": "Sales by Region",
            "datasource": "orders_ds",
            "chart": {
                "type": "bar",
                "rows": [{"field": "Sales", "aggregation": "sum"}],
                "cols": [{"field": "Region"}],
            },
        }
    ],
}

TRANSLATION: list[dict[str, Any]] = [
    {
        "name": "Total Sales",
        "source_language": "dax",
        "original_formula": "SUM(orders[Sales])",
        "status": "needs_review",
        "reason": "carried through from the draft",
    }
]


class FakeLlm:
    def __init__(self, responses: list[Any]):
        self._responses = responses
        self.calls: list[dict[str, Any]] = []

    def call_json(self, system, user_content, model, max_tokens=32000, **kwargs):
        self.calls.append({"system": system, "user_content": user_content})
        response = self._responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def usage_summary(self) -> dict[str, Any]:
        return {
            "input_tokens": 10,
            "output_tokens": 20,
            "calls": [
                {"purpose": "rebuild_author", "model": "test-model",
                 "input_tokens": 10, "output_tokens": 20}
                for _ in self.calls
            ],
        }


@pytest.fixture
def store(tmp_path: Path) -> ArtifactStore:
    return ArtifactStore(tmp_path / "artifacts")


@pytest.fixture(autouse=True)
def _no_llm_passes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Authoring is the unit under test; the best-effort polish pass would
    consume extra FakeLlm responses (it runs whenever an LlmClient exists)."""
    monkeypatch.setenv("TABLEAUFORGE_POLISH_PASS", "0")
    monkeypatch.setenv("TABLEAUFORGE_DESIGN_PASS", "0")


@pytest.fixture
def client(store: ArtifactStore) -> TestClient:
    app = FastAPI()
    app.include_router(build_rebuild_router(store, Settings(artifacts_dir=store.artifacts_dir)))
    return TestClient(app)


def test_generate_rebuild_with_spec_json_is_zero_llm(
    client: TestClient, store: ArtifactStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    resp = client.post(
        "/generate-rebuild",
        json={"brief": BRIEF, "spec_json": VALID_SPEC, "translation": TRANSLATION,
              "llm_usage": {"input_tokens": 5, "output_tokens": 7, "calls": []}},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["report"]["passed"] is True
    # Passthrough: the draft's translation comes back verbatim; usage totals
    # survive the merge (as a synthetic "untracked" entry).
    assert body["translation"] == TRANSLATION
    assert body["llm_usage"]["input_tokens"] == 5
    assert body["llm_usage"]["output_tokens"] == 7
    assert body["download_url"] == f"/download/{body['artifact_id']}"
    # Artifact persisted in the store.
    assert store.get_artifact(body["artifact_id"]) is not None
    # No polish without an LLM.


def test_generate_rebuild_forces_brief_connection(client: TestClient) -> None:
    tampered = copy.deepcopy(VALID_SPEC)
    tampered["datasources"][0]["database"] = {
        "dialect": "postgres", "host": "wrong", "database": "wrong", "table": "wrong",
    }
    resp = client.post("/generate-rebuild", json={"brief": BRIEF, "spec_json": tampered})
    assert resp.status_code == 200, resp.text
    ds = resp.json()["spec"]["datasources"][0]
    assert ds["database"] == CONNECTION


def test_generate_rebuild_invalid_spec_422(client: TestClient) -> None:
    broken = copy.deepcopy(VALID_SPEC)
    broken.pop("worksheets")
    resp = client.post("/generate-rebuild", json={"brief": BRIEF, "spec_json": broken})
    assert resp.status_code == 422


def test_generate_rebuild_authoring_path_stubbed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    envelope = {
        "spec": copy.deepcopy(VALID_SPEC),
        "translation": [
            {"name": "Total Sales", "source_language": "dax",
             "original_formula": "SUM(orders[Sales])", "status": "skipped",
             "reason": "not used by any worksheet"}
        ],
    }
    fake = FakeLlm([envelope])
    monkeypatch.setattr(rebuild_routes, "_authoring_llm", lambda: fake)
    resp = client.post("/generate-rebuild", json={"brief": BRIEF})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["translation"][0]["status"] == "skipped"
    assert len(body["llm_usage"]["calls"]) == 1
    # Authoring happened exactly once.
    assert len(fake.calls) == 1


def test_draft_rebuild_spec_stubbed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    envelope = {
        "spec": copy.deepcopy(VALID_SPEC),
        "translation": [
            {"name": "Total Sales", "source_language": "dax",
             "original_formula": "SUM(orders[Sales])", "status": "skipped",
             "reason": "helper"}
        ],
    }
    fake = FakeLlm([envelope])
    monkeypatch.setattr(rebuild_routes, "_authoring_llm", lambda: fake)
    resp = client.post("/draft-rebuild-spec", json={"brief": BRIEF})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["spec"]["workbook"]["name"] == "Revenue Ops Weekly"
    assert body["translation"][0]["name"] == "Total Sales"
    assert len(body["llm_usage"]["calls"]) == 1


def test_draft_without_key_503(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    resp = client.post("/draft-rebuild-spec", json={"brief": BRIEF})
    assert resp.status_code == 503
    assert "API key" in resp.json()["detail"]


def test_generate_without_key_503(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    resp = client.post("/generate-rebuild", json={"brief": BRIEF})
    assert resp.status_code == 503


def test_extra_fields_rejected(client: TestClient) -> None:
    resp = client.post(
        "/generate-rebuild",
        json={"brief": BRIEF, "spec_json": VALID_SPEC, "surprise": True},
    )
    assert resp.status_code == 422


def test_ollama_server_error_is_a_502_with_its_message(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Ollama's own HTTP failure must not surface as an anonymous 500: the route maps
    it to a 502 that carries the text Ollama returned."""
    from tableauforge.config import OllamaRequestError

    fake = FakeLlm(
        [OllamaRequestError("Ollama at http://x:11434 rejected the request (HTTP 500): oom")]
    )
    monkeypatch.setattr(rebuild_routes, "_authoring_llm", lambda: fake)
    for route in ("/draft-rebuild-spec", "/generate-rebuild"):
        fake._responses = [
            OllamaRequestError("Ollama at http://x:11434 rejected the request (HTTP 500): oom")
        ]
        resp = client.post(route, json={"brief": BRIEF})
        assert resp.status_code == 502, f"{route}: {resp.text}"
        assert "HTTP 500" in resp.json()["detail"]
        assert "oom" in resp.json()["detail"]


def test_a_caller_supplied_spec_with_a_dangling_zone_is_a_422_not_a_500(client: TestClient) -> None:
    """The schema only checks the identifier pattern, so a zone naming a worksheet the
    spec does not define reached the compiler and died as an anonymous KeyError."""
    spec = copy.deepcopy(VALID_SPEC)
    spec["dashboards"] = [{
        "id": "main", "title": "Main", "size": {"width": 1200, "height": 800},
        "zones": [{"kind": "worksheet", "worksheet": "no_such_worksheet",
                   "x": 0, "y": 0, "w": 100, "h": 100}],
    }]
    res = client.post("/generate-rebuild", json={"brief": BRIEF, "spec_json": spec})
    assert res.status_code == 422, res.text
    assert "no_such_worksheet" in res.json()["detail"]
