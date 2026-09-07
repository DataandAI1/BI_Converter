/**
 * Map a platform-reported raw type to the cross-platform taxonomy (spec §5.2):
 * string, integer, decimal(p,s), float, boolean, date, timestamp, timestamp_tz, time,
 * binary, variant/json, array, map, struct, geography, vector, other.
 *
 * Phase 0 covers the PostgreSQL surface; other dialects extend the table in Phase 1.
 */
export function canonicalizeDataType(raw: string): string {
  const t = raw.trim().toLowerCase();

  if (t.endsWith('[]')) return 'array';

  // numeric(p,s) / decimal(p,s) preserve precision and scale
  const dec = t.match(/^(?:numeric|decimal)(?:\((\d+)\s*,\s*(\d+)\))?$/);
  if (dec) return dec[1] ? `decimal(${dec[1]},${dec[2]})` : 'decimal';

  const base = t.replace(/\(.*\)/, '').trim();

  switch (base) {
    case 'text':
    case 'varchar':
    case 'character varying':
    case 'character':
    case 'char':
    case 'bpchar':
    case 'citext':
    case 'name':
      return 'string';
    case 'smallint':
    case 'integer':
    case 'int':
    case 'int2':
    case 'int4':
    case 'int8':
    case 'bigint':
      return 'integer';
    case 'real':
    case 'float4':
    case 'float8':
    case 'double precision':
      return 'float';
    case 'boolean':
    case 'bool':
      return 'boolean';
    case 'date':
      return 'date';
    case 'timestamp':
    case 'timestamp without time zone':
      return 'timestamp';
    case 'timestamptz':
    case 'timestamp with time zone':
      return 'timestamp_tz';
    case 'time':
    case 'time without time zone':
    case 'time with time zone':
    case 'timetz':
      return 'time';
    case 'bytea':
      return 'binary';
    case 'json':
    case 'jsonb':
      return 'variant/json';
    // Vector embeddings (pgvector): vector/halfvec are dense, sparsevec is sparse. The
    // optional dimension — vector(1536) — is stripped into `base` above, so all arities
    // fold to one canonical type. `tsvector` is full-text search, not an embedding, and
    // is deliberately excluded (it stays `other`).
    case 'vector':
    case 'halfvec':
    case 'sparsevec':
      return 'vector';
    default:
      return 'other';
  }
}
