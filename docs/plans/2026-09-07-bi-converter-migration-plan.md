# BI_Converter migration plan

*Status: complete. All seven phases delivered; see the commit series `Phase 1` … `Phase 7`.*

Execution plan for `docs/superpowers/specs/2026-09-07-tableau-to-databricks-aibi-mvp-design.md`.
Source of truth for ported code: `../Linetria`.

## Module map (Linetria → BI_Converter)

| Linetria | BI_Converter | Treatment |
|---|---|---|
| `server/src/model/{fqn,types,typemap}.ts` | `server/src/model/` | as-is |
| `server/src/errors.ts` | `server/src/errors.ts` | trim to `AppError` + `RunCancelledError` |
| `server/src/bi/grouping.ts` | `server/src/bi/grouping.ts` | drop `loadBiAssets`/`loadBiEdges` (pg) |
| `server/src/stitch/descriptors.ts` | `server/src/tableau/descriptors.ts` | keep `normalizeDescriptor`, `parsePostgresConnectionString` + helpers |
| `server/src/connectors/types.ts` | `server/src/tableau/staging.ts` | as-is |
| `server/src/connectors/executor.ts` | `server/src/tableau/executor.ts` | as-is |
| `server/src/connectors/util.ts` | `server/src/tableau/util.ts` | trim to `describeConnectorError` + deps |
| `server/src/bi/docsource.ts` | `server/src/tableau/docsource.ts` | as-is |
| `server/src/connectors/tableau/*.ts` | `server/src/tableau/` | as-is, imports rewritten |
| `server/src/migration/bi/lakeview-{format,emit}.ts` | `server/src/lakeview/` | as-is |
| `server/src/migration/bi/{shared,tableau-sql,tableau-shelf,calc-translator,semantic-layer,rebuild-databricks,rebuild-databricks-checklist}.ts` | `server/src/convert/` | trim Power BI/repoint paths |
| `server/src/migration/dialects.ts` | `server/src/convert/dialects.ts` | as-is |
| `server/src/migration/bi/databricks-deploy.ts` | `server/src/deploy/` | as-is |
| `server/src/build/{brief,visuals,types}.ts` | `server/src/brief/` | `buildBrief` only; drop pg half |
| `server/src/build/forge-client.ts` | `server/src/forge/client.ts` | as-is, target pinned to `databricks` |
| `server/src/build/pack.ts` | `server/src/pack.ts` | drop pg + Power BI |
| `server/src/build/runner.ts` | `server/src/forge/runner.ts` | **rewrite** against SQLite |
| `forge/tableauforge/**` | `forge/tableauforge/**` | slim per spec §4.4 |
| `server/test/fixtures/lakeview/` | `server/test/fixtures/lakeview/` | as-is (golden corpus) |

New code: `ingest/adapter.ts`, `bind/resolve.ts`, `store/`, `deploy/lakeview-client.ts`, `cli.ts`, `web/`.

## Phases

All delivered.

1. **Skeleton + format ground truth** — workspaces, tsconfig, golden corpus, `lakeview/`, format tripwire + mirror tests.
2. **Tableau in** — model, staging types, connector, files, mapper, calc, visuals, ingest adapter. Fixture test `.twbx` → `BiAssetRow[]`.
3. **Deterministic lane out** — `convert/`, `bind/`, semantic layer, checklist, pack, `cli.ts convert --no-llm`. End-to-end.
4. **Forge lane** — slim Python package, `forge/client.ts`, SQLite store + runner, LLM authoring.
5. **Deploy** — Lakeview REST client, `cli.ts deploy`.
6. **Web UI + run persistence.**
7. **Live Tableau Server extraction + screenshots.**


## Outcome

| Spec §9 test | Where | Tests |
|---|---|---|
| Format tripwire | `lakeview-format.test.ts` | 12 |
| Cross-language mirror | `lakeview-format-mirror.test.ts` | 6 |
| Golden-file conversion + re-ingest | `convert-golden.test.ts` | 14 |
| Ingest adapter | `ingest-adapter.test.ts` | 18 |
| Binding resolver | `bind-resolve.test.ts` | 20 |
| Tableau Metadata API | `tableau-live.test.ts` | 15 |
| Lakeview REST | `lakeview-deploy.test.ts` | 23 |
| Run queue | `runner.test.ts` | 19 |
| Forge lane | `forge/tests/` | 324 |

641 TypeScript tests and 324 forge tests. No test needs a credential or a network.

### Departures from the plan

- **`spec/precheck.py` and a trimmed `validate/pipeline.py`** — not anticipated by the
  spec's §4.4 coupling list, but forced by the dependency graph: `precheck_field_references`
  is spec logic living in the dropped TWB compiler, and `validate/pipeline.py` pulled lxml
  in through the Tableau XSD layers.
- **`tableauforge/rebuild.py`** — the Databricks branch of `generator.py`'s
  `generate_rebuild`, which the spec dropped wholesale without noting that
  `/generate-rebuild` depends on it.
- **Lane selection follows availability** — success criterion 1 requires the bare `convert`
  command to work with no network, while §8.1 lists `--no-llm` as optional. With neither
  flag the lane follows what is reachable, and the run always says which lane ran.
- **Default forge port 4126, not 4125** — 4125 is Linetria's forge on this machine, and
  "the forge is up" must never mean someone else's forge.
