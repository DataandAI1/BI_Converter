import { describe, it, expect } from 'vitest';
import { canonicalizeDataType } from '../../src/model/typemap.js';

describe('canonicalizeDataType (postgres raw types → §5.2 taxonomy)', () => {
  const cases: Array<[string, string]> = [
    ['text', 'string'],
    ['character varying(50)', 'string'],
    ['varchar', 'string'],
    ['character(3)', 'string'],
    ['integer', 'integer'],
    ['bigint', 'integer'],
    ['smallint', 'integer'],
    ['numeric(12,2)', 'decimal(12,2)'],
    ['numeric', 'decimal'],
    ['real', 'float'],
    ['double precision', 'float'],
    ['boolean', 'boolean'],
    ['date', 'date'],
    ['timestamp without time zone', 'timestamp'],
    ['timestamp with time zone', 'timestamp_tz'],
    ['time without time zone', 'time'],
    ['time with time zone', 'time'],
    ['bytea', 'binary'],
    ['json', 'variant/json'],
    ['jsonb', 'variant/json'],
    ['integer[]', 'array'],
    ['text[]', 'array'],
    ['uuid', 'other'],
    // pgvector embedding types collapse to `vector` regardless of declared dimension.
    ['vector', 'vector'],
    ['vector(1536)', 'vector'],
    ['halfvec(768)', 'vector'],
    ['sparsevec(30000)', 'vector'],
    ['VECTOR(3)', 'vector'],
    // tsvector is full-text search, not an embedding — must not be mistaken for a vector.
    ['tsvector', 'other'],
  ];

  it.each(cases)('%s → %s', (raw, canonical) => {
    expect(canonicalizeDataType(raw)).toBe(canonical);
  });

  it('is case-insensitive', () => {
    expect(canonicalizeDataType('BIGINT')).toBe('integer');
  });
});
