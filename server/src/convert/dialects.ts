import { canonicalizeDataType } from '../model/typemap.js';

/**
 * Target-platform dialects for migration script generation (Migration → Script page).
 *
 * Each dialect knows how to quote identifiers, map the canonical type taxonomy
 * (spec §5.2) — refined by the source's raw type when it carries more detail
 * (lengths, integer widths, vector dimensions, array element types) — and how to
 * translate the small set of column-default expressions that are safe to carry
 * across platforms. Anything outside that safe set degrades to an explicit
 * `TODO` note rather than silently emitting SQL that fails or lies.
 */

export const SCRIPT_TARGETS = [
  'databricks',
  'snowflake',
  'azure_sql',
  'synapse_dedicated',
  'synapse_serverless',
  'postgres',
] as const;

export type ScriptTarget = (typeof SCRIPT_TARGETS)[number];

export function isScriptTarget(v: string): v is ScriptTarget {
  return (SCRIPT_TARGETS as readonly string[]).includes(v);
}

export interface TypeMapping {
  sql: string;
  /** Present when the mapping is lossy or needs verification on the target. */
  note?: string;
}

export interface DefaultMapping {
  /** Translated DEFAULT expression; absent when the default cannot be carried over. */
  sql?: string;
  /** True when the default was a sequence-nextval → emit an identity column instead. */
  identity?: boolean;
  note?: string;
}

/** How a constraint kind lands on the target. */
export type ConstraintSupport =
  | 'enforced' // emitted, enforced by the platform
  | 'informational' // emitted, platform records but does not enforce
  | 'not_enforced' // emitted with an explicit NOT ENFORCED clause
  | 'unsupported'; // emitted commented-out

export interface Dialect {
  id: ScriptTarget;
  label: string;
  quote(ident: string): string;
  mapType(canonical: string | null, raw: string | null): TypeMapping;
  mapDefault(expr: string): DefaultMapping;
  /** Column clause for sequence-backed defaults (nextval → identity). */
  identityClause: string | null;
  supports: {
    pk: ConstraintSupport;
    fk: ConstraintSupport;
    unique: ConstraintSupport;
    check: ConstraintSupport;
    sequences: boolean;
    /** materialized views: native statement or downgrade to plain view */
    materializedView: 'native' | 'view_fallback';
    /** tables: normal CREATE TABLE or external-table template (synapse serverless) */
    tables: 'native' | 'external_template';
    /** inline COMMENT 'x' on columns/tables vs COMMENT ON statements vs none */
    comments: 'inline' | 'comment_on' | 'none';
    partitionBy: boolean;
  };
  /** Target-specific caveats surfaced in the pack README. */
  notes: string[];
}

/* ---------------------------------------------------------------- raw types */

export interface RawTypeInfo {
  base: string;
  length?: number;
  lengthIsMax?: boolean;
  precision?: number;
  scale?: number;
  /** vector(1536) → 1536 */
  dim?: number;
  /** integer[] → 'integer' */
  arrayElement?: string;
}

/** Best-effort parse of a platform raw type into refinement hints. */
export function parseRawType(raw: string | null): RawTypeInfo {
  const t = (raw ?? '').trim().toLowerCase();
  if (t === '') return { base: '' };
  const arr = t.match(/^(.+?)(\[\])+$/);
  if (arr) return { base: 'array', arrayElement: arr[1].trim() };
  const base = t.replace(/\(.*\)/, '').replace(/\s+/g, ' ').trim();
  const info: RawTypeInfo = { base };
  const args = t.match(/\(([^)]*)\)/);
  if (args) {
    const parts = args[1].split(',').map((p) => p.trim().toLowerCase());
    if (parts[0] === 'max') info.lengthIsMax = true;
    else if (/^\d+$/.test(parts[0] ?? '')) {
      const n = Number(parts[0]);
      if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
        info.precision = n;
        info.scale = Number(parts[1]);
      } else if (base === 'vector' || base === 'halfvec' || base === 'sparsevec') {
        info.dim = n;
      } else {
        info.length = n;
        info.precision = n; // number(10) style
      }
    }
  }
  return info;
}

/** small | int | big from the raw base name; big when unknown (never truncates). */
function intWidth(base: string): 'tiny' | 'small' | 'int' | 'big' {
  switch (base) {
    case 'tinyint':
      return 'tiny';
    case 'smallint':
    case 'int2':
      return 'small';
    case 'int':
    case 'integer':
    case 'int4':
      return 'int';
    default:
      return 'big';
  }
}

/** decimal(p,s) canonical → {p,s}; bare decimal → null. */
function decimalArgs(canonical: string): { p: number; s: number } | null {
  const m = canonical.match(/^decimal\((\d+),(\d+)\)$/);
  return m ? { p: Number(m[1]), s: Number(m[2]) } : null;
}

function clampDecimal(p: number, s: number, maxP: number): TypeMapping {
  if (p <= maxP) return { sql: `DECIMAL(${p},${s})` };
  const s2 = Math.min(s, maxP - 1);
  return {
    sql: `DECIMAL(${maxP},${s2})`,
    note: `source precision ${p},${s} exceeds target maximum ${maxP} — clamped`,
  };
}

const UNBOUNDED_DECIMAL_NOTE =
  'source declares unbounded numeric — DECIMAL(38,18) chosen; adjust scale to your data';

/* ---------------------------------------------------------------- defaults */

const CURRENT_TS_RE =
  /^(now\(\)|current_timestamp(\(\d*\))?|getdate\(\)|sysdatetime\(\)|systimestamp(\(\))?|current_timestamp)$/;
const CURRENT_DATE_RE = /^(current_date|curdate\(\))$/;
const UUID_RE = /^(gen_random_uuid\(\)|uuid_generate_v4\(\)|newid\(\)|uuid\(\)|uuid_string\(\))$/;

/** Strip Postgres-style ::type casts and redundant outer parens from a default. */
function normalizeDefault(expr: string): string {
  let e = expr.trim();
  for (;;) {
    const prev = e;
    // ((0)) → 0 — T-SQL wraps defaults in parens.
    if (/^\(.*\)$/.test(e)) {
      let depth = 0;
      let balanced = true;
      for (let i = 0; i < e.length; i++) {
        if (e[i] === '(') depth++;
        else if (e[i] === ')') {
          depth--;
          if (depth === 0 && i < e.length - 1) {
            balanced = false;
            break;
          }
        }
      }
      if (balanced) e = e.slice(1, -1).trim();
    }
    // 'x'::text / 0.0::numeric(10,2) → literal
    e = e.replace(/::[a-z_][a-z0-9_ ]*(\(\d+(,\s*\d+)?\))?(\[\])?$/i, '').trim();
    if (e === prev) return e;
  }
}

/**
 * Shared default translation: sequence-backed → identity, temporal/uuid functions →
 * target spelling, plain literals pass through. Everything else becomes a note.
 */
function translateDefault(
  expr: string,
  spellings: { currentTs: string; currentDate: string; uuid: string | null; boolAsBit?: boolean },
): DefaultMapping {
  const e = normalizeDefault(expr);
  const lower = e.toLowerCase();
  if (lower.startsWith('nextval(')) return { identity: true };
  if (CURRENT_TS_RE.test(lower)) return { sql: spellings.currentTs };
  if (CURRENT_DATE_RE.test(lower)) return { sql: spellings.currentDate };
  if (UUID_RE.test(lower)) {
    return spellings.uuid
      ? { sql: spellings.uuid }
      : { note: `default ${e} has no equivalent on this target` };
  }
  if (/^-?\d+(\.\d+)?$/.test(lower)) return { sql: e };
  if (/^'([^']|'')*'$/.test(e)) return { sql: e };
  if (lower === 'true' || lower === 'false') {
    if (spellings.boolAsBit) return { sql: lower === 'true' ? '1' : '0' };
    return { sql: lower.toUpperCase() };
  }
  if (lower === 'null') return { sql: 'NULL' };
  return { note: `TODO translate default: ${expr}` };
}

/* ---------------------------------------------------------------- dialects */

const escapeSingle = (s: string) => s.replace(/'/g, "''");
export { escapeSingle as escapeSqlString };

const databricks: Dialect = {
  id: 'databricks',
  label: 'Databricks',
  quote: (i) => `\`${i.replace(/`/g, '``')}\``,
  mapType(canonical, raw) {
    const c = canonical ?? '';
    const r = parseRawType(raw);
    const dec = decimalArgs(c);
    if (dec) return clampDecimal(dec.p, dec.s, 38);
    switch (c) {
      case 'string':
        return { sql: 'STRING' };
      case 'integer':
        switch (intWidth(r.base)) {
          case 'tiny':
            return { sql: 'SMALLINT', note: 'tinyint widened (unsigned range differs)' };
          case 'small':
            return { sql: 'SMALLINT' };
          case 'int':
            return { sql: 'INT' };
          default:
            return { sql: 'BIGINT' };
        }
      case 'decimal':
        return { sql: 'DECIMAL(38,18)', note: UNBOUNDED_DECIMAL_NOTE };
      case 'float':
        return r.base === 'real' || r.base === 'float4'
          ? { sql: 'FLOAT' }
          : { sql: 'DOUBLE' };
      case 'boolean':
        return { sql: 'BOOLEAN' };
      case 'date':
        return { sql: 'DATE' };
      case 'timestamp':
        return { sql: 'TIMESTAMP_NTZ', note: 'TIMESTAMP_NTZ requires DBR 13.3+; use TIMESTAMP if unavailable' };
      case 'timestamp_tz':
        return { sql: 'TIMESTAMP' };
      case 'time':
        return { sql: 'STRING', note: 'Databricks has no TIME type — stored as string HH:MM:SS' };
      case 'binary':
        return { sql: 'BINARY' };
      case 'variant/json':
        return { sql: 'VARIANT', note: 'VARIANT requires DBR 15.3+; use STRING on older runtimes' };
      case 'array': {
        if (r.arrayElement) {
          const el = databricks.mapType(canonicalizeDataType(r.arrayElement), r.arrayElement);
          return { sql: `ARRAY<${el.sql}>`, note: el.note };
        }
        return { sql: 'ARRAY<STRING>', note: 'element type unknown — verify' };
      }
      case 'map':
      case 'struct': {
        const rawTrim = (raw ?? '').trim();
        if (/^(map|struct)</i.test(rawTrim)) return { sql: rawTrim };
        return { sql: 'VARIANT', note: `${c} with unknown element types — VARIANT chosen (DBR 15.3+)` };
      }
      case 'geography':
        return { sql: 'STRING', note: 'no stable GEOGRAPHY type — store WKT/GeoJSON as string' };
      case 'vector':
        return { sql: 'ARRAY<FLOAT>', note: 'vector embeddings stored as float array (use Mosaic AI Vector Search for indexing)' };
      default: {
        if (r.base === 'uuid') return { sql: 'STRING', note: 'uuid stored as string' };
        // Databricks-native complex raws (array<int>, struct<a:int>) canonicalize to
        // 'other' but are already valid target syntax — pass them through untouched.
        const rawTrim = (raw ?? '').trim();
        if (/^(array|map|struct)</i.test(rawTrim)) return { sql: rawTrim };
        return {
          sql: rawTrim || 'STRING',
          note: `unmapped source type '${raw ?? 'unknown'}' — verify on target`,
        };
      }
    }
  },
  mapDefault: (expr) =>
    translateDefault(expr, { currentTs: 'CURRENT_TIMESTAMP', currentDate: 'CURRENT_DATE', uuid: 'uuid()' }),
  identityClause: 'GENERATED BY DEFAULT AS IDENTITY',
  supports: {
    pk: 'informational',
    fk: 'informational',
    unique: 'unsupported',
    check: 'enforced',
    sequences: false,
    materializedView: 'native',
    tables: 'native',
    comments: 'inline',
    partitionBy: true,
  },
  notes: [
    'PRIMARY KEY / FOREIGN KEY constraints are informational only (Unity Catalog) — they are recorded but not enforced.',
    'UNIQUE constraints are not supported and are emitted commented-out.',
    'Column DEFAULT values require the table property delta.feature.allowColumnDefaults, which the generated DDL sets automatically.',
    'Identity columns are emitted as GENERATED BY DEFAULT AS IDENTITY (BIGINT).',
    'Sequences do not exist on Databricks — sequence-backed columns became identity columns; standalone sequences are skipped.',
    'Materialized views require a serverless SQL warehouse / DBSQL.',
  ],
};

const snowflake: Dialect = {
  id: 'snowflake',
  label: 'Snowflake',
  quote: (i) => `"${i.replace(/"/g, '""')}"`,
  mapType(canonical, raw) {
    const c = canonical ?? '';
    const r = parseRawType(raw);
    const dec = decimalArgs(c);
    if (dec) {
      if (dec.p <= 38) return { sql: `NUMBER(${dec.p},${dec.s})` };
      return {
        sql: `NUMBER(38,${Math.min(dec.s, 37)})`,
        note: `source precision ${dec.p},${dec.s} exceeds NUMBER(38) — clamped`,
      };
    }
    switch (c) {
      case 'string':
        return r.length ? { sql: `VARCHAR(${r.length})` } : { sql: 'VARCHAR' };
      case 'integer':
        switch (intWidth(r.base)) {
          case 'tiny':
          case 'small':
            return { sql: 'SMALLINT' };
          case 'int':
            return { sql: 'INTEGER' };
          default:
            return { sql: 'BIGINT' };
        }
      case 'decimal':
        return { sql: 'NUMBER(38,18)', note: UNBOUNDED_DECIMAL_NOTE };
      case 'float':
        return { sql: 'FLOAT' };
      case 'boolean':
        return { sql: 'BOOLEAN' };
      case 'date':
        return { sql: 'DATE' };
      case 'timestamp':
        return { sql: 'TIMESTAMP_NTZ' };
      case 'timestamp_tz':
        return { sql: 'TIMESTAMP_TZ' };
      case 'time':
        return { sql: 'TIME' };
      case 'binary':
        return { sql: 'BINARY' };
      case 'variant/json':
        return { sql: 'VARIANT' };
      case 'array':
        return { sql: 'ARRAY' };
      case 'map':
      case 'struct':
        return { sql: 'OBJECT', note: `${c} mapped to semi-structured OBJECT` };
      case 'geography':
        return { sql: 'GEOGRAPHY' };
      case 'vector':
        return r.dim
          ? { sql: `VECTOR(FLOAT, ${r.dim})` }
          : { sql: 'ARRAY', note: 'vector dimension unknown — ARRAY chosen; declare VECTOR(FLOAT, n) once known' };
      default:
        if (r.base === 'uuid') return { sql: 'VARCHAR(36)', note: 'uuid stored as string' };
        return {
          sql: (raw ?? 'VARCHAR').trim() || 'VARCHAR',
          note: `unmapped source type '${raw ?? 'unknown'}' — verify on target`,
        };
    }
  },
  mapDefault: (expr) =>
    translateDefault(expr, { currentTs: 'CURRENT_TIMESTAMP', currentDate: 'CURRENT_DATE', uuid: 'UUID_STRING()' }),
  identityClause: 'IDENTITY START 1 INCREMENT 1',
  supports: {
    pk: 'informational',
    fk: 'informational',
    unique: 'informational',
    check: 'unsupported',
    sequences: true,
    materializedView: 'native',
    tables: 'native',
    comments: 'inline',
    partitionBy: false,
  },
  notes: [
    'PRIMARY KEY / UNIQUE / FOREIGN KEY constraints are informational only on Snowflake — recorded, not enforced.',
    'CHECK constraints are not supported and are emitted commented-out.',
    'Materialized views on Snowflake carry restrictions (single table, no joins on some editions) — review flagged files.',
    'Source partition keys are noted in file headers — consider CLUSTER BY on large tables.',
  ],
};

/** Shared T-SQL family mapping; small capability differences applied per target below. */
function tsqlMapType(target: ScriptTarget) {
  return (canonical: string | null, raw: string | null): TypeMapping => {
    const c = canonical ?? '';
    const r = parseRawType(raw);
    const dec = decimalArgs(c);
    if (dec) return clampDecimal(dec.p, dec.s, 38);
    switch (c) {
      case 'string': {
        if (r.lengthIsMax) return { sql: 'NVARCHAR(MAX)' };
        if (r.length && r.length <= 4000) return { sql: `NVARCHAR(${r.length})` };
        if (r.length) return { sql: 'NVARCHAR(MAX)', note: `source length ${r.length} exceeds NVARCHAR(4000)` };
        return { sql: 'NVARCHAR(MAX)', note: 'unbounded source text — consider a sized NVARCHAR for index/key columns' };
      }
      case 'integer':
        switch (intWidth(r.base)) {
          case 'tiny':
            return { sql: 'TINYINT' };
          case 'small':
            return { sql: 'SMALLINT' };
          case 'int':
            return { sql: 'INT' };
          default:
            return { sql: 'BIGINT' };
        }
      case 'decimal':
        return { sql: 'DECIMAL(38,18)', note: UNBOUNDED_DECIMAL_NOTE };
      case 'float':
        return r.base === 'real' || r.base === 'float4' ? { sql: 'REAL' } : { sql: 'FLOAT' };
      case 'boolean':
        return { sql: 'BIT' };
      case 'date':
        return { sql: 'DATE' };
      case 'timestamp':
        return { sql: 'DATETIME2' };
      case 'timestamp_tz':
        return { sql: 'DATETIMEOFFSET' };
      case 'time':
        return { sql: 'TIME' };
      case 'binary':
        return { sql: 'VARBINARY(MAX)' };
      case 'variant/json':
        return { sql: 'NVARCHAR(MAX)', note: 'JSON stored as NVARCHAR(MAX) — add ISJSON() CHECK if needed' };
      case 'array':
      case 'map':
      case 'struct':
        return { sql: 'NVARCHAR(MAX)', note: `${c} serialized as JSON text` };
      case 'geography':
        return target === 'azure_sql'
          ? { sql: 'GEOGRAPHY' }
          : { sql: 'VARBINARY(MAX)', note: 'GEOGRAPHY not supported on Synapse — store WKB' };
      case 'vector':
        if (target === 'azure_sql' && r.dim) {
          return { sql: `VECTOR(${r.dim})`, note: 'requires Azure SQL Database native vector support' };
        }
        return { sql: 'NVARCHAR(MAX)', note: 'vector stored as JSON array text' };
      default:
        if (r.base === 'uuid') return { sql: 'UNIQUEIDENTIFIER' };
        return {
          sql: (raw ?? 'NVARCHAR(MAX)').trim() || 'NVARCHAR(MAX)',
          note: `unmapped source type '${raw ?? 'unknown'}' — verify on target`,
        };
    }
  };
}

const tsqlDefaults = (expr: string): DefaultMapping =>
  translateDefault(expr, {
    currentTs: 'SYSDATETIME()',
    currentDate: 'CAST(SYSDATETIME() AS DATE)',
    uuid: 'NEWID()',
    boolAsBit: true,
  });

const tsqlQuote = (i: string) => `[${i.replace(/]/g, ']]')}]`;

const azureSql: Dialect = {
  id: 'azure_sql',
  label: 'Azure SQL Database',
  quote: tsqlQuote,
  mapType: tsqlMapType('azure_sql'),
  mapDefault: tsqlDefaults,
  identityClause: 'IDENTITY(1,1)',
  supports: {
    pk: 'enforced',
    fk: 'enforced',
    unique: 'enforced',
    check: 'enforced',
    sequences: true,
    materializedView: 'view_fallback',
    tables: 'native',
    comments: 'none',
    partitionBy: false,
  },
  notes: [
    'Materialized views became plain views — evaluate indexed views (WITH SCHEMABINDING) case-by-case.',
    'Column comments are not portable to T-SQL DDL — see manifest.json for source comments (sp_addextendedproperty if needed).',
    'CHECK-constraint expressions were carried over verbatim — review any that use source-platform functions.',
  ],
};

const synapseDedicated: Dialect = {
  id: 'synapse_dedicated',
  label: 'Azure Synapse (dedicated SQL pool)',
  quote: tsqlQuote,
  mapType: tsqlMapType('synapse_dedicated'),
  mapDefault: tsqlDefaults,
  identityClause: 'IDENTITY(1,1)',
  supports: {
    pk: 'not_enforced',
    fk: 'unsupported',
    unique: 'not_enforced',
    check: 'unsupported',
    sequences: false,
    materializedView: 'native',
    tables: 'native',
    comments: 'none',
    partitionBy: false,
  },
  notes: [
    'Dedicated SQL pools accept PRIMARY KEY / UNIQUE only as NONCLUSTERED … NOT ENFORCED; FOREIGN KEY and CHECK are not supported (emitted commented-out).',
    'Tables default to ROUND_ROBIN distribution — choose HASH(column) for large fact tables before running.',
    'Sequences are not supported — sequence-backed columns became IDENTITY(1,1); standalone sequences are skipped.',
    'Column comments are not portable to T-SQL DDL — see manifest.json for source comments.',
  ],
};

const synapseServerless: Dialect = {
  id: 'synapse_serverless',
  label: 'Azure Synapse (serverless SQL pool)',
  quote: tsqlQuote,
  mapType: tsqlMapType('synapse_serverless'),
  mapDefault: () => ({ note: 'serverless external tables cannot hold defaults' }),
  identityClause: null,
  supports: {
    pk: 'unsupported',
    fk: 'unsupported',
    unique: 'unsupported',
    check: 'unsupported',
    sequences: false,
    materializedView: 'view_fallback',
    tables: 'external_template',
    comments: 'none',
    partitionBy: false,
  },
  notes: [
    'Serverless SQL pools hold no data — every table is emitted as a CREATE EXTERNAL TABLE template; fill in LOCATION / DATA_SOURCE / FILE_FORMAT after landing the data in your lake.',
    'Constraints, defaults and identity columns do not apply to external tables and were omitted.',
    'Materialized views became plain views.',
  ],
};

const postgres: Dialect = {
  id: 'postgres',
  label: 'PostgreSQL',
  quote: (i) => `"${i.replace(/"/g, '""')}"`,
  mapType(canonical, raw) {
    const c = canonical ?? '';
    const r = parseRawType(raw);
    const dec = decimalArgs(c);
    if (dec) return { sql: `NUMERIC(${dec.p},${dec.s})` };
    switch (c) {
      case 'string':
        return r.length ? { sql: `VARCHAR(${r.length})` } : { sql: 'TEXT' };
      case 'integer':
        switch (intWidth(r.base)) {
          case 'tiny':
          case 'small':
            return { sql: 'SMALLINT' };
          case 'int':
            return { sql: 'INTEGER' };
          default:
            return { sql: 'BIGINT' };
        }
      case 'decimal':
        return { sql: 'NUMERIC' };
      case 'float':
        return r.base === 'real' || r.base === 'float4' ? { sql: 'REAL' } : { sql: 'DOUBLE PRECISION' };
      case 'boolean':
        return { sql: 'BOOLEAN' };
      case 'date':
        return { sql: 'DATE' };
      case 'timestamp':
        return { sql: 'TIMESTAMP' };
      case 'timestamp_tz':
        return { sql: 'TIMESTAMPTZ' };
      case 'time':
        return { sql: 'TIME' };
      case 'binary':
        return { sql: 'BYTEA' };
      case 'variant/json':
        return { sql: 'JSONB' };
      case 'array': {
        if (r.arrayElement) {
          const el = postgres.mapType(canonicalizeDataType(r.arrayElement), r.arrayElement);
          return { sql: `${el.sql}[]`, note: el.note };
        }
        return { sql: 'JSONB', note: 'element type unknown — JSONB chosen' };
      }
      case 'map':
      case 'struct':
        return { sql: 'JSONB', note: `${c} mapped to JSONB` };
      case 'geography':
        return { sql: 'GEOGRAPHY', note: 'requires the PostGIS extension' };
      case 'vector':
        return {
          sql: r.dim ? `VECTOR(${r.dim})` : 'VECTOR',
          note: 'requires the pgvector extension',
        };
      default:
        if (r.base === 'uuid') return { sql: 'UUID' };
        return {
          sql: (raw ?? 'TEXT').trim() || 'TEXT',
          note: `unmapped source type '${raw ?? 'unknown'}' — verify on target`,
        };
    }
  },
  mapDefault: (expr) =>
    translateDefault(expr, {
      currentTs: 'CURRENT_TIMESTAMP',
      currentDate: 'CURRENT_DATE',
      uuid: 'gen_random_uuid()',
    }),
  identityClause: 'GENERATED BY DEFAULT AS IDENTITY',
  supports: {
    pk: 'enforced',
    fk: 'enforced',
    unique: 'enforced',
    check: 'enforced',
    sequences: true,
    materializedView: 'native',
    tables: 'native',
    comments: 'comment_on',
    partitionBy: false,
  },
  notes: [
    'Sequence-backed defaults became GENERATED BY DEFAULT AS IDENTITY columns.',
    'GEOGRAPHY columns require PostGIS; VECTOR columns require pgvector — install the extensions before running.',
  ],
};

const DIALECTS: Record<ScriptTarget, Dialect> = {
  databricks,
  snowflake,
  azure_sql: azureSql,
  synapse_dedicated: synapseDedicated,
  synapse_serverless: synapseServerless,
  postgres,
};

export function getDialect(target: string): Dialect | null {
  return isScriptTarget(target) ? DIALECTS[target] : null;
}
