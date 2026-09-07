# BI_Converter migration plan

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

1. **Skeleton + format ground truth** — workspaces, tsconfig, golden corpus, `lakeview/`, format tripwire + mirror tests.
2. **Tableau in** — model, staging types, connector, files, mapper, calc, visuals, ingest adapter. Fixture test `.twbx` → `BiAssetRow[]`.
3. **Deterministic lane out** — `convert/`, `bind/`, semantic layer, checklist, pack, `cli.ts convert --no-llm`. End-to-end.
4. **Forge lane** — slim Python package, `forge/client.ts`, SQLite store + runner, LLM authoring.
5. **Deploy** — Lakeview REST client, `cli.ts deploy`.
6. **Web UI + run persistence.**
7. **Live Tableau Server extraction + screenshots.**
