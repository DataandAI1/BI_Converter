# Lakeview golden corpus (Task 0 — ground truth harness)

`.lvdash.json` is officially undocumented. Every file in this directory is a **real
`.lvdash.json` export authored by Databricks**, fetched verbatim from Databricks' own
public GitHub repositories — never hand-written. This is the evidence base for
`server/src/migration/bi/lakeview-format.ts`'s `LAKEVIEW_WIDGET_TYPES` table and for the
reader round-trip tests in `server/test/unit/`.

No Databricks workspace was available when this corpus was built (2026-08-10). Per the
task-0 brief's controller resolution, the corpus was sourced from GitHub instead of a
live workspace export.

## Sanitization

Per the brief: keep structure verbatim; truncate/replace long SQL **only** if the
original fetched file was >100KB. Two files crossed that threshold — their
`datasets[].query` / `datasets[].queryLines` values longer than 200 characters were
replaced with `<first 150 chars> -- [TRUNCATED for fixture size — see this README]`.
No other content (widgets, specs, encodings, positions, pages, text) was touched in any
file. All five files are pretty-printed (2-space indent) for reviewability; the raw
GitHub sources are minified — this is a formatting-only change, not a structural one.

## Provenance

| File | Source URL | Fetched | Widget types present | Sanitized |
|---|---|---|---|---|
| `jobs-system-tables.lvdash.json` | `https://raw.githubusercontent.com/databricks/tmm/main/System-Tables-Demo/Jobs-PrPr/Jobs%20System%20Tables%20Dashboard.lvdash.json` | 2026-08-10 | `table`(v1), `counter`(v2), `bar`(v3), `combo`(v1), `pie`(v3), `filter-date-range-picker`(v2), `filter-single-select`(v2), text (`textbox_spec` shape) | yes — long dataset SQL truncated (orig. 194,837 bytes) |
| `nyc-taxi-trip-analysis.lvdash.json` | `https://raw.githubusercontent.com/databricks/bundle-examples/main/knowledge_base/dashboard_nyc_taxi/src/nyc_taxi_trip_analysis.lvdash.json` | 2026-08-10 | `table`(v1), `bar`(v3), `counter`(v2), `scatter`(v3), `filter-date-range-picker`(v2), `filter-multi-select`(v2), text (`textbox_spec` shape) | no (24,032 bytes) |
| `dbsql-cost-dashboard.lvdash.json` | `https://raw.githubusercontent.com/databrickslabs/sandbox/main/dbsql/cost_per_query/PrPr/DBSQL%20Cost%20Dashboard%20(PrPr).lvdash.json` | 2026-08-10 | `table`(v1), `bar`(v3), `counter`(v2), `filter-date-range-picker`(v2), `filter-multi-select`(v2), `filter-single-select`(v2), text (`textbox_spec` shape) | no (51,143 bytes) |
| `serverless-migration-assistance.lvdash.json` | `https://raw.githubusercontent.com/databrickslabs/sandbox/main/dbsql/serverless_migration_dash/Serverless%20Migration%20Assistance%20Dashboard.lvdash.json` | 2026-08-10 | `line`(v3), `filter-date-picker`(v2), `filter-multi-select`(v2), `filter-single-select`(v2), text (`textbox_spec` shape) | no (15,872 bytes) |
| `account-usage-v2.lvdash.json` | `https://raw.githubusercontent.com/databrickslabs/sandbox/main/cost-observability/Account%20Usage%20Dashboard%20v2.lvdash.json` | 2026-08-10 | `table`(v1), `bar`(v3), `counter`(v2), `area`(v3), `heatmap`(v3), `pivot`(v3), `range-slider`(v2), `filter-date-range-picker`(v2), `filter-multi-select`(v2), `filter-single-select`(v2), text (`multilineTextboxSpec` shape) | yes — long dataset SQL truncated (orig. 492,272 bytes) |

## Repo-tree search for wider coverage

Per the brief's step 1, the three named repos (`databricks/tmm`, `databricks/bundle-examples`,
`databrickslabs/sandbox`) were searched in full via the GitHub trees API
(`.../git/trees/main?recursive=1`) for every `.lvdash.json` path, not just the three named
seed URLs. That search turned up 13 candidate dashboard paths beyond the three seeds (plus one
duplicate-looking path of the `dbsql_cost` seed itself, under a differently-punctuated
directory name — not fetched separately). Nine of the 13 were fetched and inspected for their
`(widgetType, spec.version)` pairs: `databricks-assistant-metrics.lvdash.json`, `Genie Usage
Dashboard.lvdash.json`, `LakeFlow System Tables Dashboard v0.1.lvdash.json`, `CDC Connector
Monitoring Dashboard Template.lvdash.json`, `SDP Monitoring Dashboard Template.lvdash.json`,
`DBR Monitor Dashboard.lvdash.json`, `Databricks Runtime Deprecation Impact
Dashboard.lvdash.json`, `Account Usage Dashboard v2.lvdash.json`, `Serverless Migration
Assistance Dashboard.lvdash.json` — 12 files fetched in total across this task (3 seeds + 9),
of which the 5 above were committed. The remaining 4 candidates — `[AWS_GCP] Jobs System
Tables Dashboard.lvdash.json`, `[Azure] Jobs System Tables Dashboard.lvdash.json`, and an
`aws-`/`azure-` regional pair of `serverless-jobs-and-notebooks-cost-observability.lvdash.json`
(all four in `databricks/tmm`) — were not fetched: the two Jobs variants are AWS/Azure regional
copies of the seed `Jobs System Tables Dashboard.lvdash.json` already fetched, and the
serverless-cost pair are AWS/Azure regional copies of each other, so unlikely to add a new
widget type beyond what's already in the corpus. None of the 12 fetched files —
committed or not — contained: `box`, `bubble`, `choropleth-map`, `cohort`, `custom`, `funnel`,
`gantt`, `histogram`, `point-map`, `sankey`, `waterfall`, `image`, or a text-entry filter
widget. Those types remain `verified: false` in `LAKEVIEW_WIDGET_TYPES` — see that file's
comments.

## Findings for later phases

See `server/src/migration/bi/lakeview-format.ts`'s file header and
`.superpowers/sdd/2026-08-10-databricks-aibi-rebuild-plan/task-0-report.md` for the full
write-up. Summary:

- **`query` vs `queryLines`**: dataset SQL appears under `datasets[].query` (a plain string,
  older/simpler dashboards) **or** `datasets[].queryLines` (an array of strings to be
  joined, seen on every dashboard with parameterized/complex SQL — e.g. `account-usage-v2`
  uses `queryLines` exclusively for all 27 of its datasets). The current reader
  (`parseSerializedDashboard`) only reads `.query` — a dataset with `.queryLines` and no
  `.query` parses with `query: null`, silently losing that dataset's SQL. This is real,
  common, and unhandled — flagged for whichever phase next touches the reader/mapper, not
  fixed here (out of this task's scope).
- **8-char hex `name`**: dataset and widget `name` values are Databricks-generated
  identifiers — 8 lowercase hex characters (e.g. `"7801704c"`) — in every file except
  `genie_usage.json` (not committed), which uses human-readable dataset names like
  `"genie_agents_daily"`. Treat the hex convention as the common case, not a hard rule.
- **`pageType: "PAGE_TYPE_CANVAS"`**: present on the primary content page in most files, but
  **absent entirely** on `nyc-taxi-trip-analysis.lvdash.json`'s only page — it is not a
  universal requirement. When a global-filters page exists (e.g. `account-usage-v2.lvdash.json`),
  it carries `pageType: "PAGE_TYPE_GLOBAL_FILTERS"` instead.
- **`uiSettings.genieSpace`**: not present in any of the 12 files fetched during this task
  (5 committed + 7 surveyed-only). Its shape is **unverified** — no fixture evidence either way.
- **encoding channel names per widget type**: captured in `LAKEVIEW_WIDGET_TYPES[...].encodings`,
  derived only from the five committed fixtures.
- **`text` widgets have no `spec` wrapper at all** — two incompatible shapes observed:
  `textbox_spec` (a plain markdown string, older/simpler dashboards) and
  `multilineTextboxSpec: { lines: string[] }` (seen only in `account-usage-v2.lvdash.json`,
  its most recently-authored dashboard in this corpus). Neither has `widgetType` or
  `version` — `LAKEVIEW_WIDGET_TYPES.text` uses `specVersion: 0` as an explicit sentinel,
  not a captured value.
- **`range-slider` filter has no `filter-` prefix**, unlike its four siblings
  (`filter-date-picker`, `filter-date-range-picker`, `filter-multi-select`,
  `filter-single-select`) — a naming inconsistency worth flagging to whoever writes the
  emitter side, since it's easy to assume all filter widgetType strings share the prefix.
