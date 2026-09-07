// Databricks AI/BI (Lakeview) enrichment (BI connectors plan Task 8). Lakeview is NOT a
// new system — it is a second extraction pass on the existing databricks connector that
// upserts onto the SAME bi_dashboard assets the MVP lineage pass (connectors/databricks/
// index.ts P7) already creates from system.access.table_lineage. This module owns doc
// fetch (live REST via the executor seam) and parse (.lvdash.json upload), plus the one
// mapping function both converge on — the Tableau/Power BI mapper.ts analog, scoped down
// to what Lakeview actually has: no fields/columns (coverage matrix: "n/a"), one asset
// per dashboard, dataset SQL as definition_sql (decision 7), names/owner/widgets in
// platform_properties.

import type { BiApiFetch } from '../tableau/docsource.js';
import type { StagingAssetRec } from '../tableau/staging.js';

/** One dashboard's Lakeview dataset (spec: `datasets[].{name,query}`). */
/** One `datasets[].parameters[]` entry — the dataset SQL references it as `:keyword`.
 *  Kept on the doc so a rebuilt dashboard's parameters survive the round trip through
 *  the reader (the emitters' CI backstop); `dataType`/`complexType` ride verbatim. */
export interface LakeviewDatasetParameter {
  keyword: string;
  displayName: string | null;
  dataType: string | null;
  complexType: string | null;
}

export interface LakeviewDataset {
  name: string;
  query: string | null;
  /** Present only when the document declared parameters on this dataset. */
  parameters?: LakeviewDatasetParameter[];
}

/** Widget geometry from `layout[].position` (12-column grid, post-Feb-2026 layout —
 *  positions are integer cell coordinates, not pixels). */
export interface LakeviewWidgetPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Widget inventory entry, flattened from `pages[].layout[].widget` (spec). */
export interface LakeviewWidgetSummary {
  name: string;
  type: string | null;
  datasetNames: string[];
  page: string | null;
  /** `layout[].position` (Task 0) — undefined when absent or malformed, never invented. */
  position?: LakeviewWidgetPosition;
}

/** The doc shape both live (REST) and file (.lvdash.json) modes converge on. */
export interface LakeviewDashboardDoc {
  /** The MVP lineage pass's entity_id (spec §6.3) — reusing it verbatim is what makes
   *  enrichment land on the SAME asset instead of creating a duplicate (decision 2). For
   *  a file upload there is no entity_id in the document; the filename stands in for it
   *  (same precedent as Tableau's file-mode doc identity, connectors/tableau/files.ts). */
  dashboardId: string;
  displayName: string;
  /** Live only — a raw .lvdash.json export carries no workspace-side ownership record
   *  (coverage matrix: "no owners"). */
  owner: string | null;
  datasets: LakeviewDataset[];
  widgets: LakeviewWidgetSummary[];
}

// ---------------------------------------------------------------------------------
// Raw wire shapes (GET /api/2.0/lakeview/dashboards, GET .../dashboards/{id}) and the
// serialized_dashboard JSON string they carry. Approximated from public Databricks
// documentation, disclosed like every other BI connector's wire-shape approximation in
// this codebase (Task 5/6/7 precedent) — never exercised against a live workspace.
// ---------------------------------------------------------------------------------

interface RawLakeviewSummary {
  dashboard_id: string;
  display_name?: string;
}

interface RawLakeviewListResponse {
  dashboards?: RawLakeviewSummary[];
  next_page_token?: string | null;
}

interface RawLakeviewDashboard {
  dashboard_id: string;
  display_name?: string;
  owner?: string | null;
  serialized_dashboard?: string | null;
}

interface RawDataset {
  name: string;
  displayName?: string;
  query?: string | null;
  /** Newer exports carry the dataset SQL split across an array instead of `query` — see
   *  `datasetQuery` for the join rule. */
  queryLines?: string[] | null;
  parameters?: Array<{
    keyword?: unknown;
    displayName?: unknown;
    dataType?: unknown;
    complexType?: unknown;
  }> | null;
}

/** Dataset parameters, or undefined when the document declared none (never `[]` invented). */
function datasetParameters(d: RawDataset): LakeviewDatasetParameter[] | undefined {
  if (!Array.isArray(d.parameters) || d.parameters.length === 0) return undefined;
  const out: LakeviewDatasetParameter[] = [];
  for (const p of d.parameters) {
    if (!p || typeof p.keyword !== 'string') continue;
    out.push({
      keyword: p.keyword,
      displayName: typeof p.displayName === 'string' ? p.displayName : null,
      dataType: typeof p.dataType === 'string' ? p.dataType : null,
      complexType: typeof p.complexType === 'string' ? p.complexType : null,
    });
  }
  return out.length > 0 ? out : undefined;
}

function toDataset(d: RawDataset): LakeviewDataset {
  const parameters = datasetParameters(d);
  return { name: d.name, query: datasetQuery(d), ...(parameters ? { parameters } : {}) };
}

/**
 * A dataset's SQL, from either wire shape (Task 0 finding, fixed in the Phase 3 emitter
 * task): `query` (a plain string — the older/simpler form) or `queryLines` (an array).
 * A dataset carrying neither honestly stays `null` — no SQL is ever invented.
 *
 * Join rule: in the golden corpus (`server/test/fixtures/lakeview/account-usage-v2.lvdash.json`,
 * the only file with `queryLines`) every element except the last already ends with its own
 * `\n`, so joining on `'\n'` would double every newline in the SQL. Lines that carry their
 * own terminators are therefore concatenated as-is; a bare (unterminated) array — the form
 * the plan's brief assumed — still joins on `'\n'`. Both shapes round-trip to the exact SQL.
 */
function datasetQuery(d: RawDataset): string | null {
  if (typeof d.query === 'string') return d.query;
  const lines = d.queryLines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const terminated = lines.slice(0, -1).every((l) => typeof l === 'string' && l.endsWith('\n'));
  return lines.join(terminated ? '' : '\n');
}

interface RawWidgetQuery {
  name?: string;
  query?: { datasetName?: string };
}

interface RawWidget {
  name: string;
  queries?: RawWidgetQuery[];
  spec?: { widgetType?: string };
}

interface RawPosition {
  x?: unknown;
  y?: unknown;
  width?: unknown;
  height?: unknown;
}

interface RawLayoutEntry {
  widget?: RawWidget;
  position?: RawPosition;
}

/** Coerce `layout[].position` into a fully-numeric geometry, or undefined if any field is
 *  missing/non-numeric — never invents a coordinate the document didn't actually supply. */
function toPosition(raw: RawPosition | undefined): LakeviewWidgetPosition | undefined {
  if (!raw) return undefined;
  const { x, y, width, height } = raw;
  if (
    typeof x === 'number' &&
    typeof y === 'number' &&
    typeof width === 'number' &&
    typeof height === 'number'
  ) {
    return { x, y, width, height };
  }
  return undefined;
}

interface RawPage {
  name?: string;
  displayName?: string;
  layout?: RawLayoutEntry[];
}

interface RawSerializedDashboard {
  datasets?: RawDataset[];
  pages?: RawPage[];
}

/** Parse a `serialized_dashboard` JSON string (live) OR a raw `.lvdash.json` file's own
 *  top-level content (file — same shape, no wrapper) into datasets + a flattened widget
 *  inventory. Malformed/absent JSON degrades to "nothing found" rather than throwing —
 *  an enrichment pass must never fail the run over a document parse hiccup. */
export function parseSerializedDashboard(raw: string): {
  datasets: RawDataset[];
  widgets: LakeviewWidgetSummary[];
} {
  let parsed: RawSerializedDashboard;
  try {
    parsed = JSON.parse(raw) as RawSerializedDashboard;
  } catch {
    parsed = {};
  }
  const datasets = parsed.datasets ?? [];
  const widgets: LakeviewWidgetSummary[] = [];
  for (const page of parsed.pages ?? []) {
    for (const entry of page.layout ?? []) {
      const w = entry.widget;
      if (!w?.name) continue;
      widgets.push({
        name: w.name,
        type: w.spec?.widgetType ?? null,
        datasetNames: (w.queries ?? [])
          .map((q) => q.query?.datasetName)
          .filter((x): x is string => !!x),
        page: page.displayName ?? page.name ?? null,
        position: toPosition(entry.position),
      });
    }
  }
  return { datasets, widgets };
}

function toDoc(raw: RawLakeviewDashboard): LakeviewDashboardDoc {
  const { datasets, widgets } = parseSerializedDashboard(raw.serialized_dashboard ?? '{}');
  return {
    dashboardId: raw.dashboard_id,
    displayName: raw.display_name ?? raw.dashboard_id,
    owner: raw.owner ?? null,
    datasets: datasets.map(toDataset),
    widgets,
  };
}

/**
 * Live-mode doc source strategy (decision 10): `lakeview_list` (paginated via
 * `page_token` riding requestJson — the stepId itself stays stable across pages, same
 * convention as Power BI's scan-id-in-requestJson) then one `lakeview_get:<id>` per
 * dashboard. Used with `ApiDocSource` exactly like `tableauLiveStrategy`/
 * the live doc-source strategies.
 */
export function lakeviewLiveStrategy(): (fetch: BiApiFetch) => AsyncGenerator<LakeviewDashboardDoc> {
  return async function* (fetch) {
    const summaries: RawLakeviewSummary[] = [];
    let pageToken: string | undefined;
    do {
      const payload = (await fetch(
        pageToken ? { page_token: pageToken } : {},
        'lakeview_list',
      )) as RawLakeviewListResponse;
      summaries.push(...(payload.dashboards ?? []));
      pageToken = payload.next_page_token ?? undefined;
    } while (pageToken);

    for (const s of summaries) {
      const raw = (await fetch({}, `lakeview_get:${s.dashboard_id}`)) as RawLakeviewDashboard;
      yield toDoc(raw);
    }
  };
}

/** `.lvdash.json` upload (offline mode, spec §9 analog): the file's own top-level JSON
 *  IS the serialized-dashboard shape (bi/uploads.ts's sniffer already keys on
 *  `datasets`+`pages`) — no dashboard_id/display_name/owner wrapper exists in the
 *  export, so the filename (minus the `.lvdash.json` suffix) stands in for both id and
 *  display name, and owner is honestly absent (coverage matrix: "no owners"). */
export function parseLvdashFile(name: string, data: Buffer): LakeviewDashboardDoc {
  const text = data.toString('utf8');
  const { datasets, widgets } = parseSerializedDashboard(text);
  const base = name.split(/[\\/]/).pop() ?? name;
  const dashboardId = base.replace(/\.lvdash\.json$/i, '') || base;
  return {
    dashboardId,
    displayName: dashboardId,
    owner: null,
    datasets: datasets.map(toDataset),
    widgets,
  };
}

/**
 * Map Lakeview docs to enrichment `StagingAssetRec`s (pass 'bi'), one per dashboard,
 * FQN-compatible with the MVP lineage pass's scheme (catalog=null, schema=null,
 * name=entity_id — decision 2, verified against connectors/databricks/index.ts's
 * BI_ENTITY_TYPES/biAssets construction) so the promotion upsert lands on the SAME
 * asset row instead of creating a duplicate.
 *
 * `priorPlatformProperties` carries forward whatever the SAME run's lineage pass already
 * captured for a dashboard it also observed (entity_type, created_by) — the promotion
 * upsert picks the LATEST staging_asset row per identity wholesale (extraction/
 * normalizer.ts: "later passes carry definitions"), so this pass must merge those fields
 * itself rather than lose them. A dashboard Lakeview sees but native lineage never did
 * (outside the 90-day window, or never queried) gets a fresh asset with an honest
 * default `entity_type: 'DASHBOARD'` — Lakeview's dashboards API is by construction only
 * ever listing AI/BI dashboards.
 */
export function mapLakeviewDocs(
  docs: LakeviewDashboardDoc[],
  mode: 'live' | 'file',
  priorPlatformProperties: Map<string, Record<string, unknown>> = new Map(),
): StagingAssetRec[] {
  return docs.map((doc) => {
    const datasetSql = doc.datasets.filter((d) => d.query && d.query.trim() !== '');
    const definitionSql = datasetSql.length > 0 ? datasetSql.map((d) => d.query).join(';\n') : null;
    const prior = priorPlatformProperties.get(doc.dashboardId) ?? {};
    return {
      catalog: null,
      schemaName: null,
      name: doc.dashboardId,
      assetType: 'bi_dashboard',
      definitionSql,
      language: definitionSql ? 'sql' : null,
      platformProperties: {
        ...prior,
        entity_type: (prior.entity_type as string | undefined) ?? 'DASHBOARD',
        display_name: doc.displayName,
        ...(mode === 'live' && doc.owner ? { owner: doc.owner } : {}),
        widgets: doc.widgets,
        ...(datasetSql.length > 0
          ? { datasets: datasetSql.map((d) => ({ name: d.name, sql: d.query })) }
          : {}),
      },
    };
  });
}
