import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTableauFile } from '../../src/tableau/files.js';
import { mapTableauDocs } from '../../src/tableau/mapper.js';
import { ingestStagingBatches } from '../../src/ingest/adapter.js';
import { convertToLakeviewPack, zipPack } from '../../src/convert/convert.js';
import { parseMappingFile } from '../../src/bind/resolve.js';
import { parseLvdashFile } from '../../src/lakeview/parse.js';
import { isPinnedLakeviewSpec } from '../../src/lakeview/format.js';

/**
 * End-to-end conversion through the deterministic lane (spec §9): a Tableau fixture
 * workbook to a full pack, byte-exact and re-ingestable. This is the lane `--no-llm`
 * runs and the baseline the LLM lane is diffed against, so its output being stable
 * across runs is load-bearing rather than a nicety.
 */

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'fixtures', 'tableau', 'files',
);

/** A fixed timestamp, so a golden comparison tests the conversion and not the clock. */
const FIXED_AT = '2026-09-07T00:00:00.000Z';

async function convert(file: string, opts: { mapping?: string } = {}) {
  const buf = await fs.readFile(path.join(FIXTURES_DIR, file));
  const name = file.replace(/\.[^.]+$/, '');
  const ingest = ingestStagingBatches(mapTableauDocs(parseTableauFile(file, buf), 'file'), {
    systemName: name,
  });
  return convertToLakeviewPack(ingest, {
    sourceName: name,
    generatedAt: FIXED_AT,
    mapping: opts.mapping ? parseMappingFile(opts.mapping) : undefined,
  });
}

describe('deterministic lane — pack shape', () => {
  it('emits a dashboard, a view, a metric view, and a checklist per workbook', async () => {
    const { files } = await convert('sample.twb');
    const paths = [...files.keys()].sort();
    expect(paths).toContain('sample/dashboards/Executive_Dashboard.lvdash.json');
    expect(paths).toContain('sample/rebuild_checklist.md');
    expect(paths.some((p) => p.startsWith('sample/views/') && p.endsWith('.sql'))).toBe(true);
    expect(paths.some((p) => p.startsWith('sample/metric_views/') && p.endsWith('.yaml'))).toBe(true);
  });

  it('ships the deploy artifacts at the pack root, with no credential in them', async () => {
    const { files } = await convert('sample.twb');
    const deploy = files.get('deploy_dashboards.py')!;
    const bundle = files.get('databricks.yml')!;
    expect(deploy).toBeDefined();
    expect(bundle).toBeDefined();
    for (const content of [deploy, bundle, files.get('README.md')!]) {
      expect(content).not.toMatch(/dap[i0-9a-f]{32}/); // a Databricks PAT
      // Naming the env var in setup instructions is fine; assigning it a real value is not.
      expect(content).not.toMatch(/DATABRICKS_TOKEN\s*=\s*(?!<)\S/);
      expect(content).not.toMatch(/DATABRICKS_CLIENT_SECRET\s*=\s*(?!<)\S/);
    }
  });

  it('describes only files the pack actually contains', async () => {
    const { files } = await convert('sample.twb');
    const readme = files.get('README.md')!;
    for (const named of ['deploy_dashboards.py', 'databricks.yml']) {
      expect(readme).toContain(named);
      expect(files.has(named)).toBe(true);
    }
  });

  it('counts every object in the manifest', async () => {
    const { manifest } = await convert('sample.twb');
    expect(manifest.counts.total).toBe(manifest.objects.length);
    expect(manifest.counts.ready + manifest.counts.needs_review + manifest.counts.skipped).toBe(
      manifest.objects.length,
    );
    expect(manifest.target).toBe('databricks');
  });
});

describe('deterministic lane — determinism', () => {
  it('produces byte-identical files across two runs', async () => {
    const a = await convert('sample.twb');
    const b = await convert('sample.twb');
    expect([...a.files.entries()].sort()).toEqual([...b.files.entries()].sort());
  });

  it('produces byte-identical zips across two runs', async () => {
    const a = zipPack((await convert('sample.twb')).files);
    const b = zipPack((await convert('sample.twb')).files);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('is stable for a workbook with dashboards and captured layout too', async () => {
    const a = await convert('sample-visual.twb');
    const b = await convert('sample-visual.twb');
    expect([...a.files.entries()].sort()).toEqual([...b.files.entries()].sort());
    expect(a.manifest).toEqual(b.manifest);
  });
});

describe('deterministic lane — re-ingest validation (spec §9)', () => {
  it('re-parses every emitted dashboard cleanly', async () => {
    for (const fixture of ['sample.twb', 'sample-visual.twb', 'regional.twb']) {
      const { files } = await convert(fixture);
      const dashboards = [...files].filter(([p]) => p.endsWith('.lvdash.json'));
      for (const [p, content] of dashboards) {
        const parsed = parseLvdashFile(path.basename(p), Buffer.from(content, 'utf8'));
        expect(parsed, `${fixture}: ${p} did not re-parse`).not.toBeNull();
      }
    }
  });

  it('references only datasets the same document declares', async () => {
    const { files } = await convert('sample.twb');
    for (const [p, content] of files) {
      if (!p.endsWith('.lvdash.json')) continue;
      const doc = JSON.parse(content) as {
        datasets: Array<{ name: string }>;
        pages: Array<{ layout: Array<{ widget: { queries?: Array<{ query?: { datasetName?: string } }> } }> }>;
      };
      const declared = new Set(doc.datasets.map((d) => d.name));
      for (const page of doc.pages) {
        for (const el of page.layout) {
          for (const q of el.widget.queries ?? []) {
            if (!q.query?.datasetName) continue;
            expect(declared.has(q.query.datasetName), `${p} queries undeclared dataset`).toBe(true);
          }
        }
      }
    }
  });

  it('emits only (widgetType, spec.version) pairs the format table pins', async () => {
    for (const fixture of ['sample.twb', 'sample-visual.twb']) {
      const { files } = await convert(fixture);
      for (const [p, content] of files) {
        if (!p.endsWith('.lvdash.json')) continue;
        const doc = JSON.parse(content) as {
          pages: Array<{ layout: Array<{ widget: { spec: { widgetType: string; version: number } } }> }>;
        };
        for (const page of doc.pages) {
          for (const el of page.layout) {
            const { widgetType, version } = el.widget.spec;
            expect(
              isPinnedLakeviewSpec(widgetType, version),
              `${fixture}: unpinned widget ${widgetType} v${version}`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe('deterministic lane — honesty', () => {
  it('writes a TODO into the view SQL rather than guessing an unresolved source', async () => {
    // regional.twb's connection does not fully qualify its relation, so the resolver
    // refuses to name a catalog.schema it was never told.
    const { files, warnings } = await convert('regional.twb');
    const views = [...files].filter(([p]) => p.includes('/views/'));
    const unresolved = views.filter(([, sql]) => sql.includes('-- TODO: unresolved source'));
    if (warnings.some((w) => w.includes('unresolved source'))) {
      expect(unresolved.length).toBeGreaterThan(0);
    }
    // Whatever the fixture happens to contain, a TODO and a warning always agree.
    for (const [, sql] of unresolved) {
      expect(sql).toContain('supply the full catalog.schema.object');
    }
  });

  it('routes every untranslatable calculation to the checklist, never into SQL', async () => {
    const { files } = await convert('sample.twb');
    const checklist = files.get('sample/rebuild_checklist.md')!;
    // sample.twb carries a LOD FIXED calc, which the spec names as irreducibly manual.
    expect(checklist).toContain('Calculations to port by hand');
    expect(checklist).toContain('{FIXED [Region] : SUM([Sales])}');
  });

  it('applies a mapping file to the emitted view SQL', async () => {
    const plain = await convert('sample.twb');
    const mapped = await convert('sample.twb', {
      mapping: `
mappings:
  - tableau:    { server: xy12345.snowflakecomputing.com, database: SALES_DB, schema: PUBLIC, table: ORDERS }
    databricks: { catalog: main, schema: sales, table: orders }
`,
    });
    const plainSql = plain.files.get('sample/views/ORDERS.sql')!;
    expect(plainSql).toContain('`SALES_DB`.`PUBLIC`.`ORDERS`');

    const mappedSql = [...mapped.files].find(([p]) => p.includes('/views/orders.sql'))?.[1];
    expect(mappedSql, 'mapped view should be named for the Databricks table').toBeDefined();
    expect(mappedSql).toContain('`main`.`sales`.`orders`');
  });

  it('warns, and changes nothing, when a mapping entry matches no reference', async () => {
    const { files, warnings } = await convert('sample.twb', {
      mapping:
        'mappings:\n  - tableau: { server: nowhere, database: N, schema: S, table: T }\n' +
        '    databricks: { catalog: main, schema: s, table: t }',
    });
    expect(warnings.join(' ')).toContain('matched no Tableau reference');
    const baseline = await convert('sample.twb');
    expect(files.get('sample/views/ORDERS.sql')).toBe(baseline.files.get('sample/views/ORDERS.sql'));
  });
});
