import path from 'node:path';
import { parseTableauFile } from '../tableau/files.js';
import { mapTableauDocs } from '../tableau/mapper.js';
import { sniffBiFileKind } from '../tableau/uploads.js';
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
