// Row-value coercion shared by the Tableau connector (ported from Linetria connectors/util.ts). Live drivers hand back JS Dates, numeric
// strings, and BIT integers; staging wants ISO strings, numbers, and booleans.

import type { ExtractionPass, StagingBatch } from './staging.js';
import { RunCancelledError } from '../errors.js';

export const str = (v: unknown): string | null => {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
};

export const num = (v: unknown): number | null =>
  v == null || v === '' ? null : Number(v);

// Accepts driver booleans plus the textual forms CSV exports produce
// (psql: t/f, T-SQL bit: 1/0, JSON: true/false).
export const bool = (v: unknown): boolean => {
  if (v === true || v === 1) return true;
  if (typeof v !== 'string') return false;
  const s = v.toLowerCase();
  return s === '1' || s === 'true' || s === 't' || s === 'yes';
};

/**
 * Array-valued columns arrive as JS arrays (drivers), JSON arrays (JSONL uploads), or
 * Postgres array literals like {a,b} (CSV exports via \copy).
 */
export function strArray(v: unknown): string[] | null {
  if (v == null || v === '') return null;
  if (Array.isArray(v)) return v.map(String);
  const s = String(v).trim();
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      return Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      return null;
    }
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1);
    if (inner === '') return [];
    // Postgres array literal: elements quoted only when needed; \" escapes inside.
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (inQuotes) {
        if (ch === '\\') cur += inner[++i];
        else if (ch === '"') inQuotes = false;
        else cur += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ',') {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  }
  return [s];
}

/**
 * Bound a driver call that offers no native timeout (snowflake-sdk, @databricks/sql).
 * The statement may keep running server-side, but the run fails cleanly instead of
 * hanging in 'running' forever (design 2026-07-13 §3.2).
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Per-query ceiling for live metadata queries; env-overridable for huge estates. */
export function connectorQueryTimeoutMs(defaultMs = 300_000): number {
  const raw = Number(process.env.LINETRIA_CONNECTOR_QUERY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : defaultMs;
}

/** Case-tolerant column lookup (Snowflake upper-cases result columns). */
export function pick(row: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    if (row[n] !== undefined) return row[n];
    const upper = n.toUpperCase();
    if (row[upper] !== undefined) return row[upper];
  }
  return undefined;
}

/** Prominent warning when the core (tables) pass runs cleanly but returns nothing —
 *  a lineage tool with zero tables is almost always a scope/grant misconfiguration,
 *  so we surface it loudly without failing the run (design D2). */
export const EMPTY_CORE_WARNING =
  '0 tables extracted — the connection succeeded but no tables were returned; ' +
  'check the catalog/database scope and that USE/SELECT grants cover the intended schemas';

/**
 * Map a raw driver/HTTP error to an actionable, human-readable message. Single source of
 * truth for error wording — used by `guardedPass` (warnings) and the runner (the hard-fail
 * `error` field). Falls back to the raw message when nothing matches.
 */
export function describeConnectorError(
  err: unknown,
  ctx: { platform: string; step?: string },
): string {
  const raw = err instanceof Error ? err.message : String(err);
  // The @databricks/sql warehouse transport phrases a wrong HTTP path as exactly
  // "...bad HTTP status code: 404" — distinct from the Lakeview REST branch's "HTTP 404".
  if (ctx.platform === 'databricks' && /bad HTTP status code:\s*404/i.test(raw)) {
    return (
      'SQL warehouse HTTP path looks wrong — expected /sql/1.0/warehouses/<id>, ' +
      `not a browser/Data-Explorer URL (driver said: ${raw})`
    );
  }
  const status = /(?:HTTP|status(?: code)?:?)\s*(\d{3})/i.exec(raw)?.[1];
  if (status === '401' || status === '403') {
    return `authentication/authorization failed (HTTP ${status}) — check the token / service principal and its grants (${raw})`;
  }
  if (status === '404') {
    return `endpoint not found (HTTP 404) — check host / workspace / that the API is enabled (${raw})`;
  }
  return raw;
}

/**
 * Run one optional extraction pass; on throw, return a single warning batch for `pass`
 * instead of propagating (so the run keeps every pass that succeeded — design D3).
 * Cancellation is never swallowed. `build` returns an array so a block that yields more
 * than one batch (e.g. Azure's views+routines) fits the same shape.
 */
export async function guardedPass(
  pass: ExtractionPass,
  platform: string,
  build: () => Promise<StagingBatch[]>,
): Promise<StagingBatch[]> {
  try {
    return await build();
  } catch (err) {
    if (err instanceof RunCancelledError) throw err;
    return [
      {
        pass,
        warnings: [`${pass} pass failed — ${describeConnectorError(err, { platform, step: pass })}`],
      },
    ];
  }
}

/** Structured single-line stderr log for connector events (called by the runner, which is
 *  the only layer that knows runId/systemId). Keeps ops logs greppable. */
export function logConnectorEvent(
  level: 'warn' | 'error',
  ctx: { runId?: string; systemId?: string; platform: string; pass?: string; status?: number },
  message: string,
): void {
  const parts = ['bi-converter[connector]', `platform=${ctx.platform}`];
  if (ctx.pass) parts.push(`pass=${ctx.pass}`);
  if (ctx.systemId) parts.push(`system=${ctx.systemId}`);
  if (ctx.runId) parts.push(`run=${ctx.runId}`);
  if (ctx.status != null) parts.push(`status=${ctx.status}`);
  const line = `${parts.join(' ')}: ${message}`;
  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  // eslint-disable-next-line no-console
  else console.warn(line);
}
