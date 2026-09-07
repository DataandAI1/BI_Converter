import { describe, it, expect } from 'vitest';
import { parseMappingFile, resolveBindings } from '../../src/bind/resolve.js';
import type { StagingBiBindingRec } from '../../src/tableau/staging.js';

/**
 * Binding policy (spec §6): passthrough by default, mapping-file override, and never a
 * fabricated name. The discipline under test is that matching is exact after
 * normalization — a resolver that guessed would produce confidently wrong Unity Catalog
 * names, which is the failure the whole design exists to prevent.
 */

function binding(
  overrides: Partial<StagingBiBindingRec> & { refs: StagingBiBindingRec['refs'] },
): StagingBiBindingRec {
  return {
    assetFqn: 'default.wb/ds',
    assetType: 'bi_datasource',
    descriptor: { platform_hint: 'snowflake', account: 'sf-prod', database: 'ANALYTICS' },
    normalizedKey: 'snowflake|account=sf-prod',
    ...overrides,
  };
}

const declared = (parts: { catalog?: string; schema?: string; object: string }) => ({
  parts,
  via: 'declared' as const,
});

function resolveOne(rec: StagingBiBindingRec, mapping?: Parameters<typeof resolveBindings>[1]) {
  const out = resolveBindings(new Map([['asset-1', [rec]]]), mapping ?? {});
  return { binding: out.bindingsByAsset.get('asset-1')![0], ...out };
}

describe('parseMappingFile', () => {
  it('parses the documented shape', () => {
    const m = parseMappingFile(`
mappings:
  - tableau:    { server: sf-prod, database: ANALYTICS, schema: PUBLIC, table: ORDERS }
    databricks: { catalog: main, schema: sales, table: orders }
`);
    expect(m.mappings).toHaveLength(1);
    expect(m.mappings[0].databricks).toEqual({ catalog: 'main', schema: 'sales', table: 'orders' });
  });

  it('rejects a file with no mappings list rather than silently mapping nothing', () => {
    expect(() => parseMappingFile('other: 1')).toThrow(/mappings/);
    expect(() => parseMappingFile('[]')).toThrow(/mappings/);
  });

  it('rejects an entry whose databricks side names nothing', () => {
    expect(() =>
      parseMappingFile('mappings:\n  - tableau: { table: ORDERS }\n    databricks: {}'),
    ).toThrow(/names no catalog, schema, or table/);
  });

  it('rejects an entry missing either side', () => {
    expect(() => parseMappingFile('mappings:\n  - tableau: { table: X }')).toThrow(/databricks/);
    expect(() => parseMappingFile('mappings:\n  - databricks: { table: X }')).toThrow(/tableau/);
  });
});

describe('resolveBindings — step 1, descriptor passthrough', () => {
  it('uses the Tableau connection names as the Unity Catalog names', () => {
    const { binding: b, stats } = resolveOne(
      binding({ refs: [declared({ catalog: 'SALES_DB', schema: 'PUBLIC', object: 'ORDERS' })] }),
    );
    expect(b.status).toBe('matched');
    expect(b.refs![0].parts).toEqual({ catalog: 'SALES_DB', schema: 'PUBLIC', object: 'ORDERS' });
    expect(stats.passthrough).toBe(1);
    expect(stats.mapped).toBe(0);
  });

  it('preserves the original case — Unity Catalog names are not lower-cased for us', () => {
    const { binding: b } = resolveOne(
      binding({ refs: [declared({ catalog: 'SALES_DB', schema: 'PUBLIC', object: 'ORDERS' })] }),
    );
    expect(b.refs![0].parts.object).toBe('ORDERS');
  });

  it('falls back to the descriptor database when a 2-part ref names no catalog', () => {
    const { binding: b } = resolveOne(
      binding({ refs: [declared({ schema: 'PUBLIC', object: 'ORDERS' })] }),
    );
    expect(b.status).toBe('matched');
    expect(b.refs![0].parts.catalog).toBe('ANALYTICS');
  });
});

describe('resolveBindings — step 2, mapping file override', () => {
  const mapping = {
    mapping: parseMappingFile(`
mappings:
  - tableau:    { server: sf-prod, database: ANALYTICS, schema: PUBLIC, table: ORDERS }
    databricks: { catalog: main, schema: sales, table: orders }
`),
  };

  it('rewrites a matching reference to the Databricks name', () => {
    const { binding: b, stats } = resolveOne(
      binding({ refs: [declared({ schema: 'PUBLIC', object: 'ORDERS' })] }),
      mapping,
    );
    expect(b.refs![0].parts).toEqual({ catalog: 'main', schema: 'sales', table: undefined, object: 'orders' });
    expect(stats.mapped).toBe(1);
    expect(stats.passthrough).toBe(0);
  });

  it('wins over passthrough even when the reference is already fully qualified', () => {
    const { binding: b } = resolveOne(
      binding({ refs: [declared({ catalog: 'ANALYTICS', schema: 'PUBLIC', object: 'ORDERS' })] }),
      mapping,
    );
    expect(b.refs![0].parts.catalog).toBe('main');
  });

  it('matches case-insensitively and through Tableau brackets, but never fuzzily', () => {
    const { binding: hit } = resolveOne(
      binding({ refs: [declared({ schema: '[public]', object: 'orders' })] }),
      mapping,
    );
    expect(hit.refs![0].parts.catalog).toBe('main');

    // A near-miss is a miss: 'ORDER' is not 'ORDERS'.
    const { binding: miss } = resolveOne(
      binding({ refs: [declared({ schema: 'PUBLIC', object: 'ORDER' })] }),
      mapping,
    );
    expect(miss.refs![0].parts.object).toBe('ORDER');
  });

  it('does not apply an entry whose server names a different system', () => {
    const { binding: b } = resolveOne(
      binding({
        descriptor: { platform_hint: 'snowflake', account: 'sf-dev', database: 'ANALYTICS' },
        refs: [declared({ schema: 'PUBLIC', object: 'ORDERS' })],
      }),
      mapping,
    );
    expect(b.refs![0].parts.catalog).toBe('ANALYTICS');
  });

  it('warns when a mapping entry matches nothing, rather than silently no-opping', () => {
    const { warnings } = resolveOne(
      binding({ refs: [declared({ schema: 'PUBLIC', object: 'CUSTOMERS' })] }),
      mapping,
    );
    expect(warnings.join(' ')).toContain('matched no Tableau reference');
  });

  it('emits no unmatched-entry warning when every entry was used', () => {
    const { warnings } = resolveOne(
      binding({ refs: [declared({ schema: 'PUBLIC', object: 'ORDERS' })] }),
      mapping,
    );
    expect(warnings.join(' ')).not.toContain('matched no Tableau reference');
  });

  it('normalizes a host with a scheme so it still matches', () => {
    const m = {
      mapping: parseMappingFile(`
mappings:
  - tableau:    { server: "https://dw.example.com/", database: db, schema: s, table: t }
    databricks: { catalog: main, schema: sales, table: t }
`),
    };
    const { binding: b } = resolveOne(
      binding({
        descriptor: { platform_hint: 'postgres', host: 'dw.example.com', database: 'db' },
        refs: [declared({ schema: 's', object: 't' })],
      }),
      m,
    );
    expect(b.refs![0].parts.catalog).toBe('main');
  });
});

describe('resolveBindings — step 3, never fabricate', () => {
  it('leaves a reference the converter cannot ground untouched, and says so', () => {
    const { binding: b, warnings, stats } = resolveOne(
      binding({
        descriptor: { platform_hint: 'snowflake', account: 'sf-prod' },
        refs: [declared({ object: 'ORDERS' })],
      }),
    );
    expect(b.status).toBe('unmatched');
    expect(b.refs![0].parts).toEqual({ object: 'ORDERS' });
    expect(stats.unresolved).toBe(1);
    expect(warnings.join(' ')).toContain('unresolved source');
    expect(warnings.join(' ')).toContain('catalog and schema');
  });

  it('marks the whole connection unmatched when any one of its references dangles', () => {
    const { binding: b } = resolveOne(
      binding({
        descriptor: { platform_hint: 'snowflake', account: 'sf-prod' },
        refs: [
          declared({ catalog: 'A', schema: 'B', object: 'GOOD' }),
          declared({ object: 'BAD' }),
        ],
      }),
    );
    expect(b.status).toBe('unmatched');
  });
});

describe('resolveBindings — ordering and custom SQL', () => {
  it('orders matched bindings first, as semantic-layer.ts reads bindings[0]', () => {
    const out = resolveBindings(
      new Map([
        [
          'asset-1',
          [
            binding({
              descriptor: { platform_hint: 'snowflake', account: 'sf-prod' },
              refs: [declared({ object: 'DANGLING' })],
            }),
            binding({ refs: [declared({ catalog: 'C', schema: 'S', object: 'T' })] }),
          ],
        ],
      ]),
      {},
    );
    const binds = out.bindingsByAsset.get('asset-1')!;
    expect(binds.map((b) => b.status)).toEqual(['matched', 'unmatched']);
  });

  it('treats a custom-SQL-only connection as resolved when the descriptor names a server', () => {
    const { binding: b, stats } = resolveOne(
      binding({ refs: [{ parts: { object: 'q' }, via: 'custom_sql' }] }),
    );
    // No table name to get wrong; the semantic layer reviews the SQL dialect separately.
    expect(b.status).toBe('matched');
    expect(stats.refs).toBe(0);
  });

  it('leaves a custom-SQL connection with no identifiable server unmatched', () => {
    const { binding: b } = resolveOne(
      binding({
        descriptor: { platform_hint: 'excel' },
        refs: [{ parts: { object: 'q' }, via: 'custom_sql' }],
      }),
    );
    expect(b.status).toBe('unmatched');
  });

  it('never rewrites a custom SQL reference', () => {
    const m = {
      mapping: parseMappingFile(
        'mappings:\n  - tableau: { server: sf-prod, database: ANALYTICS, schema: PUBLIC, table: q }\n' +
          '    databricks: { catalog: main, schema: sales, table: q2 }',
      ),
    };
    const { binding: b } = resolveOne(
      binding({ refs: [{ parts: { schema: 'PUBLIC', object: 'q' }, via: 'custom_sql' }] }),
      m,
    );
    expect(b.refs![0].parts.object).toBe('q');
  });
});
