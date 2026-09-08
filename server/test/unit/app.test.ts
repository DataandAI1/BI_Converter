import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { buildServer, resolveWebRoot } from '../../src/api/app.js';
import { ForgeClient } from '../../src/forge/client.js';
import type { FetchLike } from '../../src/deploy/lakeview-client.js';
import { RunStore } from '../../src/store/store.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/tableau/files/', import.meta.url));
const upload = (file: string) => ({
  fileName: file,
  data: fs.readFileSync(path.join(FIXTURES, file)).toString('base64'),
});

/**
 * The HTTP surface behind `bi-converter serve`: the built UI must actually be served
 * from the compiled server, and the settings routes must round-trip the forge's
 * provider configuration without ever echoing a raw key.
 */

let dir: string;
let store: RunStore;
let app: FastifyInstance | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-converter-app-'));
  store = new RunStore(path.join(dir, 'state'));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const FORGE_SETTINGS = {
  provider: 'claude',
  provider_source: null,
  ollama_base_url: 'http://localhost:11434',
  ollama_model: 'llama3.1',
  ollama_num_ctx: 32768,
  llm_ready: false,
  api_key_configured: false,
  api_key_masked: null,
  api_key_source: null,
  model: 'claude-fable-5',
  model_source: null,
  available_models: [{ id: 'claude-fable-5', label: 'Claude Fable 5', description: '', supports_effort: true }],
};

type Call = { method: string; path: string; body: unknown };

/** A forge stand-in that records every call and answers like the real settings routes. */
function fakeForge(opts: { down?: boolean; state?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const state = { ...FORGE_SETTINGS, ...(opts.state ?? {}) };
  const fetchImpl = (async (input: string | URL, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input));
    if (opts.down) throw new Error('ECONNREFUSED');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path: url.pathname, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/healthz') return json(200, { status: 'ok', version: 'test' });
    if (url.pathname === '/settings' && method === 'GET') return json(200, state);
    if (url.pathname === '/settings/provider') {
      if (body.provider !== 'claude' && body.provider !== 'ollama') {
        return json(422, { detail: `unknown provider '${body.provider}'` });
      }
      Object.assign(state, { provider: body.provider });
      if (body.ollama_base_url) state.ollama_base_url = body.ollama_base_url;
      if (body.ollama_model) state.ollama_model = body.ollama_model;
      state.llm_ready = state.provider === 'ollama' || state.api_key_configured;
      return json(200, state);
    }
    if (url.pathname === '/settings/model') {
      Object.assign(state, { model: body.model, model_source: 'runtime' });
      return json(200, state);
    }
    if (url.pathname === '/settings/api-key' && method === 'POST') {
      Object.assign(state, {
        api_key_configured: true,
        api_key_masked: `${body.api_key.slice(0, 5)}…${body.api_key.slice(-4)}`,
        api_key_source: 'runtime',
      });
      state.llm_ready = true;
      return json(200, state);
    }
    if (url.pathname === '/settings/api-key' && method === 'DELETE') {
      Object.assign(state, { api_key_configured: false, api_key_masked: null, api_key_source: null });
      state.llm_ready = state.provider === 'ollama';
      return json(200, state);
    }
    return json(404, { detail: `no route ${method} ${url.pathname}` });
  }) as unknown as ConstructorParameters<typeof ForgeClient>[1];
  return { calls, state, client: new ForgeClient('http://forge.test', fetchImpl) };
}

describe('resolveWebRoot', () => {
  it('finds web/dist above the compiled server, however deep the module sits', () => {
    // The compiled module lives at server/dist/src/api/app.js — four levels below the
    // repo root — while the source module is three below. Both must find the UI.
    fs.mkdirSync(path.join(dir, 'web', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'web', 'dist', 'index.html'), '<!doctype html>');
    const compiled = path.join(dir, 'server', 'dist', 'src', 'api');
    const source = path.join(dir, 'server', 'src', 'api');
    fs.mkdirSync(compiled, { recursive: true });
    fs.mkdirSync(source, { recursive: true });
    expect(resolveWebRoot(compiled)).toBe(path.join(dir, 'web', 'dist'));
    expect(resolveWebRoot(source)).toBe(path.join(dir, 'web', 'dist'));
  });

  it('is undefined when the UI was never built', () => {
    const compiled = path.join(dir, 'server', 'dist', 'src', 'api');
    fs.mkdirSync(compiled, { recursive: true });
    expect(resolveWebRoot(compiled)).toBeUndefined();
  });
});

describe('serving the UI', () => {
  it('serves index.html at / and for client-side routes, and JSON 404s under /api', async () => {
    const webRoot = path.join(dir, 'web', 'dist');
    fs.mkdirSync(webRoot, { recursive: true });
    fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>ui</title>');
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: fakeForge().client, webRoot });

    const root = await app.inject({ method: 'GET', url: '/' });
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain('<title>ui</title>');

    const deep = await app.inject({ method: 'GET', url: '/runs/abc' });
    expect(deep.statusCode).toBe(200);
    expect(deep.body).toContain('<title>ui</title>');

    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: 'no route GET /api/nope' });
  });
});

describe('GET /api/health', () => {
  it('reports the forge and whether its LLM provider is ready to author', async () => {
    const forge = fakeForge({ state: { provider: 'ollama', llm_ready: true, ollama_model: 'qwen3' } });
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: forge.client });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      forge: { ok: true, version: 'test', url: 'http://forge.test' },
      llm: { ready: true, provider: 'ollama', model: 'qwen3' },
    });
  });

  it('says the LLM is not ready when the forge is down', async () => {
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: fakeForge({ down: true }).client });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({
      ok: true,
      forge: { ok: false, url: 'http://forge.test' },
      llm: { ready: false, provider: null, model: null },
    });
  });
});

describe('settings', () => {
  it('GET /api/settings returns the forge settings, masked key and all', async () => {
    const forge = fakeForge({
      state: { api_key_configured: true, api_key_masked: 'sk-an…wxyz', api_key_source: 'env', llm_ready: true },
    });
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: forge.client });
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.forge).toEqual({ ok: true, version: 'test', url: 'http://forge.test' });
    expect(body.settings.api_key_masked).toBe('sk-an…wxyz');
    expect(body.settings.available_models[0].id).toBe('claude-fable-5');
    expect(JSON.stringify(body)).not.toContain('api_key":');
  });

  it('GET /api/settings has null settings, not an error, when the forge is down', async () => {
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: fakeForge({ down: true }).client });
    const res = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ forge: { ok: false, url: 'http://forge.test' }, settings: null });
  });

  it('PUT /api/settings applies provider, key and model to the forge in one round trip', async () => {
    const forge = fakeForge();
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: forge.client });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { provider: 'claude', apiKey: 'sk-ant-secret-key-1234', model: 'claude-fable-5' },
    });
    expect(res.statusCode).toBe(200);
    expect(forge.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /settings/provider',
      'POST /settings/api-key',
      'POST /settings/model',
    ]);
    const body = res.json();
    expect(body.settings.llm_ready).toBe(true);
    expect(body.settings.api_key_masked).toBe('sk-an…1234');
    expect(JSON.stringify(body)).not.toContain('sk-ant-secret-key-1234');
  });

  it('PUT /api/settings switches to Ollama with its connection details, no key needed', async () => {
    const forge = fakeForge();
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: forge.client });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { provider: 'ollama', ollamaBaseUrl: 'http://gpu-box:11434/', ollamaModel: 'qwen3:32b' },
    });
    expect(res.statusCode).toBe(200);
    expect(forge.calls).toEqual([
      {
        method: 'POST',
        path: '/settings/provider',
        body: { provider: 'ollama', ollama_base_url: 'http://gpu-box:11434', ollama_model: 'qwen3:32b' },
      },
    ]);
    expect(res.json().settings).toMatchObject({ provider: 'ollama', ollama_model: 'qwen3:32b', llm_ready: true });
  });

  it('PUT /api/settings rejects an unknown provider before touching the forge', async () => {
    const forge = fakeForge();
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: forge.client });
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { provider: 'openai' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/provider/);
    expect(forge.calls).toEqual([]);
  });

  it('PUT /api/settings is a 502 with a start hint when the forge is down', async () => {
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: fakeForge({ down: true }).client });
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { provider: 'ollama' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/forge.*not running.*dev:forge/);
  });

  it('DELETE /api/settings/api-key clears the runtime key', async () => {
    const forge = fakeForge({ state: { api_key_configured: true, api_key_masked: 'sk-an…1234', llm_ready: true } });
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: forge.client });
    const res = await app.inject({ method: 'DELETE', url: '/api/settings/api-key' });
    expect(res.statusCode).toBe(200);
    expect(forge.calls).toEqual([{ method: 'DELETE', path: '/settings/api-key', body: undefined }]);
    expect(res.json().settings.api_key_configured).toBe(false);
  });
});

describe('GET /api/settings/ollama-models', () => {
  it('lists the models an Ollama server has pulled', async () => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL) => {
      seen.push(String(input));
      return new Response(
        JSON.stringify({
          models: [
            { name: 'qwen3:32b', size: 20_000_000_000, details: { parameter_size: '32B', family: 'qwen3' } },
            { name: 'llama3.1:latest', size: 4_700_000_000, details: { parameter_size: '8B' } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: fakeForge().client, fetchImpl });
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/ollama-models?baseUrl=' + encodeURIComponent('http://localhost:11434/'),
    });
    expect(res.statusCode).toBe(200);
    expect(seen).toEqual(['http://localhost:11434/api/tags']);
    expect(res.json()).toEqual({
      models: [
        { name: 'qwen3:32b', parameterSize: '32B', bytes: 20_000_000_000 },
        { name: 'llama3.1:latest', parameterSize: '8B', bytes: 4_700_000_000 },
      ],
    });
  });

  it('is a 502 that says how to start Ollama when nothing answers', async () => {
    const fetchImpl = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: fakeForge().client, fetchImpl });
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/ollama-models?baseUrl=' + encodeURIComponent('http://localhost:11434'),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toMatch(/Ollama.*http:\/\/localhost:11434.*ollama serve/);
  });

  it('refuses a base URL that is not http(s)', async () => {
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: fakeForge().client });
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings/ollama-models?baseUrl=' + encodeURIComponent('file:///etc/passwd'),
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('POST /api/convert — input that is the caller\'s to fix', () => {
  it('converts a workbook deterministically and records its artifacts', async () => {
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: fakeForge().client });
    const res = await app.inject({
      method: 'POST',
      url: '/api/convert',
      payload: { ...upload('sample.twb'), lane: 'deterministic' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'succeeded', lane: 'deterministic' });
    expect(res.json().artifacts).toBeGreaterThan(0);
  });

  it('answers a malformed source mapping with a 422 that says what is wrong, not a 500', async () => {
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: fakeForge().client });
    const res = await app.inject({
      method: 'POST',
      url: '/api/convert',
      payload: { ...upload('sample.twb'), lane: 'deterministic', mapping: 'mappings:\n  - databricks: { catalog: main }\n' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/mappings\[0\].*tableau/);
    expect(store.listRuns(10)).toEqual([]);
  });
});

describe('POST /api/runs/:id/deploy', () => {
  const saved = { host: process.env.DATABRICKS_HOST, token: process.env.DATABRICKS_TOKEN };
  beforeEach(() => {
    process.env.DATABRICKS_HOST = 'https://ws.test';
    process.env.DATABRICKS_TOKEN = 'dapi-test';
  });
  afterEach(() => {
    if (saved.host == null) delete process.env.DATABRICKS_HOST;
    else process.env.DATABRICKS_HOST = saved.host;
    if (saved.token == null) delete process.env.DATABRICKS_TOKEN;
    else process.env.DATABRICKS_TOKEN = saved.token;
  });

  async function convertedRun(server: FastifyInstance): Promise<string> {
    const res = await server.inject({
      method: 'POST',
      url: '/api/convert',
      payload: { ...upload('sample.twb'), lane: 'deterministic' },
    });
    return res.json().id as string;
  }

  it("carries Databricks' own status and reason back instead of an opaque 500", async () => {
    const lakeviewFetch = (async () =>
      new Response(JSON.stringify({ message: 'warehouse abc123 not found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })) as unknown as FetchLike;
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: fakeForge().client, lakeviewFetch });
    const id = await convertedRun(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${id}/deploy`,
      payload: { warehouseId: 'abc123' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/Databricks.*HTTP 404.*warehouse abc123 not found/);
  });

  it('is a 422 when the run has no dashboard to deploy', async () => {
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: fakeForge().client });
    const run = store.createRun({ sourceKind: 'file', workbookName: 'empty', lane: 'deterministic' });
    store.updateRun(run.id, { status: 'succeeded' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/runs/${run.id}/deploy`,
      payload: { warehouseId: 'abc123' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/no dashboard/);
  });
});

describe('cross-origin access', () => {
  it('does not reflect an arbitrary Origin — the UI is same-origin, other pages get nothing', async () => {
    app = buildServer({ store, forgeUrl: 'http://forge.test', forge: fakeForge().client });
    const res = await app.inject({
      method: 'GET',
      url: '/api/runs',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/settings',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });
});
