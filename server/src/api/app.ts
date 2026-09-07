import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { parseMappingFile } from '../bind/resolve.js';
import {
  assembleBriefs,
  convertDeterministic,
  parseLiveSource,
  parseSource,
  type ParsedSource,
} from '../convert/pipeline.js';
import { zipPack } from '../convert/convert.js';
import { ForgeClient } from '../forge/client.js';
import { Runner, runNeedsReview } from '../forge/runner.js';
import { deployPack } from '../deploy/deploy.js';
import { authFromEnv, LakeviewClient } from '../deploy/lakeview-client.js';
import { RunStore, parseJsonColumn, type ArtifactKind, type RunRow } from '../store/store.js';
import { AppError } from '../errors.js';

/**
 * The HTTP surface behind `bi-converter serve` (spec §8.2) — what the three web screens
 * talk to. It is the same conversion the CLI runs, over the same store, so a run started
 * in the browser can be deployed from the terminal and the other way round.
 */

export interface ServerOptions {
  store: RunStore;
  forgeUrl: string;
  /** Where packs are written. Defaults to the store's own packs directory. */
  packRoot?: string;
  /** Built web UI to serve at `/`. Defaults to web/dist when it exists. */
  webRoot?: string;
}

/** The run shape the UI reads: JSON columns parsed, plus the one derived flag. */
export function runView(row: RunRow, artifacts: number) {
  return {
    id: row.id,
    createdAt: row.created_at,
    sourceKind: row.source_kind,
    workbookName: row.workbook_name,
    lane: row.lane,
    status: row.status,
    needsReview: runNeedsReview(row),
    warnings: parseJsonColumn<string[]>(row.warnings) ?? [],
    translation: parseJsonColumn<unknown[]>(row.translation) ?? [],
    validation: parseJsonColumn<unknown>(row.validation),
    llmUsage: parseJsonColumn<unknown>(row.llm_usage),
    error: row.error,
    artifacts,
  };
}

function artifactKind(rel: string): ArtifactKind {
  if (rel.endsWith('.lvdash.json')) return 'lvdash';
  if (rel.endsWith('rebuild_checklist.md')) return 'checklist';
  if (rel.includes('/views/') || rel.includes('/metric_views/') || rel.startsWith('semantic_layer/')) {
    return 'semantic_layer';
  }
  return 'pack';
}

export function buildServer(opts: ServerOptions): FastifyInstance {
  const { store, forgeUrl } = opts;
  const packRoot = opts.packRoot ?? path.join(store.dir, 'packs');
  const forge = new ForgeClient(forgeUrl);
  const runner = new Runner({ store, forge });
  // A restart must not leave runs looking active forever.
  runner.reconcile();

  const app = Fastify({ bodyLimit: 200 * 1024 * 1024 });
  app.register(cors, { origin: true });

  // AppError carries a status and a message meant for the caller; anything else is a
  // logged, opaque 500 — an internal failure must not leak a stack or a filesystem path.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AppError) {
      reply.status(err.statusCode).send({ error: err.message });
      return;
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: status >= 500 ? 'internal error' : message });
  });

  app.get('/api/health', async () => {
    const forgeHealth = await forge.health();
    return {
      ok: true,
      // The UI greys out the LLM lane rather than letting a user pick a lane that cannot
      // run, and says how to start the forge instead of failing at submit time.
      forge: { ...forgeHealth, url: forgeUrl },
    };
  });

  /**
   * Convert an uploaded workbook. The deterministic pack is always written first — it
   * costs nothing and it means a forge that never answers still leaves a usable result.
   */
  app.post<{
    Body: {
      /** File mode: the upload. */
      fileName?: string;
      /** base64 workbook bytes */
      data?: string;
      /** Live mode: the site to pull from. */
      tableauServer?: string;
      site?: string;
      patName?: string;
      patSecret?: string;
      workbook?: string;
      lane?: 'llm' | 'deterministic';
      mapping?: string;
      name?: string;
      instructions?: string;
    };
  }>('/api/convert', async (req) => {
    const body = req.body ?? {};
    const mapping = body.mapping ? parseMappingFile(body.mapping) : undefined;
    const lane = body.lane ?? 'deterministic';

    let parsed: ParsedSource;
    let name: string;
    let sourceKind: 'file' | 'tableau_server';
    try {
      if (body.tableauServer) {
        const patName = body.patName ?? process.env.TABLEAU_PAT_NAME;
        const patSecret = body.patSecret ?? process.env.TABLEAU_PAT_SECRET;
        if (!patName || !patSecret) {
          throw new AppError(
            422,
            'live extraction needs a Tableau personal access token — supply one, or set ' +
              'TABLEAU_PAT_NAME and TABLEAU_PAT_SECRET on the server',
          );
        }
        parsed = await parseLiveSource({
          serverUrl: body.tableauServer,
          site: body.site,
          patName,
          patSecret,
          workbook: body.workbook,
        });
        name = body.name ?? parsed.name;
        sourceKind = 'tableau_server';
      } else {
        if (!body.fileName || !body.data) {
          throw new AppError(422, 'provide a fileName and data, or a tableauServer');
        }
        name = body.name ?? path.basename(body.fileName).replace(/\.[^.]+$/, '');
        parsed = parseSource(body.fileName, Buffer.from(body.data, 'base64'), name);
        sourceKind = 'file';
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(422, err instanceof Error ? err.message : String(err));
    }

    const run = store.createRun({ sourceKind, workbookName: name, lane });
    const outDir = path.join(packRoot, run.id);

    const result = convertDeterministic(parsed, { mapping });
    for (const [rel, content] of result.files) {
      const target = path.join(outDir, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, 'utf8');
      store.addArtifact(run.id, target, artifactKind(rel), Buffer.byteLength(content, 'utf8'));
    }
    store.updateRun(run.id, { warnings: result.warnings });

    if (lane === 'deterministic') {
      store.updateRun(run.id, { status: 'succeeded' });
      return runView(store.getRun(run.id)!, store.listArtifacts(run.id).length);
    }

    const { briefs, warnings } = assembleBriefs(parsed, { mapping });
    if (briefs.length === 0) throw new AppError(422, 'no Tableau report container in that file');
    store.updateRun(run.id, { warnings: [...result.warnings, ...warnings] });
    // Returns immediately: authoring takes minutes, and the Run screen polls.
    runner.enqueue({
      runId: run.id,
      brief: briefs[0].brief,
      instructions: body.instructions,
    });
    return runView(store.getRun(run.id)!, store.listArtifacts(run.id).length);
  });

  app.get<{ Querystring: { limit?: string } }>('/api/runs', async (req) => {
    const limit = Number(req.query.limit ?? 50);
    const rows = store.listRuns(Number.isFinite(limit) ? limit : 50);
    return { runs: rows.map((r) => runView(r, store.listArtifacts(r.id).length)) };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (req) => {
    const row = store.getRun(req.params.id);
    if (!row) throw new AppError(404, `no run '${req.params.id}'`);
    return runView(row, store.listArtifacts(row.id).length);
  });

  app.post<{ Params: { id: string } }>('/api/runs/:id/cancel', async (req) => {
    const outcome = runner.cancel(req.params.id);
    if (outcome === 'not_found') throw new AppError(404, `no run '${req.params.id}'`);
    return { outcome };
  });

  app.get<{ Params: { id: string } }>('/api/runs/:id/artifacts', async (req) => {
    const row = store.getRun(req.params.id);
    if (!row) throw new AppError(404, `no run '${req.params.id}'`);
    const root = path.join(packRoot, row.id);
    return {
      artifacts: store.listArtifacts(row.id).map((a) => ({
        id: a.id,
        // Relative, so the UI shows the pack's own layout rather than a server path.
        path: path.relative(root, a.path).split(path.sep).join('/'),
        kind: a.kind,
        bytes: a.bytes,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (req, reply) => {
    const artifact = store.getArtifact(req.params.id);
    if (!artifact) throw new AppError(404, `no artifact '${req.params.id}'`);
    const text = await fs.readFile(artifact.path, 'utf8');
    reply.type(artifact.path.endsWith('.json') ? 'application/json' : 'text/plain');
    return text;
  });

  /** The whole pack as a zip, built from what is on disk. */
  app.get<{ Params: { id: string } }>('/api/runs/:id/pack.zip', async (req, reply) => {
    const row = store.getRun(req.params.id);
    if (!row) throw new AppError(404, `no run '${req.params.id}'`);
    const root = path.join(packRoot, row.id);
    const files = new Map<string, string>();
    for (const a of store.listArtifacts(row.id)) {
      files.set(
        path.relative(root, a.path).split(path.sep).join('/'),
        await fs.readFile(a.path, 'utf8'),
      );
    }
    if (files.size === 0) throw new AppError(404, 'that run produced no artifacts');
    reply
      .type('application/zip')
      .header('content-disposition', `attachment; filename="${row.workbook_name}-pack.zip"`);
    return Buffer.from(zipPack(files));
  });

  app.post<{
    Params: { id: string };
    Body: { host?: string; warehouseId: string; parentPath?: string; publish?: boolean };
  }>('/api/runs/:id/deploy', async (req) => {
    const row = store.getRun(req.params.id);
    if (!row) throw new AppError(404, `no run '${req.params.id}'`);
    if (!req.body?.warehouseId) throw new AppError(422, 'warehouseId is required');

    let auth;
    try {
      auth = authFromEnv({ host: req.body.host });
    } catch (err) {
      // A missing credential is the operator's to fix, and the message says how.
      throw new AppError(400, err instanceof Error ? err.message : String(err));
    }
    const deployed = await deployPack(new LakeviewClient(auth), path.join(packRoot, row.id), {
      warehouseId: req.body.warehouseId,
      parentPath: req.body.parentPath,
      publish: req.body.publish === true,
    });
    return { host: auth.host, deployed };
  });

  // The built UI, when there is one. `serve` without a build is still a working API, so a
  // missing web/dist is a quiet no-op rather than a boot failure.
  const webRoot =
    opts.webRoot ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'dist');
  if (existsSync(path.join(webRoot, 'index.html'))) {
    app.register(fastifyStatic, { root: path.resolve(webRoot) });
    // Single-page app: anything that is not an API route is the app's own routing.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.status(404).send({ error: `no route ${req.method} ${req.url}` });
        return;
      }
      reply.sendFile('index.html');
    });
  }

  return app;
}
