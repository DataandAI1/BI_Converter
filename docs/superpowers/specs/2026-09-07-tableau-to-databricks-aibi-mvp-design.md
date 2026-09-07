# BI_Converter — Tableau → Databricks AI/BI MVP

*Design spec · 2026-09-07 · Status: approved, pending implementation plan*

## 1. Purpose

BI_Converter does one job: convert a Tableau workbook or published datasource into a
Databricks AI/BI (Lakeview) dashboard, together with the Unity Catalog semantic layer the
dashboard reads from and an honest checklist of everything a human still has to decide.

It is a deliberately narrow extraction from [Linetria](../../../../Linetria), which is a
data-estate lineage and migration platform. Linetria's Tableau→Databricks converter is
mature and well isolated; nearly all of its supporting machinery — catalog, lineage graph,
review queue, migration planning, four database connectors, Power BI, script packs — is
irrelevant to this one job. This project keeps the converter and drops the platform.

### Success criteria

1. `bi-converter convert ./sales.twbx --out ./pack` produces a `.lvdash.json` per Tableau
   dashboard, UC view SQL and metric-view YAML per datasource, and a review checklist —
   with no database, no credentials, and no network access.
2. The same conversion runs against a live Tableau Server/Cloud site.
3. `bi-converter deploy ./pack --host … --warehouse-id …` creates and publishes the
   dashboards in a Databricks workspace.
4. Emitted `.lvdash.json` re-parses cleanly and uses only `(widgetType, spec.version)`
   pairs pinned in the format table.
5. Nothing is fabricated: an unresolvable table, calc, or layout becomes a `needs_review`
   checklist line, never a guess.

## 2. Background: what already exists

Linetria's converter is ~11,400 lines of TypeScript plus ~7,000 lines of Python, arranged
in two lanes that share an input:

- **Deterministic lane (TypeScript).** `emitTableauGroupAsLakeview()` walks catalog rows
  and emits `.lvdash.json` directly by rule.
- **LLM-authored lane (Python, "forge").** A rebuild brief goes to an LLM under an 18.6 KB
  authoring prompt; the LLM returns a `DashboardSpec` conforming to
  `dashboard_spec_v1.schema.json`; a compiler turns that spec into `.lvdash.json`. A
  retry loop feeds validator errors back to the model.

Two facts about that codebase shaped this design and should not be re-litigated:

- **TypeScript owns the Lakeview format.** `migration/bi/lakeview-format.ts` is the
  authoritative pinned table of `(widgetType, spec.version, encodings)`, derived from a
  golden corpus of five dashboards Databricks itself publishes. `.lvdash.json` is
  officially undocumented; this table and its corpus are the project's most valuable
  asset. Python reads a hand-maintained JSON mirror, kept honest by a lockstep test.
- **The sqlglot parser *service* is not needed.** Tableau calculation derivations are
  produced by `tokenizeCalc()` in `connectors/tableau/calc.ts`, called from `mapper.ts` —
  not by the parser. Nothing in the conversion path touches Linetria's standalone `parser/`
  FastAPI service. Note the distinction: sqlglot the *library* remains a forge dependency,
  because `validate/lakeview.py` uses it to validate emitted dataset SQL.

The method itself is documented in Linetria's
[`docs/specs/2026-08-10-databricks-aibi-rebuild-research.md`](../../../../Linetria/docs/specs/2026-08-10-databricks-aibi-rebuild-research.md),
which remains the reference for *why* conversion is a rebuild-on-a-semantic-layer problem
rather than a file-format translation problem. That document is background for this spec,
not a requirement of it.

## 3. Scope

### 3.1 In scope

| Capability | Origin |
|---|---|
| Tableau file parse — `.twb` `.twbx` `.tds` `.tdsx` | `connectors/tableau/files.ts` |
| Tableau live extraction — Metadata API (GraphQL) + REST sign-in | `connectors/tableau/{queries,live,index}.ts` |
| Doc → asset/edge mapping, visual/layout/parameter capture | `connectors/tableau/{mapper,model,visuals}.ts` |
| Tableau calculation tokenizer and classification | `connectors/tableau/calc.ts` |
| Lakeview format table + golden corpus | `migration/bi/lakeview-format.ts` |
| `.lvdash.json` emission primitives | `migration/bi/lakeview-emit.ts` |
| Deterministic Tableau→Lakeview emitter, caps, page splitting | `migration/bi/rebuild-databricks.ts` |
| Review checklist rendering | `migration/bi/rebuild-databricks-checklist.ts` |
| Tableau calc → Databricks SQL; custom SQL translation; shelf/mark mapping | `migration/bi/{calc-translator,tableau-sql,tableau-shelf}.ts` |
| UC semantic layer — view SQL, metric-view YAML, extract-rescue script | `migration/bi/semantic-layer.ts`, `migration/dialects.ts` |
| Deploy script + Asset Bundle scaffold | `migration/bi/databricks-deploy.ts` |
| Rebuild brief assembly | `build/brief.ts` (`buildBrief`, the pure half) |
| Forge HTTP client, artifact pack | `build/{forge-client,pack}.ts` |
| Run queue semantics — single-flight, drain, cancel, reconcile | `build/runner.ts` (logic only; rewritten against SQLite, §7) |
| LLM authoring: prompt, spec IR, gates, compiler, validators | `forge/tableauforge/` |

### 3.2 Out of scope

Dropped from Linetria and **not** carried over:

- Postgres catalog, migrations, run-tagged staging, canonical promotion
- Evidence graph, edge assembly, review queue, lineage traversal
- Migration planning, waves, impact analysis, complexity scoring
- Findings, drift detection, orphan/dead-asset detection, exports
- Script packs and offline pack round-trips
- Envelope encryption of connection secrets, API token gate
- The sqlglot parser service (`parser/`)
- PostgreSQL, Snowflake, Azure SQL/Synapse, MSSQL connectors
- The Power BI connector, and the Power BI and Tableau *rebuild targets*
- Descriptor stitching and shadow-source discovery
- The entire forge **designer** flow: `generator.py`, CSV/DB profilers, templates,
  preview data, `tableau_mcp/`, wireframe analyst, design reviewer, artifact polisher,
  spec author, field builder, refiner, and the `pbit` / `twb` / `twbx` / `hyper` compilers

Also out of scope as product behaviour:

- Power BI as a source or a target
- Warehouse or ETL pipeline migration
- Pixel-perfect fidelity. LOD `FIXED`, table calculations, data blends, sets/groups/bins,
  and parameter-driven filters route to the checklist as `needs_review`.

## 4. Architecture

Two processes. A Node/TypeScript shell owns extraction, conversion, storage, deployment,
and both user interfaces. A slimmed Python service ("forge") owns LLM authoring and spec
compilation only.

```
bi-converter/
├── package.json               npm workspaces: server, web
├── server/                    Node 20 · TypeScript · Fastify
│   ├── src/
│   │   ├── cli.ts             convert · deploy · serve
│   │   ├── api/               upload, runs, artifacts, deploy
│   │   ├── store/             SQLite (better-sqlite3)
│   │   ├── tableau/           ← connectors/tableau/*
│   │   ├── ingest/            NEW — StagingBatch[] → BiAssetRow[]/BiEdgeRow[]
│   │   ├── bind/              NEW — Tableau reference → Unity Catalog name
│   │   ├── brief/             ← build/brief.ts (pure half) + build/visuals.ts
│   │   ├── lakeview/          ← lakeview-{emit,format}.ts
│   │   ├── convert/           ← rebuild-databricks*, tableau-{sql,shelf},
│   │   │                        calc-translator, semantic-layer, shared, dialects
│   │   ├── forge/             ← forge-client.ts + runner (rewritten, §7)
│   │   └── deploy/            ← databricks-deploy.ts + NEW Lakeview REST client
│   └── test/
│       └── fixtures/
│           ├── lakeview/      golden corpus — 5 Databricks-published dashboards
│           └── tableau/       workbook + Metadata API fixtures
├── forge/                     Python 3.12 · FastAPI
│   ├── tableauforge/
│   │   ├── api/               main.py (slimmed), rebuild_routes.py, store.py
│   │   ├── llm/               client.py, rebuild_author.py, usage.py
│   │   ├── spec/              models.py, schema.py, field_resolution.py,
│   │   │                      dashboard_spec_v1.schema.json,
│   │   │                      lakeview_{widget,parameter}_types.json
│   │   ├── compiler/lakeview.py
│   │   ├── validate/          lakeview.py, lint.py, pipeline.py
│   │   └── config.py          providers: claude · ollama
│   ├── prompts/rebuild_author_databricks.md
│   └── tests/
└── web/                       React + Vite — 3 screens
```

### 4.1 New code budget

Everything not listed here is a move-and-trim from Linetria.

| Component | Est. lines | Section |
|---|---|---|
| `ingest/adapter.ts` | ~150 | §5 |
| `bind/resolve.ts` | ~200 | §6 |
| `store/` (SQLite) | ~250 | §7 |
| `forge/runner.ts` rewrite | ~350 | §7 |
| `deploy/` Lakeview REST client | ~200 | §8.3 |
| `cli.ts` | ~300 | §8.1 |
| `web/` | ~600 | §8.2 |
| **Total** | **~2,050** | |

### 4.2 Why two processes

This was an explicit decision against a TypeScript-only port. Keeping the forge in Python
reuses ~7,000 lines of mature LLM-lane code — the authoring gates, the spec compiler, and
the four-layer validator — instead of rewriting ~2,900 lines of it in TypeScript. The cost
is a second runtime, a `uv` bootstrap, two test suites, and the cross-language mirror test
that keeps `lakeview_widget_types.json` in step with `lakeview-format.ts`. That cost is
accepted.

### 4.3 Forge API surface

The forge shrinks from 24 routes to 7:

| Route | Purpose |
|---|---|
| `GET /healthz` | liveness; the shell answers 502 with a start hint when down |
| `GET /settings`, `POST /settings/{provider,model,api-key}` | provider config |
| `POST /draft-rebuild-spec` | brief (+ optional screenshots) → `{spec, translation, warnings}` |
| `POST /generate-rebuild` | spec → compiled `.lvdash.json` artifact |
| `POST /validate` | validate a spec or emitted artifact |
| `GET /artifacts/{id}`, `GET /download/{id}` | artifact retrieval |

The forge stays **stateless with respect to conversion**: the shell round-trips the brief,
spec, and translation report. Only artifacts are held, in the existing `ArtifactStore`.

### 4.4 Slimming the forge: couplings to break

Dropping the designer flow and the Power BI target is not a clean directory delete. Three
module-level dependencies must be resolved during phase 4:

1. **`compiler/lakeview.py` imports `CompileError` and `UnsupportedFeatureError` from
   `compiler/twb.py`** — a module otherwise dropped. Lift those two exception classes into
   a new `compiler/errors.py` and re-point both importers, rather than retaining
   `twb.py` for two classes.
2. **`llm/rebuild_author.py` imports `spec/dax.py` and `llm/spec_author.py` at module
   level**, and branches on `target == "power_bi"` in the retry loop
   (`_repair_powerbi_dax`, `spec_dax_reference_errors`). Strip the Power BI target and its
   DAX repair path; `spec/dax.py` then drops entirely. `spec_author` is imported only for
   `SCHEMA_PLACEHOLDER` and `_cross_check_fields_multi` — move both into a shared helper
   module so the designer-flow author can be deleted.
3. **`validate/lakeview.py` depends on sqlglot.** Keep it. This is dataset-SQL validation,
   not lineage parsing, and it is load-bearing for the LLM lane's honesty guarantees.

The `_TARGETS` enum, `_target_contract()`, and the prompt registry collapse to a single
entry: `databricks` → `rebuild_author_databricks.md`, `formula_language: 'sql'`.

## 5. The ingest seam

This is the single structural change that makes the extraction possible, and the place
where Linetria's platform layer is removed.

Linetria's path:

```
Tableau docs → mapTableauDocs() → StagingBatch[] → Postgres staging
             → canonical promotion → catalog → BiAssetRow[] / BiEdgeRow[] → convert
```

BI_Converter replaces the four middle stages with an in-memory adapter:

```
parseTableauFile() ─┐
                    ├→ TableauWorkbookDoc[] → mapTableauDocs() → StagingBatch[]
TableauConnector ───┘                                                  │
                                                            ingest/adapter.ts
                                                                       ▼
                                          { assets: BiAssetRow[], edges: BiEdgeRow[],
                                            columnsByAsset, derivationsByAsset }
                                                                       │
                                                    ┌──────────────────┴─────────────┐
                                        LLM lane (forge)                  deterministic lane
                                   brief → /draft-rebuild-spec       emitTableauGroupAsLakeview()
                                        → spec → /generate-rebuild            (--no-llm)
                                                    └──────────────────┬─────────────┘
                                                                       ▼
                                     .lvdash.json · semantic layer · checklist · deploy pack
```

### 5.1 Adapter responsibilities

`ingest/adapter.ts` (~150 lines) does exactly what Postgres was doing, and nothing more:

1. **Mint asset ids.** Deterministic — a stable hash of the FQN, so two runs over the same
   workbook produce byte-identical output. Linetria's emitter sorts edges by id to make
   pack bytes depend on content rather than row arrival order; deterministic ids preserve
   that property.
2. **Apply the FQN scheme.** Tableau catalog = site content-URL, schema = `/`-joined
   project path, object = workbook · published datasource · `<workbook>/<sheet>` ·
   `<workbook>/<dashboard>` · `<workbook>/<embedded-ds>`. Reused from `model/fqn.ts`.
3. **Invert dependencies into edges.** `StagingDependencyRec` references assets by FQN;
   the adapter resolves those to the minted ids and produces `BiEdgeRow[]`, sorted the way
   `loadBiEdges` sorts in SQL.
4. **Index columns and derivations by asset.** Build the `Map` structures every downstream
   consumer expects.

**Constraint:** every downstream consumer keeps its existing signature. `BiAssetRow`,
`BiEdgeRow`, `BiColumnRow`, `BiDerivationRow`, `BiBindingLite`, `LakeviewGroupContext`,
`BriefInputs`, and `SemanticLayerContext` are copied over unchanged. This is what makes the
ported files compile essentially untouched, and it is why both lanes can share one input —
which in turn makes the deterministic lane a valid diff baseline for LLM output.

**Non-goal:** the adapter does not deduplicate across workbooks, merge evidence, or track
runs. One conversion, one in-memory graph.

## 6. Binding: Tableau references → Unity Catalog names

Linetria resolves a Tableau table reference to a physical column by stitching connection
descriptors against registered source systems in its catalog. Without a catalog,
BI_Converter needs a simpler rule. `bind/resolve.ts` (~200 lines) implements a three-step
policy:

1. **Descriptor passthrough (default).** Use the Tableau connection's own
   catalog/schema/table names as the Unity Catalog names. Correct whenever the estate was
   lifted and shifted with names intact, which is the common case.
2. **Mapping file override.** `--mapping mapping.yaml` supplies explicit entries:

   ```yaml
   mappings:
     - tableau:    { server: sf-prod, database: ANALYTICS, schema: PUBLIC, table: ORDERS }
       databricks: { catalog: main, schema: sales, table: orders }
   ```

   Matching is **exact after normalization, never fuzzy** — the same discipline as
   Linetria's descriptor stitcher. A mapping entry that matches nothing is a warning, not
   a silent no-op.
3. **Never fabricate.** An unresolved reference produces a `needs_review` checklist line
   and a `-- TODO: unresolved source for <ref>` comment in the emitted view SQL, using the
   existing `Notes` / `ObjectStatus` convention from `migration/bi/shared.ts`.

The resolver's output is `BiBindingLite[]` per asset, matched-first ordered — the ordering
`semantic-layer.ts` already relies on, where `bindings[0].status === 'matched'` means the
datasource resolved.

Live Unity Catalog introspection (connect, read `information_schema`, match by name) is a
deliberate phase-2 deferral. It would require a Databricks connector and credential
handling in the extraction path, which the zero-config demo path must not depend on.

## 7. Runs and storage

**SQLite via `better-sqlite3`.** One file, no Docker, no migrations service.

```sql
CREATE TABLE run (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source_kind TEXT NOT NULL,        -- 'file' | 'tableau_server'
  workbook_name TEXT NOT NULL,
  lane TEXT NOT NULL,               -- 'llm' | 'deterministic'
  status TEXT NOT NULL,             -- queued|extracting|authoring|compiling|succeeded|failed|cancelled
  brief TEXT, spec TEXT, translation TEXT, validation TEXT,
  warnings TEXT, llm_usage TEXT, error TEXT
);

CREATE TABLE artifact (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  path TEXT NOT NULL,               -- on-disk pack location
  kind TEXT NOT NULL,               -- 'pack' | 'lvdash' | 'checklist' | 'semantic_layer'
  bytes INTEGER NOT NULL
);
```

Artifact bytes live on disk; only metadata is in SQLite. LLM authoring takes minutes, so
the web UI needs durable job state; the CLI shares the same store, which is what makes
`convert` followed by a later `deploy --run <id>` work across invocations.

**`forge/runner.ts` is a rewrite, not a port.** Linetria's `build/runner.ts` is
Postgres-coupled throughout — `queueBuilds`, `kickDrain`, `cancelBuildRun`, and
`reconcileBuildRuns` all take a `pg.Pool`. The queue semantics (single-flight per run,
drain loop, cancellation, reconciliation of runs orphaned by a forge restart) are ported as
logic against the SQLite store; roughly 350 new lines. `build/forge-client.ts` by contrast
is a clean HTTP client and moves as-is.

## 8. User surface

### 8.1 CLI

```
bi-converter convert ./sales.twbx --out ./pack [--no-llm] [--mapping map.yaml]
bi-converter convert --tableau-server https://… --site <site> --workbook "Sales"
                     [--screenshots] [--out ./pack]
bi-converter deploy ./pack --host https://<ws>.cloud.databricks.com
                    --warehouse-id <id> [--parent-path /Workspace/…] [--publish]
bi-converter serve [--port 4123]
```

`--no-llm` selects the deterministic lane. It requires no API key and no running forge,
which makes it both the fallback path and the golden-file test target the LLM lane is
diffed against.

### 8.2 Web UI

Three screens, React + Vite:

- **Convert** — drop a workbook file, or enter Tableau Server host/site/credentials and
  pick a workbook. Lane toggle, optional mapping file.
- **Run** — live status, the per-calculation translation report
  (`translated` / `approximated` / `needs_review` / `skipped`), layout-fidelity warnings,
  and the rendered checklist.
- **Artifacts** — browse the emitted pack, download the zip, or deploy to a workspace.

### 8.3 Deploy

Two paths, both shipped:

- **Direct**, via a new TypeScript Lakeview REST client (~200 lines):
  `POST /api/2.0/lakeview/dashboards` (create draft), `PATCH` (update, etag-guarded),
  `POST …/published` (publish). Auth from `DATABRICKS_HOST` plus either `DATABRICKS_TOKEN`
  or OAuth M2M `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET`.
- **In-pack**, via the generated `deploy_dashboards.py` and Asset Bundle scaffold already
  produced by `databricks-deploy.ts`, for customers who want deployment in their own CI.

No credentials are ever written into an artifact. The generated script takes host and
warehouse id as arguments and authenticates from the environment.

## 9. Testing

| Test | Purpose |
|---|---|
| Format tripwire | Every `(widgetType, spec.version)` pair in the golden corpus must be pinned in `lakeview-format.ts`. This is the mechanism that catches Databricks format drift and is the highest-value test in the repo. |
| Cross-language mirror | Deep-equals `lakeview_widget_types.json` against the TypeScript table. Still required, since the forge remains Python. |
| Golden-file conversion | Tableau fixture workbooks → expected `.lvdash.json`, semantic layer, and checklist, through the deterministic lane. Byte-exact; deterministic ids make this stable. |
| Re-ingest validation | Emitted `.lvdash.json` parses back cleanly and references only declared datasets. |
| Ingest adapter | `StagingBatch[]` → assets/edges, including FQN shape, edge ordering, and id stability across runs. |
| Binding resolver | Passthrough, mapping override, exact-match discipline, and unresolved-ref checklist output. |
| Tableau Metadata API | Recorded-response tests, no live credentials. |
| Lakeview REST | Recorded-response tests for create / update / publish. |
| Forge lane | Ported pytest suite for `rebuild_author`, `compiler/lakeview`, `validate/lakeview`, scoped to the databricks target. |

The golden corpus at `server/test/fixtures/lakeview/` comes over intact, with the
provenance notes and fetch dates in its `README.md`.

## 10. Build sequence

Each phase ends with something demonstrable.

1. **Skeleton and format ground truth.** Workspaces, TypeScript config, golden corpus,
   `lakeview-format.ts`, `lakeview-emit.ts`, format tripwire and mirror tests. Nothing
   converts yet; everything downstream now has a validated foundation.
2. **Tableau in.** Connector, file parse, mapper, calc tokenizer, and the ingest adapter.
   Ends with `.twbx` → `BiAssetRow[]` under a fixture test.
3. **Deterministic lane out.** `convert/`, `bind/`, semantic layer, checklist, pack.
   **First end-to-end conversion — the product is usable at the end of this phase.**
4. **Forge lane.** Slim the Python package, wire `forge-client` and the SQLite-backed
   runner, LLM authoring with the retry-on-validator-errors loop, screenshots plumbed
   through `/draft-rebuild-spec`.
5. **Deploy.** Lakeview REST client and `bi-converter deploy`.
6. **Web UI and run persistence.**
7. **Live Tableau Server extraction and screenshot capture.**

Phases 1–3 are the critical path to a working converter. Phase 3 is the point at which the
project delivers its stated purpose; everything after raises fidelity and convenience.

## 11. Risks

| Risk | Mitigation |
|---|---|
| `.lvdash.json` is officially undocumented and Databricks changes it | The pinned format table plus the golden-corpus tripwire test. Unverified widget types emit as `needs_review` rather than being asserted. |
| Two runtimes raise setup friction | `--no-llm` runs the whole deterministic lane with no forge and no API key. The shell answers 502 with a start hint when the forge is down, and queued runs wait rather than fail. |
| Cross-language format drift | The mirror test fails the build. The TypeScript table is authoritative; the fix is always to regenerate the mirror. |
| Tableau semantics that do not survive translation (LOD `FIXED`, table calcs, blends) | Classified and routed to the checklist. Partner tools report this as the irreducible manual portion; the product's claim is honesty about it, not coverage of it. |
| LLM output is non-deterministic | The deterministic lane is the diff baseline. Spec output is gated by JSON Schema plus semantic validators, with validator errors fed back on retry. |
| Passthrough binding produces wrong UC names on a renamed estate | The mapping file override, and unresolved or suspicious references surfaced in the checklist. Live UC introspection is the phase-2 fix. |

## 12. Open decisions deferred past MVP

- Live Unity Catalog introspection for binding
- Power BI as a source
- Genie space configuration beyond the default
- Batch conversion across a whole Tableau site in one run
- Old-vs-new aggregate parity verification against a warehouse
