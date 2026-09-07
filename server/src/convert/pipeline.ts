import path from 'node:path';
import { parseTableauFile } from '../tableau/files.js';
import { mapTableauDocs } from '../tableau/mapper.js';
import { sniffBiFileKind } from '../tableau/uploads.js';
import { TableauConnector, type TableauConnectorConfig } from '../tableau/index.js';
import { TableauLiveExecutor } from '../tableau/live.js';
import { ReplayExecutor } from '../tableau/executor.js';
import type { StagingBatch } from '../tableau/staging.js';
import { ingestStagingBatches, type IngestResult } from '../ingest/adapter.js';
import { resolveBindings, type SourceMapping } from '../bind/resolve.js';
import { groupBiAssets } from '../bi/grouping.js';
import { buildBrief } from '../brief/brief.js';
import type { AssembledBrief } from '../brief/types.js';
import type { BriefBindingRow } from '../brief/brief.js';
import { convertToLakeviewPack, type ConvertResult } from './convert.js';

/**
 * The two lanes, over one input (spec §5). Both start from the same in-memory graph, which
 * is what makes the deterministic lane a valid diff baseline for the LLM lane's output —
 * and what lets `--no-llm` be a real fallback rather than a different product.
 */

export interface ParsedSource {
  ingest: IngestResult;
  name: string;
}

/** Parse a Tableau file and run it through the ingest seam. */
export function parseSource(fileName: string, data: Buffer, name?: string): ParsedSource {
  const base = path.basename(fileName);
  if (sniffBiFileKind(base, data) === 'unknown') {
    throw new Error(`'${fileName}' is not a Tableau workbook or datasource file`);
  }
  const systemName = name ?? base.replace(/\.[^.]+$/, '');
  const docs = parseTableauFile(base, data);
  return { ingest: ingestStagingBatches(mapTableauDocs(docs, 'file'), { systemName }), name: systemName };
}

export interface LiveSourceOptions {
  serverUrl: string;
  site?: string;
  patName: string;
  patSecret: string;
  /** Extract only this workbook. Absent pulls every workbook the PAT can see. */
  workbook?: string;
  /** Capture rendered dashboard screenshots as authoring context for the LLM lane. */
  screenshots?: boolean;
  /** Recorded-response fixture instead of the wire — how the live path is tested. */
  replayFixture?: string;
}

/**
 * Pull from a live Tableau Server/Cloud site (spec §10 phase 7). The connector, the doc
 * model, and the mapper are the SAME ones file mode uses — that one-normalizer invariant
 * is why a live conversion and a downloaded-workbook conversion cannot drift apart — so
 * everything downstream of the ingest seam is identical.
 */
export async function parseLiveSource(opts: LiveSourceOptions): Promise<ParsedSource> {
  const config: TableauConnectorConfig = {
    server_url: opts.serverUrl.replace(/\/+$/, ''),
    site_content_url: opts.site ?? '',
    pat_name: opts.patName,
    pat_secret: opts.patSecret,
    ...(opts.replayFixture ? { replayFixture: opts.replayFixture } : {}),
  };

  const connector = new TableauConnector(config, async () =>
    opts.replayFixture
      ? await ReplayExecutor.fromFile(opts.replayFixture)
      : new TableauLiveExecutor(config),
  );

  const health = await connector.testConnection();
  if (!health.ok) {
    throw new Error(`Tableau connection failed: ${health.error ?? 'unknown error'}`);
  }

  const batches: StagingBatch[] = [];
  for await (const batch of connector.extract({})) batches.push(batch);

  const systemName = opts.workbook ?? (opts.site && opts.site !== '' ? opts.site : 'default');
  const ingest = ingestStagingBatches(batches, { systemName });

  if (opts.workbook) {
    // Narrow to one workbook AFTER ingest, so the filter runs over resolved ids rather
    // than over FQN strings — and so a name that matches nothing says so, rather than
    // quietly converting an empty estate.
    const filtered = filterToWorkbook(ingest, opts.workbook);
    if (filtered.assets.length === 0) {
      const available = [...new Set(
        ingest.assets.filter((a) => a.asset_type === 'bi_workbook').map((a) => a.name),
      )].sort();
      throw new Error(
        `no workbook named '${opts.workbook}' on that site — found: ${available.join(', ') || '(none)'}`,
      );
    }
    return { ingest: filtered, name: opts.workbook };
  }
  return { ingest, name: systemName };
}

/**
 * Keep one workbook and everything it reaches. A datasource shared with another workbook
 * comes along; a workbook that does not match is dropped whole, with its columns,
 * derivations, bindings and edges.
 */
function filterToWorkbook(ingest: IngestResult, workbook: string): IngestResult {
  const wanted = workbook.toLowerCase();
  const top = ingest.assets.find(
    (a) => a.asset_type === 'bi_workbook' && a.name.toLowerCase() === wanted,
  );
  if (!top) return { ...ingest, assets: [], edges: [] };

  const keep = new Set<string>([top.id]);
  // Prefix children — the workbook's own sheets, dashboards and embedded datasources.
  for (const a of ingest.assets) {
    if (a.name.toLowerCase().startsWith(`${wanted}/`)) keep.add(a.id);
  }
  // Plus whatever those elements reference: a published datasource lives at site level and
  // is not a prefix child, but the workbook is useless without it.
  for (const e of ingest.edges) {
    if (keep.has(e.from_asset_id)) keep.add(e.to_asset_id);
  }

  const assets = ingest.assets.filter((a) => keep.has(a.id));
  const subset = <T>(m: ReadonlyMap<string, T>): Map<string, T> =>
    new Map([...m].filter(([id]) => keep.has(id)));

  return {
    ...ingest,
    assets,
    edges: ingest.edges.filter((e) => keep.has(e.from_asset_id) && keep.has(e.to_asset_id)),
    columnsByAsset: subset(ingest.columnsByAsset),
    derivationsByAsset: subset(ingest.derivationsByAsset),
    bindingsByAsset: subset(ingest.bindingsByAsset),
    screenshots: ingest.screenshots.filter((s) =>
      s.name.toLowerCase() === wanted || s.name.toLowerCase().startsWith(`${wanted}/`),
    ),
  };
}

/** The deterministic lane: straight to a pack, no forge and no API key. */
export function convertDeterministic(
  source: ParsedSource,
  opts: { mapping?: SourceMapping; generatedAt?: string } = {},
): ConvertResult {
  return convertToLakeviewPack(source.ingest, {
    sourceName: source.name,
    mapping: opts.mapping,
    generatedAt: opts.generatedAt,
  });
}

export interface AssembledBriefs {
  /** One brief per top-level Tableau container — a workbook, or a standalone datasource. */
  briefs: AssembledBrief[];
  warnings: string[];
}

/**
 * The LLM lane's input: a rebuild brief per report container. The forge is stateless with
 * respect to conversion, so this is the whole package the author designs from.
 *
 * `httpPathBySystem` is empty here: Linetria lifted a Databricks SQL warehouse HTTP path
 * out of a registered system's decrypted config, and there is no credential store to lift
 * one from. A brief with no HTTP path is honest about that; the deploy step supplies the
 * warehouse id instead.
 */
export function assembleBriefs(
  source: ParsedSource,
  opts: { mapping?: SourceMapping } = {},
): AssembledBriefs {
  const { assets, edges, columnsByAsset, derivationsByAsset } = source.ingest;
  const bound = resolveBindings(source.ingest.bindingsByAsset, { mapping: opts.mapping });
  const { topLevel, members } = groupBiAssets(assets, edges);

  // buildBrief wants the matched-system id alongside each binding; without a catalog there
  // is no system to name, so it is null and the http-path lift below finds nothing.
  const bindingsByAsset = new Map<string, BriefBindingRow[]>();
  for (const [assetId, binds] of bound.bindingsByAsset) {
    bindingsByAsset.set(
      assetId,
      binds.map((b) => ({ ...b, matched_source_system_id: null })),
    );
  }

  const warnings = [...source.ingest.warnings, ...bound.warnings];
  const briefs: AssembledBrief[] = [];
  for (const top of topLevel) {
    if (top.platform !== 'tableau') continue;
    const assembled = buildBrief({
      top,
      members: members.get(top.id) ?? [],
      edges,
      columnsByAsset,
      derivationsByAsset,
      bindingsByAsset,
      httpPathBySystem: new Map(),
    });
    briefs.push(assembled);
    warnings.push(...assembled.warnings);
  }
  return { briefs, warnings };
}
