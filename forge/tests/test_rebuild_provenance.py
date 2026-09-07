"""Task B4: provenance-aware zone confidence + layout fidelity check.

Brief elements may carry an observed ``layout`` block (captured from the
original .twb geometry, or read off a rendered screenshot) alongside the
existing invented-layout path. Zones that reproduce an observed layout keep
observed-grade confidence instead of being clamped to the AI-proposed
ceiling; the fidelity check (report-only, never a retry trigger) flags
observed worksheets the authored dashboard dropped or drifted far from."""

from __future__ import annotations

from tableauforge.llm.rebuild_author import (
    MAX_OBSERVED_ZONE_CONFIDENCE,
    MAX_REBUILD_ZONE_CONFIDENCE,
    MAX_SCREENSHOT_ZONE_CONFIDENCE,
    _clamp_zone_confidence,
    _layout_fidelity_check,
)


def make_spec():
    return {
        "worksheets": [{"id": "ws_sales", "title": "Sales by Region",
                        "datasource": "ds1", "chart": {"type": "bar"}}],
        "dashboards": [{
            "id": "dash_main", "title": "Regional Overview",
            "zones": [
                {"kind": "worksheet", "worksheet": "ws_sales",
                 "x": 0, "y": 0, "w": 100, "h": 50, "confidence": 0.99},
                {"kind": "text", "text": "notes", "x": 0, "y": 50, "w": 40, "h": 50,
                 "confidence": 0.99},
            ],
        }],
    }


def make_brief(layout_source="twb"):
    return {"report": {"elements": [{
        "name": "sample-visual / Regional Overview", "kind": "dashboard", "fields": [],
        "layout": {"observed": True, "source": layout_source,
                   "zones": [{"worksheet": "Sales by Region", "kind": "worksheet",
                              "x": 0, "y": 0, "w": 100, "h": 50}]},
    }]}, "datasources": []}


def test_observed_zone_keeps_high_confidence():
    spec = make_spec()
    _clamp_zone_confidence(spec, make_brief(), has_images=False)
    zones = spec["dashboards"][0]["zones"]
    assert zones[0]["confidence"] == MAX_OBSERVED_ZONE_CONFIDENCE   # matched observed zone
    assert zones[1]["confidence"] == MAX_REBUILD_ZONE_CONFIDENCE    # unmatched → invented


def test_screenshot_analysis_layout_caps_at_point_eight():
    spec = make_spec()
    _clamp_zone_confidence(spec, make_brief("screenshot_analysis"), has_images=True)
    assert spec["dashboards"][0]["zones"][0]["confidence"] == MAX_SCREENSHOT_ZONE_CONFIDENCE


def test_no_layout_keeps_legacy_clamp():
    spec = make_spec()
    _clamp_zone_confidence(spec, {"report": {"elements": []}}, has_images=False)
    for z in spec["dashboards"][0]["zones"]:
        assert z["confidence"] == MAX_REBUILD_ZONE_CONFIDENCE


def test_geometry_outside_tolerance_is_not_observed():
    spec = make_spec()
    spec["dashboards"][0]["zones"][0].update({"x": 40, "y": 40})  # far from observed 0,0
    _clamp_zone_confidence(spec, make_brief(), has_images=False)
    assert spec["dashboards"][0]["zones"][0]["confidence"] == MAX_REBUILD_ZONE_CONFIDENCE


def test_fidelity_check_reports_missing_and_drifted_worksheets():
    spec = make_spec()
    brief = make_brief()
    brief["report"]["elements"][0]["layout"]["zones"].append(
        {"worksheet": "Sales Trend", "kind": "worksheet", "x": 0, "y": 50, "w": 60, "h": 50})
    warnings = _layout_fidelity_check(spec, brief)
    assert any("Sales Trend" in w and "missing" in w for w in warnings)

    spec["dashboards"][0]["zones"][0].update({"x": 30})
    warnings = _layout_fidelity_check(spec, brief)
    assert any("Sales by Region" in w and "deviates" in w for w in warnings)
