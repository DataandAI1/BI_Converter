"""Shared fixtures for the forge test suite.

LAKEVIEW_CANONICAL_SPEC is the one canonical spec BI_Converter needs: two live Unity
Catalog tables, a row-level SQL calculated column, an aggregate SQL measure, a bar +
KPI counter dashboard and a standalone worksheet. tests/golden/rebuild_live.lvdash.json
pins its compiled bytes. The upstream CSV and Power BI fixtures went with their targets
(spec §3.2). Fixtures hand out deep copies so tests can mutate freely.
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path
from typing import Any

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from tableauforge.spec.models import DashboardSpec  # noqa: E402

GOLDEN_DIR = Path(__file__).resolve().parent / "golden"

# Canonical Databricks AI/BI target spec (plan 2026-08-10 Phase 5): two live
# Unity Catalog tables, a row-level SQL calculated column, an aggregate SQL
# measure, a bar + KPI counter dashboard and a standalone worksheet — the golden
# .lvdash.json (tests/golden/rebuild_live.lvdash.json) pins its compiled bytes,
# and the server's build-lvdash-reingest integration test re-ingests it.
LAKEVIEW_CANONICAL_SPEC: dict[str, Any] = {
    "spec_version": "1.0",
    "workbook": {"name": "Rebuild Live"},
    "datasources": [
        {
            "id": "orders_ds",
            "name": "orders",
            "kind": "live_database",
            "database": {
                "dialect": "databricks",
                "host": "adb.example.net",
                "http_path": "/sql/1.0/warehouses/abc123",
                "database": "main",
                "db_schema": "analytics",
                "table": "orders",
            },
            "fields": [
                {"name": "Order Date", "datatype": "date", "role": "dimension"},
                {"name": "Region", "datatype": "string", "role": "dimension"},
                {"name": "Sales", "datatype": "real", "role": "measure", "default_aggregation": "sum"},
                {"name": "Quantity", "datatype": "integer", "role": "measure", "default_aggregation": "sum"},
            ],
            "calculated_fields": [
                {
                    "name": "Region Label",
                    "formula": "UPPER(`Region`)",
                    "datatype": "string",
                    "role": "dimension",
                    "formula_language": "sql",
                },
                {
                    "name": "Total Sales",
                    "formula": "SUM(`Sales`)",
                    "datatype": "real",
                    "role": "measure",
                    "formula_language": "sql",
                },
            ],
        },
        {
            "id": "events_ds",
            "name": "events",
            "kind": "live_database",
            "database": {
                "dialect": "databricks",
                "host": "adb.example.net",
                "http_path": "/sql/1.0/warehouses/abc123",
                "database": "main",
                "db_schema": "analytics",
                "table": "events",
            },
            "fields": [
                {"name": "Channel", "datatype": "string", "role": "dimension"},
                {"name": "Events", "datatype": "integer", "role": "measure", "default_aggregation": "sum"},
            ],
        },
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
        },
        {
            "id": "total_sales_kpi",
            "title": "Total Sales",
            "datasource": "orders_ds",
            "chart": {
                "type": "counter",
                "rows": [],
                "cols": [],
                "label": {"field": "Total Sales"},
            },
        },
        {
            "id": "events_by_channel",
            "title": "Events by Channel",
            "datasource": "events_ds",
            "chart": {
                "type": "bar",
                "rows": [{"field": "Channel"}],
                "cols": [{"field": "Events", "aggregation": "sum"}],
            },
        },
    ],
    "dashboards": [
        {
            "id": "main",
            "title": "Revenue Overview",
            "size": {"width": 1200, "height": 800},
            "zones": [
                {"kind": "text", "text": "Revenue Overview", "x": 0, "y": 0, "w": 100, "h": 8},
                {"kind": "worksheet", "worksheet": "total_sales_kpi", "x": 0, "y": 8, "w": 30, "h": 22},
                {"kind": "worksheet", "worksheet": "sales_by_region", "x": 0, "y": 30, "w": 100, "h": 70},
                {"kind": "blank", "x": 30, "y": 8, "w": 70, "h": 22},
            ],
        }
    ],
}


@pytest.fixture
def lakeview_spec_dict() -> dict[str, Any]:
    """Fresh deep copy of the canonical Databricks AI/BI spec; mutate at will."""
    return copy.deepcopy(LAKEVIEW_CANONICAL_SPEC)


@pytest.fixture
def lakeview_spec() -> DashboardSpec:
    return DashboardSpec.model_validate(copy.deepcopy(LAKEVIEW_CANONICAL_SPEC))

# A minimal valid spec for the target-neutral schema/model tests: one live Unity Catalog
# datasource, one bar worksheet, one dashboard. Upstream this fixture was a CSV-backed
# spec; the shape the schema tests exercise is the same, but a spec BI_Converter could
# actually emit keeps the fixtures honest about what the product produces.
CANONICAL_SPEC: dict[str, Any] = {
    "spec_version": "1.0",
    "workbook": {"name": "Sales Analysis"},
    "datasources": [
        {
            "id": "sales_ds",
            "name": "sales",
            "kind": "live_database",
            "database": {
                "dialect": "databricks",
                "host": "adb.example.net",
                "http_path": "/sql/1.0/warehouses/abc123",
                "database": "main",
                "db_schema": "analytics",
                "table": "sales",
            },
            "fields": [
                {"name": "Order Date", "datatype": "date", "role": "dimension"},
                {"name": "Region", "datatype": "string", "role": "dimension"},
                {"name": "Category", "datatype": "string", "role": "dimension"},
                {"name": "Sales", "datatype": "real", "role": "measure", "default_aggregation": "sum"},
                {"name": "Profit", "datatype": "real", "role": "measure", "default_aggregation": "sum"},
                {"name": "Quantity", "datatype": "integer", "role": "measure", "default_aggregation": "sum"},
            ],
        }
    ],
    "worksheets": [
        {
            "id": "sales_by_region",
            "title": "Sales by Region",
            "datasource": "sales_ds",
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
            "title": "Sales Dashboard",
            "size": {"width": 1200, "height": 800},
            "zones": [
                {"kind": "worksheet", "worksheet": "sales_by_region", "x": 0, "y": 0, "w": 100, "h": 100}
            ],
        }
    ],
}


@pytest.fixture
def canonical_spec_dict() -> dict[str, Any]:
    """Fresh deep copy of the minimal canonical spec; mutate at will."""
    return copy.deepcopy(CANONICAL_SPEC)


@pytest.fixture
def canonical_spec() -> DashboardSpec:
    return DashboardSpec.model_validate(copy.deepcopy(CANONICAL_SPEC))
