import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { parseMappingFile, type SourceMapping } from '../bind/resolve.js';
import {
  assembleBriefs,
  convertDeterministic,
  parseLiveSource,
  parseSource,
  type ParsedSource,
} from '../convert/pipeline.js';
import { zipPack } from '../convert/convert.js';
import { ForgeClient, ForgeError, type ForgeSettings } from '../forge/client.js';
import { Runner, runNeedsReview } from '../forge/runner.js';
import { deployPack } from '../deploy/deploy.js';
import {
  authFromEnv,
  DatabricksError,
  LakeviewClient,
  type FetchLike,
} from '../deploy/lakeview-client.js';
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
  /** The forge client. Defaults to one for `forgeUrl`; tests inject a fake. */
  forge?: ForgeClient;
  /** Outbound fetch for servers other than the forge (an Ollama host). Tests inject. */
  fetchImpl?: typeof fetch;
  /** Fetch for the Databricks Lakeview client. Tests inject. */
  lakeviewFetch?: FetchLike;
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const PROVIDERS = new Set(['claude', 'ollama']);

/**
 * Where the built UI lives, starting from the directory of whichever module asks. The
 * compiled server runs from `server/dist/src/api` and the source from `server/src/api`
 * — one level apart — so a fixed number of `..` cannot serve both. Walk up until a
 * `web/dist/index.html` appears; none means the UI was never built.
 */
export function resolveWebRoot(from: string): string | undefined {
  let dir = path.resolve(from);
  for (let depth = 0; depth < 8; depth++) {
    const candidate = path.join(dir, 'web', 'dist');
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
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

/**
 * A Content-Disposition whose filename cannot break the header. The workbook name is the
 * upload's own name or whatever the caller typed: a quote, a CR/LF or a non-ASCII
 * character in it made the header invalid and the download a 500. The ASCII form keeps
 * the header well-formed for every client; the RFC 5987 form carries the real name.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim() || 'pack.zip';
  const utf8 = encodeURIComponent(filename.replace(/[\r\n]/g, ' '));
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
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
  const forge = opts.forge ?? new ForgeClient(forgeUrl);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const runner = new Runner({ store, forge });
  // A restart must not leave runs looking active forever.
  runner.reconcile();

  // No CORS, deliberately. The UI is served from this same origin (or proxied to it by
  // the Vite dev server), so nothing legitimate calls these routes cross-origin — and
  // reflecting any Origin would let any web page the user has open drive a local server
  // that holds Tableau and Databricks credentials.
  const app = Fastify({ bodyLimit: 200 * 1024 * 1024 });

  // AppError carries a status and a message meant for the caller; anything else is a
  // logged, opaque 500 — an internal failure must not leak a stack or a filesystem path.
  app.addHook('onClose', async () => runner.close());

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
    // The UI greys out the LLM lane rather than letting a user pick a lane that cannot
    // run, and says how to start the forge instead of failing at submit time. A forge
    // that is up but has no provider configured is the same story one step later, so
    // readiness rides along: the Convert screen points at Settings instead of a
    // conversion that fails minutes in.
    let llm: { ready: boolean; provider: string | null; model: string | null } = {
      ready: false,
      provider: null,
      model: null,
    };
    if (forgeHealth.ok) {
      try {
        const s = await forge.getSettings();
        llm = {
          ready: s.llm_ready,
          provider: s.provider,
          model: s.provider === 'ollama' ? s.ollama_model : s.model,
        };
      } catch {
        /* healthz answered but settings did not — an older forge; treat as not ready */
      }
    }
    return { ok: true, forge: { ...forgeHealth, url: forgeUrl }, llm };
  });

  /* ------------------------------------------------------------- settings */

  // The forge owns the provider configuration (it is the process that talks to the
  // model); these routes are the UI's way to it. A forge error keeps its status and
  // message — a 422 for a bad model id is the user's to fix — while a forge that does
  // not answer at all becomes one 502 that says how to start it.
  function forgeFailure(err: unknown): AppError {
    if (err instanceof ForgeError) return new AppError(err.status, err.message);
    const message = err instanceof Error ? err.message : String(err);
    return new AppError(
      502,
      `the forge is not running at ${forgeUrl} — start it with npm run dev:forge (${message})`,
    );
  }

  app.get('/api/settings', async () => {
    const forgeHealth = await forge.health();
    const forgeView = { ...forgeHealth, url: forgeUrl };
    if (!forgeHealth.ok) return { forge: forgeView, settings: null };
    let settings: ForgeSettings;
    try {
      settings = await forge.getSettings();
    } catch (err) {
      throw forgeFailure(err);
    }
    return { forge: forgeView, settings };
  });

  app.put<{
    Body: {
      provider?: string;
      /** Blank or absent keeps whatever key the forge already has. */
      apiKey?: string;
      model?: string;
      ollamaBaseUrl?: string;
      ollamaModel?: string;
      ollamaNumCtx?: number;
    };
  }>('/api/settings', async (req) => {
    const body = req.body ?? {};
    const provider = (body.provider ?? '').trim().toLowerCase();
    if (!PROVIDERS.has(provider)) {
      throw new AppError(422, "provider must be 'claude' (Anthropic) or 'ollama'");
    }
    const apiKey = body.apiKey?.trim();
    const model = body.model?.trim();
    const ollamaBaseUrl = body.ollamaBaseUrl?.trim().replace(/\/+$/, '');
    const ollamaModel = body.ollamaModel?.trim();
    let settings: ForgeSettings;
    try {
      settings = await forge.setProvider({
        provider: provider as 'claude' | 'ollama',
        ollama_base_url: ollamaBaseUrl || undefined,
        ollama_model: ollamaModel || undefined,
        ollama_num_ctx: body.ollamaNumCtx,
      });
      if (apiKey) settings = await forge.setApiKey(apiKey);
      if (model) settings = await forge.setModel(model);
    } catch (err) {
      throw forgeFailure(err);
    }
    return { forge: { ok: true, url: forgeUrl }, settings };
  });

  app.delete('/api/settings/api-key', async () => {
    try {
      return { forge: { ok: true, url: forgeUrl }, settings: await forge.clearApiKey() };
    } catch (err) {
      throw forgeFailure(err);
    }
  });

  /**
   * The models an Ollama server has pulled, so the picker offers what can actually run.
   * Fetched from here rather than the browser: Ollama only answers cross-origin calls
   * from origins it was started to allow, and this server is already the one talking
   * to backends.
   */
  app.get<{ Querystring: { baseUrl?: string } }>('/api/settings/ollama-models', async (req) => {
    const raw = (req.query.baseUrl ?? '').trim() || DEFAULT_OLLAMA_URL;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new AppError(422, `baseUrl must be an http(s) URL, not '${raw}'`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new AppError(422, `baseUrl must be an http(s) URL, not '${raw}'`);
    }
    const origin = raw.replace(/\/+$/, '');
    let res: Response;
    try {
      res = await fetchImpl(`${origin}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError(
        502,
        `Ollama is not reachable at ${origin} — start it with \`ollama serve\` (${message})`,
      );
    }
    if (!res.ok) throw new AppError(502, `Ollama at ${origin} responded ${res.status}`);
    const body = (await res.json()) as {
      models?: Array<{ name: string; size?: number; details?: { parameter_size?: string } }>;
    };
    return {
      models: (body.models ?? []).map((m) => ({
        name: m.name,
        parameterSize: m.details?.parameter_size ?? null,
        bytes: m.size ?? 0,
      })),
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
    const lane = body.lane ?? 'deterministic';

    let mapping: SourceMapping | undefined;
    let parsed: ParsedSource;
    let name: string;
    let sourceKind: 'file' | 'tableau_server';
    try {
      // A mapping the converter half-understands would bind confidently wrong names, so
      // parseMappingFile throws — and that is the caller's input, not a server fault.
      mapping = body.mapping ? parseMappingFile(body.mapping) : undefined;
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
        if (!body.fileName || body.data == null) {
          throw new AppError(422, 'provide a fileName and data, or a tableauServer');
        }
        // A zero-byte upload base64-encodes to '' — the file was given, it just holds
        // nothing, and "provide a file" would send the user looking for the wrong thing.
        if (body.data === '') throw new AppError(422, `'${path.basename(body.fileName)}' is empty`);
        name = body.name ?? path.basename(body.fileName).replace(/\.[^.]+$/, '');
        parsed = parseSource(body.fileName, Buffer.from(body.data, 'base64'), name);
        sourceKind = 'file';
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(422, err instanceof Error ? err.message : String(err));
    }

    // The AI lane needs a report container to brief. Find that out before there is a run
    // row: a row created first and never enqueued would sit in 'queued' — polled by the
    // UI forever — until a restart's reconcile failed it.
    let briefing: ReturnType<typeof assembleBriefs> | undefined;
    if (lane === 'llm') {
      briefing = assembleBriefs(parsed, { mapping });
      if (briefing.briefs.length === 0) {
        throw new AppError(422, 'no Tableau report container in that file');
      }
    }

    const run = store.createRun({ sourceKind, workbookName: name, lane });
    const outDir = path.join(packRoot, run.id);

    // From here on a run row exists, so anything that breaks has to land ON the row:
    // an exception escaping to the error handler left the run 'queued' forever behind an
    // opaque 500, and the Run screen polled it until the next restart failed it.
    let result: ReturnType<typeof convertDeterministic>;
    try {
      result = convertDeterministic(parsed, { mapping });
      for (const [rel, content] of result.files) {
        const target = path.join(outDir, rel);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, content, 'utf8');
        store.addArtifact(run.id, target, artifactKind(rel), Buffer.byteLength(content, 'utf8'));
      }
      store.updateRun(run.id, { warnings: result.warnings });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      store.updateRun(run.id, { status: 'failed', error: `conversion failed: ${reason}` });
      throw new AppError(500, `conversion failed: ${reason}`);
    }

    if (lane === 'deterministic') {
      store.updateRun(run.id, { status: 'succeeded' });
      return runView(store.getRun(run.id)!, store.listArtifacts(run.id).length);
    }

    const { briefs, warnings } = briefing!;
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
      .header('content-disposition', contentDisposition(`${row.workbook_name}-pack.zip`));
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
    if (!store.listArtifacts(row.id).some((a) => a.kind === 'lvdash')) {
      throw new AppError(422, 'that run produced no dashboard to deploy');
    }
    try {
      const deployed = await deployPack(
        new LakeviewClient(auth, opts.lakeviewFetch),
        path.join(packRoot, row.id),
        {
          warehouseId: req.body.warehouseId,
          parentPath: req.body.parentPath,
          publish: req.body.publish === true,
        },
      );
      return { host: auth.host, deployed };
    } catch (err) {
      // Databricks answered with a status and a reason — a bad warehouse id, a missing
      // permission, a rejected dashboard. That is the user's to act on, so it must reach
      // them rather than be filed as an internal error.
      if (err instanceof DatabricksError) {
        const status = err.status >= 400 && err.status < 600 ? err.status : 502;
        throw new AppError(status, `Databricks: ${err.message}`);
      }
      throw err;
    }
  });

  // The built UI, when there is one. `serve` without a build is still a working API, so a
  // missing web/dist is not a boot failure — the serve command says so instead.
  const webRoot = opts.webRoot ?? resolveWebRoot(path.dirname(fileURLToPath(import.meta.url)));
  const hasUi = webRoot != null && existsSync(path.join(webRoot, 'index.html'));
  if (hasUi) app.register(fastifyStatic, { root: path.resolve(webRoot) });
  app.setNotFoundHandler((req, reply) => {
    // Single-page app: anything that is not an API route is the app's own routing.
    if (!req.url.startsWith('/api/') && hasUi) {
      reply.sendFile('index.html');
      return;
    }
    reply.status(404).send({ error: `no route ${req.method} ${req.url}` });
  });

  return app;
}
