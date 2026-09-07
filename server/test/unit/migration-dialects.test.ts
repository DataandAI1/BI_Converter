import { describe, it, expect } from 'vitest';
import { getDialect, parseRawType, SCRIPT_TARGETS } from '../../src/convert/dialects.js';

const db = getDialect('databricks')!;
const sf = getDialect('snowflake')!;
const az = getDialect('azure_sql')!;
const syn = getDialect('synapse_dedicated')!;
const pg = getDialect('postgres')!;

describe('parseRawType', () => {
  it('extracts lengths, precision/scale, vector dims and array elements', () => {
    expect(parseRawType('character varying(255)')).toMatchObject({
      base: 'character varying',
      length: 255,
    });
    expect(parseRawType('numeric(10,2)')).toMatchObject({ precision: 10, scale: 2 });
    expect(parseRawType('vector(1536)')).toMatchObject({ base: 'vector', dim: 1536 });
    expect(parseRawType('integer[]')).toMatchObject({ base: 'array', arrayElement: 'integer' });
    expect(parseRawType('nvarchar(max)')).toMatchObject({ base: 'nvarchar', lengthIsMax: true });
    expect(parseRawType(null)).toEqual({ base: '' });
  });
});

describe('type mapping', () => {
  it('every target maps the full canonical taxonomy without throwing', () => {
    const canonicals = [
      'string', 'integer', 'decimal', 'decimal(10,2)', 'float', 'boolean', 'date',
      'timestamp', 'timestamp_tz', 'time', 'binary', 'variant/json', 'array', 'map',
      'struct', 'geography', 'vector', 'other',
    ];
    for (const target of SCRIPT_TARGETS) {
      const d = getDialect(target)!;
      for (const c of canonicals) {
        const m = d.mapType(c, null);
        expect(m.sql.length, `${target}/${c}`).toBeGreaterThan(0);
      }
    }
  });

  it('maps postgres surface onto Databricks', () => {
    expect(db.mapType('string', 'text').sql).toBe('STRING');
    expect(db.mapType('integer', 'int4').sql).toBe('INT');
    expect(db.mapType('integer', 'bigint').sql).toBe('BIGINT');
    expect(db.mapType('timestamp_tz', 'timestamptz').sql).toBe('TIMESTAMP');
    expect(db.mapType('timestamp', 'timestamp').sql).toBe('TIMESTAMP_NTZ');
    expect(db.mapType('variant/json', 'jsonb')).toMatchObject({ sql: 'VARIANT' });
    expect(db.mapType('array', 'integer[]').sql).toBe('ARRAY<INT>');
    expect(db.mapType('time', 'time').note).toMatch(/no TIME/);
    expect(db.mapType('vector', 'vector(1536)').sql).toBe('ARRAY<FLOAT>');
    expect(db.mapType('other', 'uuid').sql).toBe('STRING');
    // Databricks-native complex raw passes through verbatim.
    expect(db.mapType('other', 'struct<a:int,b:string>').sql).toBe('struct<a:int,b:string>');
  });

  it('maps onto Snowflake with vector dims and clamped precision', () => {
    expect(sf.mapType('string', 'varchar(50)').sql).toBe('VARCHAR(50)');
    expect(sf.mapType('vector', 'vector(1536)').sql).toBe('VECTOR(FLOAT, 1536)');
    expect(sf.mapType('decimal(50,10)', 'numeric(50,10)').sql).toBe('NUMBER(38,10)');
    expect(sf.mapType('decimal(50,10)', 'numeric(50,10)').note).toMatch(/clamp/i);
    expect(sf.mapType('timestamp_tz', 'timestamptz').sql).toBe('TIMESTAMP_TZ');
  });

  it('maps onto the T-SQL family with platform capability differences', () => {
    expect(az.mapType('boolean', 'bool').sql).toBe('BIT');
    expect(az.mapType('string', 'varchar(255)').sql).toBe('NVARCHAR(255)');
    expect(az.mapType('other', 'uuid').sql).toBe('UNIQUEIDENTIFIER');
    expect(az.mapType('geography', 'geography').sql).toBe('GEOGRAPHY');
    expect(syn.mapType('geography', 'geography').sql).toBe('VARBINARY(MAX)');
    expect(az.mapType('vector', 'vector(768)').sql).toBe('VECTOR(768)');
    expect(syn.mapType('vector', 'vector(768)').sql).toBe('NVARCHAR(MAX)');
  });

  it('round-trips the postgres surface onto postgres', () => {
    expect(pg.mapType('string', 'text').sql).toBe('TEXT');
    expect(pg.mapType('string', 'character varying(50)').sql).toBe('VARCHAR(50)');
    expect(pg.mapType('array', 'integer[]').sql).toBe('INTEGER[]');
    expect(pg.mapType('vector', 'vector(1536)').sql).toBe('VECTOR(1536)');
    expect(pg.mapType('variant/json', 'jsonb').sql).toBe('JSONB');
    expect(pg.mapType('other', 'uuid').sql).toBe('UUID');
  });

  it('flags unmapped raw types for review instead of guessing silently', () => {
    const m = db.mapType('other', 'tsrange');
    expect(m.sql).toBe('tsrange');
    expect(m.note).toMatch(/unmapped/);
  });
});

describe('default translation', () => {
  it('turns sequence defaults into identity', () => {
    expect(pg.mapDefault(`nextval('sales.orders_id_seq'::regclass)`)).toEqual({ identity: true });
  });

  it('maps temporal and uuid functions to target spellings', () => {
    expect(db.mapDefault('now()').sql).toBe('CURRENT_TIMESTAMP');
    expect(az.mapDefault('now()').sql).toBe('SYSDATETIME()');
    expect(az.mapDefault('gen_random_uuid()').sql).toBe('NEWID()');
    expect(sf.mapDefault('gen_random_uuid()').sql).toBe('UUID_STRING()');
  });

  it('carries literals, stripping casts and T-SQL paren wrapping', () => {
    expect(db.mapDefault(`'open'::text`).sql).toBe(`'open'`);
    expect(db.mapDefault('((0))').sql).toBe('0');
    expect(az.mapDefault('true').sql).toBe('1');
    expect(db.mapDefault('true').sql).toBe('TRUE');
  });

  it('degrades unknown expressions to a TODO note, never broken SQL', () => {
    const m = db.mapDefault(`lower(concat(a, b))`);
    expect(m.sql).toBeUndefined();
    expect(m.note).toMatch(/TODO/);
  });
});

describe('identifier quoting', () => {
  it('quotes and escapes per dialect', () => {
    expect(db.quote('weird`name')).toBe('`weird``name`');
    expect(sf.quote('Weird"Name')).toBe('"Weird""Name"');
    expect(az.quote('weird]name')).toBe('[weird]]name]');
    expect(pg.quote('Weird"Name')).toBe('"Weird""Name"');
  });
});
