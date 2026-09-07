import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSerializedDashboard,
  parseLvdashFile,
  mapLakeviewDocs,
} from '../../src/lakeview/parse.js';

/**
 * Databricks AI/BI (Lakeview) reader unit coverage (Task 0 — ground-truth harness). No
 * unit-level coverage of the reader existed before this task (only the DB-backed
 * test/integration/lakeview.e2e.test.ts, which this suite does not replace or run). Covers
 * the Task 0 reader change: widget geometry (`position`) capture and round-trip fidelity
 * against the real golden-corpus fixtures in server/test/fixtures/lakeview/.
 */

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'fixtures', 'lakeview',
);

interface RawLvdash {
  datasets?: Array<{ name: string }>;
  pages?: Array<{ layout?: Array<{ widget?: { name?: string }; position?: unknown }> }>;
}

async function readCorpusFile(name: string): Promise<{ buf: Buffer; raw: RawLvdash }> {
  const buf = await fs.readFile(path.join(FIXTURES_DIR, name));
  return { buf, raw: JSON.parse(buf.toString('utf8')) as RawLvdash };
}

describe('parseSerializedDashboard — widget position capture', () => {
  it('populates position from layout[].position when present', () => {
    const { widgets } = parseSerializedDashboard(
      JSON.stringify({
        datasets: [],
        pages: [
          {
            name: 'p1',
            displayName: 'Page One',
            layout: [
              {
                widget: { name: 'w1', spec: { widgetType: 'bar' } },
                position: { x: 1, y: 2, width: 3, height: 4 },
              },
            ],
          },
        ],
      }),
    );
    expect(widgets).toHaveLength(1);
    expect(widgets[0].position).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });

  it('leaves position undefined when layout[].position is absent (never invents geometry)', () => {
    const { widgets } = parseSerializedDashboard(
      JSON.stringify({
        datasets: [],
        pages: [{ layout: [{ widget: { name: 'w1', spec: { widgetType: 'bar' } } }] }],
      }),
    );
    expect(widgets[0].position).toBeUndefined();
  });

  it('leaves position undefined when a position field is malformed (non-numeric)', () => {
    const { widgets } = parseSerializedDashboard(
      JSON.stringify({
        datasets: [],
        pages: [
          {
            layout: [
              {
                widget: { name: 'w1', spec: { widgetType: 'bar' } },
                position: { x: 1, y: 2, width: 'three', height: 4 },
              },
            ],
          },
        ],
      }),
    );
    expect(widgets[0].position).toBeUndefined();
  });

  it('preserves page order and per-widget page name across multiple pages', () => {
    const { widgets } = parseSerializedDashboard(
      JSON.stringify({
        datasets: [],
        pages: [
          { name: 'p1', displayName: 'First', layout: [{ widget: { name: 'a' } }, { widget: { name: 'b' } }] },
          { name: 'p2', displayName: 'Second', layout: [{ widget: { name: 'c' } }] },
        ],
      }),
    );
    expect(widgets.map((w) => [w.name, w.page])).toEqual([
      ['a', 'First'],
      ['b', 'First'],
      ['c', 'Second'],
    ]);
  });
});

describe('parseLvdashFile — queryLines datasets (Task 0 finding, fixed in Phase 3)', () => {
  const lvdash = (datasets: unknown[]): Buffer =>
    Buffer.from(JSON.stringify({ datasets, pages: [] }), 'utf8');

  it('joins newline-terminated queryLines without doubling the newlines (the corpus form)', () => {
    const doc = parseLvdashFile(
      'x.lvdash.json',
      lvdash([
        {
          name: 'ds1',
          displayName: 'toggle',
          queryLines: ['select explode(array(\n', "  'a',\n", "  'b'\n", ')) as toggle'],
        },
      ]),
    );
    expect(doc.datasets[0].query).toBe("select explode(array(\n  'a',\n  'b'\n)) as toggle");
  });

  it('joins bare (unterminated) queryLines with a newline', () => {
    const doc = parseLvdashFile('x.lvdash.json', lvdash([{ name: 'ds1', queryLines: ['SELECT 1', 'FROM t'] }]));
    expect(doc.datasets[0].query).toBe('SELECT 1\nFROM t');
  });

  it('prefers an explicit query string when a dataset carries both', () => {
    const doc = parseLvdashFile(
      'x.lvdash.json',
      lvdash([{ name: 'ds1', query: 'SELECT 1', queryLines: ['SELECT 2'] }]),
    );
    expect(doc.datasets[0].query).toBe('SELECT 1');
  });

  it('leaves query null when a dataset carries neither (never invents SQL)', () => {
    const doc = parseLvdashFile('x.lvdash.json', lvdash([{ name: 'ds1' }]));
    expect(doc.datasets[0].query).toBeNull();
  });

  it('carries queryLines SQL through parseLvdashFile and into definition_sql', async () => {
    const { buf, raw } = await readCorpusFile('account-usage-v2.lvdash.json');
    // Every one of this fixture's datasets uses queryLines exclusively (fixtures README).
    expect((raw.datasets ?? []).length).toBeGreaterThan(0);
    const doc = parseLvdashFile('account-usage-v2.lvdash.json', buf);
    expect(doc.datasets.every((d) => d.query && d.query.trim() !== '')).toBe(true);
    const [rec] = mapLakeviewDocs([doc], 'file');
    expect(rec.definitionSql).not.toBeNull();
    expect(rec.language).toBe('sql');
  });
});

describe('parseLvdashFile — round trip against the golden corpus', () => {
  it.each([
    'jobs-system-tables.lvdash.json',
    'nyc-taxi-trip-analysis.lvdash.json',
    'dbsql-cost-dashboard.lvdash.json',
    'serverless-migration-assistance.lvdash.json',
    'account-usage-v2.lvdash.json',
  ])('retains every dataset, widget, and position from %s', async (file) => {
    const { buf, raw } = await readCorpusFile(file);
    const doc = parseLvdashFile(file, buf);

    expect(doc.datasets).toHaveLength(raw.datasets?.length ?? 0);
    expect(new Set(doc.datasets.map((d) => d.name))).toEqual(
      new Set((raw.datasets ?? []).map((d) => d.name)),
    );

    const rawLayoutEntries = (raw.pages ?? []).flatMap((p) => p.layout ?? []).filter((e) => e.widget?.name);
    expect(doc.widgets).toHaveLength(rawLayoutEntries.length);

    // Every fixture widget carries a real position (server/test/fixtures/lakeview/README.md)
    // — round-tripping must not drop it.
    for (let i = 0; i < rawLayoutEntries.length; i++) {
      expect(doc.widgets[i].position, `widget[${i}] in ${file} should have a position`).toBeDefined();
      expect(doc.widgets[i].position).toEqual(rawLayoutEntries[i].position);
    }
  });
});

describe('mapLakeviewDocs — position flows through additively into platformProperties.widgets', () => {
  it('carries widget position into the persisted widgets array without changing other fields', async () => {
    const { buf } = await readCorpusFile('nyc-taxi-trip-analysis.lvdash.json');
    const doc = parseLvdashFile('nyc-taxi-trip-analysis.lvdash.json', buf);
    const [rec] = mapLakeviewDocs([doc], 'file');
    const widgets = rec.platformProperties!.widgets as Array<{ name: string; position?: unknown }>;
    expect(widgets).toHaveLength(doc.widgets.length);
    expect(widgets[0].position).toEqual(doc.widgets[0].position);
    // Existing fields untouched.
    expect(widgets[0].name).toBe(doc.widgets[0].name);
  });
});

describe('parseLvdashFile — dataset parameters (improvement plan Phase D)', () => {
  it('keeps each dataset parameter keyword/dataType/complexType from the golden corpus', async () => {
    const fixture = path.join(FIXTURES_DIR, 'account-usage-v2.lvdash.json');
    const doc = parseLvdashFile('account-usage-v2.lvdash.json', await fs.readFile(fixture));
    const withParams = doc.datasets.filter((d) => d.parameters && d.parameters.length > 0);
    expect(withParams.length).toBeGreaterThan(0);
    const all = withParams.flatMap((d) => d.parameters!);
    const range = all.find((p) => p.keyword === 'time_range');
    expect(range).toEqual({ keyword: 'time_range', displayName: 'time_range', dataType: 'DATE', complexType: 'RANGE' });
    const plain = all.find((p) => p.keyword === 'param_workspace');
    expect(plain?.dataType).toBe('STRING');
    expect(plain?.complexType).toBeNull();
  });

  it('omits `parameters` entirely for a dataset that declares none', () => {
    const buf = Buffer.from(JSON.stringify({ datasets: [{ name: 'ds1', query: 'SELECT 1' }], pages: [] }), 'utf8');
    const doc = parseLvdashFile('x.lvdash.json', buf);
    expect('parameters' in doc.datasets[0]).toBe(false);
  });
});
