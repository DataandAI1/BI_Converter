import { strToU8, zipSync } from 'fflate';
import { groupBiAssets } from '../bi/grouping.js';
import { emitTableauGroupAsLakeview } from './rebuild-databricks.js';
import { DEPLOY_PY, bundleYaml } from '../deploy/databricks-deploy.js';
import { resolveBindings, type SourceMapping } from '../bind/resolve.js';
import type { IngestResult } from '../ingest/adapter.js';
import {
  countsOf,
  slugify,
  type BiManifestObject,
  type BiPackManifest,
} from './shared.js';

/**
 * The deterministic lane (spec §5, §8.1 `--no-llm`). Linetria's `rebuild.ts` opened a
 * transaction, loaded a project's BI assets out of Postgres, and fanned out to three
 * rebuild targets. This is the same orchestration with the database and the other two
 * targets removed: one in-memory graph in, one Databricks pack out.
 *
 * It requires no credentials and no network, which is what makes it both the fallback path
 * when the forge is down and the golden-file baseline the LLM lane is diffed against.
 */

export interface ConvertOptions {
  /** Names the pack and its manifest — the workbook name, or the Tableau site. */
  sourceName: string;
  mapping?: SourceMapping;
  /** Fixed timestamp, for byte-exact golden-file tests. Defaults to now. */
  generatedAt?: string;
}

export interface ConvertResult {
  files: Map<string, string>;
  manifest: BiPackManifest;
  warnings: string[];
  /** Suggested zip filename, when the caller wants one file rather than a directory. */
  filename: string;
}

export function convertToLakeviewPack(
  ingest: IngestResult,
  opts: ConvertOptions,
): ConvertResult {
  const generatedAt = opts.generatedAt ?? new Date().toISOString();
  const warnings = [...ingest.warnings];

  // ---- binding: Tableau references become Unity Catalog names, or become a checklist
  // line. Nothing in between (spec §6).
  const bound = resolveBindings(ingest.bindingsByAsset, { mapping: opts.mapping });
  warnings.push(...bound.warnings);

  const { assets, edges, columnsByAsset, derivationsByAsset } = ingest;
  const { topLevel, members } = groupBiAssets(assets, edges);
  const byId = new Map(assets.map((a) => [a.id, a]));

  const files = new Map<string, string>();
  const objects: BiManifestObject[] = [];

  // Two workbooks may share a display name; the suffix keeps their folders apart and is
  // assigned in `topLevel` order, which is fqn order, so it is stable across runs.
  const slugCounts = new Map<string, number>();
  const slugFor = (name: string): string => {
    const base = slugify(name);
    const n = (slugCounts.get(base) ?? 0) + 1;
    slugCounts.set(base, n);
    return n === 1 ? base : `${base}-${n}`;
  };

  const ctx = {
    files,
    objects,
    edges,
    byId,
    columnsByAsset,
    derivationsByAsset,
    bindingsByAsset: bound.bindingsByAsset,
  };

  for (const top of topLevel) {
    const own = members.get(top.id) ?? [];
    if (top.platform !== 'tableau') {
      for (const a of [top, ...own]) {
        objects.push({
          fqn: a.fqn,
          asset_type: a.asset_type,
          system: a.system_name,
          file: null,
          status: 'skipped',
          notes: [`conversion from platform '${top.platform}' is not supported`],
        });
      }
      continue;
    }
    emitTableauGroupAsLakeview(ctx, top, own, slugFor(top.name));
  }

  // Pack-level deploy artifacts ride every pack — including one where no group emitted a
  // dashboard — so the README never describes files the pack lacks.
  files.set('deploy_dashboards.py', DEPLOY_PY);
  files.set('databricks.yml', bundleYaml(files));

  const manifest: BiPackManifest = {
    project: opts.sourceName,
    project_id: '',
    path: 'rebuild',
    target: 'databricks',
    target_label: 'Databricks AI/BI',
    generated_at: generatedAt,
    counts: countsOf(objects, files.size + 2), // + manifest.json and README.md, added below
    objects,
  };

  files.set('manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  files.set('README.md', readme(manifest, bound.stats, warnings));

  const stamp = generatedAt.replace(/[:.]/g, '-');
  return {
    files,
    manifest,
    warnings,
    filename: `bi_converter_databricks_${slugify(opts.sourceName)}_${stamp}.zip`,
  };
}

/** Zip a pack's files, ordered by path so the bytes depend on content, not iteration. */
export function zipPack(files: ReadonlyMap<string, string>): Uint8Array {
  const zipInput: Record<string, Uint8Array> = {};
  for (const [path, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    zipInput[path] = strToU8(content);
  }
  return zipSync(zipInput, { level: 6 });
}

function readme(
  manifest: BiPackManifest,
  stats: { refs: number; passthrough: number; mapped: number; unresolved: number },
  warnings: readonly string[],
): string {
  const review = manifest.objects.filter((o) => o.status === 'needs_review');
  return `# Databricks AI/BI conversion pack — ${manifest.project}

- **Generated:** ${manifest.generated_at}
- **Objects:** ${manifest.counts.total} (${manifest.counts.ready} ready, ${manifest.counts.needs_review} need review, ${manifest.counts.skipped} skipped)
- **Source references:** ${stats.refs} (${stats.passthrough} passed through, ${stats.mapped} from the mapping file, ${stats.unresolved} unresolved)

Pack root:

- \`deploy_dashboards.py\` — creates/updates (and optionally publishes) every dashboard
  in the pack via the Databricks SDK. Takes \`--host\` and \`--warehouse-id\` as
  arguments and authenticates from environment variables — no credential, workspace
  host or warehouse id is baked into any file here.
- \`databricks.yml\` — the same dashboards as a minimal Asset Bundle skeleton.

Each workbook folder contains:

- \`views/*.sql\` — one \`CREATE OR REPLACE VIEW\` per Tableau relation (custom SQL
  ships verbatim behind a review banner, never rewritten). A reference the converter
  could not resolve to a full Unity Catalog name carries a \`-- TODO\` line rather than
  a guessed one.
- \`metric_views/*.yaml\` — a Unity Catalog metric view per datasource: dimensions from
  the plain fields, measures from the calcs that are a single simple aggregate.
- \`dashboards/*.lvdash.json\` — one AI/BI dashboard per Tableau dashboard: datasets
  selecting from the views above, and one widget per worksheet laid out on the
  12-column grid from the captured dashboard zones. Every widget type is one the
  pinned format table backs; nothing is guessed.
- \`rebuild_checklist.md\` — unverified widget types, every Tableau calculation to port
  by hand (verbatim, classified, with the AI/BI construct that fits it), and every
  channel, zone or field the conversion could not ground.

${review.length > 0 ? `## Needs review\n\n${review.map((o) => `- ${o.fqn}: ${o.notes[0] ?? ''}`).join('\n')}\n` : ''}${
    warnings.length > 0 ? `\n## Conversion warnings\n\n${warnings.map((w) => `- ${w}`).join('\n')}\n` : ''
  }`;
}
