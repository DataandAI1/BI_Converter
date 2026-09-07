import type { BiDescriptor } from '../model/types.js';

/**
 * Descriptor normalization, lifted from Linetria's `stitch/descriptors.ts`. Linetria used
 * this to match a BI connection descriptor against *registered* source systems in its
 * catalog; BI_Converter has no catalog, so only the normalization half comes over — it is
 * what `bind/resolve.ts` and `convert/shared.ts` use to compare a Tableau connection with
 * a mapping-file entry. Matching stays exact after normalization, never fuzzy (spec §6).
 */

// Normalization (never fuzzy): lowercase host, strip scheme/default ports. The relevant
// identity fields are platform-specific — snowflake matches on account locator only,
// databricks on workspace host only, azure_sql/synapse/postgres on host+database.
const DEFAULT_PORTS: Record<string, string> = {
  postgres: '5432',
  azure_sql: '1433',
  synapse_dedicated: '1433',
  synapse_serverless: '1433',
  databricks: '443',
};

function normalizeHost(raw: string | null | undefined, platform: string): string {
  if (!raw) return '';
  let h = raw.trim().toLowerCase();
  h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // strip scheme
  const slash = h.indexOf('/');
  if (slash !== -1) h = h.slice(0, slash); // strip any trailing path
  const m = h.match(/^(.*):(\d+)$/);
  if (m && DEFAULT_PORTS[platform] === m[2]) h = m[1]; // strip the platform's default port
  return h;
}

export function normalizeDescriptor(d: BiDescriptor): string {
  const platform = (d.platform_hint ?? '').trim().toLowerCase();
  const account = (d.account ?? '').trim().toLowerCase();
  const database = (d.database ?? '').trim().toLowerCase();
  switch (platform) {
    case 'snowflake':
      return `snowflake|account=${account}`;
    case 'databricks':
      return `databricks|host=${normalizeHost(d.host, platform)}`;
    case 'azure_sql':
    case 'synapse_dedicated':
    case 'synapse_serverless':
      return `${platform}|host=${normalizeHost(d.host, platform)}|db=${database}`;
    case 'postgres':
      return `postgres|host=${normalizeHost(d.host, platform)}|db=${database}`;
    default:
      // Unknown/future platform_hint: fall back to every field so the key is still
      // deterministic and distinct, rather than guessing which fields matter.
      return `${platform}|host=${normalizeHost(d.host, platform)}|account=${account}|db=${database}`;
  }
}

export function parsePostgresConnectionString(cs: string): { host: string; database: string } | null {
  try {
    const url = new URL(cs);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
    if (!url.hostname || !database) return null;
    return { host: url.port ? `${url.hostname}:${url.port}` : url.hostname, database };
  } catch {
    return null;
  }
}
