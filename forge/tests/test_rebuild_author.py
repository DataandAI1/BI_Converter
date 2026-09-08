"""Rebuild Author (Linetria addition): brief -> {spec, translation}, gated by
schema + field cross-check + translation-report honesty, with validator-error
retries. The Anthropic client is stubbed at the call_json seam."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest

from tableauforge.config import Settings
from tableauforge.llm.client import LlmJsonError
from tableauforge.llm.rebuild_author import (
    BRIEF_UNREFERENCED_FIELD_TAIL,
    MAX_REBUILD_ZONE_CONFIDENCE,
    RebuildAuthoringError,
    author_rebuild_spec,
    force_brief_datasources,
    prompt_brief,
    rebuild_schema_view,
    render_system_prompt,
    trim_overfull_shelves,
)
from tableauforge.llm.field_checks import SCHEMA_PLACEHOLDER
from tableauforge.spec.schema import (
    load_schema,
    normalize_zone_grid,
    prune_unknown_root_keys,
    validate_spec,
)

SETTINGS = Settings(
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
                {
                    "name": "Sales",
                    "datatype": "real",
                    "role": "measure",
                    "default_aggregation": "sum",
                },
            ],
            "calculations": [
                {
                    "name": "Total Sales",
                    "formula": "SUM(orders[Sales])",
                    "language": "dax",
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
                {
                    "name": "Sales",
                    "datatype": "real",
                    "role": "measure",
                    "default_aggregation": "sum",
                },
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


def _author(llm: FakeLlm, **overrides: Any) -> dict[str, Any]:
    return author_rebuild_spec(
        copy.deepcopy(BRIEF),
        workbook_name=overrides.get("workbook_name"),
        instructions=overrides.get("instructions"),
        llm=llm,
        settings=SETTINGS,
    )


def test_render_system_prompt_injects_actual_schema():
    rendered = render_system_prompt()
    assert SCHEMA_PLACEHOLDER not in rendered
    assert load_schema()["$id"] in rendered


def test_happy_path_single_call():
    llm = FakeLlm([_envelope()])
    result = _author(llm)
    assert result["translation"] == VALID_TRANSLATION
    assert result["spec"]["worksheets"][0]["id"] == "sales_by_region"
    assert len(llm.calls) == 1
    # The brief reaches the prompt payload verbatim.
    payload = json.loads(llm.calls[0]["user_content"])
    assert payload["brief"]["report"]["name"] == "Revenue Ops Weekly"


def test_out_of_grid_zone_layout_is_normalized_not_rejected():
    """Row-stacked / pixel-style zone geometry (the dominant local-model failure:
    y=130, 160 … on the 0-100 grid) is projected onto the grid, not retried."""
    spec = copy.deepcopy(VALID_SPEC)
    spec["dashboards"][0]["zones"] = [
        {"kind": "worksheet", "worksheet": "sales_by_region", "x": 0, "y": 0, "w": 100, "h": 60},
        {"kind": "text", "text": "middle", "x": 0, "y": 65, "w": 100, "h": 60},
        {"kind": "text", "text": "bottom", "x": 0, "y": 130, "w": 100, "h": 60},
    ]
    llm = FakeLlm([_envelope(spec=spec)])
    result = _author(llm)
    assert len(llm.calls) == 1  # no retry burned on fixable geometry
    zones = result["spec"]["dashboards"][0]["zones"]
    assert all(0 <= z["y"] and z["y"] + z["h"] <= 100.01 for z in zones)
    assert zones[0]["y"] < zones[1]["y"] < zones[2]["y"]  # relative order kept
    assert validate_spec(result["spec"]) == []


def test_force_brief_datasources_dedupes_field_names():
    """One physical column declared as several local fields (same name,
    different captions/datatypes) must land as ONE workbook column — the first
    occurrence — or the round-trip datatype check fails post-compile."""
    brief = copy.deepcopy(BRIEF)
    brief["datasources"][0]["fields"].append(
        {"name": "Region", "datatype": "date", "role": "dimension", "caption": "Region (parsed)"}
    )
    spec = copy.deepcopy(VALID_SPEC)
    force_brief_datasources(spec, brief)
    regions = [f for f in spec["datasources"][0]["fields"] if f["name"] == "Region"]
    assert len(regions) == 1
    assert regions[0]["datatype"] == "string"  # first occurrence wins


def test_missing_translation_defaults_to_empty_for_calc_free_brief():
    """A brief with no calculations legitimately yields no translation — the
    model omitting the key must not fail the envelope (the dtna failure)."""
    calc_free = copy.deepcopy(BRIEF)
    calc_free["datasources"][0]["calculations"] = []
    spec = copy.deepcopy(VALID_SPEC)
    spec["datasources"][0].pop("calculated_fields")
    llm = FakeLlm([{"spec": spec}])  # no "translation" key at all
    result = author_rebuild_spec(
        calc_free, workbook_name=None, instructions=None, llm=llm, settings=SETTINGS
    )
    assert result["translation"] == []
    assert len(llm.calls) == 1


def test_envelope_coercion_repairs_classic_shapes():
    # Bare DashboardSpec at the root (no {"spec": ...} wrapper).
    llm = FakeLlm([{**copy.deepcopy(VALID_SPEC), "translation": copy.deepcopy(VALID_TRANSLATION)}])
    result = _author(llm)
    assert result["spec"]["workbook"]["name"] == "Revenue Ops Weekly"
    assert result["translation"] == VALID_TRANSLATION

    # Double-encoded spec + translation keyed by calc name.
    keyed = {e["name"]: {k: v for k, v in e.items() if k != "name"} for e in VALID_TRANSLATION}
    llm = FakeLlm([{"spec": json.dumps(VALID_SPEC), "translation": keyed}])
    result = _author(llm)
    assert result["translation"] == VALID_TRANSLATION


def test_root_shared_filters_is_relocated_not_fatal():
    """A root-level shared_filters (observed local-model mistake) relocates into
    the sole dashboard instead of failing the round on additionalProperties."""
    spec = copy.deepcopy(VALID_SPEC)
    spec["shared_filters"] = [{"field": "Region", "filter_type": "categorical"}]
    spec["totally_unknown"] = {"x": 1}
    llm = FakeLlm([_envelope(spec=spec)])
    result = _author(llm)
    assert len(llm.calls) == 1
    out = result["spec"]
    assert "shared_filters" not in out and "totally_unknown" not in out
    assert out["dashboards"][0]["shared_filters"] == [{"field": "Region", "filter_type": "categorical"}]
    assert validate_spec(out) == []


def test_prune_unknown_root_keys_unit_behavior():
    # Multi-dashboard: ambiguous target — the stray key is dropped, not guessed.
    multi = {
        "dashboards": [{"zones": []}, {"zones": []}],
        "shared_filters": [{"field": "A"}],
    }
    prune_unknown_root_keys(multi)
    assert "shared_filters" not in multi
    assert all("shared_filters" not in d for d in multi["dashboards"])

    # A dashboard with its own shared_filters keeps them (no overwrite).
    owned = {
        "dashboards": [{"zones": [], "shared_filters": [{"field": "B"}]}],
        "shared_filters": [{"field": "A"}],
    }
    prune_unknown_root_keys(owned)
    assert owned["dashboards"][0]["shared_filters"] == [{"field": "B"}]

    # Known root keys are never touched.
    known = {"spec_version": "1.0", "workbook": {"name": "n"}}
    before = copy.deepcopy(known)
    prune_unknown_root_keys(known)
    assert known == before

    # Stray advisory 'confidence' on worksheets (zone-only concept) is stripped.
    ws_conf = {"worksheets": [{"id": "w1", "confidence": 0.7}]}
    prune_unknown_root_keys(ws_conf)
    assert ws_conf["worksheets"][0] == {"id": "w1"}


def test_normalize_zone_grid_unit_behavior():
    # In-bounds layouts are untouched (byte-identical geometry).
    ok = {"dashboards": [{"zones": [
        {"kind": "text", "text": "t", "x": 5, "y": 10, "w": 50, "h": 40}]}]}
    before = copy.deepcopy(ok)
    normalize_zone_grid(ok)
    assert ok == before

    # Negative origins shift, oversized extents rescale, per axis independently.
    bad = {"dashboards": [{"zones": [
        {"kind": "text", "text": "a", "x": -10, "y": 0, "w": 100, "h": 400},
        {"kind": "text", "text": "b", "x": 90, "y": 400, "w": 120, "h": 400},
    ]}]}
    normalize_zone_grid(bad)
    for z in bad["dashboards"][0]["zones"]:
        assert 0 <= z["x"] and z["x"] + z["w"] <= 100.01
        assert 0 <= z["y"] and z["y"] + z["h"] <= 100.01

    # Non-numeric coordinates are left for schema validation to reject.
    junk = {"dashboards": [{"zones": [
        {"kind": "text", "text": "t", "x": "left", "y": 0, "w": 50, "h": 500}]}]}
    before_junk = copy.deepcopy(junk)
    normalize_zone_grid(junk)
    assert junk == before_junk


def test_zone_confidence_is_clamped():
    llm = FakeLlm([_envelope()])  # zone declares 0.9
    result = _author(llm)
    zones = result["spec"]["dashboards"][0]["zones"]
    assert all(z["confidence"] <= MAX_REBUILD_ZONE_CONFIDENCE for z in zones)


def test_connection_and_fields_are_forced_from_brief():
    tampered = copy.deepcopy(VALID_SPEC)
    tampered["datasources"][0]["database"] = {
        "dialect": "postgres", "host": "wrong", "database": "wrong", "table": "wrong",
    }
    tampered["datasources"][0]["fields"] = [
        {"name": "Region", "datatype": "string", "role": "dimension"},
        {"name": "Sales", "datatype": "real", "role": "measure",
         "default_aggregation": "sum"},
        {"name": "Invented", "datatype": "string", "role": "dimension"},
    ]
    llm = FakeLlm([_envelope(spec=tampered)])
    result = _author(llm)
    ds = result["spec"]["datasources"][0]
    assert ds["database"] == CONNECTION
    assert [f["name"] for f in ds["fields"]] == ["Region", "Sales"]


def test_unknown_field_reference_retries_with_errors():
    bad = copy.deepcopy(VALID_SPEC)
    bad["worksheets"][0]["chart"]["cols"] = [{"field": "Nonexistent"}]
    llm = FakeLlm([_envelope(spec=bad), _envelope()])
    result = _author(llm)
    assert len(llm.calls) == 2
    retry_payload = json.loads(llm.calls[1]["user_content"])
    assert any("Nonexistent" in e for e in retry_payload["validation_errors"])
    assert result["spec"]["worksheets"][0]["chart"]["cols"] == [{"field": "Region"}]


def test_missing_translation_entry_is_rejected():
    llm = FakeLlm([_envelope(translation=[]), _envelope()])
    _author(llm)
    retry_payload = json.loads(llm.calls[1]["user_content"])
    assert any("Total Sales" in e and "missing" in e for e in retry_payload["validation_errors"])


def test_translated_calc_missing_from_spec_is_injected_not_retried():
    """The dominant local-model rebuild failure (the 'Test sales month' report):
    a calc is reported 'translated' with its Tableau formula right there in the
    entry, but the model forgets to also declare it under the datasource's
    calculated_fields. Rather than burn every retry and fail the whole build, the
    formula is deterministically injected (mirroring force_brief_datasources /
    spec_author._inject_calculated_fields)."""
    spec_without_calc = copy.deepcopy(VALID_SPEC)
    spec_without_calc["datasources"][0].pop("calculated_fields")
    llm = FakeLlm([_envelope(spec=spec_without_calc)])
    result = _author(llm)
    assert len(llm.calls) == 1  # no retry burned on a deterministically-fixable gap
    calcs = {
        c["name"]: c
        for ds in result["spec"]["datasources"]
        for c in ds.get("calculated_fields") or []
    }
    assert "Total Sales" in calcs
    assert calcs["Total Sales"]["formula"] == "SUM(`Sales`)"  # from the translation entry
    assert calcs["Total Sales"]["formula_language"] == "sql"
    assert validate_spec(result["spec"]) == []


def test_extra_translated_calc_absent_from_spec_is_injected():
    """A brief calc the model translates but never declares (neither in
    calculated_fields nor referenced by any worksheet) is still injected, so the
    user keeps the translated formula instead of losing the whole build."""
    brief = copy.deepcopy(BRIEF)
    brief["datasources"][0]["calculations"].append({
        "name": "Test sales month",
        "formula": "MONTH([OrderDate])",
        "language": "tableau_calc",
        "derivation_type": ["date_part"],
        "flags": [],
    })
    translation = copy.deepcopy(VALID_TRANSLATION) + [{
        "name": "Test sales month",
        "source_language": "tableau_calc",
        "original_formula": "MONTH([OrderDate])",
        "status": "translated",
        "sql_expression": "MONTH(`Order Date`)",
    }]
    llm = FakeLlm([_envelope(translation=translation)])
    result = author_rebuild_spec(
        brief, workbook_name=None, instructions=None, llm=llm, settings=SETTINGS
    )
    assert len(llm.calls) == 1
    calcs = {
        c["name"]: c
        for ds in result["spec"]["datasources"]
        for c in ds.get("calculated_fields") or []
    }
    assert calcs["Test sales month"]["formula"] == "MONTH(`Order Date`)"
    assert calcs["Test sales month"]["formula_language"] == "sql"
    assert calcs["Test sales month"]["role"] in ("dimension", "measure")
    assert calcs["Test sales month"]["datatype"] in (
        "string", "integer", "real", "boolean", "date", "datetime"
    )
    assert validate_spec(result["spec"]) == []


def test_declared_status_without_formula_still_errors():
    """Injection needs a formula to synthesize from; a 'translated' entry with no
    tableau_formula is genuinely unfixable and must still fail (retry), not be
    silently injected with an empty formula."""
    spec_without_calc = copy.deepcopy(VALID_SPEC)
    spec_without_calc["datasources"][0].pop("calculated_fields")
    no_formula = [{
        "name": "Total Sales",
        "source_language": "dax",
        "original_formula": "SUM(orders[Sales])",
        "status": "translated",
    }]  # no tableau_formula
    llm = FakeLlm([_envelope(spec=spec_without_calc, translation=no_formula), _envelope()])
    _author(llm)
    retry_payload = json.loads(llm.calls[1]["user_content"])
    assert any("tableau_formula" in e or "not declared" in e
               for e in retry_payload["validation_errors"])


def test_needs_review_must_not_be_declared():
    translation = [
        {
            "name": "Total Sales",
            "source_language": "dax",
            "original_formula": "SUM(orders[Sales])",
            "status": "needs_review",
            "reason": "filter context",
        }
    ]
    # spec still declares the calc -> contradiction -> retry
    llm = FakeLlm([_envelope(translation=translation), _envelope()])
    _author(llm)
    retry_payload = json.loads(llm.calls[1]["user_content"])
    assert any("must NOT be declared" in e for e in retry_payload["validation_errors"])


def test_undeclared_brief_calc_reference_gets_actionable_error():
    """A worksheet that references a brief calculation the spec never declared
    (the model marked it needs_review, so it rightly kept it out of
    calculated_fields, yet still put it on a shelf because the brief element
    used it) must be told it is a BRIEF CALC with a remedy — not the generic
    'field does not exist' whose 'available fields' list omits every brief
    calc. Observed on 'cx summary': a legend sheet made only of parameter-driven
    calcs burned all three retries on the generic message."""
    brief = copy.deepcopy(BRIEF)
    brief["datasources"][0]["calculations"].append(
        {
            "name": "Legend - CNX",
            "formula": "IF [p Design Scheme] = 'CNX' THEN 'x' ELSE '' END",
            "language": "tableau_calc",
            "derivation_type": ["case_switch"],
            "flags": ["unresolved_ref:p Design Scheme"],
        }
    )
    bad = copy.deepcopy(VALID_SPEC)
    bad["worksheets"][0]["chart"]["cols"] = [{"field": "Legend - CNX"}]
    translation = copy.deepcopy(VALID_TRANSLATION) + [
        {
            "name": "Legend - CNX",
            "source_language": "tableau_calc",
            "original_formula": "IF [p Design Scheme] = 'CNX' THEN 'x' ELSE '' END",
            "status": "needs_review",
            "reason": "reads parameter p Design Scheme, not in the brief",
        }
    ]
    good_translation = copy.deepcopy(VALID_TRANSLATION) + [translation[-1]]
    llm = FakeLlm([_envelope(spec=bad, translation=translation),
                   _envelope(translation=good_translation)])
    author_rebuild_spec(brief, workbook_name=None, instructions=None, llm=llm, settings=SETTINGS)
    assert len(llm.calls) == 2
    errors = json.loads(llm.calls[1]["user_content"])["validation_errors"]
    hit = [e for e in errors if "Legend - CNX" in e]
    assert hit, errors
    assert "brief calculation" in hit[0]
    assert "needs_review" in hit[0]
    assert "remove it from the worksheet" in hit[0]
    assert "does not exist" not in hit[0]


def test_invalid_status_rejected():
    translation = copy.deepcopy(VALID_TRANSLATION)
    translation[0]["status"] = "perfect"
    llm = FakeLlm([_envelope(translation=translation), _envelope()])
    _author(llm)
    retry_payload = json.loads(llm.calls[1]["user_content"])
    assert any("invalid status" in e for e in retry_payload["validation_errors"])


def test_json_error_retries_then_raises_after_max_attempts():
    err = LlmJsonError("no JSON object found in response", "not json")
    llm = FakeLlm([err, err, err])
    with pytest.raises(RebuildAuthoringError) as exc_info:
        _author(llm)
    assert len(llm.calls) == 3
    assert "parseable JSON" in "\n".join(exc_info.value.errors)


def test_force_brief_datasources_is_deterministic_helper():
    spec = copy.deepcopy(VALID_SPEC)
    spec["datasources"][0]["kind"] = "embedded_csv"
    spec["datasources"][0]["csv"] = {"table_name": "orders"}
    force_brief_datasources(spec, BRIEF)
    ds = spec["datasources"][0]
    assert ds["kind"] == "live_database"
    assert "csv" not in ds
    assert ds["database"] == CONNECTION


def test_rebuild_schema_view_drops_what_rule_2_forbids():
    """The prompt tells the model to emit no connection and an empty field list,
    then handed it 4.2k chars of csv/database/published syntax and a minItems
    that contradicted the instruction. On a 32k local window that is output
    budget the answer never got back."""
    view = rebuild_schema_view()
    ds = view["$defs"]["datasource"]
    assert set(ds["properties"]) == {"id", "name", "kind", "fields",
                                     "calculated_fields", "parameters"}
    assert ds["properties"]["kind"]["enum"] == ["live_database"]
    assert ds["properties"]["fields"]["minItems"] == 0  # rule 2 asks for []
    assert "allOf" not in ds  # required `database` when kind=live_database
    # Serialized into the prompt it must be materially smaller than the full one.
    assert len(json.dumps(view, separators=(",", ":"))) < len(
        json.dumps(load_schema(), indent=2)
    ) / 2


def test_rebuild_schema_view_does_not_touch_the_validating_schema():
    """It is a prompt view, not a second contract: validate_spec keeps using the
    full schema, so a spec WITH a connection still validates."""
    before = copy.deepcopy(load_schema())
    rebuild_schema_view()
    assert load_schema() == before
    assert validate_spec(copy.deepcopy(VALID_SPEC)) == []


def test_prompt_brief_keeps_referenced_fields_and_caps_the_rest():
    """The cnx brief carried 171 columns for a report referencing 47; the other
    124 cost 10,232 chars (~2,900 tokens) of a prompt whose answer then had
    nowhere to go. The model is never asked to echo the field list back."""
    brief = copy.deepcopy(BRIEF)
    ds = brief["datasources"][0]
    ds["fields"] += [
        {"name": f"Unused {i}", "datatype": "string", "role": "dimension"}
        for i in range(120)
    ]
    trimmed = prompt_brief(brief)["datasources"][0]
    names = [f["name"] for f in trimmed["fields"]]
    # Everything an element or calculation names survives, in full.
    assert "Region" in names and "Sales" in names
    # The tail is capped and the model is told what was withheld, so it asks for
    # a listed column instead of inventing one the cross-check will reject.
    assert len(names) == 2 + BRIEF_UNREFERENCED_FIELD_TAIL
    assert "80 further column(s)" in trimmed["fields_note"]
    # The caller's brief is untouched: force_brief_datasources still declares
    # every column on the compiled datasource.
    assert len(brief["datasources"][0]["fields"]) == 122


def test_prompt_brief_leaves_a_brief_that_fits_alone():
    """No trimming when there is nothing to gain — small briefs reach the prompt
    verbatim, which is what every other test in this file assumes."""
    assert prompt_brief(copy.deepcopy(BRIEF)) == BRIEF


def test_retry_guard_counts_the_system_prompt_not_just_the_payload(monkeypatch):
    """The old guard measured the payload against 60k chars, ignoring a 36k-char
    system prompt and every image — so it kept a previous_attempt that pushed run
    ee362cc4 to ~29k tokens of a 32,768 window and the call was refused before it
    was sent. A payload well under 60k chars must still drop the prior attempt
    when the WHOLE prompt no longer leaves room for an answer."""
    monkeypatch.setenv("TABLEAUFORGE_PROVIDER", "ollama")
    bloated = copy.deepcopy(VALID_SPEC)
    bloated["workbook"]["name"] = "x" * 50_000  # ~14k tokens, payload < 60k chars
    envelope = {"spec": bloated, "translation": VALID_TRANSLATION}
    llm = FakeLlm([envelope, _envelope()])
    _author(llm)

    retry_payload = json.loads(llm.calls[1]["user_content"])
    assert "previous_attempt" not in retry_payload
    assert any("previous attempt omitted" in e for e in retry_payload["validation_errors"])


def test_retry_keeps_the_previous_attempt_when_it_fits(monkeypatch):
    """The prior attempt is the most useful thing in a retry prompt — drop it
    only under real budget pressure, never as a blanket rule."""
    monkeypatch.setenv("TABLEAUFORGE_PROVIDER", "ollama")
    broken = copy.deepcopy(VALID_SPEC)
    # A stray key would now be pruned rather than retried; a field that matches
    # nothing is still the model's to fix.
    broken["worksheets"][0]["chart"]["cols"] = [{"field": "no_such_field"}]
    llm = FakeLlm([{"spec": broken, "translation": VALID_TRANSLATION}, _envelope()])
    _author(llm)

    retry_payload = json.loads(llm.calls[1]["user_content"])
    assert retry_payload["previous_attempt"]["spec"]["worksheets"][0]["chart"]["cols"] == [
        {"field": "no_such_field"}
    ]


def test_shelf_caps_match_the_schema():
    """trim_overfull_shelves reads the cap from the schema; if rows and cols ever
    disagree, or a third shelf gains a cap, this catches it."""
    props = load_schema()["$defs"]["chart"]["properties"]
    assert props["rows"]["maxItems"] == props["cols"]["maxItems"]


def test_overfull_shelves_are_trimmed_and_reported():
    """A wide source element draws 7-14 refs onto one shelf. The schema caps it
    at 6, and the model reproduced the same violation on all 3 attempts of the
    cnx rebuild — losing 27 good worksheets to a shelf the prompt already said
    to keep at 1-3 fields. Trim it, and say so in the build warnings."""
    spec = copy.deepcopy(VALID_SPEC)
    chart = spec["worksheets"][0]["chart"]
    chart["cols"] = [{"field": f"F{i}", "aggregation": "none"} for i in range(9)]

    warnings = trim_overfull_shelves(spec)

    assert len(chart["cols"]) == 6
    assert [r["field"] for r in chart["cols"]] == [f"F{i}" for i in range(6)]
    assert len(warnings) == 1
    assert "put 9 fields on 'cols'" in warnings[0]
    assert "F6, F7, F8" in warnings[0]  # the user is told what was dropped
    assert validate_spec(spec) == []


def test_shelves_within_the_cap_are_untouched():
    spec = copy.deepcopy(VALID_SPEC)
    before = copy.deepcopy(spec)
    assert trim_overfull_shelves(spec) == []
    assert spec == before


def test_trimmed_shelves_reach_the_caller_as_build_warnings():
    """The repair must surface on the same channel the layout-fidelity notes use,
    or the rebuilt report silently differs from the source."""
    envelope = _envelope()
    envelope["spec"]["worksheets"][0]["chart"]["cols"] = [
        {"field": "Region", "aggregation": "none"} for _ in range(8)
    ]
    result = _author(FakeLlm([envelope]))
    assert any("put 8 fields on 'cols'" in w for w in result["warnings"])


# ---- repairs that used to cost a retry (or the whole run) ---------------------


def test_near_miss_field_names_are_renamed_not_retried():
    """A model writing 'region' or 'Total  sales' for a real field burns a retry on a
    repair the resolver already knows how to make. Rename before the cross-check."""
    near = copy.deepcopy(VALID_SPEC)
    near["worksheets"][0]["chart"]["cols"] = [{"field": "region"}]
    near["worksheets"][0]["chart"]["color"] = {"field": "total  sales", "aggregation": "sum"}
    near["worksheets"][0]["filters"] = [{"field": "REGION", "filter_type": "categorical"}]
    llm = FakeLlm([_envelope(spec=near)])
    result = _author(llm)
    assert len(llm.calls) == 1
    chart = result["spec"]["worksheets"][0]["chart"]
    assert chart["cols"] == [{"field": "Region"}]
    assert chart["color"]["field"] == "Total Sales"
    assert result["spec"]["worksheets"][0]["filters"][0]["field"] == "Region"
    assert any(r["action"] == "renamed" for r in result["field_resolutions"])


def test_a_field_that_matches_nothing_is_still_fed_back():
    """Rename is a repair; inventing a field is not. An unmatched shelf reference still
    costs a retry with the error fed back, exactly as before."""
    bad = copy.deepcopy(VALID_SPEC)
    bad["worksheets"][0]["chart"]["cols"] = [{"field": "Nonexistent"}]
    llm = FakeLlm([_envelope(spec=bad), _envelope()])
    _author(llm)
    assert len(llm.calls) == 2


def test_enum_casing_is_normalized_not_retried():
    cased = copy.deepcopy(VALID_SPEC)
    cased["worksheets"][0]["chart"]["type"] = "Bar"
    cased["worksheets"][0]["chart"]["rows"][0]["aggregation"] = "SUM"
    cased["datasources"][0]["fields"][0]["role"] = "Dimension"
    cased["datasources"][0]["kind"] = "Live_Database"
    cased["dashboards"][0]["zones"][0]["kind"] = "Worksheet"
    llm = FakeLlm([_envelope(spec=cased)])
    result = _author(llm)
    assert len(llm.calls) == 1
    spec = result["spec"]
    assert spec["worksheets"][0]["chart"]["type"] == "bar"
    assert spec["worksheets"][0]["chart"]["rows"][0]["aggregation"] == "sum"
    assert spec["dashboards"][0]["zones"][0]["kind"] == "worksheet"


def test_shelf_aliases_and_stray_chart_keys_are_repaired_and_reported():
    """`columns` for `cols`, `x`/`y` for the axes, and a key the schema does not know:
    each used to be an additionalProperties error and a retry."""
    aliased = copy.deepcopy(VALID_SPEC)
    chart = aliased["worksheets"][0]["chart"]
    chart["columns"] = chart.pop("cols")
    chart["y"] = chart.pop("rows")
    chart["legend"] = True
    aliased["worksheets"][0]["description"] = "a stray key"
    llm = FakeLlm([_envelope(spec=aliased)])
    result = _author(llm)
    assert len(llm.calls) == 1
    repaired = result["spec"]["worksheets"][0]["chart"]
    assert repaired["cols"] == [{"field": "Region"}]
    assert repaired["rows"] == [{"field": "Sales", "aggregation": "sum"}]
    assert "legend" not in repaired and "columns" not in repaired and "y" not in repaired
    assert "description" not in result["spec"]["worksheets"][0]
    assert any("legend" in w for w in result["warnings"])


def test_duplicate_worksheet_titles_are_disambiguated_before_the_compiler_sees_them():
    """Titles are not schema-checked, so two 'Sales' worksheets passed every authoring
    gate and died in the compiler with every retry already spent."""
    dup = copy.deepcopy(VALID_SPEC)
    second = copy.deepcopy(dup["worksheets"][0])
    second["id"] = "sales_by_region_2"
    dup["worksheets"].append(second)
    dup["dashboards"][0]["zones"].append(
        {"kind": "worksheet", "worksheet": "sales_by_region_2", "x": 0, "y": 50, "w": 100, "h": 50}
    )
    dup["dashboards"][0]["zones"][0]["h"] = 50
    llm = FakeLlm([_envelope(spec=dup)])
    result = _author(llm)
    titles = [ws["title"] for ws in result["spec"]["worksheets"]]
    assert titles == ["Sales by Region", "Sales by Region (2)"]
    from tableauforge.compiler.lakeview import compile_lakeview_parts
    from tableauforge.spec.models import DashboardSpec

    compile_lakeview_parts(DashboardSpec.model_validate(result["spec"]))


def test_a_truncated_answer_tells_the_model_to_be_more_compact():
    """A response cut off at max_tokens is retried with a message that names the
    cause, not a generic 'not valid JSON'."""
    llm = FakeLlm([
        LlmJsonError(
            "the answer was cut off at the max_tokens limit (32000 tokens) before the JSON "
            "completed; return a more compact object",
            '{"spec": {"work',
        ),
        _envelope(),
    ])
    _author(llm)
    assert len(llm.calls) == 2
    retry_payload = json.loads(llm.calls[1]["user_content"])
    assert any("cut off" in e and "compact" in e for e in retry_payload["validation_errors"])


def test_a_text_zone_with_cased_kind_keeps_its_caption():
    """repair_zones keys on `kind == "text"`; with enum repair running after it, a zone
    written as {"kind": "Text", "content": ...} lost its caption and became blank."""
    cased = copy.deepcopy(VALID_SPEC)
    cased["dashboards"][0]["zones"][0]["h"] = 80
    cased["dashboards"][0]["zones"].append(
        {"kind": "Text", "content": "Q3 summary", "x": 0, "y": 80, "w": 100, "h": 20}
    )
    llm = FakeLlm([_envelope(spec=cased)])
    result = _author(llm)
    assert len(llm.calls) == 1
    zone = result["spec"]["dashboards"][0]["zones"][1]
    assert zone["kind"] == "text"
    assert zone["text"] == "Q3 summary"
