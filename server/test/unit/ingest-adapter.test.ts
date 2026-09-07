import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTableauFile } from '../../src/tableau/files.js';
import { mapTableauDocs } from '../../src/tableau/mapper.js';
import { ingestStagingBatches } from '../../src/ingest/adapter.js';
import { groupBiAssets } from '../../src/bi/grouping.js';
import type { StagingBatch } from '../../src/tableau/staging.js';

/**
 * The ingest seam (spec §5) — the one structural change that makes the extraction from
 * Linetria possible. These tests pin the four things Postgres used to guarantee: the FQN
 * shape, edge ordering, id stability across runs, and the columns/derivations indexes.
 */

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'fixtures', 'tableau', 'files',
);

let batches: StagingBatch[];

async function ingestFixture(file: string, name = file.replace(/\.[^.]+$/, '')) {
  const buf = await fs.readFile(path.join(FIXTURES_DIR, file));
  const docs = parseTableauFile(file, buf);
  return ingestStagingBatches(mapTableauDocs(docs, 'file'), { systemName: name });
}

beforeAll(async () => {
  const buf = await fs.readFile(path.join(FIXTURES_DIR, 'sample.twb'));
  batches = mapTableauDocs(parseTableauFile('sample.twb', buf), 'file');
});

describe('ingestStagingBatches — assets and the FQN scheme', () => {
  it('mints one asset per staged record, ordered by fqn as loadBiAssets was', () => {
    const { assets } = ingestStagingBatches(batches, { systemName: 'sample' });
    expect(assets.length).toBeGreaterThan(0);
    const fqns = assets.map((a) => a.fqn);
    expect(fqns).toEqual([...fqns].sort());
  });

  it('applies catalog.schema.object lower-cased, skipping null levels', () => {
    const { assets } = ingestStagingBatches(batches, { systemName: 'sample' });
    const wb = assets.find((a) => a.asset_type === 'bi_workbook');
    expect(wb).toBeDefined();
    // File mode has no server context: site 'default', project '' -> schema null.
    expect(wb!.catalog).toBe('default');
    expect(wb!.fqn).toBe('default.sample');
    for (const a of assets) expect(a.fqn).toBe(a.fqn.toLowerCase());
  });

  it('carries every asset under one synthetic source system', () => {
    const { assets } = ingestStagingBatches(batches, { systemName: 'sample' });
    const systems = new Set(assets.map((a) => a.source_system_id));
    expect(systems.size).toBe(1);
    expect(assets.every((a) => a.platform === 'tableau')).toBe(true);
    expect(assets.every((a) => a.system_name === 'sample')).toBe(true);
  });

  it('produces the workbook, its sheets, and its embedded datasources', () => {
    const { assets } = ingestStagingBatches(batches, { systemName: 'sample' });
    const types = new Set(assets.map((a) => a.asset_type));
    expect(types.has('bi_workbook')).toBe(true);
    expect(types.has('bi_sheet')).toBe(true);
    expect(types.has('bi_datasource')).toBe(true);
  });
});

describe('ingestStagingBatches — id stability', () => {
  it('is byte-identical across two runs over the same input', async () => {
    const a = await ingestFixture('sample.twb');
    const b = await ingestFixture('sample.twb');
    expect(a.assets).toEqual(b.assets);
    expect(a.edges).toEqual(b.edges);
    expect([...a.columnsByAsset]).toEqual([...b.columnsByAsset]);
    expect([...a.derivationsByAsset]).toEqual([...b.derivationsByAsset]);
  });

  it('derives an asset id from its fqn alone, so the id survives a re-parse', async () => {
    const first = await ingestFixture('sample.twb');
    const again = ingestStagingBatches(batches, { systemName: 'sample' });
    const byFqn = new Map(again.assets.map((a) => [a.fqn, a.id]));
    for (const a of first.assets) expect(byFqn.get(a.fqn)).toBe(a.id);
  });

  it('gives two different workbooks different ids', async () => {
    const sample = await ingestFixture('sample.twb');
    const regional = await ingestFixture('regional.twb');
    const shared = sample.assets.filter((a) => regional.assets.some((r) => r.id === a.id));
    expect(shared).toEqual([]);
  });
});

describe('ingestStagingBatches — edges', () => {
  it('resolves FQN-keyed dependencies to minted asset ids', () => {
    const { assets, edges } = ingestStagingBatches(batches, { systemName: 'sample' });
    const ids = new Set(assets.map((a) => a.id));
    expect(edges.length).toBeGreaterThan(0);
    for (const e of edges) {
      expect(ids.has(e.from_asset_id)).toBe(true);
      expect(ids.has(e.to_asset_id)).toBe(true);
    }
  });

  it('sorts by (from, to, to_column_id NULLS FIRST) as loadBiEdges did in SQL', () => {
    const { edges } = ingestStagingBatches(batches, { systemName: 'sample' });
    const key = (e: (typeof edges)[number]) =>
      `${e.from_asset_id}|${e.to_asset_id}|${e.to_column_id ?? ''}`;
    const keys = edges.map(key);
    expect(keys).toEqual([...keys].sort());
    // Asset-grain rows precede the column-grain rows for the same pair.
    for (let i = 1; i < edges.length; i++) {
      const prev = edges[i - 1];
      const cur = edges[i];
      if (prev.from_asset_id === cur.from_asset_id && prev.to_asset_id === cur.to_asset_id) {
        if (prev.to_column_id === null) continue;
        expect(cur.to_column_id).not.toBeNull();
      }
    }
  });

  it('points column-grain edges at a real column of the target asset', () => {
    const { edges, columnsByAsset } = ingestStagingBatches(batches, { systemName: 'sample' });
    const columnGrain = edges.filter((e) => e.to_column_id);
    expect(columnGrain.length).toBeGreaterThan(0);
    for (const e of columnGrain) {
      const cols = columnsByAsset.get(e.to_asset_id) ?? [];
      expect(cols.some((c) => c.id === e.to_column_id && c.name === e.to_column_name)).toBe(true);
    }
  });

  it('emits no duplicate edge rows', () => {
    const { edges } = ingestStagingBatches(batches, { systemName: 'sample' });
    const keys = edges.map((e) => `${e.from_asset_id}|${e.to_asset_id}|${e.to_column_id ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('ingestStagingBatches — columns and derivations', () => {
  it('indexes columns by asset, in ordinal order, with a canonical data type', () => {
    const { assets, columnsByAsset } = ingestStagingBatches(batches, { systemName: 'sample' });
    const ds = assets.find((a) => a.asset_type === 'bi_datasource')!;
    const cols = columnsByAsset.get(ds.id) ?? [];
    expect(cols.length).toBeGreaterThan(0);
    expect(cols.map((c) => c.ordinal)).toEqual([...cols.map((c) => c.ordinal)].sort((a, b) => (a ?? 0) - (b ?? 0)));
    for (const c of cols) {
      expect(c.asset_id).toBe(ds.id);
      if (c.data_type_raw) expect(c.data_type_canonical).not.toBeNull();
    }
  });

  it('promotes a calculated field to BOTH a column row and a derivation row', () => {
    const { columnsByAsset, derivationsByAsset } = ingestStagingBatches(batches, {
      systemName: 'sample',
    });
    const allDerivations = [...derivationsByAsset.values()].flat();
    expect(allDerivations.length).toBeGreaterThan(0);
    for (const d of allDerivations) {
      const cols = columnsByAsset.get(d.asset_id) ?? [];
      const col = cols.find((c) => c.id === d.output_column_id);
      expect(col, `derivation '${d.output_name}' has no matching column row`).toBeDefined();
      expect(col!.name).toBe(d.output_name);
      expect(d.expression_sql.length).toBeGreaterThan(0);
      expect(d.language).toBe('tableau_calc');
    }
  });

  it('keeps the tokenizer classification the connector attached', () => {
    const { derivationsByAsset } = ingestStagingBatches(batches, { systemName: 'sample' });
    const classified = [...derivationsByAsset.values()]
      .flat()
      .filter((d) => d.derivation_type && d.derivation_type.length > 0);
    expect(classified.length).toBeGreaterThan(0);
  });
});

describe('ingestStagingBatches — bindings and grouping', () => {
  it('keys staged bindings by asset id without deciding their status', () => {
    const { assets, bindingsByAsset } = ingestStagingBatches(batches, { systemName: 'sample' });
    const ids = new Set(assets.map((a) => a.id));
    expect(bindingsByAsset.size).toBeGreaterThan(0);
    for (const [assetId, binds] of bindingsByAsset) {
      expect(ids.has(assetId)).toBe(true);
      for (const b of binds) expect(b.normalizedKey.length).toBeGreaterThan(0);
    }
  });

  it('feeds groupBiAssets a graph it can regroup into workbook containers', () => {
    const { assets, edges } = ingestStagingBatches(batches, { systemName: 'sample' });
    const { topLevel, members } = groupBiAssets(assets, edges);
    const wb = topLevel.find((a) => a.asset_type === 'bi_workbook');
    expect(wb, 'the workbook should be a top-level container').toBeDefined();
    const own = members.get(wb!.id) ?? [];
    expect(own.some((m) => m.asset_type === 'bi_sheet')).toBe(true);
    expect(own.some((m) => m.asset_type === 'bi_datasource')).toBe(true);
  });
});

describe('ingestStagingBatches — honesty', () => {
  it('warns rather than inventing an asset when a dependency names one that was not extracted', () => {
    const orphaned: StagingBatch[] = [
      {
        pass: 'bi',
        assets: [{ catalog: 'default', schemaName: null, name: 'wb', assetType: 'bi_workbook' }],
        dependencies: [
          {
            fromCatalog: 'default', fromSchema: null, fromName: 'wb',
            toCatalog: 'default', toSchema: null, toName: 'missing',
            dependencyKind: 'bi_declared',
          },
        ],
      },
    ];
    const { assets, edges, warnings } = ingestStagingBatches(orphaned, { systemName: 'x' });
    expect(assets).toHaveLength(1);
    expect(edges).toEqual([]);
    expect(warnings.join(' ')).toContain('was not extracted');
  });

  it('passes connector warnings through untouched', () => {
    const result = ingestStagingBatches([{ pass: 'bi', warnings: ['upstream said so'] }], {
      systemName: 'x',
    });
    expect(result.warnings).toContain('upstream said so');
  });
});
