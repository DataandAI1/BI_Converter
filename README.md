# BI_Converter

Convert a Tableau workbook or published datasource into a Databricks AI/BI (Lakeview)
dashboard, together with the Unity Catalog semantic layer the dashboard reads from and an
honest checklist of everything a human still has to decide.

It does one job. It does not fabricate: an unresolvable table, calculation, or layout
becomes a `needs_review` checklist line, never a guess.

Design spec: [`docs/superpowers/specs/2026-09-07-tableau-to-databricks-aibi-mvp-design.md`](docs/superpowers/specs/2026-09-07-tableau-to-databricks-aibi-mvp-design.md).

## Quick start

```bash
npm install
npm run build            # the server, then the web UI into web/dist

# Convert a workbook. No database, no credentials, no network.
npx bi-converter convert ./sales.twbx --out ./pack

# Or use the browser: serve the UI and the API together, then open the URL it prints.
npm run serve            # http://127.0.0.1:4123
```

That produces, per workbook:

- `dashboards/*.lvdash.json` — one AI/BI dashboard per Tableau dashboard, laid out on the
  12-column grid from the captured dashboard zones. Every widget type is one the pinned
  format table backs.
- `views/*.sql` — one `CREATE OR REPLACE VIEW` per Tableau relation. Custom SQL ships
  verbatim behind a review banner, never rewritten.
- `metric_views/*.yaml` — a Unity Catalog metric view per datasource.
- `rebuild_checklist.md` — every calculation to port by hand, every unverified widget type,
  and every field the conversion could not ground.

Plus, at the pack root, `deploy_dashboards.py` and `databricks.yml` — neither of which
contains a credential.

## The two lanes

| Lane | What it does | Needs |
|---|---|---|
| **Deterministic** | Emits `.lvdash.json` directly by rule. Byte-identical every run. | Nothing |
| **AI-authored** | An LLM designs the dashboard from a rebuild brief, gated by JSON Schema plus semantic validators with errors fed back on retry. | The forge, and a provider |

With neither `--no-llm` nor `--llm`, the lane follows what is available: the AI-authored
lane when the forge is reachable, the deterministic lane otherwise. Either way the run says
which lane produced the pack. `--llm` forces the AI lane and fails if the forge is down;
`--no-llm` forces the deterministic one.

The deterministic pack is written **first and always**, even on the AI path. It costs
nothing, it is the diff baseline for what the model returns, and it means a forge that
never answers still leaves a working conversion.

## Commands

```
bi-converter convert <file.twb|.twbx|.tds|.tdsx> [--out ./pack] [--mapping map.yaml] [--zip]
bi-converter convert --tableau-server <url> [--site <site>] [--workbook <name>]
bi-converter deploy <pack-dir> --host <url> --warehouse-id <id> [--publish]
bi-converter deploy --run <id> --warehouse-id <id>
bi-converter runs
bi-converter serve [--port 4123]
```

`serve` hosts the three-screen web UI (Convert, Run, Artifacts) over the same store the
CLI uses, so a run started in the browser can be deployed from the terminal. It needs the
UI built first (`npm run build`); without one it says so at startup and serves the API
alone. The gear icon in the UI's header opens the LLM provider settings: Anthropic (an API
key plus a model from the forge's catalog) or a local Ollama server (its URL plus a model
it has pulled). Those settings live in the forge, so it has to be running to change them.

If the browser ever reports that it cannot reach the server, the process behind `serve`
has stopped: start it again and reload. During development, `npm run dev:web` serves the
UI from Vite and proxies `/api` to a server started with `npm run dev:server`.

## Binding: Tableau names to Unity Catalog names

Three steps, and nothing in between:

1. **Passthrough** (default) — the Tableau connection's own catalog/schema/table names
   *are* the Unity Catalog names. Correct whenever the estate was lifted and shifted with
   names intact.
2. **Mapping file** — `--mapping map.yaml` overrides specific references. Matching is exact
   after normalization, never fuzzy. An entry that matches nothing is a warning.
   ```yaml
   mappings:
     - tableau:    { server: sf-prod, database: ANALYTICS, schema: PUBLIC, table: ORDERS }
       databricks: { catalog: main, schema: sales, table: orders }
   ```
3. **Never fabricate** — an unresolved reference becomes a checklist line and a
   `-- TODO: unresolved source` comment in the emitted view SQL.

Live Unity Catalog introspection is a deliberate phase-2 deferral: it would put a Databricks
connector and credential handling in the extraction path, which the zero-config path must
not depend on.

## Credentials

None are ever written into a pack.

| Purpose | Variable |
|---|---|
| Deploy | `DATABRICKS_HOST` + `DATABRICKS_TOKEN`, or `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET` |
| Live Tableau extraction | `TABLEAU_PAT_NAME` + `TABLEAU_PAT_SECRET` |

The Tableau token secret is read from the environment only, never from a CLI argument — an
argument lands in shell history and in every process listing on the machine.

## The forge

A slimmed Python service owns LLM authoring and spec compilation. It is optional.

```bash
cd forge && python -m venv .venv && .venv/bin/pip install -e ".[dev]"   # Python 3.12
npm run dev:forge                                                       # port 4126
```

Configure a provider from the UI's Settings dialog (the gear icon), at
`POST /settings/provider` on the forge directly (Claude, or a local Ollama server), or by
setting `ANTHROPIC_API_KEY` in the forge's environment.

## Layout

```
server/        Node 20 · TypeScript · Fastify — extraction, conversion, storage, deploy, API
  src/tableau/   Tableau connector, file parse, mapper, calc tokenizer
  src/ingest/    StagingBatch[] -> BiAssetRow[]/BiEdgeRow[], in memory
  src/bind/      Tableau reference -> Unity Catalog name
  src/lakeview/  the pinned format table, the emitter, the re-ingest reader
  src/convert/   the deterministic lane
  src/forge/     forge client + the SQLite-backed run queue
  src/deploy/    Lakeview REST client + the in-pack deploy script
forge/         Python 3.12 · FastAPI — LLM authoring and spec compilation only
web/           React + Vite — three screens
```

## Tests

```bash
npm test              # 641 TypeScript tests
npm run test:forge    # 324 forge tests
```

The highest-value test in the repo is the **format tripwire**: every `(widgetType,
spec.version)` pair in the golden corpus of five Databricks-published dashboards must be
pinned in `lakeview-format.ts`. `.lvdash.json` is officially undocumented, and that table
plus its corpus is the project's most valuable asset. A **cross-language mirror test**
keeps the forge's JSON copy in lockstep; the TypeScript table is authoritative, and the fix
for a mirror failure is always to regenerate the mirror.

Everything else — golden-file conversion, re-ingest validation, the ingest adapter, the
binding resolver, the Tableau Metadata API, and the Lakeview REST client — runs against
fixtures and recorded responses. No test needs a credential or a network.

## What this is not

Not a pixel-perfect translator. LOD `FIXED`, table calculations, data blends, sets, groups,
bins, and parameter-driven filters route to the checklist as `needs_review`. Partner tools
report the same irreducible manual portion; the claim here is honesty about it, not
coverage of it.

Power BI is neither a source nor a target. Warehouse and ETL pipeline migration are out of
scope.
