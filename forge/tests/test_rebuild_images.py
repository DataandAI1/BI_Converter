"""Task B3: screenshot vision input on the rebuild endpoints. The server sends
``images: [{element, media_type, data}]`` on /draft-rebuild-spec and
/generate-rebuild when captured screenshots exist; forge must accept them,
validate caps, and hand them to the rebuild author as Anthropic-style content
blocks. Follows the stub-LLM pattern from test_rebuild_author_powerbi.py
(FakeLlm records call_json kwargs) and the router-under-TestClient pattern
from test_rebuild_endpoints_powerbi.py."""

from __future__ import annotations

import base64
import copy
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import tableauforge.api.rebuild_routes as rebuild_routes
from tableauforge.api.main import Settings
from tableauforge.api.rebuild_routes import build_rebuild_router
from tableauforge.api.store import ArtifactStore
from tableauforge.config import Settings as ForgeSettings
from tableauforge.llm.rebuild_author import _user_blocks, author_rebuild_spec

PNG_B64 = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode()

SETTINGS = ForgeSettings(
    model="test-model",
    vision_model="test-model",
    artifacts_dir=Path("artifacts"),
    max_spec_retries=3,
    field_building_pass=False,
)

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
        "fqn": "site::workbooks.revenue_ops_weekly",
        "elements": [
            {"name": "Sales by Region", "kind": "bi_sheet", "fields": ["Region", "Sales"]}
        ],
        "notes": [],
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
            "calculations": [],
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
    "dashboards": [
        {
            "id": "main",
            "title": "Revenue Ops Weekly",
            "size": {"width": 1200, "height": 800},
            "zones": [
                {"kind": "worksheet", "worksheet": "sales_by_region",
                 "x": 0, "y": 0, "w": 100, "h": 100, "confidence": 0.9}
            ],
        }
    ],
}


def _envelope() -> dict[str, Any]:
    return {"spec": copy.deepcopy(VALID_SPEC), "translation": []}


class FakeLlm:
    def __init__(self, responses: list[Any]):
        self._responses = responses
        self.calls: list[dict[str, Any]] = []

    def call_json(self, system, user_content, model, max_tokens=32000, **kwargs):
        self.calls.append(
            {"system": system, "user_content": user_content, "model": model, **kwargs}
        )
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


# --- _user_blocks -----------------------------------------------------------


def test_user_blocks_without_images_is_plain_text():
    assert _user_blocks('{"brief": {}}', None) == '{"brief": {}}'


def test_user_blocks_with_empty_list_is_plain_text():
    assert _user_blocks('{"brief": {}}', []) == '{"brief": {}}'


def test_user_blocks_interleaves_labelled_image_blocks():
    blocks = _user_blocks(
        '{"brief": {}}',
        [{"element": "Regional Overview", "media_type": "image/png", "data": PNG_B64}],
    )
    assert blocks[0] == {"type": "text", "text": '{"brief": {}}'}
    assert blocks[1]["type"] == "text"
    assert "Regional Overview" in blocks[1]["text"]
    assert blocks[2] == {
        "type": "image",
        "source": {"type": "base64", "media_type": "image/png", "data": PNG_B64},
    }


def test_user_blocks_handles_multiple_images_in_order():
    blocks = _user_blocks(
        '{"brief": {}}',
        [
            {"element": "First", "media_type": "image/png", "data": PNG_B64},
            {"element": "Second", "media_type": "image/jpeg", "data": PNG_B64},
        ],
    )
    assert len(blocks) == 5  # 1 text payload + 2 * (label + image)
    assert "First" in blocks[1]["text"]
    assert blocks[2]["source"]["media_type"] == "image/png"
    assert "Second" in blocks[3]["text"]
    assert blocks[4]["source"]["media_type"] == "image/jpeg"


# --- author_rebuild_spec -----------------------------------------------------


def test_author_passes_blocks_to_llm():
    llm = FakeLlm([_envelope()])
    author_rebuild_spec(
        copy.deepcopy(BRIEF), workbook_name=None, instructions=None,
        llm=llm, settings=SETTINGS, target="databricks",
        images=[{"element": "D", "media_type": "image/png", "data": PNG_B64}],
    )
    content = llm.calls[0]["user_content"]
    assert isinstance(content, list)
    assert any(b.get("type") == "image" for b in content)


def test_author_without_images_keeps_plain_string_user_content():
    """Unchanged behavior when images is None: user_content stays the plain
    JSON string (existing token accounting / retry-payload parsing relies
    on this)."""
    llm = FakeLlm([_envelope()])
    author_rebuild_spec(
        copy.deepcopy(BRIEF), workbook_name=None, instructions=None,
        llm=llm, settings=SETTINGS, target="databricks",
    )
    assert isinstance(llm.calls[0]["user_content"], str)


def test_author_retry_also_gets_image_blocks():
    """Both the initial and retry user_content go through _user_blocks."""
    bad_envelope = {"spec": {}, "translation": []}
    llm = FakeLlm([bad_envelope, _envelope()])
    author_rebuild_spec(
        copy.deepcopy(BRIEF), workbook_name=None, instructions=None,
        llm=llm, settings=SETTINGS, target="databricks",
        images=[{"element": "D", "media_type": "image/png", "data": PNG_B64}],
    )
    assert len(llm.calls) == 2
    retry_content = llm.calls[1]["user_content"]
    assert isinstance(retry_content, list)
    assert retry_content[0]["type"] == "text"
    # The retry payload (validation_errors etc.) is still valid JSON text.
    json.loads(retry_content[0]["text"])
    assert any(b.get("type") == "image" for b in retry_content)


# --- endpoint validation ------------------------------------------------------


@pytest.fixture
def store(tmp_path: Path) -> ArtifactStore:
    return ArtifactStore(tmp_path / "artifacts")


@pytest.fixture(autouse=True)
def _no_llm_passes(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TABLEAUFORGE_POLISH_PASS", "0")
    monkeypatch.setenv("TABLEAUFORGE_DESIGN_PASS", "0")


@pytest.fixture
def client(store: ArtifactStore) -> TestClient:
    app = FastAPI()
    app.include_router(build_rebuild_router(store, Settings(artifacts_dir=store.artifacts_dir)))
    return TestClient(app)


def _draft_body(images: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "brief": {
            "brief_version": "1",
            "report": {"name": "r", "platform": "tableau", "fqn": "f",
                       "elements": [], "notes": []},
            "datasources": [], "notes": [],
        },
                "images": images,
    }


def test_endpoint_rejects_a_fifth_image(client: TestClient) -> None:
    img = {"element": "D", "media_type": "image/png", "data": PNG_B64}
    resp = client.post("/draft-rebuild-spec", json=_draft_body([img] * 5))
    assert resp.status_code == 422


def test_endpoint_rejects_oversized_image(client: TestClient) -> None:
    big = base64.b64encode(b"x" * (5 * 1024 * 1024 + 16)).decode()
    resp = client.post(
        "/draft-rebuild-spec",
        json=_draft_body([{"element": "D", "media_type": "image/png", "data": big}]),
    )
    assert resp.status_code == 422


def test_endpoint_rejects_bad_media_type(client: TestClient) -> None:
    resp = client.post(
        "/draft-rebuild-spec",
        json=_draft_body([{"element": "D", "media_type": "image/gif", "data": PNG_B64}]),
    )
    assert resp.status_code == 422


def test_endpoint_accepts_up_to_four_images_and_forwards_to_llm(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeLlm([_envelope()])
    monkeypatch.setattr(rebuild_routes, "_authoring_llm", lambda: fake)
    img = {"element": "D", "media_type": "image/png", "data": PNG_B64}
    resp = client.post(
        "/draft-rebuild-spec",
        json={"brief": BRIEF, "images": [img] * 4},
    )
    assert resp.status_code == 200, resp.text
    content = fake.calls[0]["user_content"]
    assert isinstance(content, list)
    assert sum(1 for b in content if b.get("type") == "image") == 4


def test_generate_rebuild_endpoint_forwards_images_on_authoring_path(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = FakeLlm([_envelope()])
    monkeypatch.setattr(rebuild_routes, "_authoring_llm", lambda: fake)
    img = {"element": "D", "media_type": "image/png", "data": PNG_B64}
    resp = client.post(
        "/generate-rebuild",
        json={
            "brief": BRIEF,
                        "images": [img],
        },
    )
    assert resp.status_code == 200, resp.text
    content = fake.calls[0]["user_content"]
    assert isinstance(content, list)
    assert any(b.get("type") == "image" for b in content)


def test_generate_rebuild_endpoint_ignores_images_on_spec_json_path(
    client: TestClient,
) -> None:
    """Caller-supplied spec_json is a zero-LLM path; images must not force an
    authoring call (and must not error out either)."""
    img = {"element": "D", "media_type": "image/png", "data": PNG_B64}
    resp = client.post(
        "/generate-rebuild",
        json={
            "brief": BRIEF,
            "spec_json": VALID_SPEC,
                        "images": [img],
        },
    )
    assert resp.status_code == 200, resp.text
