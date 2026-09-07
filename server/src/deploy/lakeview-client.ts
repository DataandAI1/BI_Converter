import { fetch as undiciFetch } from 'undici';

/**
 * Databricks Lakeview REST client (spec §8.3) — the direct deploy path.
 *
 * The pack's own `deploy_dashboards.py` remains the in-pack path for customers who want
 * deployment in their own CI; this is the same three calls over HTTP so `bi-converter
 * deploy` needs no Python and no SDK:
 *
 *   POST  /api/2.0/lakeview/dashboards            create a draft
 *   PATCH /api/2.0/lakeview/dashboards/{id}       update it, etag-guarded
 *   POST  /api/2.0/lakeview/dashboards/{id}/published    publish
 *
 * No credential is ever written into an artifact: auth comes from the environment, and
 * this client only ever reads it.
 */

export type FetchLike = typeof undiciFetch;

export class DatabricksError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'DatabricksError';
  }
}

export interface LakeviewDashboard {
  dashboard_id: string;
  display_name: string;
  /** Concurrency token the update call must echo back; absent on some responses. */
  etag?: string;
  warehouse_id?: string;
  parent_path?: string;
  lifecycle_state?: string;
}

export interface DatabricksAuth {
  host: string;
  token?: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Read auth from explicit options, then the environment. A personal access token wins over
 * OAuth M2M when both are present, matching the SDK's own precedence.
 */
export function authFromEnv(
  overrides: { host?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): DatabricksAuth {
  const host = overrides.host ?? env.DATABRICKS_HOST ?? '';
  if (!host) {
    throw new Error(
      'no workspace host — pass --host or set DATABRICKS_HOST (e.g. https://ws.cloud.databricks.com)',
    );
  }
  const auth: DatabricksAuth = { host: host.replace(/\/+$/, '') };
  if (env.DATABRICKS_TOKEN) auth.token = env.DATABRICKS_TOKEN;
  else if (env.DATABRICKS_CLIENT_ID && env.DATABRICKS_CLIENT_SECRET) {
    auth.clientId = env.DATABRICKS_CLIENT_ID;
    auth.clientSecret = env.DATABRICKS_CLIENT_SECRET;
  } else {
    throw new Error(
      'no credential — set DATABRICKS_TOKEN, or the OAuth M2M pair DATABRICKS_CLIENT_ID ' +
        'and DATABRICKS_CLIENT_SECRET. Credentials are read from the environment and are ' +
        'never written into a pack.',
    );
  }
  return auth;
}

export class LakeviewClient {
  private readonly fetchImpl: FetchLike;
  /** Cached OAuth bearer, with the epoch-ms it stops being usable. */
  private oauth: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly auth: DatabricksAuth,
    fetchImpl?: FetchLike,
  ) {
    this.fetchImpl = fetchImpl ?? undiciFetch;
  }

  /**
   * A bearer token for the workspace. A PAT is used as-is; OAuth M2M exchanges the client
   * credentials at the workspace's own token endpoint and caches the result until a minute
   * before it expires, so a deploy of many dashboards is one exchange rather than N.
   */
  private async bearer(): Promise<string> {
    if (this.auth.token) return this.auth.token;
    const now = Date.now();
    if (this.oauth && this.oauth.expiresAt > now) return this.oauth.token;

    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'all-apis',
    });
    const basic = Buffer.from(`${this.auth.clientId}:${this.auth.clientSecret}`).toString('base64');
    const res = await this.fetchImpl(`${this.auth.host}/oidc/v1/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new DatabricksError(
        res.status,
        `OAuth token request failed (HTTP ${res.status}) — check DATABRICKS_CLIENT_ID / ` +
          `DATABRICKS_CLIENT_SECRET and that the service principal can reach ${this.auth.host}`,
        await res.text().catch(() => undefined),
      );
    }
    const json = (await res.json()) as { access_token: string; expires_in?: number };
    const ttl = (json.expires_in ?? 3600) * 1000;
    this.oauth = { token: json.access_token, expiresAt: now + ttl - 60_000 };
    return json.access_token;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(`${this.auth.host}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${await this.bearer()}`,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) {
      // The workspace's own message is far more useful than a status line — a 400 from
      // Lakeview usually names the offending widget or dataset.
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) detail = parsed.message;
      } catch {
        /* not JSON — the raw body is the best detail available */
      }
      throw new DatabricksError(res.status, `${method} ${path} failed (HTTP ${res.status}): ${detail}`, text);
    }
    return text ? JSON.parse(text) : {};
  }

  /**
   * Every dashboard the workspace holds, following pagination. Used to match an existing
   * dashboard by display name so a second deploy updates in place instead of creating a
   * duplicate — the same rule `deploy_dashboards.py` follows, so the two paths cannot
   * diverge on what counts as "the same dashboard".
   */
  async list(): Promise<LakeviewDashboard[]> {
    const out: LakeviewDashboard[] = [];
    let pageToken: string | undefined;
    do {
      const page = (await this.request(
        'GET',
        '/api/2.0/lakeview/dashboards',
        undefined,
        pageToken ? { page_token: pageToken, page_size: '100' } : { page_size: '100' },
      )) as { dashboards?: LakeviewDashboard[]; next_page_token?: string };
      out.push(...(page.dashboards ?? []));
      pageToken = page.next_page_token;
    } while (pageToken);
    return out;
  }

  async create(input: {
    displayName: string;
    warehouseId: string;
    serializedDashboard: string;
    parentPath?: string;
  }): Promise<LakeviewDashboard> {
    return (await this.request('POST', '/api/2.0/lakeview/dashboards', {
      display_name: input.displayName,
      warehouse_id: input.warehouseId,
      serialized_dashboard: input.serializedDashboard,
      ...(input.parentPath ? { parent_path: input.parentPath } : {}),
    })) as LakeviewDashboard;
  }

  /**
   * Update a draft in place. `etag` is the concurrency guard: passing the one the last read
   * returned means the workspace rejects the write if someone edited the dashboard in the
   * UI since. Omitting it is a last-write-wins overwrite, so callers should pass it.
   */
  async update(input: {
    dashboardId: string;
    displayName: string;
    warehouseId: string;
    serializedDashboard: string;
    etag?: string;
  }): Promise<LakeviewDashboard> {
    return (await this.request('PATCH', `/api/2.0/lakeview/dashboards/${input.dashboardId}`, {
      display_name: input.displayName,
      warehouse_id: input.warehouseId,
      serialized_dashboard: input.serializedDashboard,
      ...(input.etag ? { etag: input.etag } : {}),
    })) as LakeviewDashboard;
  }

  async publish(input: {
    dashboardId: string;
    warehouseId: string;
    embedCredentials?: boolean;
  }): Promise<unknown> {
    return await this.request(
      'POST',
      `/api/2.0/lakeview/dashboards/${input.dashboardId}/published`,
      {
        warehouse_id: input.warehouseId,
        // Default false: embedding the publisher's credentials makes every viewer query
        // run as them, which is a sharing decision the converter must not make silently.
        embed_credentials: input.embedCredentials ?? false,
      },
    );
  }
}
