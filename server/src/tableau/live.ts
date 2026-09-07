import type { QueryExecutor } from './executor.js';
import type { TableauConnectorConfig } from './index.js';

interface SigninResult {
  token: string;
  siteId: string;
}

/** Parses an env-configured MB cap, falling back to `fallback` for anything that
 *  isn't a finite, positive number — an unset var (`undefined`), a typo'd value
 *  (`'abc'`), or a nonsensical one (`'-5'`, `'0'`) must never silently produce
 *  `NaN`/0/negative caps downstream (a `buf.length > NaN * 1024 * 1024` comparison
 *  is always false, i.e. no cap at all — the opposite of the intended guard). */
function envCapMb(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Live wire executor for the Tableau REST + Metadata API (BI connectors plan Task 5, decision
 * 10). Three request shapes hide behind the one `QueryExecutor` seam: the `signin` stepId does
 * a REST `POST {server_url}/api/3.22/auth/signin` with the configured PAT, caching the
 * resulting token + site id; the `serverinfo` stepId does a REST
 * `GET {server_url}/api/3.22/serverinfo` (unauthenticated — the Metadata API GraphQL schema
 * has no server-version field, this is the only place Tableau exposes it); every other stepId
 * POSTs the request body (a GraphQL query+variables document built by queries.ts) to
 * `{server_url}/api/metadata/graphql` with the cached token attached. Uses global `fetch` (Node 18+) — no extra HTTP dependency, and
 * nothing here ever logs the PAT secret or the session token.
 */
export class TableauLiveExecutor implements QueryExecutor {
  private signinPromise?: Promise<SigninResult>;

  constructor(private readonly cfg: TableauConnectorConfig) {}

  private signin(): Promise<SigninResult> {
    this.signinPromise ??= (async () => {
      if (!this.cfg.server_url) throw new Error('tableau connection requires server_url');
      const res = await fetch(`${this.cfg.server_url}/api/3.22/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          credentials: {
            personalAccessTokenName: this.cfg.pat_name,
            personalAccessTokenSecret: this.cfg.pat_secret,
            site: { contentUrl: this.cfg.site_content_url ?? '' },
          },
        }),
      });
      if (!res.ok) {
        throw new Error(`Tableau signin failed: HTTP ${res.status}`);
      }
      const body = (await res.json()) as {
        credentials?: { token?: string; site?: { id?: string } };
      };
      const token = body.credentials?.token;
      const siteId = body.credentials?.site?.id;
      if (!token || !siteId) {
        throw new Error("Tableau signin response is missing credentials.token/credentials.site.id");
      }
      return { token, siteId };
    })();
    return this.signinPromise;
  }

  async execute(requestJson: string, stepId: string): Promise<Array<Record<string, unknown>>> {
    if (stepId === 'signin') {
      const { siteId } = await this.signin();
      return [{ json: { site: { id: siteId } } }];
    }
    if (stepId === 'serverinfo') {
      if (!this.cfg.server_url) throw new Error('tableau connection requires server_url');
      const res = await fetch(`${this.cfg.server_url}/api/3.22/serverinfo`, {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`Tableau REST serverinfo request failed: HTTP ${res.status}`);
      }
      return [{ json: await res.json() }];
    }
    const binaryPrefix = stepId.startsWith('content:') ? 'content' : stepId.startsWith('image:') ? 'image' : null;
    if (binaryPrefix) {
      const { token, siteId } = await this.signin();
      const luid = stepId.slice(binaryPrefix.length + 1);
      const url =
        binaryPrefix === 'content'
          ? `${this.cfg.server_url}/api/3.22/sites/${siteId}/workbooks/${luid}/content?includeExtract=false`
          : `${this.cfg.server_url}/api/3.22/sites/${siteId}/views/${luid}/image?resolution=high`;
      const res = await fetch(url, { headers: { 'X-Tableau-Auth': token } });
      if (!res.ok) {
        throw new Error(`Tableau REST ${binaryPrefix} request for '${luid}' failed: HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const capMb =
        binaryPrefix === 'content'
          ? envCapMb(process.env.LINETRIA_TABLEAU_MAX_CONTENT_MB, 50)
          : envCapMb(process.env.LINETRIA_TABLEAU_MAX_IMAGE_MB, 4);
      if (buf.length > capMb * 1024 * 1024) {
        throw new Error(
          `Tableau ${binaryPrefix} response for '${luid}' is ${(buf.length / 1048576).toFixed(1)}MB — ` +
            `exceeds the ${capMb}MB cap (LINETRIA_TABLEAU_MAX_${binaryPrefix === 'content' ? 'CONTENT' : 'IMAGE'}_MB)`,
        );
      }
      return [{
        base64: buf.toString('base64'),
        contentType:
          res.headers.get('content-type') ??
          (binaryPrefix === 'image' ? 'image/png' : 'application/octet-stream'),
        byteLength: buf.length,
      }];
    }
    const { token } = await this.signin();
    const res = await fetch(`${this.cfg.server_url}/api/metadata/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tableau-Auth': token },
      body: requestJson,
    });
    if (!res.ok) {
      throw new Error(`Tableau Metadata API request '${stepId}' failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as { errors?: Array<{ message: string }> };
    if (body.errors && body.errors.length > 0) {
      throw new Error(
        `Tableau Metadata API request '${stepId}' returned errors: ${body.errors
          .map((e) => e.message)
          .join('; ')}`,
      );
    }
    return [{ json: body }];
  }

  async close(): Promise<void> {
    // Tableau REST sessions expire on their own (no persistent connection to release);
    // an explicit signout is a nice-to-have, not required for correctness here.
  }
}
