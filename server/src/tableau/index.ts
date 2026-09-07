import { ApiDocSource } from './docsource.js';
import type { BiFileParser, BiUploadFile } from './uploads.js';
import type {
  CatalogTree,
  ConnectionHealth,
  MetadataConnector,
  ScopeSelection,
  StagingBatch,
} from './staging.js';
import type { QueryExecutor } from './executor.js';
import { parseTableauFile } from './files.js';
import { mapTableauDocs } from './mapper.js';
import type { TableauWorkbookDoc } from './model.js';
import { metadataPingRequest, serverInfoRequest, tableauLiveStrategy } from './queries.js';
import { collectVisuals } from './visuals.js';
import { describeConnectorError } from './util.js';

/**
 * Tableau connector façade (BI connectors plan Task 4/5) — file mode (Task 4) plus live-mode
 * registration (Task 5; `runner.ts` connectorFor/connectorWithExecutor wire this in). Both
 * modes converge on the identical `mapTableauDocs` normalizer (spec §4). `bi/uploads.ts`
 * imports this module for its side effect (the static `registerBiFileParser` call below), so
 * importing it once at server startup is enough to wire the file parser in.
 */
export const tableauFileParser: BiFileParser = {
  platform: 'tableau',
  kinds: ['tableau_workbook', 'tableau_datasource'],
  parseAndMap(file: BiUploadFile): StagingBatch[] {
    const docs = parseTableauFile(file.name, Buffer.from(file.data));
    return mapTableauDocs(docs, 'file');
  },
};

export interface TableauConnectorConfig {
  server_url?: string;
  /** Site content-URL; '' (or absent) is the default site (spec §5.1 decision 2). */
  site_content_url?: string;
  pat_name?: string;
  pat_secret?: string;
  /** Recorded-response fixture path — replay mode for tests/demos (spec §16). */
  replayFixture?: string;
}

function unwrapJson(row: Record<string, unknown> | undefined): unknown {
  const payload = row?.json;
  return typeof payload === 'string' ? JSON.parse(payload) : payload;
}

/**
 * Tableau live connector (BI connectors plan Task 5): REST signin + Metadata API GraphQL
 * over the executor seam (decision 10). `extract()` yields an empty `containers` pass (parity
 * with every other connector's pass-boundary bookkeeping — Tableau's "container" concept,
 * the site/projects tree, carries no generic asset shape of its own) followed by the `bi`
 * batch(es) `mapTableauDocs` produces from the paginated workbook pull.
 */
export class TableauConnector implements MetadataConnector {
  constructor(
    private readonly config: TableauConnectorConfig,
    private readonly executorFactory: () => Promise<QueryExecutor>,
  ) {}

  async testConnection(): Promise<ConnectionHealth> {
    let ex: QueryExecutor | undefined;
    try {
      ex = await this.executorFactory();
      await ex.execute('{}', 'signin');
      // Version comes from REST serverinfo (the Metadata API schema has no version field);
      // the metadata ping then proves the Metadata API itself is enabled — extraction is
      // impossible without it, so a disabled Metadata API fails here, not mid-run.
      const infoRows = await ex.execute(JSON.stringify(serverInfoRequest()), 'serverinfo');
      const payload = unwrapJson(infoRows[0]) as
        | { serverInfo?: { productVersion?: { value?: string } } }
        | undefined;
      await ex.execute(JSON.stringify(metadataPingRequest()), 'metadata-ping');
      return {
        ok: true,
        serverVersion: payload?.serverInfo?.productVersion?.value ?? undefined,
        readOnly: true,
        warnings: [],
      };
    } catch (err) {
      return {
        ok: false,
        readOnly: false,
        warnings: [],
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      await ex?.close().catch(() => {});
    }
  }

  async enumerateScope(): Promise<CatalogTree> {
    const site =
      this.config.site_content_url && this.config.site_content_url.trim() !== ''
        ? this.config.site_content_url
        : 'default';
    // Tableau has no schema-scoped extraction concept (ScopeSelection.schemas doesn't
    // apply) — the site stands alone as the one "catalog" a Tableau connection exposes.
    return { catalogs: [{ name: site, schemas: [] }] };
  }

  async *extract(_scope: ScopeSelection): AsyncGenerator<StagingBatch> {
    const ex = await this.executorFactory();
    try {
      yield { pass: 'containers' };
      const source = new ApiDocSource<TableauWorkbookDoc>(ex, tableauLiveStrategy(this.config));
      const docs: TableauWorkbookDoc[] = [];
      let partialWarning: string | undefined;
      try {
        for await (const doc of source.docs()) docs.push(doc);
      } catch (err) {
        // Zero docs collected ⇒ total failure: fail the run (runner enriches the message).
        if (docs.length === 0) throw err;
        // Partial: keep what we pulled, surface the interruption as a warning (design D4).
        partialWarning =
          `document pull interrupted after ${docs.length} document(s) — partial results kept: ` +
          describeConnectorError(err, { platform: 'tableau' });
      }
      const { screenshots, warnings: visualWarnings } = await collectVisuals(ex, docs);
      const batches = mapTableauDocs(docs, 'live');
      if (partialWarning) {
        if (batches.length === 0) batches.push({ pass: 'bi', warnings: [partialWarning] });
        else
          batches[batches.length - 1].warnings = [
            ...(batches[batches.length - 1].warnings ?? []),
            partialWarning,
          ];
      }
      if (screenshots.length > 0 || visualWarnings.length > 0) {
        batches.push({ pass: 'bi', screenshots, warnings: visualWarnings });
      }
      for (const batch of batches) yield batch;
    } finally {
      await ex.close().catch(() => {});
    }
  }

  requiredPrivileges(): string {
    return [
      `-- BI_Converter minimal-privilege setup for Tableau Server/Cloud extraction.`,
      `-- 1) Enable the Metadata API for the site/server:`,
      `--    Server: tsm maintenance metadata-services enable`,
      `--    Cloud: enabled by default.`,
      `-- 2) Create a Personal Access Token for a user with (at minimum) Viewer access to`,
      `--    every project/workbook this connection should extract.`,
      `-- No write access is required — the connector only issues a REST signin and`,
      `-- read-only Metadata API GraphQL queries.`,
      `-- 3) For visual capture (optional but recommended): grant the PAT user the`,
      `--    'Download Workbook/Save As' capability (workbook definition download) and`,
      `--    'Download Image/PDF' (rendered view screenshots) on the relevant projects.`,
      `--    Without them, extraction still succeeds — visual detail degrades to warnings.`,
    ].join('\n');
  }
}
