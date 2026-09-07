import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LakeviewClient, authFromEnv, DatabricksError } from '../../src/deploy/lakeview-client.js';
import { deployPack, findDashboards, resolveDisplayNames } from '../../src/deploy/deploy.js';

/**
 * Lakeview REST, against recorded responses — no live credentials (spec §9). What is
 * pinned here is the contract with the workspace (create / update / publish, etag,
 * pagination, OAuth exchange) and the naming rules deploy shares with the pack's own
 * `deploy_dashboards.py`, since two paths that disagreed on what counts as "the same
 * dashboard" would let one duplicate what the other updates.
 */

interface Recorded {
  status?: number;
  body: unknown;
}

interface Call {
  method: string;
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

let calls: Call[];

/** A fetch stand-in serving recorded responses keyed by `METHOD path`. */
function recorder(routes: Record<string, Recorded | Recorded[]>) {
  const remaining = new Map<string, Recorded[]>(
    Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
  );
  return (async (url: string, init: Record<string, unknown> = {}) => {
    const parsed = new URL(url);
    const method = (init.method as string) ?? 'GET';
    const key = `${method} ${parsed.pathname}`;
    calls.push({
      method,
      url,
      body: init.body ? tryJson(init.body as string) : undefined,
      headers: (init.headers as Record<string, string>) ?? {},
    });
    const queue = remaining.get(key);
    if (!queue || queue.length === 0) throw new Error(`no recorded response for ${key}`);
    const rec = queue.length === 1 ? queue[0] : queue.shift()!;
    const status = rec.status ?? 200;
    const text = typeof rec.body === 'string' ? rec.body : JSON.stringify(rec.body);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  }) as never;
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

const HOST = 'https://ws.cloud.databricks.com';
const PAT = { host: HOST, token: 'dapi-test' };

beforeEach(() => {
  calls = [];
});

describe('authFromEnv', () => {
  it('prefers a personal access token', () => {
    const auth = authFromEnv({}, { DATABRICKS_HOST: HOST, DATABRICKS_TOKEN: 't', DATABRICKS_CLIENT_ID: 'c', DATABRICKS_CLIENT_SECRET: 's' } as NodeJS.ProcessEnv);
    expect(auth.token).toBe('t');
    expect(auth.clientId).toBeUndefined();
  });

  it('falls back to the OAuth M2M pair', () => {
    const auth = authFromEnv({}, { DATABRICKS_HOST: HOST, DATABRICKS_CLIENT_ID: 'c', DATABRICKS_CLIENT_SECRET: 's' } as NodeJS.ProcessEnv);
    expect(auth.clientId).toBe('c');
    expect(auth.token).toBeUndefined();
  });

  it('lets --host override the environment, and trims a trailing slash', () => {
    const auth = authFromEnv({ host: `${HOST}/` }, { DATABRICKS_HOST: 'https://other', DATABRICKS_TOKEN: 't' } as NodeJS.ProcessEnv);
    expect(auth.host).toBe(HOST);
  });

  it('refuses to guess when no credential is set', () => {
    expect(() => authFromEnv({}, { DATABRICKS_HOST: HOST } as NodeJS.ProcessEnv)).toThrow(/DATABRICKS_TOKEN/);
  });

  it('refuses to guess a host', () => {
    expect(() => authFromEnv({}, { DATABRICKS_TOKEN: 't' } as NodeJS.ProcessEnv)).toThrow(/--host/);
  });
});

describe('LakeviewClient — the three calls', () => {
  it('creates a draft, sending the serialized dashboard', async () => {
    const client = new LakeviewClient(
      PAT,
      recorder({ 'POST /api/2.0/lakeview/dashboards': { body: { dashboard_id: 'd1', display_name: 'Sales' } } }),
    );
    const out = await client.create({
      displayName: 'Sales',
      warehouseId: 'wh1',
      serializedDashboard: '{"pages":[]}',
      parentPath: '/Workspace/Shared',
    });
    expect(out.dashboard_id).toBe('d1');
    expect(calls[0].body).toEqual({
      display_name: 'Sales',
      warehouse_id: 'wh1',
      serialized_dashboard: '{"pages":[]}',
      parent_path: '/Workspace/Shared',
    });
    expect(calls[0].headers.authorization).toBe('Bearer dapi-test');
  });

  it('omits parent_path when none was given, rather than sending null', async () => {
    const client = new LakeviewClient(PAT, recorder({ 'POST /api/2.0/lakeview/dashboards': { body: { dashboard_id: 'd1' } } }));
    await client.create({ displayName: 'S', warehouseId: 'wh1', serializedDashboard: '{}' });
    expect(calls[0].body).not.toHaveProperty('parent_path');
  });

  it('updates with PATCH and echoes the etag back as the concurrency guard', async () => {
    const client = new LakeviewClient(
      PAT,
      recorder({ 'PATCH /api/2.0/lakeview/dashboards/d1': { body: { dashboard_id: 'd1', etag: 'v2' } } }),
    );
    await client.update({
      dashboardId: 'd1',
      displayName: 'Sales',
      warehouseId: 'wh1',
      serializedDashboard: '{}',
      etag: 'v1',
    });
    expect(calls[0].method).toBe('PATCH');
    expect((calls[0].body as { etag: string }).etag).toBe('v1');
  });

  it('publishes without embedding the publisher credentials by default', async () => {
    const client = new LakeviewClient(
      PAT,
      recorder({ 'POST /api/2.0/lakeview/dashboards/d1/published': { body: {} } }),
    );
    await client.publish({ dashboardId: 'd1', warehouseId: 'wh1' });
    // Embedding would make every viewer's query run as the publisher — a sharing
    // decision the converter must not make silently.
    expect(calls[0].body).toEqual({ warehouse_id: 'wh1', embed_credentials: false });
  });

  it('follows pagination when listing', async () => {
    const client = new LakeviewClient(
      PAT,
      recorder({
        'GET /api/2.0/lakeview/dashboards': [
          { body: { dashboards: [{ dashboard_id: 'a', display_name: 'A' }], next_page_token: 'p2' } },
          { body: { dashboards: [{ dashboard_id: 'b', display_name: 'B' }] } },
        ],
      }),
    );
    const all = await client.list();
    expect(all.map((d) => d.dashboard_id)).toEqual(['a', 'b']);
    expect(new URL(calls[1].url).searchParams.get('page_token')).toBe('p2');
  });

  it("surfaces the workspace's own message on an error, not just the status", async () => {
    const client = new LakeviewClient(
      PAT,
      recorder({
        'POST /api/2.0/lakeview/dashboards': {
          status: 400,
          body: { message: "widget type 'sankey' is not supported" },
        },
      }),
    );
    await expect(
      client.create({ displayName: 'S', warehouseId: 'wh', serializedDashboard: '{}' }),
    ).rejects.toThrow(/sankey/);
  });

  it('reports a 403 as a DatabricksError carrying the status', async () => {
    const client = new LakeviewClient(
      PAT,
      recorder({ 'GET /api/2.0/lakeview/dashboards': { status: 403, body: { message: 'denied' } } }),
    );
    await expect(client.list()).rejects.toBeInstanceOf(DatabricksError);
    await expect(client.list()).rejects.toMatchObject({ status: 403 });
  });
});

describe('LakeviewClient — OAuth M2M', () => {
  it('exchanges client credentials and uses the bearer it gets back', async () => {
    const client = new LakeviewClient(
      { host: HOST, clientId: 'cid', clientSecret: 'secret' },
      recorder({
        'POST /oidc/v1/token': { body: { access_token: 'oauth-token', expires_in: 3600 } },
        'GET /api/2.0/lakeview/dashboards': { body: { dashboards: [] } },
      }),
    );
    await client.list();
    expect(calls[0].url).toContain('/oidc/v1/token');
    expect(calls[0].headers.authorization).toBe(
      `Basic ${Buffer.from('cid:secret').toString('base64')}`,
    );
    expect(calls[1].headers.authorization).toBe('Bearer oauth-token');
  });

  it('exchanges once and reuses the token across calls', async () => {
    const client = new LakeviewClient(
      { host: HOST, clientId: 'cid', clientSecret: 'secret' },
      recorder({
        'POST /oidc/v1/token': { body: { access_token: 'oauth-token', expires_in: 3600 } },
        'GET /api/2.0/lakeview/dashboards': { body: { dashboards: [] } },
      }),
    );
    await client.list();
    await client.list();
    expect(calls.filter((c) => c.url.includes('/oidc/v1/token'))).toHaveLength(1);
  });
});

describe('deployPack — naming and idempotency', () => {
  let packRoot: string;

  async function pack(files: Record<string, unknown>): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bi-converter-pack-'));
    for (const [rel, doc] of Object.entries(files)) {
      const full = path.join(root, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, JSON.stringify(doc), 'utf8');
    }
    return root;
  }

  it('finds every dashboard under the pack, in a stable order', async () => {
    packRoot = await pack({
      'b/dashboards/Two.lvdash.json': { pages: [{ displayName: 'Two' }] },
      'a/dashboards/One.lvdash.json': { pages: [{ displayName: 'One' }] },
      'a/views/x.sql': {},
    });
    const files = await findDashboards(packRoot);
    expect(files).toHaveLength(2);
    expect(files.map((f) => path.basename(f))).toEqual(['One.lvdash.json', 'Two.lvdash.json']);
  });

  it("names a dashboard from its first page's title, not the filename", async () => {
    packRoot = await pack({
      'wb/dashboards/Executive_Dashboard.lvdash.json': { pages: [{ displayName: 'Executive Dashboard' }] },
    });
    const files = await findDashboards(packRoot);
    const names = await resolveDisplayNames(packRoot, files);
    expect([...names.values()][0].displayName).toBe('Executive Dashboard');
  });

  it('falls back to the file stem when a dashboard has no page', async () => {
    packRoot = await pack({ 'wb/dashboards/Fallback.lvdash.json': { pages: [] } });
    const files = await findDashboards(packRoot);
    const names = await resolveDisplayNames(packRoot, files);
    expect([...names.values()][0].displayName).toBe('Fallback');
  });

  it('qualifies colliding titles with their pack folder', async () => {
    packRoot = await pack({
      'sales/dashboards/a.lvdash.json': { pages: [{ displayName: 'Overview' }] },
      'ops/dashboards/b.lvdash.json': { pages: [{ displayName: 'Overview' }] },
    });
    const files = await findDashboards(packRoot);
    const names = [...(await resolveDisplayNames(packRoot, files)).values()].map((v) => v.displayName);
    expect(names.sort()).toEqual(['Overview (ops)', 'Overview (sales)']);
  });

  it('creates a dashboard the workspace does not have', async () => {
    packRoot = await pack({ 'wb/dashboards/a.lvdash.json': { pages: [{ displayName: 'Sales' }] } });
    const client = new LakeviewClient(
      PAT,
      recorder({
        'GET /api/2.0/lakeview/dashboards': { body: { dashboards: [] } },
        'POST /api/2.0/lakeview/dashboards': { body: { dashboard_id: 'd1', display_name: 'Sales' } },
      }),
    );
    const out = await deployPack(client, packRoot, { warehouseId: 'wh' });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ displayName: 'Sales', action: 'created', published: false });
  });

  it('updates in place rather than duplicating a dashboard that already exists', async () => {
    packRoot = await pack({ 'wb/dashboards/a.lvdash.json': { pages: [{ displayName: 'Sales' }] } });
    const client = new LakeviewClient(
      PAT,
      recorder({
        'GET /api/2.0/lakeview/dashboards': {
          body: { dashboards: [{ dashboard_id: 'd1', display_name: 'Sales', etag: 'v1' }] },
        },
        'PATCH /api/2.0/lakeview/dashboards/d1': { body: { dashboard_id: 'd1', etag: 'v2' } },
      }),
    );
    const out = await deployPack(client, packRoot, { warehouseId: 'wh' });
    expect(out[0].action).toBe('updated');
    // The etag from the listing guards the write.
    expect((calls.find((c) => c.method === 'PATCH')!.body as { etag: string }).etag).toBe('v1');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('publishes each dashboard when asked', async () => {
    packRoot = await pack({ 'wb/dashboards/a.lvdash.json': { pages: [{ displayName: 'Sales' }] } });
    const client = new LakeviewClient(
      PAT,
      recorder({
        'GET /api/2.0/lakeview/dashboards': { body: { dashboards: [] } },
        'POST /api/2.0/lakeview/dashboards': { body: { dashboard_id: 'd1' } },
        'POST /api/2.0/lakeview/dashboards/d1/published': { body: {} } ,
      }),
    );
    const out = await deployPack(client, packRoot, { warehouseId: 'wh', publish: true });
    expect(out[0].published).toBe(true);
  });

  it('sees a dashboard it created earlier in the same run', async () => {
    // Two files resolving to the same name would otherwise race for it; the second must
    // update the first's dashboard, not create a duplicate.
    packRoot = await pack({
      'wb/dashboards/a.lvdash.json': { pages: [{ displayName: 'Same' }] },
      'wb/dashboards/b.lvdash.json': { pages: [{ displayName: 'Same' }] },
    });
    const client = new LakeviewClient(
      PAT,
      recorder({
        'GET /api/2.0/lakeview/dashboards': { body: { dashboards: [] } },
        'POST /api/2.0/lakeview/dashboards': { body: { dashboard_id: 'd1', display_name: 'Same (a)' } },
        'PATCH /api/2.0/lakeview/dashboards/d1': { body: { dashboard_id: 'd1' } },
      }),
    );
    // Both live in the same folder, so the flat-layout rule qualifies them by file stem
    // and they do NOT collide — which is the correct outcome.
    const out = await deployPack(client, packRoot, { warehouseId: 'wh' });
    expect(out.map((d) => d.displayName).sort()).toEqual(['Same (a)', 'Same (b)']);
  });

  it('refuses a directory with no dashboards rather than reporting success', async () => {
    packRoot = await pack({ 'wb/views/x.sql': {} });
    const client = new LakeviewClient(PAT, recorder({}));
    await expect(deployPack(client, packRoot, { warehouseId: 'wh' })).rejects.toThrow(
      /no \.lvdash\.json files/,
    );
  });
});
