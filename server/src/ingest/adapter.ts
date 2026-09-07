import { createHash } from 'node:crypto';
import { buildFqn } from '../model/fqn.js';
import { canonicalizeDataType } from '../model/typemap.js';
import type { BiAssetRow, BiEdgeRow } from '../bi/grouping.js';
import type { BiColumnRow, BiDerivationRow } from '../convert/shared.js';
import type {
  StagingBatch,
  StagingBiBindingRec,
  StagingColumnRec,
  StagingScreenshotRec,
} from '../tableau/staging.js';

/**
 * The ingest seam (spec §5). Linetria ran `StagingBatch[]` through Postgres staging,
 * canonical promotion, and a catalog before the converter saw a `BiAssetRow`. This adapter
 * does the same work in memory and nothing more: mint ids, apply the FQN scheme, invert
 * FQN-keyed dependencies into id-keyed edges, and index columns and derivations by asset.
 *
 * Ids are a stable hash of the FQN rather than a database sequence, so two runs over the
 * same workbook produce byte-identical output — the property the emitter relies on when it
 * sorts edges by id, and the property the golden-file conversion tests rest on.
 *
 * Non-goals, deliberately: no deduplication across workbooks, no evidence merging, no run
 * tracking. One conversion, one in-memory graph.
 */

export interface IngestResult {
  assets: BiAssetRow[];
  edges: BiEdgeRow[];
  columnsByAsset: Map<string, BiColumnRow[]>;
  derivationsByAsset: Map<string, BiDerivationRow[]>;
  /** Staged bindings keyed by asset id, for `bind/resolve.ts` to turn into BiBindingLite. */
  bindingsByAsset: Map<string, StagingBiBindingRec[]>;
  screenshots: StagingScreenshotRec[];
  warnings: string[];
}

export interface IngestOptions {
  /** Display name for the source, e.g. the uploaded filename or the Tableau site. */
  systemName: string;
  platform?: string;
}

/**
 * A UUID-shaped id derived from `kind` plus the natural key. UUID shape (not just a hex
 * digest) because every ported consumer treats these as opaque ids that may end up in a
 * pack or a run record, and Linetria's rows were UUIDs — keeping the shape means nothing
 * downstream has to care that the database is gone.
 */
function stableId(kind: string, key: string): string {
  const h = createHash('sha256').update(`${kind} ${key}`).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

/** Column identity is (asset, column name) — the grain `asset_column` used. */
function columnId(assetId: string, name: string): string {
  return stableId('column', `${assetId} ${name.toLowerCase()}`);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Fold every batch's records into the row shapes the converter expects. `systemName` names
 * one synthetic source system standing in for the registered system Linetria would have
 * had — one conversion never spans two.
 */
export function ingestStagingBatches(
  batches: readonly StagingBatch[],
  opts: IngestOptions,
): IngestResult {
  const platform = opts.platform ?? 'tableau';
  const sourceSystemId = stableId('system', `${platform} ${opts.systemName}`);

  const warnings: string[] = [];
  const screenshots: StagingScreenshotRec[] = [];

  // ---- assets. Last write wins per FQN: a doc set may name the same published
  // datasource from two workbooks, and the mapper emits it once per sighting.
  const assetByFqn = new Map<string, BiAssetRow>();
  for (const batch of batches) {
    if (batch.warnings) warnings.push(...batch.warnings);
    if (batch.screenshots) screenshots.push(...batch.screenshots);
    for (const rec of batch.assets ?? []) {
      const fqn = buildFqn(rec.catalog, rec.schemaName, rec.name);
      assetByFqn.set(fqn, {
        id: stableId('asset', fqn),
        source_system_id: sourceSystemId,
        system_name: opts.systemName,
        platform,
        catalog: rec.catalog,
        schema_name: rec.schemaName,
        name: rec.name,
        asset_type: rec.assetType,
        fqn,
        definition_sql: rec.definitionSql ?? null,
        platform_properties: rec.platformProperties ?? null,
      });
    }
  }
  // `loadBiAssets` ordered by fqn; grouping and the emitters read that order.
  const assets = [...assetByFqn.values()].sort((a, b) => cmp(a.fqn, b.fqn));
  const idByFqn = new Map(assets.map((a) => [a.fqn, a.id]));

  // ---- columns and derivations. A staged column carrying `expression` is a calculated
  // field: it becomes a column row AND a derivation row, exactly as the normalizer's
  // promotion did (every BI field is a column; calculated ones also carry a derivation).
  const columnsByAsset = new Map<string, BiColumnRow[]>();
  const derivationsByAsset = new Map<string, BiDerivationRow[]>();
  const seenColumn = new Set<string>();

  const pushColumn = (rec: StagingColumnRec): void => {
    const fqn = buildFqn(rec.catalog, rec.schemaName, rec.objectName);
    const assetId = idByFqn.get(fqn);
    if (!assetId) {
      warnings.push(`column '${rec.columnName}' references unknown asset '${fqn}' -- dropped`);
      return;
    }
    const colId = columnId(assetId, rec.columnName);
    if (seenColumn.has(colId)) return;
    seenColumn.add(colId);

    const cols = columnsByAsset.get(assetId) ?? [];
    cols.push({
      id: colId,
      asset_id: assetId,
      ordinal: rec.ordinal,
      name: rec.columnName,
      data_type_raw: rec.dataTypeRaw,
      data_type_canonical: rec.dataTypeRaw ? canonicalizeDataType(rec.dataTypeRaw) : null,
      platform_properties: rec.platformProperties ?? null,
    });
    columnsByAsset.set(assetId, cols);

    if (rec.expression) {
      const derivs = derivationsByAsset.get(assetId) ?? [];
      derivs.push({
        asset_id: assetId,
        output_column_id: colId,
        output_name: rec.columnName,
        expression_sql: rec.expression.text,
        derivation_type: rec.expression.derivationTypes ?? null,
        language: rec.expression.language,
        input_refs: rec.expression.inputRefs ?? null,
      });
      derivationsByAsset.set(assetId, derivs);
    }
  };

  for (const batch of batches) for (const rec of batch.columns ?? []) pushColumn(rec);
  for (const cols of columnsByAsset.values()) {
    cols.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  }

  // ---- edges. Staging references assets by FQN; resolve to minted ids and sort the way
  // `loadBiEdges` sorted in SQL (from, to, then to_column_id NULLS FIRST) -- asset-grain
  // containment rows ahead of the column-grain field-usage rows for the same pair. The
  // emitters read widget order, dataset order, and split boundaries off this list, so the
  // ordering is what keeps a pack's bytes stable between runs.
  const edges: BiEdgeRow[] = [];
  const seenEdge = new Set<string>();
  for (const batch of batches) {
    for (const dep of batch.dependencies ?? []) {
      if (dep.dependencyKind !== 'bi_declared') continue;
      const fromFqn = buildFqn(dep.fromCatalog, dep.fromSchema, dep.fromName);
      const toFqn = buildFqn(dep.toCatalog, dep.toSchema, dep.toName);
      const from = idByFqn.get(fromFqn);
      const to = idByFqn.get(toFqn);
      if (!from || !to) {
        warnings.push(
          `dependency '${fromFqn}' -> '${toFqn}' names an asset that was not extracted -- dropped`,
        );
        continue;
      }
      const toColumnName = dep.toColumn ?? null;
      const toColumnId = toColumnName ? columnId(to, toColumnName) : null;
      const key = `${from}|${to}|${toColumnId ?? ''}`;
      if (seenEdge.has(key)) continue;
      seenEdge.add(key);
      edges.push({
        from_asset_id: from,
        to_asset_id: to,
        to_column_id: toColumnId,
        to_column_name: toColumnName,
      });
    }
  }
  // `to_column_id` sorted NULLS FIRST in SQL, and '' sorts below any hex digest, so the
  // empty-string substitution reproduces that ordering without a special case.
  edges.sort(
    (a, b) =>
      cmp(a.from_asset_id, b.from_asset_id) ||
      cmp(a.to_asset_id, b.to_asset_id) ||
      cmp(a.to_column_id ?? '', b.to_column_id ?? ''),
  );

  // ---- bindings, keyed by asset. Status is not decided here: `bind/resolve.ts` owns
  // whether a descriptor resolves to a Unity Catalog name (spec §6).
  const bindingsByAsset = new Map<string, StagingBiBindingRec[]>();
  for (const batch of batches) {
    for (const b of batch.bindings ?? []) {
      const assetId = idByFqn.get(b.assetFqn);
      if (!assetId) {
        warnings.push(`binding names unknown asset '${b.assetFqn}' -- dropped`);
        continue;
      }
      const list = bindingsByAsset.get(assetId) ?? [];
      list.push(b);
      bindingsByAsset.set(assetId, list);
    }
  }

  return { assets, edges, columnsByAsset, derivationsByAsset, bindingsByAsset, screenshots, warnings };
}
