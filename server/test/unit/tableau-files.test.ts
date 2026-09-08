import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { parseTableauFile } from '../../src/tableau/files.js';
import { mapTableauDocs } from '../../src/tableau/mapper.js';
import { normalizeDescriptor } from '../../src/tableau/descriptors.js';
import type { TableauWorkbookDoc } from '../../src/tableau/model.js';
import type { StagingBiBindingRec, StagingDependencyRec } from '../../src/tableau/staging.js';

/**
 * Tableau file-mode parsing (BI connectors plan Task 4): XML → doc-model exactness,
 * .twbx/.tdsx zip unwrapping, and the mapper's staging snapshot (FQNs per decision 2,
 * chain kinds, binding refs). files.ts and mapper.ts are the single normalizer live mode
 * (Task 5) will reuse verbatim (spec §4 invariant).
 */

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'fixtures', 'tableau', 'files',
);

let sampleTwbBuf: Buffer;
let publishedTdsBuf: Buffer;

beforeAll(async () => {
  sampleTwbBuf = await fs.readFile(path.join(FIXTURES_DIR, 'sample.twb'));
  publishedTdsBuf = await fs.readFile(path.join(FIXTURES_DIR, 'published.tds'));
});

function findDs(doc: TableauWorkbookDoc, name: string) {
  const ds = doc.datasources.find((d) => d.name === name);
  if (!ds) throw new Error(`datasource '${name}' not found in doc`);
  return ds;
}

describe('parseTableauFile — .twb XML exactness', () => {
  let docs: TableauWorkbookDoc[];
  let doc: TableauWorkbookDoc;

  beforeAll(() => {
    docs = parseTableauFile('sample.twb', sampleTwbBuf);
    doc = docs[0];
  });

  it('returns exactly one workbook doc, named from the filename (file mode has no server context)', () => {
    expect(docs).toHaveLength(1);
    expect(doc.site).toBe('default');
    expect(doc.project).toBe('');
    expect(doc.name).toBe('sample');
  });

  it('parses both datasources with their identity and published flag', () => {
    expect(doc.datasources).toHaveLength(2);
    const names = doc.datasources.map((d) => d.name).sort();
    expect(names).toEqual(['postgres-orders', 'snowflake-sales']);
    expect(doc.datasources.every((d) => d.published === false)).toBe(true);
  });

  it('resolves the snowflake named-connection into a BiDescriptor with a derived account', () => {
    const ds = findDs(doc, 'snowflake-sales');
    expect(ds.connections).toHaveLength(1);
    expect(ds.connections[0]).toMatchObject({
      platform_hint: 'snowflake',
      host: 'xy12345.snowflakecomputing.com',
      database: 'SALES_DB',
      warehouse: 'ANALYTICS_WH',
      schema: 'PUBLIC',
      connection_type: 'snowflake',
      account: 'xy12345',
    });
    expect((ds.connections[0].extra as Record<string, unknown>).named_connection).toBe(
      'snowflake.0abc123',
    );
  });

  it('resolves the postgres named-connection into a BiDescriptor', () => {
    const ds = findDs(doc, 'postgres-orders');
    expect(ds.connections).toHaveLength(1);
    expect(ds.connections[0]).toMatchObject({
      platform_hint: 'postgres',
      host: 'warehouse.internal',
      database: 'salesdb',
      connection_type: 'postgres',
    });
    expect((ds.connections[0].extra as Record<string, unknown>).named_connection).toBe(
      'postgres.0def456',
    );
  });

  it('parses a declared table relation with catalog/schema/object parts', () => {
    const ds = findDs(doc, 'snowflake-sales');
    expect(ds.relations).toEqual([
      {
        kind: 'table',
        table: { schema: 'PUBLIC', object: 'ORDERS' },
        connection: 'snowflake.0abc123',
      },
    ]);
  });

  it('parses a custom SQL relation, XML-entity-decoded, with no table parts', () => {
    const ds = findDs(doc, 'postgres-orders');
    expect(ds.relations).toEqual([
      {
        kind: 'custom_sql',
        sql: 'SELECT customer_id, region, revenue FROM orders_summary WHERE revenue > 0',
        connection: 'postgres.0def456',
      },
    ]);
  });

  it('parses plain (non-calculated) fields with caption/datatype/role and no formula', () => {
    const ds = findDs(doc, 'snowflake-sales');
    const sales = ds.fields.find((f) => f.name === 'Sales');
    expect(sales).toEqual({ name: 'Sales', caption: 'Sales', datatype: 'real', role: 'measure' });
  });

  it('covers every decision-8 taxonomy row across the calculated fields, XML-entity-decoded', () => {
    const ds = findDs(doc, 'snowflake-sales');
    const calc = (name: string) => ds.fields.find((f) => f.name === name);

    expect(calc('Calculation_1')).toMatchObject({
      caption: 'Profit Tier',
      formula: 'IF [Sales] > 100 THEN "High" ELSE "Low" END',
    });
    expect(calc('Calculation_2')).toMatchObject({ caption: 'Total Sales', formula: 'SUM([Sales])' });
    expect(calc('Calculation_3')).toMatchObject({
      caption: 'Sales by Region (Fixed)',
      formula: '{FIXED [Region] : SUM([Sales])}',
    });
    expect(calc('Calculation_4')).toMatchObject({
      caption: 'Order Date Plus 30',
      formula: "DATEADD('day', 30, [Order Date])",
    });
    expect(calc('Calculation_5')).toMatchObject({
      caption: 'Customer Prefix',
      formula: 'LEFT([Customer Name], 3)',
    });
    expect(calc('Calculation_6')).toMatchObject({ caption: 'Customer Ref', formula: '[Customer ID]' });
    expect(calc('Calculation_7')).toMatchObject({
      caption: 'Region Label',
      formula: '"North America"',
    });
    expect(calc('Calculation_8')).toMatchObject({
      caption: 'Weighted Score',
      formula: 'CUSTOMSCORE([Sales], [Cost])',
    });
  });

  it('parses worksheets with datasource + field-grain dependency refs', () => {
    expect(doc.sheets).toEqual([
      {
        name: 'Sales Overview',
        datasourceRefs: ['snowflake-sales'],
        fieldRefs: [
          { ds: 'snowflake-sales', field: 'Order ID' },
          { ds: 'snowflake-sales', field: 'Calculation_2' },
          { ds: 'snowflake-sales', field: 'Calculation_1' },
        ],
      },
      {
        name: 'Customer Detail',
        datasourceRefs: ['postgres-orders'],
        fieldRefs: [
          { ds: 'postgres-orders', field: 'region' },
          { ds: 'postgres-orders', field: 'revenue' },
        ],
      },
    ]);
  });

  it('parses dashboards with their zone-referenced sheet names', () => {
    expect(doc.dashboards).toEqual([
      { name: 'Executive Dashboard', sheetNames: ['Sales Overview', 'Customer Detail'] },
    ]);
  });
});

describe('parseTableauFile — .twbx unzip', () => {
  it('unwraps a packaged workbook to the identical doc a bare .twb produces', () => {
    const zipped = Buffer.from(zipSync({ 'sample.twb': new Uint8Array(sampleTwbBuf) }));
    const fromTwbx = parseTableauFile('sample.twbx', zipped);
    const fromTwb = parseTableauFile('sample.twb', sampleTwbBuf);
    // The workbook identity is derived from the *outer* filename either way, so both
    // should be named 'sample' — otherwise identical.
    expect(fromTwbx).toEqual(fromTwb);
  });
});

describe('parseTableauFile — input that is not quite what the extension says', () => {
  it('prefers the workbook inside a .twbx that also packages a .tds, whichever the zip lists first', () => {
    // A packaged workbook routinely carries its embedded datasources as `Data/**/*.tds`
    // beside the `.twb`. Taking the first entry that matched either extension read the
    // datasource and silently converted the workbook as a sheetless .tds.
    const zipped = Buffer.from(
      zipSync({
        'Data/Datasources/published.tds': new Uint8Array(publishedTdsBuf),
        'sample.twb': new Uint8Array(sampleTwbBuf),
      }),
    );
    const fromTwbx = parseTableauFile('sample.twbx', zipped);
    expect(fromTwbx).toEqual(parseTableauFile('sample.twb', sampleTwbBuf));
    expect(fromTwbx[0].sheets.length).toBeGreaterThan(0);
  });

  it('prefers the shallowest .tds inside a .tdsx', () => {
    const zipped = Buffer.from(
      zipSync({
        'Data/Extracts/other.tds': new Uint8Array(Buffer.from('<datasource name="other"/>')),
        'published.tds': new Uint8Array(publishedTdsBuf),
      }),
    );
    expect(parseTableauFile('published.tdsx', zipped)).toEqual(
      parseTableauFile('published.tds', publishedTdsBuf),
    );
  });

  it('reads a workbook saved with a UTF-8 byte-order mark', () => {
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), sampleTwbBuf]);
    expect(parseTableauFile('sample.twb', bom)).toEqual(parseTableauFile('sample.twb', sampleTwbBuf));
  });

  it('reads a workbook saved as UTF-16 (either byte order)', () => {
    const text = sampleTwbBuf.toString('utf8');
    const le = Buffer.from(`﻿${text}`, 'utf16le');
    const be = Buffer.from(le.map((_, i, arr) => (i % 2 === 0 ? arr[i + 1] : arr[i - 1])));
    const expected = parseTableauFile('sample.twb', sampleTwbBuf);
    expect(parseTableauFile('sample.twb', le)).toEqual(expected);
    expect(parseTableauFile('sample.twb', be)).toEqual(expected);
  });

  it('names the file and says the package is unreadable when the zip is corrupt', () => {
    const corrupt = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => parseTableauFile('broken.twbx', corrupt)).toThrow(
      /'broken\.twbx'.*not a readable zip/,
    );
  });

  it('names the file and the position when the XML is truncated', () => {
    const half = sampleTwbBuf.subarray(0, Math.floor(sampleTwbBuf.length / 2));
    expect(() => parseTableauFile('half.twb', half)).toThrow(/'half\.twb'.*XML/);
  });

  it('says an empty file is empty', () => {
    expect(() => parseTableauFile('empty.twb', Buffer.alloc(0))).toThrow(/'empty\.twb' is empty/);
  });
});

describe('parseTableauFile — joined and unioned relations', () => {
  const twb = (relations: string) => Buffer.from(`<?xml version='1.0' encoding='utf-8' ?>
<workbook>
  <datasources>
    <datasource name='joined' caption='Joined'>
      <connection class='federated'>
        <named-connections>
          <named-connection caption='pg' name='postgres.0def456'>
            <connection class='postgres' dbname='shop' port='5432' server='db.example.com' />
          </named-connection>
        </named-connections>
        ${relations}
      </connection>
      <column datatype='string' name='[region]' role='dimension' type='nominal' />
    </datasource>
  </datasources>
</workbook>`);

  it('keeps every table under a join, not the join node itself', () => {
    const [doc] = parseTableauFile('joined.twb', twb(`
        <relation join='inner' type='join'>
          <clause type='join'><expression op='='><expression op='[orders].[customer_id]' /><expression op='[customers].[id]' /></expression></clause>
          <relation connection='postgres.0def456' name='orders' table='[public].[orders]' type='table' />
          <relation connection='postgres.0def456' name='customers' table='[public].[customers]' type='table' />
        </relation>`));
    expect(doc.datasources[0].relations).toEqual([
      { kind: 'table', table: { schema: 'public', object: 'orders' }, connection: 'postgres.0def456' },
      { kind: 'table', table: { schema: 'public', object: 'customers' }, connection: 'postgres.0def456' },
    ]);
  });

  it('flattens nested joins, unions and collections, and keeps custom SQL leaves', () => {
    const [doc] = parseTableauFile('joined.twb', twb(`
        <relation type='collection'>
          <relation join='left' type='join'>
            <relation type='union' name='all_orders'>
              <relation connection='postgres.0def456' name='orders_2024' table='[public].[orders_2024]' type='table' />
              <relation connection='postgres.0def456' name='orders_2025' table='[public].[orders_2025]' type='table' />
            </relation>
            <relation connection='postgres.0def456' name='Custom SQL Query' type='text'>SELECT id FROM customers</relation>
          </relation>
        </relation>`));
    expect(doc.datasources[0].relations.map((r) => r.kind === 'table' ? r.table?.object : r.sql)).toEqual([
      'orders_2024',
      'orders_2025',
      'SELECT id FROM customers',
    ]);
  });
});

describe('parseTableauFile — standalone .tds', () => {
  let docs: TableauWorkbookDoc[];

  beforeAll(() => {
    docs = parseTableauFile('published.tds', publishedTdsBuf);
  });

  it('yields a workbook-shaped doc with no sheets/dashboards and one published datasource', () => {
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    expect(doc.sheets).toEqual([]);
    expect(doc.dashboards).toEqual([]);
    expect(doc.datasources).toHaveLength(1);
    expect(doc.datasources[0].published).toBe(true);
    expect(doc.datasources[0].name).toBe('federated.0xyz789');
  });

  it('parses the published datasource fields and its calc formula', () => {
    const ds = docs[0].datasources[0];
    const calc = ds.fields.find((f) => f.name === 'Calculation_1');
    expect(calc).toMatchObject({ caption: 'Amount Rounded', formula: 'ROUND([Amount])' });
  });
});

describe('parseTableauFile — .tdsx unzip', () => {
  it('unwraps a packaged datasource to the identical doc a bare .tds produces', () => {
    const zipped = Buffer.from(zipSync({ 'published.tds': new Uint8Array(publishedTdsBuf) }));
    const fromTdsx = parseTableauFile('published.tdsx', zipped);
    const fromTds = parseTableauFile('published.tds', publishedTdsBuf);
    expect(fromTdsx).toEqual(fromTds);
  });
});

describe('visual structure (sample-visual.twb)', () => {
  const docs = parseTableauFile('sample-visual.twb',
    readFileSync(path.join(FIXTURES_DIR, 'sample-visual.twb')));
  const wb = docs[0];

  it('extracts mark class, shelves, encodings, and filters per sheet', () => {
    const bar = wb.sheets.find((s) => s.name === 'Sales by Region')!;
    expect(bar.visual).toEqual({
      markClass: 'Bar',
      markClasses: ['Bar'],
      rows: ['Region'],
      cols: ['Sales'],
      rowsRaw: '[federated.0abc123].[none:Region:nk]',
      colsRaw: '[federated.0abc123].[sum:Sales:qk]',
      encodings: [{ channel: 'color', field: 'Region' }],
      filters: [{ field: 'Region', filterClass: 'categorical' }],
    });
    const trend = wb.sheets.find((s) => s.name === 'Sales Trend')!;
    expect(trend.visual!.markClass).toBe('Automatic');
    expect(trend.visual!.cols).toEqual(['Order Date']);
  });

  it('extracts dashboard layout with percentage zones and size', () => {
    const dash = wb.dashboards.find((d) => d.name === 'Regional Overview')!;
    expect(dash.layout!.width).toBe(1200);
    expect(dash.layout!.height).toBe(800);
    expect(dash.layout!.sizing).toBe('fixed');
    // nested zones are flattened; the outer layout container is kept with its type
    expect(dash.layout!.zones).toContainEqual(
      { sheetName: 'Sales by Region', type: 'worksheet', x: 0, y: 0, w: 100, h: 50 });
    expect(dash.layout!.zones).toContainEqual(
      { sheetName: 'Sales Trend', type: 'worksheet', x: 0, y: 50, w: 60, h: 50 });
    expect(dash.layout!.zones).toContainEqual(
      { type: 'text', x: 60, y: 50, w: 40, h: 50 });
    // sheetNames (existing behavior) still populated from zones
    expect(dash.sheetNames).toEqual(['Sales by Region', 'Sales Trend']);
  });

  it('extracts embedded thumbnails and marks the visual source', () => {
    expect(wb.visualSource).toBe('twb_file');
    expect(wb.thumbnails).toHaveLength(1);
    expect(wb.thumbnails![0].name).toBe('Regional Overview');
    expect(Buffer.from(wb.thumbnails![0].base64, 'base64').subarray(0, 4))
      .toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
});

describe('parseTableauFile — workbooks with no Parameters datasource (safety)', () => {
  it('leaves `parameters` absent — never an empty array', () => {
    const [doc] = parseTableauFile('sample.twb', sampleTwbBuf);
    expect(doc.parameters).toBeUndefined();
  });
});

describe('parseTableauFile — workbook parameters (sample-parameters.twb)', () => {
  const docs = parseTableauFile('sample-parameters.twb',
    readFileSync(path.join(FIXTURES_DIR, 'sample-parameters.twb')));
  const wb = docs[0];

  it('excludes the Parameters pseudo-datasource from `datasources`', () => {
    expect(wb.datasources.map((d) => d.name)).toEqual(['orders-ds']);
    expect(wb.datasources.every((d) => d.name !== 'Parameters')).toBe(true);
  });

  it('extracts a list-domain parameter with its members and current value', () => {
    const p1 = wb.parameters?.find((p) => p.name === 'Parameter 1');
    expect(p1).toEqual({
      name: 'Parameter 1',
      caption: 'Select Metric',
      datatype: 'string',
      currentValue: '"Sales"',
      allowableValues: { kind: 'list', values: ['"Sales"', '"Profit"'] },
    });
  });

  it('extracts a range-domain parameter with its min/max', () => {
    const p2 = wb.parameters?.find((p) => p.name === 'Parameter 2');
    expect(p2).toEqual({
      name: 'Parameter 2',
      caption: 'Top N',
      datatype: 'integer',
      currentValue: '5',
      allowableValues: { kind: 'range', min: '1', max: '20' },
    });
  });

  it('extracts exactly the two declared parameters, in document order', () => {
    expect(wb.parameters?.map((p) => p.name)).toEqual(['Parameter 1', 'Parameter 2']);
  });

  it('captures the worksheet sort as field + direction, resolved off the shelf ref', () => {
    const sheet = wb.sheets.find((s) => s.name === 'Sales by Region Sorted')!;
    expect(sheet.visual?.sorts).toEqual([{ field: 'Region', direction: 'DESC' }]);
  });
});

describe('mapTableauDocs — staging batch snapshot (decision 2 FQNs, bi_declared chain, bindings)', () => {
  let docs: TableauWorkbookDoc[];
  let batches: ReturnType<typeof mapTableauDocs>;

  beforeAll(() => {
    docs = parseTableauFile('sample.twb', sampleTwbBuf);
    batches = mapTableauDocs(docs, 'file');
  });

  it('produces one bi-pass batch', () => {
    expect(batches).toHaveLength(1);
    expect(batches[0].pass).toBe('bi');
  });

  it('emits the workbook, dashboard, sheet, and datasource assets with decision-2 FQN naming', () => {
    const assets = batches[0].assets!;
    expect(assets).toHaveLength(6);
    expect(assets).toEqual(
      expect.arrayContaining([
        { catalog: 'default', schemaName: null, name: 'sample', assetType: 'bi_workbook' },
      ]),
    );
    const byName = (n: string) => assets.find((a) => a.name === n)!;
    expect(byName('sample/Executive Dashboard').assetType).toBe('bi_dashboard');
    expect(byName('sample/Sales Overview').assetType).toBe('bi_sheet');
    expect(byName('sample/Customer Detail').assetType).toBe('bi_sheet');
    expect(byName('sample/snowflake-sales').assetType).toBe('bi_datasource');
    expect(byName('sample/postgres-orders').assetType).toBe('bi_datasource');
  });

  it('joins the custom SQL relation into the postgres datasource definition_sql', () => {
    const assets = batches[0].assets!;
    const pg = assets.find((a) => a.name === 'sample/postgres-orders')!;
    expect(pg.definitionSql).toBe(
      'SELECT customer_id, region, revenue FROM orders_summary WHERE revenue > 0',
    );
    expect(pg.language).toBe('sql');

    const sf = assets.find((a) => a.name === 'sample/snowflake-sales')!;
    expect(sf.definitionSql).toBeFalsy();
  });

  it('emits every field as a column, with expression on calculated fields only', () => {
    const columns = batches[0].columns!;
    const sfColumns = columns.filter((c) => c.objectName === 'sample/snowflake-sales');
    expect(sfColumns).toHaveLength(15); // 7 plain + 8 calculated
    const plain = sfColumns.find((c) => c.columnName === 'Sales')!;
    expect(plain.expression).toBeUndefined();
    expect(plain.dataTypeRaw).toBe('real');

    const calc1 = sfColumns.find((c) => c.columnName === 'Calculation_1')!;
    expect(calc1.expression).toEqual({
      text: 'IF [Sales] > 100 THEN "High" ELSE "Low" END',
      language: 'tableau_calc',
      derivationTypes: ['case_switch'],
      inputRefs: [
        { asset_fqn: 'default.sample/snowflake-sales', column: 'Sales', resolution: 'exact' },
      ],
      parserVersion: 'bi-calc/1.0',
      flags: [],
    });

    const pgColumns = columns.filter((c) => c.objectName === 'sample/postgres-orders');
    expect(pgColumns).toHaveLength(3);
  });

  it('persists the tokenizer classification on every calculated field (decision 3)', () => {
    const columns = batches[0].columns!;
    const expr = (name: string) =>
      columns.find((c) => c.objectName === 'sample/snowflake-sales' && c.columnName === name)!
        .expression!;

    expect(expr('Calculation_2').derivationTypes).toEqual(['aggregation']);
    expect(expr('Calculation_3').derivationTypes).toEqual(
      expect.arrayContaining(['window', 'aggregation']),
    );
    expect(expr('Calculation_6')).toMatchObject({
      derivationTypes: ['passthrough'],
      inputRefs: [
        { asset_fqn: 'default.sample/snowflake-sales', column: 'Customer ID', resolution: 'exact' },
      ],
    });
    expect(expr('Calculation_7')).toMatchObject({ derivationTypes: ['constant'], inputRefs: [] });
    expect(expr('Calculation_8')).toMatchObject({
      derivationTypes: ['udf_call'],
      flags: ['unknown_function:CUSTOMSCORE'],
    });
    // Every calc row carries the tokenizer's version tag.
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(expr(`Calculation_${n}`).parserVersion, `Calculation_${n}`).toBe('bi-calc/1.0');
    }
  });

  it('carries field caption/role/datatype in platformProperties (decision 3)', () => {
    const columns = batches[0].columns!;
    const plain = columns.find(
      (c) => c.objectName === 'sample/snowflake-sales' && c.columnName === 'Sales',
    )!;
    expect(plain.platformProperties).toEqual({
      caption: 'Sales',
      role: 'measure',
      datatype: 'real',
    });
    const calc1 = columns.find(
      (c) => c.objectName === 'sample/snowflake-sales' && c.columnName === 'Calculation_1',
    )!;
    expect(calc1.platformProperties).toEqual({
      caption: 'Profit Tier',
      role: 'dimension',
      datatype: 'string',
    });
  });

  it('emits dashboard→sheet and sheet→datasource asset-grain bi_declared dependency edges', () => {
    const deps = (batches[0].dependencies! as StagingDependencyRec[]).filter((d) => !d.toColumn);
    expect(deps.every((d) => d.dependencyKind === 'bi_declared')).toBe(true);
    const pairs = deps.map((d) => `${d.fromName} -> ${d.toName}`).sort();
    expect(pairs).toEqual([
      'sample/Customer Detail -> sample/postgres-orders',
      'sample/Executive Dashboard -> sample/Customer Detail',
      'sample/Executive Dashboard -> sample/Sales Overview',
      'sample/Sales Overview -> sample/snowflake-sales',
    ]);
  });

  it('emits sheet→field usage as column-grain deps with toColumn set (decision 6)', () => {
    const deps = (batches[0].dependencies! as StagingDependencyRec[]).filter((d) => d.toColumn);
    expect(deps.every((d) => d.dependencyKind === 'bi_declared')).toBe(true);
    const triples = deps.map((d) => `${d.fromName} -> ${d.toName}.${d.toColumn}`).sort();
    expect(triples).toEqual([
      'sample/Customer Detail -> sample/postgres-orders.region',
      'sample/Customer Detail -> sample/postgres-orders.revenue',
      'sample/Sales Overview -> sample/snowflake-sales.Calculation_1',
      'sample/Sales Overview -> sample/snowflake-sales.Calculation_2',
      'sample/Sales Overview -> sample/snowflake-sales.Order ID',
    ]);
  });

  it('emits one binding per (datasource, descriptor) with declared table refs', () => {
    const bindings = batches[0].bindings! as StagingBiBindingRec[];
    expect(bindings).toHaveLength(2);

    const sfBinding = bindings.find((b) => b.assetFqn === 'default.sample/snowflake-sales')!;
    expect(sfBinding.assetType).toBe('bi_datasource');
    expect(sfBinding.normalizedKey).toBe(normalizeDescriptor(sfBinding.descriptor));
    expect(sfBinding.refs).toHaveLength(1);
    expect(sfBinding.refs[0].via).toBe('declared');
    // catalog is backfilled from the connection descriptor's database (SALES_DB) — the
    // relation's own 2-part `[PUBLIC].[ORDERS]` ref never states one (Task 5 fix: a
    // catalog-less ref can never resolve against a real, always-fully-qualified target
    // system asset).
    expect(sfBinding.refs[0].parts).toEqual({ catalog: 'SALES_DB', schema: 'PUBLIC', object: 'ORDERS' });

    // Custom-SQL-only datasource still records its descriptor (retained for a future
    // parse-pass binding), with no declared table refs.
    const pgBinding = bindings.find((b) => b.assetFqn === 'default.sample/postgres-orders')!;
    expect(pgBinding.refs).toEqual([]);
  });

  it('attaches calc/tokenizer-derived column refs, marked expression_ref (0.85 rule)', () => {
    const bindings = batches[0].bindings! as StagingBiBindingRec[];
    const sfBinding = bindings.find((b) => b.assetFqn === 'default.sample/snowflake-sales')!;
    const cols = sfBinding.refs[0].columns!;
    expect(cols).toHaveLength(9);
    expect(cols).toEqual(
      expect.arrayContaining([
        { bi_field: 'Calculation_2', db_column: 'Sales', method: 'expression_ref' },
        { bi_field: 'Calculation_6', db_column: 'Customer ID', method: 'expression_ref' },
        { bi_field: 'Calculation_3', db_column: 'Region', method: 'expression_ref' },
        { bi_field: 'Calculation_3', db_column: 'Sales', method: 'expression_ref' },
      ]),
    );
    // Tokenizer-derived, every one of them: file mode has no platform-declared columns.
    expect(cols.every((c) => c.method === 'expression_ref')).toBe(true);
    // Calculation_7 is a pure literal (no refs) and contributes nothing.
    expect(cols.some((c) => c.bi_field === 'Calculation_7')).toBe(false);
  });
});
