/**
 * BI container grouping: the converter's flat bi_* assets regrouped into their platform
 * containers — Tableau workbook → dashboards/sheets/embedded datasources, standalone published datasource — assembled
 * from what the mapper produced: name-prefix children (`<workbook>/<child>`), bi_declared
 * asset-grain containment/usage edges, and column-grain field-usage edges.
 *
 * Ported from Linetria; the two Postgres loaders (`loadBiAssets`/`loadBiEdges`) are gone —
 * `ingest/adapter.ts` builds the same rows in memory (spec §5).
 */

export interface BiAssetRow {
  id: string;
  source_system_id: string;
  system_name: string;
  platform: string;
  catalog: string | null;
  schema_name: string | null;
  name: string;
  asset_type: string;
  fqn: string;
  definition_sql: string | null;
  platform_properties: Record<string, unknown> | null;
}

export interface BiEdgeRow {
  from_asset_id: string;
  to_asset_id: string;
  to_column_id: string | null;
  to_column_name: string | null;
}

export const DATASOURCE_TYPES = new Set(['bi_datasource', 'bi_semantic_model', 'bi_dataset']);
export const ELEMENT_TYPES = new Set(['bi_dashboard', 'bi_sheet', 'bi_report', 'bi_workbook']);

/** Null-safe namespace equality — embedded children always share the container's
 *  catalog+schema (both mappers construct them that way). */
function sameNamespace(a: BiAssetRow, b: BiAssetRow): boolean {
  return (
    a.source_system_id === b.source_system_id &&
    (a.catalog ?? '') === (b.catalog ?? '') &&
    (a.schema_name ?? '') === (b.schema_name ?? '')
  );
}

export function isPrefixChildOf(parent: BiAssetRow, asset: BiAssetRow): boolean {
  return (
    asset.id !== parent.id &&
    sameNamespace(parent, asset) &&
    asset.name.startsWith(`${parent.name}/`)
  );
}

export interface Grouping {
  topLevel: BiAssetRow[];
  /** Container asset id → member assets (prefix children + edge-reachable datasources). */
  members: Map<string, BiAssetRow[]>;
}

/** Groups the project's BI assets under their top-level containers. A datasource/model is
 *  a member of every container whose elements reference it (a published datasource shared
 *  by two workbooks appears under both) and is itself top-level only when nothing claims
 *  it — the standalone `.tds` case. */
export function groupBiAssets(assets: BiAssetRow[], edges: BiEdgeRow[]): Grouping {
  const byId = new Map(assets.map((a) => [a.id, a]));
  const workbooks = assets.filter((a) => a.asset_type === 'bi_workbook');

  const prefixClaimed = new Set<string>();
  const prefixChildren = new Map<string, BiAssetRow[]>();
  for (const wb of workbooks) {
    const children = assets.filter((a) => isPrefixChildOf(wb, a));
    prefixChildren.set(wb.id, children);
    for (const c of children) prefixClaimed.add(c.id);
  }

  // Asset-grain incoming edges onto datasource-ish assets, from BI elements.
  const dsReferencedBy = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.to_column_id) continue;
    const to = byId.get(e.to_asset_id);
    if (!to || !DATASOURCE_TYPES.has(to.asset_type)) continue;
    if (!dsReferencedBy.has(to.id)) dsReferencedBy.set(to.id, new Set());
    dsReferencedBy.get(to.id)!.add(e.from_asset_id);
  }

  const topLevel = assets.filter((a) => {
    if (a.asset_type === 'bi_workbook' || a.asset_type === 'bi_report') return true;
    if (prefixClaimed.has(a.id)) return false;
    if (DATASOURCE_TYPES.has(a.asset_type)) return !dsReferencedBy.has(a.id);
    return true; // e.g. a Lakeview bi_dashboard with no workbook container
  });

  const members = new Map<string, BiAssetRow[]>();
  for (const top of topLevel) {
    const own = prefixChildren.get(top.id) ?? [];
    const memberIds = new Set<string>([top.id, ...own.map((c) => c.id)]);
    const result = [...own];
    // Edge-reachable datasources from the container or any of its elements (Tableau
    // published DS via sheet edges, Power BI model via report edge).
    for (const [dsId, fromIds] of dsReferencedBy) {
      if (memberIds.has(dsId)) continue;
      if ([...fromIds].some((f) => memberIds.has(f))) {
        const ds = byId.get(dsId);
        if (ds) {
          result.push(ds);
          memberIds.add(dsId);
        }
      }
    }
    members.set(top.id, result);
  }

  return { topLevel, members };
}

/** BI_Extractor "Calc Clean Status" analog, from the derivation's input-ref resolutions:
 *  every ref resolved → 'resolved'; some → 'partial'; none of ≥1 → 'unresolved'; a formula
 *  with no refs (constants) counts as resolved. */
export function formulaStatus(inputRefs: Array<{ resolution?: string }> | null): string {
  const refs = inputRefs ?? [];
  if (refs.length === 0) return 'resolved';
  const ok = refs.filter(
    (r) => r.resolution === 'exact' || r.resolution === 'schema_defaulted',
  ).length;
  if (ok === refs.length) return 'resolved';
  return ok > 0 ? 'partial' : 'unresolved';
}

/** A member's display name inside its container — the `workbook/` prefix dropped. */
export function displayName(top: BiAssetRow, asset: BiAssetRow): string {
  const prefix = `${top.name}/`;
  return asset.id !== top.id && asset.name.startsWith(prefix)
    ? asset.name.slice(prefix.length)
    : asset.name;
}

/** SQL queries itemized the way the mappers persisted them (Tableau `customSql`,
 *  Power BI `nativeQueries`), falling back to the joined definition_sql. */
export function sqlQueriesOf(
  ds: BiAssetRow,
  name: string,
): Array<{ name: string; datasource_id: string; datasource_name: string; sql: string }> {
  const props = ds.platform_properties ?? {};
  const custom = props.customSql as Array<{ connection?: string; sql: string }> | undefined;
  if (Array.isArray(custom) && custom.length > 0) {
    return custom.map((q, i) => ({
      name: q.connection ? `custom_sql:${q.connection}` : `custom_sql_${i + 1}`,
      datasource_id: ds.id,
      datasource_name: name,
      sql: q.sql,
    }));
  }
  const native = props.nativeQueries as Array<{ source?: string; sql: string }> | undefined;
  if (Array.isArray(native) && native.length > 0) {
    return native.map((q, i) => ({
      name: q.source ?? `native_query_${i + 1}`,
      datasource_id: ds.id,
      datasource_name: name,
      sql: q.sql,
    }));
  }
  if (ds.definition_sql) {
    return [{ name: 'definition', datasource_id: ds.id, datasource_name: name, sql: ds.definition_sql }];
  }
  return [];
}
