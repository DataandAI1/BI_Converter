"""Databricks AI/BI target wiring (plan 2026-08-10 Phase 5): the authoring
contract (`sql_expression` / `formula_language: 'sql'`), the generator branch,
the /generate-rebuild route, the artifact store's new kind, and the CLI's
zero-LLM `--target databricks` path.

Mirrors tests/test_rebuild_author_powerbi.py + tests/test_rebuild_endpoints_
powerbi.py: the LLM is stubbed at the call_json seam, and the spec_json path
runs the REAL compile + validation pipeline with no LLM at all.
"""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tableauforge.api.rebuild_routes import build_rebuild_router
from tableauforge.api.store import ArtifactStore
from tableauforge.config import Settings
from tableauforge.rebuild import generate_rebuild
from tableauforge.llm.rebuild_author import author_rebuild_spec, render_system_prompt
from tableauforge.llm.field_checks import SCHEMA_PLACEHOLDER
from tableauforge.spec.schema import load_schema

SETTINGS = Settings(
    model="test-model",
    vision_model="test-model",
    artifacts_dir=Path("artifacts"),
    max_spec_retries=3,
    field_building_pass=False,
)

CONNECTION: dict[str, Any] = {
    "dialect": "databricks",
    "host": "adb.example.net",
    "http_path": "/sql/1.0/warehouses/abc123",
    "database": "main",
    "db_schema": "analytics",
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
            "calculations": [
                {
                    "name": "Total Sales",
                    "formula": "SUM([Sales])",
                    "language": "tableau_calc",
                    "derivation_type": ["aggregation"],
                    "flags": [],
                }
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
            "calculated_fields": [
                {
                    "name": "Total Sales",
                    "formula": "SUM(`Sales`)",
                    "datatype": "real",
                    "role": "measure",
                    "formula_language": "sql",
                }
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

VALID_TRANSLATION: list[dict[str, Any]] = [
    {
        "name": "Total Sales",
        "source_language": "tableau_calc",
        "original_formula": "SUM([Sales])",
        "status": "translated",
        "sql_expression": "SUM(`Sales`)",
    }
]


def _envelope(spec: dict[str, Any] | None = None,
              translation: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "spec": copy.deepcopy(VALID_SPEC if spec is None else spec),
        "translation": copy.deepcopy(VALID_TRANSLATION if translation is None else translation),
    }


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


def _author(llm: FakeLlm) -> dict[str, Any]:
    return author_rebuild_spec(
        copy.deepcopy(BRIEF),
        workbook_name=None,
        instructions=None,
        llm=llm,
        settings=SETTINGS,
        target="databricks",
    )


# --- prompt + authoring contract ---------------------------------------------


def test_databricks_prompt_injects_schema_and_is_its_own_prompt() -> None:
    rendered = render_system_prompt("databricks")
    assert SCHEMA_PLACEHOLDER not in rendered
    assert load_schema()["$id"] in rendered
    assert "sql_expression" in rendered
    # SQL-first authoring rules that only this target carries.
    assert "AGGREGATE OVER" in rendered
    assert "three-part" in rendered or "`catalog`.`schema`.`table`" in rendered
    # The default render is the same prompt now that databricks is the only target.
    assert rendered == render_system_prompt()


def test_the_prompt_matches_what_the_compiler_actually_does() -> None:
    """The prompt is a contract with the model; every claim below is one the
    compiler now honours (or refuses), and each was wrong before this pass."""
    # The prompt is hard-wrapped, so match against a whitespace-collapsed copy.
    rendered = " ".join(render_system_prompt("databricks").split())
    # C12: no tooltip/detail advice — this target has no such channel.
    assert 'move context fields to "tooltip"/"detail"' not in rendered
    assert "no tooltip or detail channel" in rendered
    # C4: filter widgets ARE emitted now.
    assert "show_quick_filter" in rendered
    assert "filters are NOT emitted" not in rendered
    assert "relative_date" in rendered
    # C7: chart-type provenance prefers the native type over the downgrade.
    assert "source_mark_class" in rendered
    assert "chart_type_downgraded" in rendered
    # C12: parameters, sorts, number formats and the split seam are documented.
    # Parameters are a real spec field now (plan 2026-09-03 D4), so the prompt
    # must describe what the compiler actually emits, not the old "nothing".
    assert "report.parameters" in rendered
    assert 'A datasource may declare "parameters"' in rendered
    assert "emits NOTHING for them" not in rendered
    # ...the pinned datatype vocabulary, keyword form, and default derivation.
    assert '"string" | "integer" | "decimal" | "date" | "datetime"' in rendered
    assert "never `[Parameters].[X]`" in rendered
    assert "current_value" in rendered
    # ...and the two rules the compiler enforces as errors.
    assert "cannot read a parameter" in rendered
    assert "declare it on BOTH" in rendered
    assert "visual.sorts" in rendered
    assert "Number formats" in rendered
    assert "datasource seam" in rendered
    # C1: the sqlglot promise is now true.
    assert "sqlglot" in rendered


def test_authoring_accepts_a_sql_translation_report() -> None:
    llm = FakeLlm([_envelope()])
    result = _author(llm)
    assert len(llm.calls) == 1
    assert result["translation"][0]["sql_expression"] == "SUM(`Sales`)"


def test_translated_sql_calc_missing_from_spec_is_injected() -> None:
    """A calc reported 'translated' with its sql_expression but absent from
    calculated_fields is injected with formula_language 'sql' (not tableau_calc),
    so the build completes instead of failing every retry."""
    spec_without_calc = copy.deepcopy(VALID_SPEC)
    spec_without_calc["datasources"][0].pop("calculated_fields")
    llm = FakeLlm([_envelope(spec=spec_without_calc)])
    result = _author(llm)
    calcs = {
        c["name"]: c
        for ds in result["spec"]["datasources"]
        for c in ds.get("calculated_fields") or []
    }
    assert calcs["Total Sales"]["formula"] == "SUM(`Sales`)"
    assert calcs["Total Sales"]["formula_language"] == "sql"


def test_an_untranslated_tableau_formula_costs_a_retry_not_the_build() -> None:
    """The prompt promises "every expression is parsed with sqlglot's databricks
    dialect; anything that does not parse costs a retry". Before the gate existed
    that was untrue: `SUM([Sales])` sailed through authoring (sqlglot reads it as
    `SUM(ARRAY(Sales))`), reached the post-compile validator, and failed the whole
    build with every retry unspent."""
    untranslated = copy.deepcopy(VALID_SPEC)
    untranslated["datasources"][0]["calculated_fields"][0]["formula"] = "SUM([Sales])"
    bad_translation = copy.deepcopy(VALID_TRANSLATION)
    bad_translation[0]["sql_expression"] = "SUM([Sales])"

    llm = FakeLlm([_envelope(spec=untranslated, translation=bad_translation), _envelope()])
    result = _author(llm)
    assert len(llm.calls) == 2, "the bad SQL must have cost exactly one retry"
    # The retry prompt names the offending calculation, so the model can fix it.
    retry_errors = json.loads(llm.calls[1]["user_content"])["validation_errors"]
    assert any("'Total Sales'" in e for e in retry_errors), retry_errors
    # ...and the corrected second answer completes the run.
    assert result["translation"][0]["sql_expression"] == "SUM(`Sales`)"


def test_the_sql_gate_error_names_the_calculation_and_the_entry() -> None:
    untranslated = copy.deepcopy(VALID_SPEC)
    untranslated["datasources"][0]["calculated_fields"][0]["formula"] = "SUM([Sales])"
    bad_translation = copy.deepcopy(VALID_TRANSLATION)
    bad_translation[0]["sql_expression"] = "SUM([Sales])"
    envelope = _envelope(spec=untranslated, translation=bad_translation)
    llm = FakeLlm([copy.deepcopy(envelope) for _ in range(3)])
    from tableauforge.llm.rebuild_author import RebuildAuthoringError

    with pytest.raises(RebuildAuthoringError) as exc:
        _author(llm)
    assert any(
        "'Total Sales'" in e and "[Sales]" in e for e in exc.value.errors
    ), exc.value.errors
    assert any("sql_expression" in e for e in exc.value.errors), exc.value.errors


def test_an_unparseable_sql_expression_is_caught_in_the_loop() -> None:
    broken = copy.deepcopy(VALID_SPEC)
    broken["datasources"][0]["calculated_fields"][0]["formula"] = "SUM(((`Sales`"
    translation = copy.deepcopy(VALID_TRANSLATION)
    translation[0]["sql_expression"] = "SUM(((`Sales`"
    llm = FakeLlm([_envelope(spec=broken, translation=translation), _envelope()])
    result = _author(llm)
    assert len(llm.calls) == 2
    assert result["spec"]["datasources"][0]["calculated_fields"][0]["formula"] == (
        "SUM(`Sales`)"
    )


def test_array_indexing_is_not_mistaken_for_a_tableau_reference() -> None:
    """The bracket check must not reject real Databricks SQL: `col[0]` and
    `map['key']` are legitimate."""
    from tableauforge.llm.rebuild_author import _sql_expression_error

    for good in ("`tags`[0]", "`attrs`['region']", "SUM(`Sales`)", "`arr`[`i` + 1]"):
        assert _sql_expression_error(good, "where") is None, good
    assert _sql_expression_error("SUM([Sales])", "where") is not None


def test_a_bracketed_string_literal_is_not_a_tableau_reference() -> None:
    """`'[Unassigned]'` is a STRING, not a field reference — rejecting it cost a
    retry (and eventually the build) over correct Databricks SQL."""
    from tableauforge.llm.rebuild_author import _sql_expression_error

    good = "CASE WHEN `Region` IS NULL THEN '[Unassigned]' ELSE `Region` END"
    assert _sql_expression_error(good, "where") is None, good
    assert _sql_expression_error("CONCAT('[', `Region`, ']')", "where") is None


def test_bare_identifier_array_indexing_is_not_a_tableau_reference() -> None:
    """`arr[idx]` is a subscript, not a field reference: the bracket is preceded
    by an identifier character, which `[Sales]` never is."""
    from tableauforge.llm.rebuild_author import _sql_expression_error

    for good in ("arr[idx]", "`m`[key_name]", "SPLIT(`s`, ',')[part]"):
        assert _sql_expression_error(good, "where") is None, good
    # ...and a real Tableau reference still fails, standalone or nested.
    assert _sql_expression_error("SUM([Sales])", "where") is not None
    assert _sql_expression_error("[Sales] + 1", "where") is not None


def test_a_brief_with_no_datasources_never_reaches_the_llm() -> None:
    """Three paid calls then a schema failure was the old behaviour for a
    Lakeview container the catalog resolved no datasource for."""
    brief = copy.deepcopy(BRIEF)
    brief["datasources"] = []
    llm = FakeLlm([])
    with pytest.raises(ValueError, match="no datasources"):
        author_rebuild_spec(
            brief,
            workbook_name=None,
            instructions=None,
            llm=llm,
            settings=SETTINGS,
            target="databricks",
        )
    assert llm.calls == []


def test_an_injected_date_calc_lands_with_a_temporal_datatype() -> None:
    """A `DATE_TRUNC` column defaulting to `datatype: string` turned the time
    axis categorical — it sorted alphabetically, so 2024-10 came before 2024-2."""
    brief = copy.deepcopy(BRIEF)
    brief["datasources"][0]["calculations"].append(
        {
            "name": "Order Month",
            "formula": "DATETRUNC('month', [Order Date])",
            "language": "tableau_calc",
            "derivation_type": ["date"],
            "flags": [],
        }
    )
    spec_without_calc = copy.deepcopy(VALID_SPEC)
    translation = copy.deepcopy(VALID_TRANSLATION) + [
        {
            "name": "Order Month",
            "source_language": "tableau_calc",
            "original_formula": "DATETRUNC('month', [Order Date])",
            "status": "translated",
            "sql_expression": "DATE_TRUNC('MONTH', `Order Date`)",
        }
    ]
    result = author_rebuild_spec(
        brief,
        workbook_name=None,
        instructions=None,
        llm=FakeLlm([_envelope(spec=spec_without_calc, translation=translation)]),
        settings=SETTINGS,
        target="databricks",
    )
    calcs = {
        c["name"]: c
        for ds in result["spec"]["datasources"]
        for c in ds.get("calculated_fields") or []
    }
    assert calcs["Order Month"]["datatype"] == "datetime"
    assert calcs["Order Month"]["role"] == "dimension"


def test_temporal_inference_is_top_level_only() -> None:
    from tableauforge.llm.rebuild_author import _temporal_datatype

    assert _temporal_datatype("DATE_TRUNC('MONTH', `d`)") == "datetime"
    assert _temporal_datatype("TO_DATE(`d`)") == "date"
    assert _temporal_datatype("CAST(`d` AS DATE)") == "date"
    assert _temporal_datatype("CAST(`d` AS TIMESTAMP)") == "datetime"
    # YEAR(...) returns an integer and CONCAT(...) a string, whatever they wrap.
    assert _temporal_datatype("YEAR(DATE_TRUNC('MONTH', `d`))") is None
    assert _temporal_datatype("CONCAT(TO_DATE(`d`), '!')") is None
    assert _temporal_datatype("UPPER(`Region`)") is None


def test_a_dax_declared_calc_is_rejected_for_this_target() -> None:
    """The language gate is target-aware: a spec written in DAX must not
    silently compile as a Databricks dashboard."""
    wrong = copy.deepcopy(VALID_SPEC)
    wrong["datasources"][0]["calculated_fields"][0]["formula_language"] = "dax"
    llm = FakeLlm([_envelope(spec=wrong), _envelope(spec=wrong), _envelope(spec=wrong)])
    from tableauforge.llm.rebuild_author import RebuildAuthoringError

    with pytest.raises(RebuildAuthoringError) as exc:
        _author(llm)
    assert any("'sql'" in e for e in exc.value.errors), exc.value.errors


# --- the databricks pre-compile gate ------------------------------------------
#
# Every mistake below is one the COMPILER refuses. Refused after authoring it
# costs the whole build (with every retry unspent); refused inside the loop it
# costs one retry. Each test asserts the error text reaches the retry payload.


def _retry_errors(llm: FakeLlm) -> list[str]:
    """The validation_errors the second call carried."""
    assert len(llm.calls) >= 2, "the mistake did not cost a retry"
    return json.loads(llm.calls[1]["user_content"])["validation_errors"]


def _gated(spec: dict[str, Any]) -> FakeLlm:
    """A FakeLlm that answers with `spec` first and the good spec second."""
    return FakeLlm([_envelope(spec=spec), _envelope()])


def test_a_dimension_calc_that_aggregates_costs_a_retry() -> None:
    """A row-level calc is projected into the dataset SELECT; an aggregate there
    is a SQL error at dashboard load, and the compiler will not emit one."""
    bad = copy.deepcopy(VALID_SPEC)
    bad["datasources"][0]["calculated_fields"].append(
        {
            "name": "Region Total",
            "formula": "SUM(`Sales`)",
            "datatype": "real",
            "role": "dimension",
            "formula_language": "sql",
        }
    )
    llm = _gated(bad)
    _author(llm)
    errors = _retry_errors(llm)
    assert any("'Region Total'" in e and "aggregate" in e for e in errors), errors


def test_a_row_level_calc_reading_an_undeclared_parameter_costs_a_retry() -> None:
    bad = copy.deepcopy(VALID_SPEC)
    bad["datasources"][0]["calculated_fields"].append(
        {
            "name": "Big Order",
            "formula": "CASE WHEN `Sales` > :threshold THEN 'yes' ELSE 'no' END",
            "datatype": "string",
            "role": "dimension",
            "formula_language": "sql",
        }
    )
    llm = _gated(bad)
    _author(llm)
    errors = _retry_errors(llm)
    assert any(":threshold" in e and "not declared" in e for e in errors), errors


def test_a_declared_parameter_is_accepted_by_the_gate() -> None:
    """The mirror of the test above: a DECLARED parameter must not cost a retry."""
    good = copy.deepcopy(VALID_SPEC)
    good["datasources"][0]["parameters"] = [
        {"name": "threshold", "datatype": "decimal", "default": "100"}
    ]
    good["datasources"][0]["calculated_fields"].append(
        {
            "name": "Big Order",
            "formula": "CASE WHEN `Sales` > :threshold THEN 'yes' ELSE 'no' END",
            "datatype": "string",
            "role": "dimension",
            "formula_language": "sql",
        }
    )
    llm = FakeLlm([_envelope(spec=good)])
    result = _author(llm)
    assert len(llm.calls) == 1
    names = [c["name"] for c in result["spec"]["datasources"][0]["calculated_fields"]]
    assert "Big Order" in names


def test_an_aggregate_calc_reading_a_parameter_costs_a_retry() -> None:
    """An aggregate is a WIDGET expression and only a dataset query binds a
    parameter — declared or not, `:kw` inside one is a compile error."""
    bad = copy.deepcopy(VALID_SPEC)
    bad["datasources"][0]["parameters"] = [
        {"name": "threshold", "datatype": "decimal", "default": "100"}
    ]
    bad["datasources"][0]["calculated_fields"][0]["formula"] = (
        "SUM(CASE WHEN `Sales` > :threshold THEN `Sales` ELSE 0 END)"
    )
    llm = _gated(bad)
    _author(llm)
    errors = _retry_errors(llm)
    assert any(
        "'Total Sales'" in e and ":threshold" in e and "row-level" in e for e in errors
    ), errors


def test_one_keyword_with_two_datatypes_costs_a_retry() -> None:
    """One control cannot bind two datatypes; the compiler refuses the page."""
    brief = copy.deepcopy(BRIEF)
    brief["datasources"].append(
        {
            "id": "events_ds",
            "name": "events",
            "connection": dict(CONNECTION, table="events"),
            "fields": [
                {"name": "Channel", "datatype": "string", "role": "dimension"},
                {"name": "Events", "datatype": "integer", "role": "measure",
                 "default_aggregation": "sum"},
            ],
            "calculations": [],
            "notes": [],
        }
    )
    bad = copy.deepcopy(VALID_SPEC)
    bad["datasources"][0]["parameters"] = [
        {"name": "as_of", "datatype": "date", "default": "2026-01-01"}
    ]
    bad["datasources"].append(
        {
            "id": "events_ds",
            "name": "events",
            "kind": "live_database",
            "database": dict(CONNECTION, table="events"),
            "fields": [
                {"name": "Channel", "datatype": "string", "role": "dimension"},
                {"name": "Events", "datatype": "integer", "role": "measure",
                 "default_aggregation": "sum"},
            ],
            "parameters": [
                {"name": "as_of", "datatype": "string", "default": "2026-01-01"}
            ],
        }
    )
    bad["worksheets"].append(
        {
            "id": "events_by_channel",
            "title": "Events by Channel",
            "datasource": "events_ds",
            "chart": {
                "type": "bar",
                "rows": [{"field": "Events", "aggregation": "sum"}],
                "cols": [{"field": "Channel"}],
            },
        }
    )
    bad["dashboards"][0]["zones"] = [
        {"kind": "worksheet", "worksheet": "sales_by_region",
         "x": 0, "y": 0, "w": 100, "h": 50, "confidence": 0.9},
        {"kind": "worksheet", "worksheet": "events_by_channel",
         "x": 0, "y": 50, "w": 100, "h": 50, "confidence": 0.9},
    ]
    good = copy.deepcopy(bad)
    good["datasources"][1]["parameters"] = [
        {"name": "as_of", "datatype": "date", "default": "2026-01-01"}
    ]
    llm = FakeLlm([_envelope(spec=bad), _envelope(spec=good)])
    author_rebuild_spec(
        brief, workbook_name=None, instructions=None, llm=llm,
        settings=SETTINGS, target="databricks",
    )
    errors = _retry_errors(llm)
    assert any("'as_of'" in e and "two datatypes" in e for e in errors), errors


def test_a_date_part_on_a_shelf_costs_a_retry() -> None:
    """Tableau's shelf-level date grouping has no Lakeview equivalent; the
    compiler refuses it, so the model must not author one."""
    bad = copy.deepcopy(VALID_SPEC)
    bad["worksheets"][0]["chart"]["cols"] = [{"field": "Region", "date_part": "month"}]
    llm = _gated(bad)
    _author(llm)
    errors = _retry_errors(llm)
    assert any(
        "date_part" in e and "'Sales by Region'" in e and "'Region'" in e
        for e in errors
    ), errors


def test_a_date_part_on_a_filter_costs_a_retry() -> None:
    bad = copy.deepcopy(VALID_SPEC)
    bad["worksheets"][0]["filters"] = [
        {"field": "Region", "filter_type": "categorical", "date_part": "year",
         "show_quick_filter": True}
    ]
    llm = _gated(bad)
    _author(llm)
    errors = _retry_errors(llm)
    assert any("date_part" in e and "'Region'" in e for e in errors), errors


def test_a_relative_date_filter_costs_a_retry() -> None:
    """The compiler now WARNS instead of raising, so nothing downstream would
    ever stop the model authoring a filter that silently does not appear."""
    bad = copy.deepcopy(VALID_SPEC)
    bad["dashboards"][0]["shared_filters"] = [
        {"field": "Region", "filter_type": "relative_date", "show_quick_filter": True}
    ]
    llm = _gated(bad)
    _author(llm)
    errors = _retry_errors(llm)
    assert any("relative_date" in e for e in errors), errors


# --- generator branch ---------------------------------------------------------


def test_generate_rebuild_compiles_and_validates_a_lvdash_artifact(tmp_path: Path) -> None:
    result, translation = generate_rebuild(
        brief=copy.deepcopy(BRIEF),
        out_dir=tmp_path,
        spec=copy.deepcopy(VALID_SPEC),
    )
    assert translation == []
    assert result.artifact_path is not None
    assert result.artifact_path.name.endswith(".lvdash.json")
    assert result.report.passed, result.report.to_dict()
    doc = json.loads(result.artifact_path.read_text(encoding="utf-8"))
    assert [d["displayName"] for d in doc["datasets"]] == ["orders"]
    assert doc["pages"][0]["pageType"] == "PAGE_TYPE_CANVAS"
    # The spec + report are persisted next to the artifact, like every target.
    assert (result.artifact_path.parent / "spec.json").exists()
    assert (result.artifact_path.parent / "validation_report.json").exists()


def _spec_with_sheets(count: int) -> dict[str, Any]:
    """VALID_SPEC widened to `count` standalone worksheets â€” one page each."""
    spec = copy.deepcopy(VALID_SPEC)
    spec["dashboards"] = []
    spec["worksheets"] = [
        {
            "id": f"ws_{i}",
            "title": f"Sheet {i}",
            "datasource": spec["datasources"][0]["id"],
            "chart": {
                "type": "bar",
                "rows": [{"field": "Sales", "aggregation": "sum"}],
                "cols": [{"field": "Region"}],
            },
        }
        for i in range(count)
    ]
    return spec


def test_a_report_over_the_page_cap_builds_as_a_zip_of_dashboards(tmp_path: Path) -> None:
    """The failure this replaces: 'spec produces 28 pages; an AI/BI dashboard
    holds at most 15'. The build now completes, splitting the report."""
    import zipfile

    result, _ = generate_rebuild(
        brief=copy.deepcopy(BRIEF),
        out_dir=tmp_path,
        spec=_spec_with_sheets(28),
    )
    assert result.report.passed, result.report.to_dict()
    assert result.artifact_path is not None
    assert result.artifact_path.name.endswith(".lvdash.zip")
    assert [p["pages"] for p in result.artifact_parts] == [14, 14]
    assert [p["title"] for p in result.artifact_parts] == [
        "Revenue Ops Weekly (1 of 2)",
        "Revenue Ops Weekly (2 of 2)",
    ]
    with zipfile.ZipFile(result.artifact_path) as zf:
        names = sorted(zf.namelist())
        assert names == [
            "README.txt",
            "Revenue Ops Weekly (1 of 2).lvdash.json",
            "Revenue Ops Weekly (2 of 2).lvdash.json",
        ]
        pages = [
            page["displayName"]
            for name in names[1:]
            for page in json.loads(zf.read(name).decode("utf-8"))["pages"]
        ]
    # Every page of the source report is delivered, in order â€” nothing dropped.
    assert pages == [f"Sheet {i}" for i in range(28)]
    # Each part is also on disk beside the zip, for a caller that wants one file.
    assert (result.artifact_path.parent / "Revenue Ops Weekly (2 of 2).lvdash.json").exists()


def test_the_split_is_announced_in_the_build_warnings(tmp_path: Path) -> None:
    result, _ = generate_rebuild(
        brief=copy.deepcopy(BRIEF),
        out_dir=tmp_path,
        spec=_spec_with_sheets(28),
    )
    assert any("split into 2 dashboards" in w for w in result.compile_warnings), (
        result.compile_warnings
    )


def test_an_unsplit_build_reports_no_parts_and_keeps_its_filename(tmp_path: Path) -> None:
    result, _ = generate_rebuild(
        brief=copy.deepcopy(BRIEF),
        out_dir=tmp_path,
        spec=copy.deepcopy(VALID_SPEC),
    )
    assert result.artifact_parts == []
    assert result.artifact_path is not None
    assert result.artifact_path.name == "Revenue Ops Weekly.lvdash.json"


def test_a_split_build_with_a_broken_part_does_not_report_passed(tmp_path: Path) -> None:
    """A merged report must fail when ANY document fails â€” otherwise a split
    build could ship a broken dashboard under a green report."""
    from tableauforge.rebuild import _merge_reports
    from tableauforge.validate.pipeline import LayerResult, ValidationReport

    class _Part:
        def __init__(self, title: str) -> None:
            self.title = title

    ok = ValidationReport(layers=[LayerResult(1, "json-structure", True, [])], xsd_version="v")
    bad = ValidationReport(
        layers=[LayerResult(1, "json-structure", False, ["page[0]: broken"])],
        xsd_version="v",
    )
    merged = _merge_reports([ok, bad], [_Part("A (1 of 2)"), _Part("B (2 of 2)")])
    assert merged.passed is False
    assert merged.layers[0].errors == ["B (2 of 2): page[0]: broken"]


def test_authoring_rejects_an_unknown_target() -> None:
    """generate_rebuild no longer takes a target — there is only one — but the
    authoring contract registry still refuses a name it does not serve."""
    with pytest.raises(ValueError, match="unknown rebuild target"):
        render_system_prompt("looker")


def test_compile_warnings_reach_the_generation_result(tmp_path: Path) -> None:
    spec = copy.deepcopy(VALID_SPEC)
    spec["dashboards"][0]["zones"].append(
        {"kind": "text", "text": "Header", "x": 0, "y": 0, "w": 100, "h": 8}
    )
    result, _ = generate_rebuild(
        brief=copy.deepcopy(BRIEF), out_dir=tmp_path, spec=spec
    )
    assert any("text zone" in w for w in result.compile_warnings), result.compile_warnings


def test_a_non_databricks_source_is_a_note_not_a_warning(tmp_path: Path) -> None:
    """It fires on every migration this target exists for, so as a warning it made
    every single run `complete_with_warnings`."""
    spec = copy.deepcopy(VALID_SPEC)
    spec["datasources"][0]["database"] = {
        "dialect": "snowflake", "host": "acct.snowflakecomputing.com",
        "database": "ANALYTICS", "db_schema": "PUBLIC", "table": "ORDERS",
    }
    brief = copy.deepcopy(BRIEF)
    brief["datasources"][0]["connection"] = spec["datasources"][0]["database"]
    result, _ = generate_rebuild(
        brief=brief, out_dir=tmp_path, spec=spec
    )
    assert result.compile_warnings == []
    assert any("Unity Catalog" in n for n in result.compile_notes), result.compile_notes


def test_the_route_returns_notes_beside_warnings(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path / "artifacts")
    app = FastAPI()
    app.include_router(build_rebuild_router(store, Settings.from_env()))
    spec = copy.deepcopy(VALID_SPEC)
    spec["datasources"][0]["database"] = {
        "dialect": "snowflake", "host": "acct.snowflakecomputing.com",
        "database": "ANALYTICS", "db_schema": "PUBLIC", "table": "ORDERS",
    }
    brief = copy.deepcopy(BRIEF)
    brief["datasources"][0]["connection"] = spec["datasources"][0]["database"]
    res = TestClient(app).post(
        "/generate-rebuild",
        json={"brief": brief, "spec_json": spec},
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["warnings"] == []
    assert any("Unity Catalog" in n for n in body["notes"]), body["notes"]


def test_the_lvdash_zip_is_byte_identical_on_recompile(tmp_path: Path) -> None:
    """Determinism holds for the SPLIT path too: same spec in, same zip bytes out
    (a re-run must produce a clean diff, not a new archive)."""
    spec = _spec_with_sheets(28)
    first, _ = generate_rebuild(
        brief=copy.deepcopy(BRIEF), out_dir=tmp_path / "a",
        spec=copy.deepcopy(spec)
    )
    second, _ = generate_rebuild(
        brief=copy.deepcopy(BRIEF), out_dir=tmp_path / "b",
        spec=copy.deepcopy(spec)
    )
    assert first.artifact_path is not None and second.artifact_path is not None
    assert first.artifact_path.name.endswith(".lvdash.zip")
    assert first.artifact_path.read_bytes() == second.artifact_path.read_bytes()


def test_the_single_document_path_is_byte_identical_on_recompile(tmp_path: Path) -> None:
    first, _ = generate_rebuild(
        brief=copy.deepcopy(BRIEF), out_dir=tmp_path / "a",
        spec=copy.deepcopy(VALID_SPEC)
    )
    second, _ = generate_rebuild(
        brief=copy.deepcopy(BRIEF), out_dir=tmp_path / "b",
        spec=copy.deepcopy(VALID_SPEC)
    )
    assert first.artifact_path is not None and second.artifact_path is not None
    assert first.artifact_path.read_bytes() == second.artifact_path.read_bytes()


# --- /generate-rebuild route + store ------------------------------------------


@pytest.fixture
def client(tmp_path: Path) -> TestClient:
    store = ArtifactStore(tmp_path / "artifacts")
    app = FastAPI()
    app.include_router(build_rebuild_router(store, Settings.from_env()))
    app.state.store = store
    return TestClient(app)


def test_generate_rebuild_route_accepts_the_databricks_target(client: TestClient) -> None:
    res = client.post(
        "/generate-rebuild",
        json={
            "brief": BRIEF,
            "spec_json": VALID_SPEC,
            "translation": VALID_TRANSLATION,
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["report"]["passed"] is True
    assert body["translation"] == VALID_TRANSLATION
    assert body["download_url"] == f"/download/{body['artifact_id']}"


def test_the_stored_artifact_row_carries_kind_lvdash(client: TestClient) -> None:
    res = client.post(
        "/generate-rebuild",
        json={"brief": BRIEF, "spec_json": VALID_SPEC},
    )
    assert res.status_code == 200, res.text
    store: ArtifactStore = client.app.state.store
    row = store.get_artifact(res.json()["artifact_id"])
    assert row is not None
    assert row["kind"] == "lvdash"
    assert row["path"].endswith(".lvdash.json")


def test_store_migrates_a_database_created_before_the_lvdash_kind(tmp_path: Path) -> None:
    """SQLite cannot alter a CHECK constraint, so an existing forge.db must be
    rebuilt â€” without losing its rows."""
    import sqlite3

    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    conn = sqlite3.connect(artifacts / "forge.db")
    with conn:
        conn.execute(
            "CREATE TABLE artifacts (id TEXT PRIMARY KEY, workbook_name TEXT NOT NULL, "
            "kind TEXT NOT NULL CHECK (kind IN ('twb', 'twbx', 'pbit')), path TEXT NOT NULL, "
            "spec_json TEXT NOT NULL, report_json TEXT NOT NULL, created_at TEXT NOT NULL, "
            "llm_usage_json TEXT)"
        )
        conn.execute(
            "INSERT INTO artifacts VALUES ('a1', 'Old', 'twb', '/tmp/a.twb', '{}', '{}', "
            "'2026-01-01T00:00:00Z', NULL)"
        )
    conn.close()

    store = ArtifactStore(artifacts)
    assert store.get_artifact("a1") is not None  # the pre-existing row survived
    store.save_artifact(
        artifact_id="a2",
        workbook_name="New",
        kind="lvdash",
        path="/tmp/a.lvdash.json",
        spec={},
        report={},
    )
    assert store.get_artifact("a2")["kind"] == "lvdash"


def test_store_still_rejects_an_unknown_kind(tmp_path: Path) -> None:
    store = ArtifactStore(tmp_path / "artifacts")
    with pytest.raises(ValueError, match="kind must be one of"):
        store.save_artifact(
            artifact_id="a1", workbook_name="X", kind="lvdash.json",
            path="/tmp/x", spec={}, report={},
        )
