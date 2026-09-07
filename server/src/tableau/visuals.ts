import type { QueryExecutor } from './executor.js';
import { ReplayStepMissingError } from './executor.js';
import type { StagingScreenshotRec } from './staging.js';
import { describeConnectorError } from './util.js';
import { parseTableauFile } from './files.js';
import type { TableauWorkbookDoc } from './model.js';

/** Decode a binary row envelope returned from content:/image: steps. */
export function decodeBinaryRow(
  row: Record<string, unknown> | undefined,
  stepId: string,
): { buffer: Buffer; contentType: string; base64: string } {
  if (!row || typeof row.base64 !== 'string') {
    throw new Error(
      `step '${stepId}' returned no {base64: …} row — binary transports and replay fixtures must wrap responses as [{base64, contentType}]`,
    );
  }
  const buffer = Buffer.from(row.base64, 'base64');
  const contentType = typeof row.contentType === 'string' ? row.contentType : 'application/octet-stream';
  return {
    buffer,
    contentType,
    base64: row.base64,
  };
}

/**
 * Merges a downloaded-and-reparsed workbook's visual structure (mark/shelf/encoding/
 * filter detail, dashboard zone layout, thumbnails) onto the Metadata-API-built doc's
 * name-matched sheets/dashboards (Tableau visual-rebuild feature, Task A3). `target` is
 * mutated in place; `parsed` is the doc `parseTableauFile` produced from the downloaded
 * .twb/.twbx content. Matching is case-insensitive (Tableau sheet/dashboard names are
 * effectively case-insensitive identifiers across the REST/Metadata surfaces). Parsed
 * sheets that carry visual detail but have no name-matched counterpart on `target`
 * (Metadata API pull vs. downloaded content drifted) are counted into one warning rather
 * than silently dropped.
 */
export function mergeVisualStructure(
  target: TableauWorkbookDoc, parsed: TableauWorkbookDoc, warnings: string[],
): void {
  target.visualSource = 'twb_content';
  if (parsed.thumbnails?.length) target.thumbnails = parsed.thumbnails;
  const sheetByName = new Map(parsed.sheets.map((s) => [s.name.toLowerCase(), s]));
  const targetSheetNames = new Set(target.sheets.map((s) => s.name.toLowerCase()));
  for (const sheet of target.sheets) {
    const p = sheetByName.get(sheet.name.toLowerCase());
    if (p?.visual) sheet.visual = p.visual;
  }
  const dashByName = new Map(parsed.dashboards.map((d) => [d.name.toLowerCase(), d]));
  for (const dash of target.dashboards) {
    const p = dashByName.get(dash.name.toLowerCase());
    if (p?.layout) dash.layout = p.layout;
  }
  const unmatched = parsed.sheets.filter(
    (s) => s.visual && !targetSheetNames.has(s.name.toLowerCase()),
  ).length;
  if (unmatched > 0) {
    warnings.push(
      `workbook '${target.name}': ${unmatched} sheet(s) in the downloaded definition have ` +
        `no Metadata API counterpart — their visual detail was skipped`,
    );
  }
}

/**
 * Live-mode visual capture (Task A3): downloads and reparses each workbook's .twbx
 * content (merging visual structure onto the Metadata-API-built docs via
 * `mergeVisualStructure`), then captures rendered view images for every dashboard plus
 * any sheet not embedded in a dashboard (a dashboarded sheet's own image would be
 * redundant with the dashboard capture). Both passes degrade to warnings — a fixture/
 * server that never recorded a content:/image: step (`ReplayStepMissingError`) is an
 * optional capability gap, not a failed run, and any other capture failure (auth,
 * timeout, size cap) is caught per-target so one bad view never aborts the rest.
 */
export async function collectVisuals(
  ex: QueryExecutor, docs: TableauWorkbookDoc[],
): Promise<{ screenshots: StagingScreenshotRec[]; warnings: string[] }> {
  const warnings: string[] = [];
  const screenshots: StagingScreenshotRec[] = [];

  // Pass 1: workbook definitions — visual structure merged onto the GraphQL docs.
  for (const doc of docs) {
    if (!doc.luid) continue;
    try {
      const rows = await ex.execute('{}', `content:${doc.luid}`);
      const bin = decodeBinaryRow(rows[0], `content:${doc.luid}`);
      const parsed = parseTableauFile(`${doc.name}.twbx`, bin.buffer);
      if (parsed[0]) mergeVisualStructure(doc, parsed[0], warnings);
    } catch (err) {
      if (err instanceof ReplayStepMissingError) continue;
      warnings.push(
        `workbook '${doc.name}': definition download failed — visual detail skipped: ` +
          describeConnectorError(err, { platform: 'tableau' }),
      );
    }
  }

  // Pass 2: rendered view images — dashboards, plus sheets not on any dashboard.
  if (process.env.LINETRIA_BI_SCREENSHOTS === 'off') return { screenshots, warnings };
  // A non-finite/negative override (unset, typo'd, or nonsensical) must fall back
  // to the 200 default rather than flow into `targets.slice(0, NaN)`, which drops
  // ALL screenshots silently — the opposite of what an env-cap guard should do.
  const rawCap = Number(process.env.LINETRIA_TABLEAU_MAX_SCREENSHOTS);
  const cap = Number.isFinite(rawCap) && rawCap >= 0 ? rawCap : 200;
  const targets: Array<{
    luid: string; catalog: string; schemaName: string | null;
    name: string; assetType: 'bi_dashboard' | 'bi_sheet';
  }> = [];
  for (const doc of docs) {
    const catalog = doc.site || 'default';
    const schemaName = doc.project || null;
    const inDash = new Set(doc.dashboards.flatMap((d) => d.sheetNames));
    for (const d of doc.dashboards) {
      if (d.luid) targets.push({ luid: d.luid, catalog, schemaName, name: `${doc.name}/${d.name}`, assetType: 'bi_dashboard' });
    }
    for (const s of doc.sheets) {
      if (s.luid && !inDash.has(s.name)) targets.push({ luid: s.luid, catalog, schemaName, name: `${doc.name}/${s.name}`, assetType: 'bi_sheet' });
    }
  }
  if (targets.length > cap) {
    warnings.push(
      `screenshot cap reached (LINETRIA_TABLEAU_MAX_SCREENSHOTS=${cap}) — ` +
        `${targets.length - cap} view image(s) not captured`,
    );
  }
  for (const t of targets.slice(0, cap)) {
    try {
      const rows = await ex.execute('{}', `image:${t.luid}`);
      const bin = decodeBinaryRow(rows[0], `image:${t.luid}`);
      screenshots.push({
        catalog: t.catalog, schemaName: t.schemaName, name: t.name, assetType: t.assetType,
        source: 'rest_image', contentType: bin.contentType, base64: bin.base64,
      });
    } catch (err) {
      if (err instanceof ReplayStepMissingError) continue;
      warnings.push(
        `view image for '${t.name}' failed: ` + describeConnectorError(err, { platform: 'tableau' }),
      );
    }
  }
  return { screenshots, warnings };
}
