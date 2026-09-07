import type { BiBindingRef, BiDescriptor } from '../model/types.js';
import { parsePostgresConnectionString } from '../tableau/descriptors.js';

/**
 * Shared pieces of the BI migration generators (Migration → BI platforms page):
 * manifest shapes mirroring the DDL script pack's, descriptor resolution from a
 * registered system's connection_config, the canonical/Tableau → tabular-model type
 * map, M source-expression construction, and the deliberately tiny Tableau-calc → DAX
 * translator. Anything beyond the trivially-mechanical ships verbatim with a
 * needs_review flag — cross-platform semantics are scaffolded, never machine-translated
 * (same honesty ethos as migration/scriptgen.ts).
 */

/** BI platforms a rebuild pack / forge build can target; [0] is the project default.
 *  Single canonical const — migration/bi/rebuild.ts and build/forge-client.ts
 *  re-export it (this module is the lowest-level shared home, import-cycle-safe). */
export const BI_REBUILD_TARGETS = ['power_bi', 'tableau', 'databricks'] as const;
export type BiRebuildTarget = (typeof BI_REBUILD_TARGETS)[number];
export const BI_REBUILD_TARGET_LABELS: Record<string, string> = {
  power_bi: 'Power BI',
  tableau: 'Tableau',
  databricks: 'Databricks AI/BI',
};

export type ObjectStatus = 'ready' | 'needs_review' | 'skipped';

export interface BiManifestObject {
  fqn: string;
  asset_type: string;
  system: string;
  file: string | null;
  /** Every file this object was emitted across, when one object needed several — a
   *  rebuild past the AI/BI page/dataset caps splits one dashboard into N `.lvdash.json`
   *  documents. `file` still names the first, so readers that only know `file` keep
   *  working; a reader that shows `parts` shows the whole report. Absent when the object
   *  has exactly one file (or none). */
  parts?: string[];
  status: ObjectStatus;
  notes: string[];
}

export interface BiPackManifest {
  project: string;
  project_id: string;
  path: 'repoint' | 'rebuild' | 'build';
  target: string | null;
  target_label: string | null;
  generated_at: string;
  counts: { total: number; ready: number; needs_review: number; skipped: number; files: number };
  objects: BiManifestObject[];
}

export interface BiPackResult {
  zip: Uint8Array | null;
  manifest: BiPackManifest;
  filename: string;
}

/** Notes split by severity: `review` flips the object to needs_review, `info` does not. */
export class Notes {
  info: string[] = [];
  review: string[] = [];

  all(): string[] {
    return [...this.review, ...this.info];
  }

  status(base: ObjectStatus = 'ready'): ObjectStatus {
    return this.review.length > 0 ? 'needs_review' : base;
  }
}

export const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'item';

export const fileSafe = (s: string): string => s.replace(/[^a-zA-Z0-9._-]+/g, '_');

/** Codebase-wide BI field lookup key: lowercased, surrounding brackets stripped (`[Sales]`
 *  and `Sales` both key to `sales`). Every `physicalByField`-style map in the rebuild
 *  lanes (rebuild.ts, semantic-layer.ts, rebuild-databricks.ts, tableau-shelf.ts) keys on
 *  this, so a field is never a hit in one lane and a miss in another. */
export const fieldKey = (name: string): string => name.toLowerCase().replace(/^\[|\]$/g, '');

/** Collapse a multi-line formula onto one line — a Tableau/DAX formula quoted inside a
 *  single-line artifact (a checklist bullet, a YAML comment, an XML comment) must not
 *  smuggle its own newlines into that line. */
export const oneLine = (s: string): string => s.replace(/\r\n|\r|\n/g, ' ');

/** Extensions that are more than one dot deep. Splitting `X.lvdash.json` on its LAST dot
 *  would number a collision as `X.lvdash_2.json`, which no longer looks like a Lakeview
 *  dashboard to `deploy_dashboards.py`, `databricks.yml` or the Databricks importer —
 *  the suffix has to go before the whole compound extension. Longest first: the loop
 *  takes the first match. */
const COMPOUND_EXTENSIONS = ['.lvdash.json', '.lvdash.zip'];

/** Reserve a unique zip path: fileSafe() can collapse two distinct object names onto the
 *  same string, and a bare files.set() would silently overwrite the first artifact while
 *  the manifest still claims both exist. */
export function claimPath(files: ReadonlyMap<string, unknown>, path: string): string {
  if (!files.has(path)) return path;
  const compound = COMPOUND_EXTENSIONS.find((e) => path.toLowerCase().endsWith(e));
  const dot = compound ? path.length - compound.length : path.lastIndexOf('.');
  const stem = dot === -1 ? path : path.slice(0, dot);
  const ext = dot === -1 ? '' : path.slice(dot);
  for (let n = 2; ; n++) {
    const candidate = `${stem}_${n}${ext}`;
    if (!files.has(candidate)) return candidate;
  }
}

export function countsOf(objects: BiManifestObject[], files: number) {
  return {
    total: objects.length,
    ready: objects.filter((o) => o.status === 'ready').length,
    needs_review: objects.filter((o) => o.status === 'needs_review').length,
    skipped: objects.filter((o) => o.status === 'skipped').length,
    files,
  };
}

/* ------------------------------------------------- generator input row shapes */

/** asset_column row as the rebuild generators load it (both directions). */
export interface BiColumnRow {
  id: string;
  asset_id: string;
  ordinal: number | null;
  name: string;
  data_type_raw: string | null;
  data_type_canonical: string | null;
  platform_properties: Record<string, unknown> | null;
}

/** column_derivation row as the rebuild generators load it. */
export interface BiDerivationRow {
  asset_id: string;
  output_column_id: string | null;
  output_name: string;
  expression_sql: string;
  derivation_type: string[] | null;
  language: string | null;
  input_refs: Array<{ asset_fqn: string; column: string; resolution: string }> | null;
}

/** bi_source_binding row as the rebuild generators load it (matched-first ordering). */
export interface BiBindingLite {
  asset_id: string;
  descriptor: BiDescriptor;
  refs: BiBindingRef[] | null;
  status: string;
}

/* ------------------------------------------------------ descriptor resolution */

/** Platforms a repoint target descriptor may name — the DB platforms Linetria models. */
export const REPOINT_PLATFORMS = [
  'databricks',
  'snowflake',
  'azure_sql',
  'synapse_dedicated',
  'synapse_serverless',
  'postgres',
] as const;

export function isRepointPlatform(p: string): boolean {
  return (REPOINT_PLATFORMS as readonly string[]).includes(p);
}

/**
 * Derive the connection descriptor a registered system would present to a BI tool —
 * the inverse of stitch/descriptors.ts's systemNormalizedKeys(), reading the same
 * config fields. Returns extra review notes when the config cannot pin every field
 * (e.g. an azure_sql system configured with several databases).
 */
export function descriptorFromSystem(
  platform: string,
  config: Record<string, unknown>,
): { descriptor: BiDescriptor; notes: string[] } | null {
  switch (platform) {
    case 'snowflake': {
      const account = config.account as string | undefined;
      if (!account) return null;
      return {
        descriptor: {
          platform_hint: 'snowflake',
          account,
          host: `${account}.snowflakecomputing.com`,
          warehouse: (config.warehouse as string | undefined) ?? null,
          database: (config.database as string | undefined) ?? null,
        },
        notes: [],
      };
    }
    case 'databricks': {
      const host = config.host as string | undefined;
      if (!host) return null;
      return {
        descriptor: {
          platform_hint: 'databricks',
          host,
          database: (config.catalog as string | undefined) ?? null,
        },
        notes: [],
      };
    }
    case 'azure_sql':
    case 'synapse_dedicated':
    case 'synapse_serverless': {
      const server = config.server as string | undefined;
      const databases = (config.databases as string[] | undefined) ?? [];
      if (!server) return null;
      const notes: string[] = [];
      if (databases.length !== 1) {
        notes.push(
          `the target system defines ${databases.length} databases — confirm which one this connection should use`,
        );
      }
      return {
        descriptor: { platform_hint: platform, host: server, database: databases[0] ?? null },
        notes,
      };
    }
    case 'postgres': {
      const cs = config.connectionString as string | undefined;
      const parsed = cs ? parsePostgresConnectionString(cs) : null;
      if (!parsed) return null;
      return {
        descriptor: { platform_hint: 'postgres', host: parsed.host, database: parsed.database },
        notes: [],
      };
    }
    default:
      return null;
  }
}

/** A snowflake target named by account alone still has a well-known host. One rule for
 *  every descriptor consumer (XML snippet, REST script, M source) — patching it at a
 *  single call site left the others reading `.host` raw. */
export function withDerivedHost(d: BiDescriptor): BiDescriptor {
  if (d.platform_hint === 'snowflake' && !d.host && d.account) {
    return { ...d, host: `${d.account}.snowflakecomputing.com` };
  }
  return d;
}

/** Fields a descriptor must carry for its platform before a repoint can be applied —
 *  the same identity fields the stitcher's normalizeDescriptor() keys on. */
export function missingDescriptorFields(d: BiDescriptor): string[] {
  switch (d.platform_hint) {
    case 'snowflake':
      return d.account || d.host ? [] : ['account'];
    case 'databricks':
      return d.host ? [] : ['host'];
    case 'azure_sql':
    case 'synapse_dedicated':
    case 'synapse_serverless':
    case 'postgres': {
      const missing: string[] = [];
      if (!d.host) missing.push('host');
      if (!d.database) missing.push('database');
      return missing;
    }
    default:
      return [];
  }
}

/* ------------------------------------------------------------- Tableau XML */

/** Tableau <connection class=…> value for a Linetria platform. */
export function tableauConnectionClass(platform: string): string {
  switch (platform) {
    case 'snowflake':
      return 'snowflake';
    case 'postgres':
      return 'postgres';
    case 'azure_sql':
    case 'synapse_dedicated':
    case 'synapse_serverless':
      return 'sqlserver';
    case 'databricks':
      return 'databricks';
    default:
      return platform;
  }
}

export function xmlEscape(s: string): string {
  return s
    // Control characters are invalid in XML 1.0 even escaped — a stray one in an
    // estate-supplied value would make the snippet unparseable.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------ M expressions */

const mStr = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** Escape arbitrary text (e.g. custom SQL) for a single-line M text literal: `"` doubles,
 *  `#(` opens an M character-escape sequence and must itself be escaped, and newlines
 *  collapse to spaces (CR included — a stray \r would corrupt the literal). */
export function mEscapeText(s: string): string {
  return s.replace(/#\(/g, '#(#)(').replace(/"/g, '""').replace(/\r\n|\r|\n/g, ' ');
}

/**
 * Power Query source expression for a descriptor — the same source functions
 * connectors/powerbi/mquery.ts recognizes, emitted in reverse. Null when the
 * platform has no known M source function.
 */
export function mSourceFor(d: BiDescriptor): string | null {
  switch (d.platform_hint) {
    case 'snowflake': {
      const host = d.host ?? (d.account ? `${d.account}.snowflakecomputing.com` : null);
      if (!host) return null;
      return `Snowflake.Databases(${mStr(host)}${d.warehouse ? `, ${mStr(d.warehouse)}` : ''})`;
    }
    case 'databricks':
      return d.host ? `Databricks.Catalogs(${mStr(d.host)}, null, null)` : null;
    case 'azure_sql':
    case 'synapse_dedicated':
    case 'synapse_serverless':
      return d.host && d.database ? `Sql.Database(${mStr(d.host)}, ${mStr(d.database)})` : null;
    case 'postgres':
      return d.host && d.database
        ? `PostgreSQL.Database(${mStr(d.host)}, ${mStr(d.database)})`
        : null;
    default:
      return null;
  }
}

/** Navigation step from a source expression to one table, `[Schema=…,Item=…]` style. */
export function mNavigationStep(parts: { schema?: string | null; object: string }): string {
  return parts.schema
    ? `Source{[Schema=${mStr(parts.schema)},Item=${mStr(parts.object)}]}[Data]`
    : `Source{[Item=${mStr(parts.object)}]}[Data]`;
}

/* -------------------------------------------------------- tabular type map */

/**
 * Canonical taxonomy (model/typemap.ts) or raw Tableau datatype → Power BI tabular
 * model dataType. Lossy mappings carry a note (same convention as Dialect.mapType).
 */
export function tabularTypeFor(
  canonical: string | null,
  raw: string | null,
): { type: string; note?: string } {
  const c = (canonical ?? '').toLowerCase();
  if (c) {
    if (c.startsWith('decimal')) return { type: 'decimal' };
    switch (c) {
      case 'string':
        return { type: 'string' };
      case 'integer':
        return { type: 'int64' };
      case 'float':
        return { type: 'double' };
      case 'boolean':
        return { type: 'boolean' };
      case 'date':
      case 'timestamp':
        return { type: 'dateTime' };
      case 'timestamp_tz':
        return { type: 'dateTime', note: 'timezone offset is not preserved by the tabular dateTime type' };
      case 'time':
        return { type: 'dateTime', note: 'no standalone TIME type in the tabular model — dateTime with a date part of 1899-12-30' };
      case 'binary':
        return { type: 'binary' };
      case 'variant/json':
      case 'array':
      case 'map':
      case 'struct':
      case 'geography':
      case 'vector':
        return { type: 'string', note: `no tabular equivalent for ${c} — mapped to string` };
    }
  }
  switch ((raw ?? '').toLowerCase()) {
    case 'integer':
      return { type: 'int64' };
    case 'real':
      return { type: 'double' };
    case 'string':
      return { type: 'string' };
    case 'boolean':
      return { type: 'boolean' };
    case 'date':
    case 'datetime':
      return { type: 'dateTime' };
    default:
      return { type: 'string', note: `unknown source datatype '${raw ?? '?'}' — mapped to string` };
  }
}

/**
 * Canonical taxonomy (model/typemap.ts) or raw tabular-model dataType → Tableau column
 * datatype — the reverse of tabularTypeFor, for the Power BI → Tableau rebuild. Lossy
 * mappings carry a note (same convention as Dialect.mapType).
 */
export function tableauTypeFor(
  canonical: string | null,
  raw: string | null,
): { type: string; note?: string } {
  const c = (canonical ?? '').toLowerCase();
  if (c) {
    if (c.startsWith('decimal')) {
      return { type: 'real', note: 'fixed-precision decimal maps to Tableau real (floating point)' };
    }
    switch (c) {
      case 'string':
        return { type: 'string' };
      case 'integer':
        return { type: 'integer' };
      case 'float':
        return { type: 'real' };
      case 'boolean':
        return { type: 'boolean' };
      case 'date':
        return { type: 'date' };
      case 'timestamp':
        return { type: 'datetime' };
      case 'timestamp_tz':
        return { type: 'datetime', note: 'timezone offset is not preserved by the Tableau datetime type' };
      case 'time':
        return { type: 'datetime', note: 'no standalone TIME type in Tableau — datetime with an epoch date part' };
      case 'binary':
        return { type: 'string', note: 'no Tableau equivalent for binary — mapped to string' };
      case 'variant/json':
      case 'array':
      case 'map':
      case 'struct':
      case 'geography':
      case 'vector':
        return { type: 'string', note: `no Tableau equivalent for ${c} — mapped to string` };
    }
  }
  switch ((raw ?? '').toLowerCase()) {
    case 'int64':
      return { type: 'integer' };
    case 'double':
      return { type: 'real' };
    case 'decimal':
      return { type: 'real', note: 'fixed-precision decimal maps to Tableau real (floating point)' };
    case 'string':
      return { type: 'string' };
    case 'boolean':
      return { type: 'boolean' };
    case 'datetime':
      return { type: 'datetime' };
    case 'binary':
      return { type: 'string', note: 'no Tableau equivalent for binary — mapped to string' };
    default:
      return { type: 'string', note: `unknown source datatype '${raw ?? '?'}' — mapped to string` };
  }
}

/* ------------------------------------------------- Tableau calc → DAX (tiny) */

const DAX_AGG: Record<string, string> = {
  SUM: 'SUM',
  MIN: 'MIN',
  MAX: 'MAX',
  AVG: 'AVERAGE',
  COUNT: 'COUNT',
  COUNTD: 'DISTINCTCOUNT',
};

export interface CalcTranslation {
  dax: string;
  /** true → the translation is mechanical and complete; false → scaffold only. */
  ready: boolean;
  note: string;
}

const daxTableRef = (table: string, column: string): string =>
  `'${table.replace(/'/g, "''")}'[${column}]`;

/**
 * Translate the trivially-mechanical Tableau calcs only: bare constants and a single
 * `AGG([Field])` over one field. Everything else returns null — the caller ships the
 * original formula verbatim as a comment with a TODO body (never a fake translation).
 */
export function translateTableauCalc(formula: string, tableName: string): CalcTranslation | null {
  const f = formula.trim();

  const num = /^-?\d+(\.\d+)?$/.exec(f);
  if (num) return { dax: f, ready: true, note: 'constant — translated as-is' };
  // Newlines excluded: a multi-line string constant would corrupt the single-line
  // TMDL expression — it falls through to the verbatim-TODO path instead.
  const str = /^"([^"\r\n]*)"$/.exec(f);
  if (str) return { dax: `"${str[1]}"`, ready: true, note: 'constant — translated as-is' };

  const agg = /^([A-Za-z]+)\(\s*\[([^\]]+)\]\s*\)$/.exec(f);
  if (agg) {
    const fn = DAX_AGG[agg[1].toUpperCase()];
    if (fn) {
      return {
        dax: `${fn}(${daxTableRef(tableName, agg[2])})`,
        ready: true,
        note: `simple aggregate — auto-translated to ${fn}`,
      };
    }
  }
  return null;
}

/* ------------------------------------------------- DAX → Tableau calc (tiny) */

const TABLEAU_AGG: Record<string, string> = {
  SUM: 'SUM',
  MIN: 'MIN',
  MAX: 'MAX',
  AVERAGE: 'AVG',
  COUNT: 'COUNT',
  DISTINCTCOUNT: 'COUNTD',
};

export interface DaxTranslation {
  tableau: string;
  /** true → the translation is mechanical and complete; false → scaffold only. */
  ready: boolean;
  note: string;
}

/**
 * Translate the trivially-mechanical DAX only: bare constants and a single
 * `AGG(Table[Column])` / `AGG('Table'[Column])` over one column. The table qualifier
 * drops — the Tableau calc lives on the datasource scaffolded from that table, where
 * fields are unqualified. Everything else returns null — the caller ships the original
 * DAX verbatim as a comment with a TODO body (never a fake translation), mirroring
 * translateTableauCalc.
 */
export function translateDaxToTableau(formula: string): DaxTranslation | null {
  const f = formula.trim();

  const num = /^-?\d+(\.\d+)?$/.exec(f);
  if (num) return { tableau: f, ready: true, note: 'constant — translated as-is' };
  const str = /^"([^"\r\n]*)"$/.exec(f);
  if (str) return { tableau: `"${str[1]}"`, ready: true, note: 'constant — translated as-is' };

  const agg = /^([A-Za-z]+)\(\s*(?:'([^']+)'|([A-Za-z_][\w ]*?))\s*\[([^\]]+)\]\s*\)$/.exec(f);
  if (agg) {
    const fn = TABLEAU_AGG[agg[1].toUpperCase()];
    if (fn) {
      return {
        tableau: `${fn}([${agg[4]}])`,
        ready: true,
        note: `simple aggregate — auto-translated to ${fn}`,
      };
    }
  }
  return null;
}
