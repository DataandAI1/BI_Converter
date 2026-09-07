import { describe, it, expect } from 'vitest';
import {
  buildDataset,
  buildPage,
  buildWidget,
  lakeviewId,
  zonesToGrid,
  type LakeviewDashboardJson,
  type LakeviewPageJson,
} from '../../src/lakeview/emit.js';
import {
  emitTableauGroupAsLakeview,
  splitLakeviewPages,
  type LakeviewGroupContext,
} from '../../src/convert/rebuild-databricks.js';
import { LAKEVIEW_WIDGET_TYPES, isPinnedLakeviewSpec } from '../../src/lakeview/format.js';
import { parseLvdashFile, mapLakeviewDocs } from '../../src/lakeview/parse.js';
import type { BiAssetRow, BiEdgeRow } from '../../src/bi/grouping.js';
import type {
  BiBindingLite,
  BiColumnRow,
  BiDerivationRow,
  BiManifestObject,
} from '../../src/convert/shared.js';

/**
 * Databricks AI/BI rebuild target — Phase 3 (plan 2026-08-10): the deterministic
 * `.lvdash.json` rebuild pack. Two modules under test: `lakeview-emit.ts` (pure JSON
 * builders over the Phase-0 pinned format table) and `rebuild-databricks.ts` (the
 * catalog-context orchestration `rebuild.ts` dispatches into). Fixtures are hand-built
 * ctx/group objects in the style of semantic-layer.test.ts.
 */

/* ------------------------------------------------------------------ fixtures */

const asset = (over: Partial<BiAssetRow>): BiAssetRow => ({
  id: 'a0',
  source_system_id: 'sys1',
  system_name: 'Tableau Co',
  platform: 'tableau',
  catalog: 'default',
  schema_name: 'Sales',
  name: 'Sales WB',
  asset_type: 'bi_workbook',
  fqn: 'wb.sales',
  definition_sql: null,
  platform_properties: null,
  ...over,
});

const column = (over: Partial<BiColumnRow>): BiColumnRow => ({
  id: 'c0',
  asset_id: 'ds1',
  ordinal: 1,
  name: '[Field]',
  data_type_raw: null,
  data_type_canonical: 'string',
  platform_properties: null,
  ...over,
});

const binding = (over: Partial<BiBindingLite>): BiBindingLite => ({
  asset_id: 'ds1',
  descriptor: { platform_hint: 'databricks', host: 'workspace.cloud.databricks.com' },
  refs: [
    {
      parts: { catalog: 'main', schema: 'sales', object: 'orders' },
      via: 'declared',
      columns: [
        { bi_field: 'Sales', db_column: 'sales_amount' },
        { bi_field: 'Region', db_column: 'region' },
        { bi_field: 'Order Date', db_column: 'order_date' },
        { bi_field: 'Category', db_column: 'category' },
        { bi_field: 'Profit', db_column: 'profit' },
      ],
    },
  ],
  status: 'matched',
  ...over,
});

/** `[federated.x].[sum:Sales:qk]` shelf text for a list of tokens. */
const shelf = (...tokens: string[]): string =>
  tokens.map((t) => `[federated.abc].[${t}]`).join(' / ');

interface SheetSpec {
  name: string;
  visual?: Record<string, unknown>;
  /** column-grain field usage edges (no visual capture path). */
  fields?: string[];
}

interface GroupFixture {
  ctx: LakeviewGroupContext;
  top: BiAssetRow;
  own: BiAssetRow[];
  slug: string;
}

/** One workbook: one datasource ('Orders'), one dashboard, N sheets. */
function groupFixture(opts: {
  sheets: SheetSpec[];
  zones?: Array<{ sheet_name?: string; type: string; x: number; y: number; w: number; h: number }>;
  dashboardName?: string;
  columns?: BiColumnRow[];
  derivations?: BiDerivationRow[];
  bindings?: BiBindingLite[];
  withDashboard?: boolean;
  /** Give the first sheet a second datasource (a Tableau data blend). */
  blend?: boolean;
  /** Drop the sheet→datasource edges, so the emitter has to assume `datasources[0]`. */
  noDatasourceEdge?: boolean;
  /** Workbook-scope parameters (Task 6), landed on `top.platform_properties.parameters`
   *  exactly as connectors/tableau/mapper.ts snake-cases them. */
  workbookParameters?: Array<Record<string, unknown>>;
}): GroupFixture {
  const withDashboard = opts.withDashboard !== false;
  const top = asset({
    id: 'wb1', name: 'Sales WB', asset_type: 'bi_workbook', fqn: 'wb.sales',
    platform_properties: opts.workbookParameters
      ? { parameters: opts.workbookParameters }
      : null,
  });
  const ds = asset({
    id: 'ds1',
    asset_type: 'bi_datasource',
    name: 'Sales WB/Orders',
    fqn: 'wb.sales/orders',
  });
  const dashName = opts.dashboardName ?? 'Exec Dashboard';
  const dash = asset({
    id: 'dash1',
    asset_type: 'bi_dashboard',
    name: `Sales WB/${dashName}`,
    fqn: `wb.sales/${dashName.toLowerCase()}`,
    platform_properties: opts.zones
      ? { layout: { width: 1200, height: 800, zones: opts.zones, captured_via: 'twb_content' } }
      : null,
  });
  const sheets = opts.sheets.map((s, i) =>
    asset({
      id: `sh${i + 1}`,
      asset_type: 'bi_sheet',
      name: `Sales WB/${s.name}`,
      fqn: `wb.sales/${s.name.toLowerCase()}`,
      platform_properties: s.visual ? { visual: { ...s.visual, captured_via: 'twb_content' } } : null,
    }),
  );

  const edges: BiEdgeRow[] = [];
  for (const sh of sheets) {
    if (withDashboard) {
      edges.push({ from_asset_id: dash.id, to_asset_id: sh.id, to_column_id: null, to_column_name: null });
    }
    if (!opts.noDatasourceEdge) {
      edges.push({ from_asset_id: sh.id, to_asset_id: ds.id, to_column_id: null, to_column_name: null });
    }
  }
  opts.sheets.forEach((s, i) => {
    for (const f of s.fields ?? []) {
      edges.push({
        from_asset_id: sheets[i].id,
        to_asset_id: ds.id,
        to_column_id: `col:${f}`,
        to_column_name: f,
      });
    }
  });

  const ds2 = asset({
    id: 'ds2',
    asset_type: 'bi_datasource',
    name: 'Sales WB/Returns',
    fqn: 'wb.sales/returns',
  });
  if (opts.blend) {
    edges.push({ from_asset_id: sheets[0].id, to_asset_id: ds2.id, to_column_id: null, to_column_name: null });
  }

  const own = [...(withDashboard ? [dash] : []), ...sheets, ds, ...(opts.blend ? [ds2] : [])];
  const ctx: LakeviewGroupContext = {
    files: new Map<string, string>(),
    objects: [] as BiManifestObject[],
    edges,
    byId: new Map([top, ...own].map((a) => [a.id, a])),
    columnsByAsset: new Map([['ds1', opts.columns ?? [column({ id: 'c1', name: '[Sales]' })]]]),
    derivationsByAsset: new Map([['ds1', opts.derivations ?? []]]),
    bindingsByAsset: new Map([
      ['ds1', opts.bindings ?? [binding({})]],
      ['ds2', [binding({ asset_id: 'ds2', refs: [{ parts: { catalog: 'main', schema: 'sales', object: 'returns' }, via: 'declared' }] })]],
    ]),
  };
  return { ctx, top, own, slug: 'sales-wb' };
}

function emitFixture(opts: Parameters<typeof groupFixture>[0]): {
  files: Map<string, string>;
  objects: BiManifestObject[];
  dashboard: LakeviewDashboardJson;
  path: string;
} {
  const f = groupFixture(opts);
  emitTableauGroupAsLakeview(f.ctx, f.top, f.own, f.slug);
  const path = [...f.ctx.files.keys()].find((p) => p.endsWith('.lvdash.json'))!;
  return {
    files: f.ctx.files,
    objects: f.ctx.objects,
    dashboard: JSON.parse(f.ctx.files.get(path) ?? '{}') as LakeviewDashboardJson,
    path,
  };
}

const widgetTypes = (d: LakeviewDashboardJson): string[] =>
  d.pages.flatMap((p) => p.layout.map((l) => l.widget.spec.widgetType));

/* ------------------------------------------------------------- zonesToGrid */

describe('zonesToGrid — percent zones → the 12-column integer grid', () => {
  it('scales x/width against 12 columns and y/height against a 12-row viewport times 4', () => {
    expect(zonesToGrid([{ x: 0, y: 0, w: 50, h: 50 }])).toEqual([
      { x: 0, y: 0, width: 6, height: 24 },
    ]);
    expect(zonesToGrid([{ x: 50, y: 25, w: 50, h: 25 }])).toEqual([
      { x: 6, y: 12, width: 6, height: 12 },
    ]);
  });

  it('never emits a zero width, and keeps every widget inside the 12-column grid', () => {
    const [tiny, overflow] = zonesToGrid([
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 95, y: 60, w: 20, h: 40 },
    ]);
    expect(tiny.width).toBe(1);
    expect(tiny.height).toBeGreaterThanOrEqual(4);
    expect(overflow.x + overflow.width).toBeLessThanOrEqual(12);
  });

  it('pushes a later overlapping widget below the one it collides with', () => {
    const [a, b] = zonesToGrid([
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 0, y: 0, w: 100, h: 50 },
    ]);
    expect(a).toEqual({ x: 0, y: 0, width: 12, height: 24 });
    expect(b.y).toBe(a.y + a.height);
    expect(b.x).toBe(0);
  });

  it('treats a zero-size zone as unpositioned and appends it below, 2 per row', () => {
    const [zoned, zero, missing] = zonesToGrid([
      { x: 0, y: 0, w: 100, h: 25 },
      { x: 10, y: 10, w: 0, h: 0 },
      undefined,
    ]);
    expect(zoned).toEqual({ x: 0, y: 0, width: 12, height: 12 });
    expect(zero).toEqual({ x: 0, y: 12, width: 6, height: 8 });
    expect(missing).toEqual({ x: 6, y: 12, width: 6, height: 8 });
  });

  it('lays out a whole dashboard with no layout capture at all in reading order', () => {
    expect(zonesToGrid([undefined, undefined, undefined])).toEqual([
      { x: 0, y: 0, width: 6, height: 8 },
      { x: 6, y: 0, width: 6, height: 8 },
      { x: 0, y: 8, width: 6, height: 8 },
    ]);
  });

  it('is deterministic — the same zones always produce the same positions', () => {
    const zones = [
      { x: 0, y: 0, w: 33, h: 40 },
      { x: 33, y: 0, w: 67, h: 40 },
      undefined,
    ];
    expect(zonesToGrid(zones)).toEqual(zonesToGrid(zones));
  });

  it('keeps the full row resolution — height/y round against 12×4 rows, not 12 (A17)', () => {
    // A tenth of the canvas is ~5 rows of 48, not 4: rounding to 12 rows first and then
    // multiplying by 4 threw away three quarters of the vertical precision.
    expect(zonesToGrid([{ x: 0, y: 10, w: 100, h: 10 }])).toEqual([
      { x: 0, y: 5, width: 12, height: 5 },
    ]);
    // Three stacked thirds stay adjacent rather than collapsing onto each other.
    expect(
      zonesToGrid([
        { x: 0, y: 0, w: 100, h: 33 },
        { x: 0, y: 33, w: 100, h: 33 },
      ]),
    ).toEqual([
      { x: 0, y: 0, width: 12, height: 16 },
      { x: 0, y: 16, width: 12, height: 16 },
    ]);
  });

  it('emits only integers', () => {
    for (const p of zonesToGrid([{ x: 13.7, y: 21.3, w: 41.9, h: 37.1 }, undefined])) {
      for (const v of [p.x, p.y, p.width, p.height]) expect(Number.isInteger(v)).toBe(true);
    }
  });
});

/* ------------------------------------------------------- pure JSON builders */

describe('lakeviewId — deterministic 8-char lowercase hex names', () => {
  it('is stable across runs and distinct per (slug, logical name)', () => {
    const a = lakeviewId('sales-wb', 'dataset:Orders');
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(a).toBe(lakeviewId('sales-wb', 'dataset:Orders'));
    expect(a).not.toBe(lakeviewId('sales-wb', 'dataset:Returns'));
    expect(a).not.toBe(lakeviewId('other-wb', 'dataset:Orders'));
  });
});

describe('buildDataset — query as a plain string over the semantic-layer view', () => {
  it('selects the bound columns backtick-quoted from the view', () => {
    const ds = buildDataset({
      slug: 'sales-wb',
      logicalName: 'dataset:Orders',
      displayName: 'Orders',
      view: 'orders',
      columns: ['sales_amount', 'region'],
    });
    expect(ds.name).toBe(lakeviewId('sales-wb', 'dataset:Orders'));
    expect(ds.displayName).toBe('Orders');
    expect(typeof ds.query).toBe('string');
    expect(ds.query).toBe('SELECT\n  `sales_amount`,\n  `region`\nFROM `orders`');
    expect(ds).not.toHaveProperty('queryLines');
  });

  it('falls back to SELECT * when no bound column is known', () => {
    const ds = buildDataset({
      slug: 's',
      logicalName: 'd',
      displayName: 'D',
      view: 'v',
      columns: [],
    });
    expect(ds.query).toBe('SELECT *\nFROM `v`');
  });
});

describe('buildWidget — every emitted shape is backed by the pinned table', () => {
  const base = {
    slug: 'sales-wb',
    logicalName: 'widget:Sheet1',
    datasetName: 'abc12345',
    fields: [{ name: 'region', expression: '`region`' }],
  };

  it('pins spec.version from LAKEVIEW_WIDGET_TYPES and shapes the main_query', () => {
    const { widget } = buildWidget({
      ...base,
      widgetType: 'bar',
      title: 'Sales by Region',
      fields: [
        { name: 'region', expression: '`region`' },
        { name: 'sum(sales_amount)', expression: 'SUM(`sales_amount`)' },
      ],
      channels: [
        { channel: 'x', fieldName: 'region', scaleType: 'categorical' },
        { channel: 'y', fieldName: 'sum(sales_amount)', scaleType: 'quantitative' },
      ],
    });
    expect(widget.spec.version).toBe(LAKEVIEW_WIDGET_TYPES.bar.specVersion);
    expect(widget.spec.widgetType).toBe('bar');
    expect(widget.name).toMatch(/^[0-9a-f]{8}$/);
    expect(widget.queries).toHaveLength(1);
    expect(widget.queries[0].name).toBe('main_query');
    expect(widget.queries[0].query.datasetName).toBe('abc12345');
    expect(widget.queries[0].query.disaggregated).toBe(false);
    expect(widget.spec.encodings.x).toEqual({
      fieldName: 'region',
      displayName: 'region',
      scale: { type: 'categorical' },
    });
    expect(widget.spec.frame).toEqual({ showTitle: true, title: 'Sales by Region' });
  });

  it('drops a channel the pinned table does not list for that widget type, with a note', () => {
    const { widget, notes } = buildWidget({
      ...base,
      widgetType: 'counter',
      channels: [
        { channel: 'value', fieldName: 'sum(sales_amount)' },
        { channel: 'color', fieldName: 'region' },
      ],
    });
    expect(Object.keys(widget.spec.encodings)).toEqual(['value']);
    expect(notes.some((n) => n.includes("'color'") && n.includes('counter'))).toBe(true);
  });

  it('flags an unverified pinned type with the exact review wording', () => {
    const { widget, notes } = buildWidget({
      ...base,
      widgetType: 'choropleth-map',
      channels: [],
    });
    expect(widget.spec.widgetType).toBe('choropleth-map');
    expect(notes).toContain(
      "widget type 'choropleth-map' pinned from docs, not from an exported fixture — verify rendering",
    );
  });

  it('never emits a widgetType the pinned table cannot back — unknown falls back to table', () => {
    const { widget, notes } = buildWidget({
      ...base,
      widgetType: 'sunburst',
      channels: [{ channel: 'columns', fieldName: 'region' }],
    });
    expect(widget.spec.widgetType).toBe('table');
    expect(isPinnedLakeviewSpec(widget.spec.widgetType, widget.spec.version)).toBe(true);
    expect(notes.some((n) => n.includes('sunburst'))).toBe(true);
  });

  it('shapes array channels: table columns, filter fields (queryName), combo y primary', () => {
    const table = buildWidget({
      ...base,
      widgetType: 'table',
      channels: [
        { channel: 'columns', fieldName: 'region' },
        { channel: 'columns', fieldName: 'sum(sales_amount)', displayName: 'Sales' },
      ],
    }).widget;
    expect(table.spec.encodings.columns).toEqual([
      { fieldName: 'region', displayName: 'region' },
      { fieldName: 'sum(sales_amount)', displayName: 'Sales' },
    ]);

    const filter = buildWidget({
      ...base,
      widgetType: 'filter-single-select',
      channels: [{ channel: 'fields', fieldName: 'region' }],
    }).widget;
    expect(filter.spec.encodings.fields).toEqual([
      { fieldName: 'region', displayName: 'region', queryName: 'main_query' },
    ]);

    const combo = buildWidget({
      ...base,
      widgetType: 'combo',
      channels: [
        { channel: 'x', fieldName: 'order_date', scaleType: 'temporal' },
        { channel: 'y', fieldName: 'sum(sales_amount)' },
        { channel: 'y', fieldName: 'avg(profit)' },
      ],
    }).widget;
    expect(combo.spec.encodings.y).toEqual({
      primary: {
        fields: [
          { fieldName: 'sum(sales_amount)', displayName: 'sum(sales_amount)' },
          { fieldName: 'avg(profit)', displayName: 'avg(profit)' },
        ],
      },
      scale: { type: 'quantitative' },
    });
  });
});

describe('buildPage — canvas pages, no uiSettings', () => {
  it('emits pageType PAGE_TYPE_CANVAS with a deterministic name', () => {
    const page = buildPage({
      slug: 'sales-wb',
      logicalName: 'page:Exec Dashboard:1',
      displayName: 'Exec Dashboard',
      layout: [],
    });
    expect(page.pageType).toBe('PAGE_TYPE_CANVAS');
    expect(page.name).toBe(lakeviewId('sales-wb', 'page:Exec Dashboard:1'));
    expect(page.displayName).toBe('Exec Dashboard');
  });
});

/* ------------------------------------------------- emitTableauGroupAsLakeview */

describe('emitTableauGroupAsLakeview — pack shape', () => {
  it('emits a .lvdash.json per dashboard, deploy scripts, a checklist, and the semantic layer', () => {
    const { files, path } = emitFixture({
      sheets: [{ name: 'Sales by Region', visual: { mark_class: 'Bar', mark_classes: ['Bar'], rows: ['Sales'], cols: ['Region'], rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'), encodings: [], filters: [] } }],
    });
    expect(path).toBe('sales-wb/dashboards/Exec_Dashboard.lvdash.json');
    // Deploy artifacts are pack-level (rebuild.ts writes them once per pack) — the
    // per-group emitter never writes to the pack root.
    expect(files.has('deploy_dashboards.py')).toBe(false);
    expect(files.has('databricks.yml')).toBe(false);
    expect(files.has('sales-wb/rebuild_checklist.md')).toBe(true);
    // Semantic-layer files folded into the same path-keyed map (Task 1's contract).
    expect(files.has('sales-wb/views/orders.sql')).toBe(true);
    expect(files.has('sales-wb/metric_views/Orders.yaml')).toBe(true);
  });

  it('the top-level document carries datasets + pages and never uiSettings', () => {
    const { dashboard } = emitFixture({
      sheets: [{ name: 'Sales by Region', fields: ['Sales'] }],
    });
    expect(Object.keys(dashboard).sort()).toEqual(['datasets', 'pages']);
    expect(dashboard.pages[0].pageType).toBe('PAGE_TYPE_CANVAS');
  });

  it('dedups the shared extract_rescue.py across two groups sharing one files map', () => {
    const a = groupFixture({ sheets: [{ name: 'S1' }], bindings: [binding({ status: 'unmatched' })] });
    emitTableauGroupAsLakeview(a.ctx, a.top, a.own, a.slug);
    const b = groupFixture({ sheets: [{ name: 'S2' }], bindings: [binding({ status: 'unmatched' })] });
    // Second group emits into the SAME files map, as rebuild.ts does across groups.
    b.ctx.files = a.ctx.files;
    emitTableauGroupAsLakeview(b.ctx, b.top, b.own, 'sales-wb-2');
    const rescue = [...a.ctx.files.keys()].filter((p) => p.endsWith('extract_rescue.py'));
    expect(rescue).toEqual(['semantic_layer/extract_rescue.py']);
  });

  it('emits one dataset per datasource, query as a plain string over the semantic-layer view', () => {
    const { dashboard } = emitFixture({
      sheets: [
        {
          name: 'Sales by Region',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    expect(dashboard.datasets).toHaveLength(1);
    expect(dashboard.datasets[0].query).toContain('FROM `orders`');
    expect(dashboard.datasets[0].query).toContain('`sales_amount`');
    expect(dashboard.datasets[0].query).toContain('`region`');
    expect(dashboard.datasets[0].name).toMatch(/^[0-9a-f]{8}$/);
    expect(dashboard.pages[0].layout[0].widget.queries[0].query.datasetName).toBe(
      dashboard.datasets[0].name,
    );
  });

  it('is byte-for-byte deterministic across runs', () => {
    const opts = {
      sheets: [
        { name: 'A', visual: { mark_class: 'Line', mark_classes: ['Line'], rows: ['Sales'], cols: ['Order Date'], rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('yr:Order Date:ok'), encodings: [], filters: [] } },
        { name: 'B', fields: ['Region'] },
      ],
    };
    expect(emitFixture(opts).files.get(emitFixture(opts).path)).toBe(
      emitFixture(opts).files.get(emitFixture(opts).path),
    );
  });
});

describe('emitTableauGroupAsLakeview — determinism against the edge feed (A6)', () => {
  it('emits byte-identical files however the edge rows arrive', () => {
    const opts = {
      sheets: [
        {
          name: 'Bar',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
        { name: 'Plain', fields: ['Sales', 'Region', 'Category'] },
      ],
      zones: [{ sheet_name: 'Bar', type: 'worksheet', x: 0, y: 0, w: 50, h: 50 }],
    };
    const forward = groupFixture(opts);
    emitTableauGroupAsLakeview(forward.ctx, forward.top, forward.own, forward.slug);

    const reversed = groupFixture(opts);
    reversed.ctx.edges = [...reversed.ctx.edges].reverse();
    emitTableauGroupAsLakeview(reversed.ctx, reversed.top, reversed.own, reversed.slug);

    expect([...reversed.ctx.files.entries()]).toEqual([...forward.ctx.files.entries()]);
    expect(reversed.ctx.objects).toEqual(forward.ctx.objects);
  });
});

describe('claimPath — compound extensions (A3)', () => {
  it('numbers a colliding dashboard before .lvdash.json, and both files reach the manifest', () => {
    const top = asset({ id: 'wb1', name: 'Sales WB', asset_type: 'bi_workbook', fqn: 'wb.sales' });
    const ds = asset({ id: 'ds1', asset_type: 'bi_datasource', name: 'Sales WB/Orders', fqn: 'wb.sales/orders' });
    // fileSafe() collapses the slash: both dashboards want `Exec_Dashboard.lvdash.json`.
    const dashes = ['Exec Dashboard', 'Exec/Dashboard'].map((name, i) =>
      asset({
        id: `dash${i + 1}`, asset_type: 'bi_dashboard',
        name: `Sales WB/${name}`, fqn: `wb.sales/d${i + 1}`,
      }),
    );
    const sheets = dashes.map((_, i) =>
      asset({ id: `sh${i + 1}`, asset_type: 'bi_sheet', name: `Sales WB/S${i + 1}`, fqn: `wb.sales/s${i + 1}` }),
    );
    const edges: BiEdgeRow[] = [];
    dashes.forEach((d, i) => {
      edges.push({ from_asset_id: d.id, to_asset_id: sheets[i].id, to_column_id: null, to_column_name: null });
      edges.push({ from_asset_id: sheets[i].id, to_asset_id: ds.id, to_column_id: null, to_column_name: null });
      edges.push({ from_asset_id: sheets[i].id, to_asset_id: ds.id, to_column_id: 'col:Sales', to_column_name: 'Sales' });
    });
    const own = [...dashes, ...sheets, ds];
    const ctx: LakeviewGroupContext = {
      files: new Map<string, string>(),
      objects: [] as BiManifestObject[],
      edges,
      byId: new Map([top, ...own].map((a) => [a.id, a])),
      columnsByAsset: new Map([['ds1', [column({ id: 'c1', name: '[Sales]' })]]]),
      derivationsByAsset: new Map([['ds1', []]]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    };
    emitTableauGroupAsLakeview(ctx, top, own, 'sales-wb');

    const paths = [...ctx.files.keys()].filter((p) => p.includes('/dashboards/')).sort();
    expect(paths).toEqual([
      'sales-wb/dashboards/Exec_Dashboard.lvdash.json',
      'sales-wb/dashboards/Exec_Dashboard_2.lvdash.json',
    ]);
    // Both dashboards point at a file the pack actually contains.
    const files = ctx.objects
      .filter((o) => o.asset_type === 'bi_dashboard')
      .map((o) => o.file);
    expect(files.sort()).toEqual(paths);
    for (const f of files) expect(ctx.files.has(f!)).toBe(true);
  });
});

describe('emitTableauGroupAsLakeview — widget mapping (widen, never downgrade)', () => {
  const visual = (over: Record<string, unknown>): Record<string, unknown> => ({
    mark_class: 'Automatic',
    mark_classes: ['Automatic'],
    rows: [],
    cols: [],
    rows_raw: '',
    cols_raw: '',
    encodings: [],
    filters: [],
    ...over,
  });

  const typeFor = (over: Record<string, unknown>): string =>
    widgetTypes(emitFixture({ sheets: [{ name: 'S', visual: visual(over) }] }).dashboard)[0];

  it('maps bar/line/area/pie mark classes onto the same-named widget types', () => {
    for (const [mark, type] of [['Bar', 'bar'], ['Line', 'line'], ['Area', 'area'], ['Pie', 'pie']]) {
      expect(
        typeFor({
          mark_class: mark, mark_classes: [mark],
          rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'),
        }),
        `${mark} should map to ${type}`,
      ).toBe(type);
    }
  });

  it('maps circle/shape marks to scatter', () => {
    for (const mark of ['Circle', 'Shape']) {
      expect(
        typeFor({
          mark_class: mark, mark_classes: [mark],
          rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('sum:Profit:qk'),
        }),
      ).toBe('scatter');
    }
  });

  it('maps a text mark to table', () => {
    expect(
      typeFor({
        mark_class: 'Text', mark_classes: ['Text'],
        rows_raw: shelf('none:Region:nk'), cols_raw: shelf('sum:Sales:qk'),
      }),
    ).toBe('table');
  });

  it('maps a square mark with two dimensions to heatmap', () => {
    expect(
      typeFor({
        mark_class: 'Square', mark_classes: ['Square'],
        rows_raw: shelf('none:Region:nk'), cols_raw: shelf('none:Category:nk'),
        encodings: [{ channel: 'color', field: 'Sales' }],
      }),
    ).toBe('heatmap');
  });

  it('maps a single aggregate with no dimensions to counter', () => {
    expect(typeFor({ rows_raw: shelf('sum:Sales:qk'), cols_raw: '' })).toBe('counter');
  });

  it('maps dual-axis bar+line panes to combo', () => {
    expect(
      typeFor({
        mark_class: 'Bar', mark_classes: ['Bar', 'Line'],
        rows_raw: shelf('sum:Sales:qk', 'avg:Profit:qk'), cols_raw: shelf('yr:Order Date:ok'),
      }),
    ).toBe('combo');
  });

  it('emits a filled map as a table — choropleth-map has no pinned encodings (A9)', () => {
    const { dashboard, files, objects } = emitFixture({
      sheets: [
        {
          name: 'Map',
          visual: visual({
            mark_class: 'Map', mark_classes: ['Map'],
            rows_raw: shelf('none:Region:nk'), cols_raw: shelf('sum:Sales:qk'),
          }),
        },
      ],
    });
    // A choropleth-map widget would render nothing: the pinned table has no encoding
    // channels for it, so every field would be dropped. A table shows the data.
    expect(widgetTypes(dashboard)).toEqual(['table']);
    const columns = dashboard.pages[0].layout[0].widget.spec.encodings.columns as Array<{ fieldName: string }>;
    expect(columns.map((c) => c.fieldName)).toEqual(['sum(sales_amount)', 'region']);
    const sheet = objects.find((o) => o.fqn === 'wb.sales/map')!;
    expect(sheet.notes.join(' ')).toContain(
      'choropleth-map has no pinned encodings — emitted as a table; rebuild as choropleth-map in the editor',
    );
    // The checklist still names the intended type in the unverified-types worklist.
    const checklist = files.get('sales-wb/rebuild_checklist.md')!;
    expect(checklist).toContain('## Unverified widget types used');
    expect(checklist).toContain('`choropleth-map`');
  });

  it('emits a lat/long symbol map as a table too, naming point-map as the intent (A9)', () => {
    const { dashboard, objects } = emitFixture({
      sheets: [
        {
          name: 'Pins',
          visual: visual({
            mark_class: 'Circle', mark_classes: ['Circle'],
            rows_raw: shelf('none:Latitude:qk'), cols_raw: shelf('none:Longitude:qk'),
          }),
        },
      ],
    });
    expect(widgetTypes(dashboard)).toEqual(['table']);
    expect(objects.find((o) => o.fqn === 'wb.sales/pins')!.notes.join(' ')).toContain(
      'point-map has no pinned encodings',
    );
  });

  it('falls back to table with a needs_review note for an unknown/automatic mark', () => {
    const { dashboard, objects } = emitFixture({
      sheets: [{ name: 'S', visual: visual({ rows_raw: shelf('none:Region:nk'), cols_raw: shelf('none:Category:nk') }) }],
    });
    expect(widgetTypes(dashboard)).toEqual(['table']);
    const sheet = objects.find((o) => o.fqn === 'wb.sales/s')!;
    expect(sheet.status).toBe('needs_review');
    expect(sheet.notes.join(' ')).toMatch(/could not be mapped|automatic/i);
  });

  it('emits a table of the fields a sheet uses when it has no visual capture', () => {
    const { dashboard, objects } = emitFixture({
      sheets: [{ name: 'S', fields: ['Sales', 'Region'] }],
    });
    const widget = dashboard.pages[0].layout[0].widget;
    expect(widget.spec.widgetType).toBe('table');
    // Field order follows the edge order loadBiEdges now guarantees (to_column_id).
    expect(widget.queries[0].query.fields!.map((f) => f.expression)).toEqual([
      '`region`',
      '`sales_amount`',
    ]);
    expect(objects.find((o) => o.fqn === 'wb.sales/s')!.status).toBe('needs_review');
  });

  it('turns sheet filters into filter widgets on a filters row', () => {
    const { dashboard } = emitFixture({
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [],
            filters: [{ field: 'Category', filter_class: 'categorical' }],
          },
        },
      ],
    });
    const layout = dashboard.pages[0].layout;
    const filter = layout.find((l) => l.widget.spec.widgetType === 'filter-multi-select')!;
    expect(filter).toBeDefined();
    expect(filter.position.y).toBe(0);
    expect(filter.widget.queries[0].query.fields![0].expression).toBe('`category`');
    // The chart sits below the filters row.
    const chart = layout.find((l) => l.widget.spec.widgetType === 'bar')!;
    expect(chart.position.y).toBeGreaterThanOrEqual(filter.position.y + filter.position.height);
  });
});

describe('emitTableauGroupAsLakeview — aggregation + encodings from the visual', () => {
  it('reads the aggregation from the shelf token and backticks the physical column', () => {
    const { dashboard } = emitFixture({
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            rows_raw: shelf('avg:Sales:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [{ channel: 'color', field: 'Category' }],
            filters: [],
          },
        },
      ],
    });
    const widget = dashboard.pages[0].layout[0].widget;
    expect(widget.queries[0].query.fields!).toEqual([
      { name: 'region', expression: '`region`' },
      { name: 'avg(sales_amount)', expression: 'AVG(`sales_amount`)' },
      { name: 'category', expression: '`category`' },
    ]);
    // toMatchObject: every scalar channel also carries a caption-derived displayName.
    expect(widget.spec.encodings).toMatchObject({
      x: { fieldName: 'region', scale: { type: 'categorical' } },
      y: { fieldName: 'avg(sales_amount)', scale: { type: 'quantitative' } },
      color: { fieldName: 'category', scale: { type: 'categorical' } },
    });
  });

  it('defaults a continuous NUMERIC shelf field with no translatable aggregation to SUM, and says so', () => {
    const { dashboard, objects } = emitFixture({
      columns: [column({ id: 'c1', name: '[Sales]', data_type_canonical: 'decimal(18,2)' })],
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            // `none:` on a `:qk` (continuous) shelf — a measure with no shelf-level
            // aggregation, NOT a category.
            rows_raw: shelf('none:Sales:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    const widget = dashboard.pages[0].layout[0].widget;
    expect(widget.queries[0].query.fields![1]).toEqual({
      name: 'sum(sales_amount)',
      expression: 'SUM(`sales_amount`)',
    });
    const enc = widget.spec.encodings as Record<string, { scale?: { type: string } }>;
    expect(enc.y.scale).toEqual({ type: 'quantitative' });
    const sheet = objects.find((o) => o.fqn === 'wb.sales/s')!;
    expect(sheet.status).toBe('needs_review');
    expect(sheet.notes.join(' ')).toMatch(/defaulted to SUM/);
  });

  it('keeps a genuinely categorical shelf field a dimension, with no defaulted-aggregation note', () => {
    const { dashboard, objects } = emitFixture({
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    const widget = dashboard.pages[0].layout[0].widget;
    expect(widget.queries[0].query.fields![0]).toEqual({ name: 'region', expression: '`region`' });
    const enc = widget.spec.encodings as Record<string, { scale?: { type: string } }>;
    expect(enc.x.scale).toEqual({ type: 'categorical' });
    const sheet = objects.find((o) => o.fqn === 'wb.sales/s')!;
    expect(sheet.notes.join(' ')).not.toMatch(/defaulted to SUM/);
    expect(sheet.status).toBe('ready');
  });

  it('flags a field with no matched physical column instead of silently passing it through', () => {
    const { dashboard, objects } = emitFixture({
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Mystery'], cols: ['Region'],
            rows_raw: shelf('sum:Mystery:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    expect(dashboard.pages[0].layout[0].widget.queries[0].query.fields![1].expression).toBe(
      'SUM(`Mystery`)',
    );
    const sheet = objects.find((o) => o.fqn === 'wb.sales/s')!;
    expect(sheet.status).toBe('needs_review');
    expect(sheet.notes.join(' ')).toMatch(/no matched physical column/);
  });
});

/* ------------------------------------------------------------- date grain (A1) */

describe('emitTableauGroupAsLakeview — date grain from the shelf prefix (A1)', () => {
  const dateSheet = (colsRaw: string, mark = 'Line'): Parameters<typeof emitFixture>[0] => ({
    columns: [
      column({ id: 'c1', name: '[Sales]', data_type_canonical: 'decimal(18,2)' }),
      column({ id: 'c2', name: '[Order Date]', data_type_canonical: 'timestamp' }),
    ],
    sheets: [
      {
        name: 'S',
        visual: {
          mark_class: mark, mark_classes: [mark],
          rows: ['Sales'], cols: ['Order Date'],
          rows_raw: shelf('sum:Sales:qk'), cols_raw: colsRaw,
          encodings: [], filters: [],
        },
      },
    ],
  });

  it('emits a truncation prefix as DATE_TRUNC on a temporal scale, named the corpus way', () => {
    const { dashboard } = emitFixture(dateSheet(shelf('tmn:Order Date:qk')));
    const widget = dashboard.pages[0].layout[0].widget;
    expect(widget.queries[0].query.fields![0]).toEqual({
      name: 'monthly(order_date)',
      expression: 'DATE_TRUNC("MONTH", `order_date`)',
    });
    const enc = widget.spec.encodings as Record<string, { fieldName: string; scale?: { type: string } }>;
    expect(enc.x.fieldName).toBe('monthly(order_date)');
    expect(enc.x.scale).toEqual({ type: 'temporal' });
  });

  it('emits a discrete date part as date_part() on a categorical scale', () => {
    const { dashboard } = emitFixture(dateSheet(shelf('yr:Order Date:ok')));
    const widget = dashboard.pages[0].layout[0].widget;
    expect(widget.queries[0].query.fields![0]).toEqual({
      name: 'year(order_date)',
      expression: "date_part('YEAR', `order_date`)",
    });
    const enc = widget.spec.encodings as Record<string, { scale?: { type: string } }>;
    expect(enc.x.scale).toEqual({ type: 'categorical' });
  });

  it('maps every truncation and every discrete part prefix to its own unit', () => {
    const cases: Array<[string, string, string]> = [
      ['tyr', 'yearly(order_date)', 'DATE_TRUNC("YEAR", `order_date`)'],
      ['tqr', 'quarterly(order_date)', 'DATE_TRUNC("QUARTER", `order_date`)'],
      ['tmn', 'monthly(order_date)', 'DATE_TRUNC("MONTH", `order_date`)'],
      ['twk', 'weekly(order_date)', 'DATE_TRUNC("WEEK", `order_date`)'],
      ['tdy', 'daily(order_date)', 'DATE_TRUNC("DAY", `order_date`)'],
      ['thr', 'hourly(order_date)', 'DATE_TRUNC("HOUR", `order_date`)'],
      ['tmi', 'minutely(order_date)', 'DATE_TRUNC("MINUTE", `order_date`)'],
      ['tse', 'secondly(order_date)', 'DATE_TRUNC("SECOND", `order_date`)'],
      ['my', 'monthly(order_date)', 'DATE_TRUNC("MONTH", `order_date`)'],
      ['mdy', 'daily(order_date)', 'DATE_TRUNC("DAY", `order_date`)'],
      ['yr', 'year(order_date)', "date_part('YEAR', `order_date`)"],
      ['qr', 'quarter(order_date)', "date_part('QUARTER', `order_date`)"],
      ['mn', 'month(order_date)', "date_part('MONTH', `order_date`)"],
      ['wk', 'week(order_date)', "date_part('WEEK', `order_date`)"],
      ['dy', 'day(order_date)', "date_part('DAY', `order_date`)"],
      ['hr', 'hour(order_date)', "date_part('HOUR', `order_date`)"],
      ['mi', 'minute(order_date)', "date_part('MINUTE', `order_date`)"],
      ['se', 'second(order_date)', "date_part('SECOND', `order_date`)"],
    ];
    for (const [prefix, name, expression] of cases) {
      const { dashboard } = emitFixture(dateSheet(shelf(`${prefix}:Order Date:qk`)));
      const field = dashboard.pages[0].layout[0].widget.queries[0].query.fields![0];
      expect(field, `prefix ${prefix}`).toEqual({ name, expression });
    }
  });

  it('keeps two grains of one date on a sheet as two distinct query fields', () => {
    const { dashboard } = emitFixture(
      dateSheet(shelf('tyr:Order Date:qk', 'tmn:Order Date:qk'), 'Text'),
    );
    const fields = dashboard.pages[0].layout[0].widget.queries[0].query.fields!;
    expect(fields.map((f) => f.name)).toEqual([
      'yearly(order_date)',
      'monthly(order_date)',
      'sum(sales_amount)',
    ]);
  });

  it('falls back to the raw date column for an ISO date part, and says so', () => {
    const { dashboard, objects } = emitFixture(dateSheet(shelf('isoyr:Order Date:qk')));
    const widget = dashboard.pages[0].layout[0].widget;
    expect(widget.queries[0].query.fields![0]).toEqual({
      name: 'order_date',
      expression: '`order_date`',
    });
    const enc = widget.spec.encodings as Record<string, { scale?: { type: string } }>;
    expect(enc.x.scale).toEqual({ type: 'temporal' });
    const sheet = objects.find((o) => o.fqn === 'wb.sales/s')!;
    expect(sheet.status).toBe('needs_review');
    expect(sheet.notes.join(' ')).toMatch(/ISO/);
  });
});

/* ------------------------------------------- type-aware continuous tokens (A2) */

describe('emitTableauGroupAsLakeview — continuous tokens read the catalog type (A2)', () => {
  const sheetOn = (rowsRaw: string, columns: BiColumnRow[]): Parameters<typeof emitFixture>[0] => ({
    columns,
    sheets: [
      {
        name: 'S',
        visual: {
          mark_class: 'Bar', mark_classes: ['Bar'],
          rows: [], cols: ['Region'],
          rows_raw: rowsRaw, cols_raw: shelf('none:Region:nk'),
          encodings: [], filters: [],
        },
      },
    ],
  });

  it('reads a DATE column on a continuous axis as a temporal dimension, never SUM', () => {
    const { dashboard, objects } = emitFixture(
      sheetOn(shelf('none:Order Date:qk'), [
        column({ id: 'c2', name: '[Order Date]', data_type_canonical: 'timestamp' }),
      ]),
    );
    const widget = dashboard.pages[0].layout[0].widget;
    expect(widget.queries[0].query.fields!.map((f) => f.expression)).toContain('`order_date`');
    expect(JSON.stringify(widget)).not.toContain('SUM(`order_date`)');
    const enc = widget.spec.encodings as Record<string, { scale?: { type: string } }>;
    expect(enc.y.scale).toEqual({ type: 'temporal' });
    const sheet = objects.find((o) => o.fqn === 'wb.sales/s')!;
    expect(sheet.status).toBe('needs_review');
    expect(sheet.notes.join(' ')).toMatch(/date column/);
  });

  it('reads a STRING column on a continuous axis as a categorical dimension, never SUM', () => {
    const { dashboard, objects } = emitFixture(
      sheetOn(shelf('none:Category:qk'), [
        column({ id: 'c3', name: '[Category]', data_type_canonical: 'string' }),
      ]),
    );
    const widget = dashboard.pages[0].layout[0].widget;
    expect(JSON.stringify(widget)).not.toContain('SUM(`category`)');
    const enc = widget.spec.encodings as Record<string, { scale?: { type: string } }>;
    expect(enc.y.scale).toEqual({ type: 'categorical' });
    expect(objects.find((o) => o.fqn === 'wb.sales/s')!.notes.join(' ')).toMatch(
      /is not a numeric column/,
    );
  });

  it('never sums an ATTR() token, even on a numeric column', () => {
    const { dashboard, objects } = emitFixture(
      sheetOn(shelf('attr:Sales:qk'), [
        column({ id: 'c1', name: '[Sales]', data_type_canonical: 'decimal(18,2)' }),
      ]),
    );
    expect(JSON.stringify(dashboard)).not.toContain('SUM(`sales_amount`)');
    expect(objects.find((o) => o.fqn === 'wb.sales/s')!.notes.join(' ')).toContain(
      'ATTR has no exact SQL equivalent',
    );
  });

  it('translates the exact aggregations median/stdev/var without a defaulted-SUM note', () => {
    const numeric = [column({ id: 'c1', name: '[Sales]', data_type_canonical: 'decimal(18,2)' })];
    for (const [prefix, name, expression] of [
      ['median', 'median(sales_amount)', 'MEDIAN(`sales_amount`)'],
      ['stdev', 'stdev(sales_amount)', 'stddev_samp(`sales_amount`)'],
      ['var', 'var(sales_amount)', 'var_samp(`sales_amount`)'],
    ]) {
      const { dashboard, objects } = emitFixture(sheetOn(shelf(`${prefix}:Sales:qk`), numeric));
      const fields = dashboard.pages[0].layout[0].widget.queries[0].query.fields!;
      expect(fields.find((f) => f.name === name), `${prefix} field`).toEqual({ name, expression });
      expect(objects.find((o) => o.fqn === 'wb.sales/s')!.notes.join(' ')).not.toMatch(
        /defaulted to SUM/,
      );
    }
  });
});

/* --------------------------------------------------- extra shelf fields (A4) */

describe('emitTableauGroupAsLakeview — extra shelf fields (A4)', () => {
  it('binds a second dimension to the color channel when the type pins one', () => {
    const { dashboard, objects } = emitFixture({
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region', 'Category'],
            rows_raw: shelf('sum:Sales:qk'),
            cols_raw: shelf('none:Region:nk', 'none:Category:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    const enc = dashboard.pages[0].layout[0].widget.spec.encodings as Record<string, { fieldName: string }>;
    expect(enc.x.fieldName).toBe('region');
    expect(enc.y.fieldName).toBe('sum(sales_amount)');
    expect(enc.color.fieldName).toBe('category');
    expect(objects.find((o) => o.fqn === 'wb.sales/s')!.status).toBe('ready');
  });

  it('notes a shelf field left with no channel instead of dropping it silently', () => {
    const { objects } = emitFixture({
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region', 'Category'],
            rows_raw: shelf('sum:Sales:qk'),
            cols_raw: shelf('none:Region:nk', 'none:Category:nk'),
            // The mark's own colour encoding already owns the only spare channel.
            encodings: [{ channel: 'color', field: 'Profit' }],
            filters: [],
          },
        },
      ],
    });
    const sheet = objects.find((o) => o.fqn === 'wb.sales/s')!;
    expect(sheet.status).toBe('needs_review');
    expect(sheet.notes).toContain(
      "S: field 'Category' on the cols shelf has no AI/BI channel on a bar widget — re-add it in the editor",
    );
  });
});

describe('emitTableauGroupAsLakeview — calc translation tier (Phase 4)', () => {
  it('an out-of-scope calc (LOD EXCLUDE) still lands in the checklist verbatim, channel dropped, plus an UNVERIFIED window candidate', () => {
    const { files, dashboard, objects } = emitFixture({
      columns: [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Regional Total]' })],
      derivations: [
        {
          asset_id: 'ds1',
          output_column_id: 'c_calc',
          output_name: '[Regional Total]',
          expression_sql: '{EXCLUDE [Region]: SUM([Sales])}',
          derivation_type: ['window'],
          language: 'tableau_calc',
          input_refs: null,
        },
      ],
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Regional Total'], cols: ['Region'],
            rows_raw: shelf('none:Regional Total:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    const checklist = files.get('sales-wb/rebuild_checklist.md')!;
    expect(checklist).toContain('Regional Total');
    expect(checklist).toContain('{EXCLUDE [Region]: SUM([Sales])}');
    expect(checklist).toContain('window');
    expect(checklist).toContain('UNVERIFIED candidate: AGGREGATE OVER (PARTITION BY * EXCEPT (Region))');
    // No translated SQL for the calc anywhere in the emitted dashboard.
    const blob = JSON.stringify(dashboard);
    expect(blob).not.toContain('regional_total');
    expect(blob).not.toContain('Regional Total');
    expect(objects.find((o) => o.fqn === 'wb.sales/s')!.status).toBe('needs_review');
  });

  it('an in-scope compound aggregate calc translates end-to-end: inlined into the widget field, dropped from the checklist, downgraded to an info note', () => {
    const { files, dashboard, objects } = emitFixture({
      columns: [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Profit Ratio]' })],
      derivations: [
        {
          asset_id: 'ds1',
          output_column_id: 'c_calc',
          output_name: '[Profit Ratio]',
          expression_sql: 'SUM([Profit]) / SUM([Sales])',
          derivation_type: ['aggregation'],
          language: 'tableau_calc',
          input_refs: null,
        },
      ],
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Profit Ratio'], cols: ['Region'],
            rows_raw: shelf('none:Profit Ratio:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    const checklist = files.get('sales-wb/rebuild_checklist.md')!;
    // Dropped from the "port by hand" TODO list, but surfaced as a translated-calc note.
    expect(checklist).not.toContain('## Calculations to port by hand');
    expect(checklist).toContain('## Calculations translated automatically');
    expect(checklist).toContain("'Profit Ratio' translated: SUM([Profit]) / SUM([Sales]) → (SUM(`profit`) / SUM(`sales_amount`))");

    // The translated SQL is inlined as the widget's own field expression.
    const widget = dashboard.pages[0].layout.find((l) => l.widget.spec.widgetType === 'bar')!.widget;
    const field = widget.queries[0].query.fields!.find((f) => f.expression.includes('profit'))!;
    expect(field).toBeDefined();
    expect(field.expression).toBe('(SUM(`profit`) / SUM(`sales_amount`))');

    // The underlying physical columns the calc references are pulled into the dataset.
    expect(dashboard.datasets[0].query).toContain('`profit`');
    expect(dashboard.datasets[0].query).toContain('`sales_amount`');

    const sheet = objects.find((o) => o.fqn === 'wb.sales/s')!;
    expect(sheet.status).toBe('ready');
    expect(sheet.notes.join(' ')).toMatch(/translated/);
  });

  it('a row-level translated calc placed on an aggregating shelf gets wrapped in that shelf aggregation, not double-counted', () => {
    const { dashboard } = emitFixture({
      columns: [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Net]' })],
      derivations: [
        {
          asset_id: 'ds1',
          output_column_id: 'c_calc',
          output_name: '[Net]',
          expression_sql: '[Sales] - [Profit]',
          derivation_type: ['arithmetic'],
          language: 'tableau_calc',
          input_refs: null,
        },
      ],
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Net'], cols: ['Region'],
            rows_raw: shelf('sum:Net:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    const widget = dashboard.pages[0].layout.find((l) => l.widget.spec.widgetType === 'bar')!.widget;
    const field = widget.queries[0].query.fields!.find((f) => f.expression.includes('SUM'))!;
    expect(field.expression).toBe('SUM((`sales_amount` - `profit`))');
  });
});

/* -------------------------------------------------------- filters (A7) */

describe('emitTableauGroupAsLakeview — filter widgets from filter_class (A7)', () => {
  const filterFixture = (
    filter: Record<string, unknown>,
    columns?: BiColumnRow[],
  ): ReturnType<typeof emitFixture> =>
    emitFixture({
      columns,
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [filter],
          },
        },
      ],
    });

  const filterTypeOf = (
    filter: Record<string, unknown>,
    columns?: BiColumnRow[],
  ): string =>
    widgetTypes(filterFixture(filter, columns).dashboard).find((t) => t.includes('filter') || t === 'range-slider')!;

  it('maps a categorical filter to filter-multi-select', () => {
    expect(filterTypeOf({ field: 'Category', filter_class: 'categorical' })).toBe(
      'filter-multi-select',
    );
  });

  it('maps a quantitative filter on a numeric column to range-slider', () => {
    expect(
      filterTypeOf({ field: 'Sales', filter_class: 'quantitative' }, [
        column({ id: 'c1', name: '[Sales]', data_type_canonical: 'decimal(18,2)' }),
      ]),
    ).toBe('range-slider');
  });

  it('maps a quantitative filter on a date column to filter-date-range-picker', () => {
    expect(
      filterTypeOf({ field: 'Order Date', filter_class: 'quantitative' }, [
        column({ id: 'c2', name: '[Order Date]', data_type_canonical: 'date' }),
      ]),
    ).toBe('filter-date-range-picker');
  });

  it('maps a quantitative filter on an unknown/string column to filter-single-select', () => {
    expect(filterTypeOf({ field: 'Category', filter_class: 'quantitative' })).toBe(
      'filter-single-select',
    );
  });

  it('maps a relative-date filter to filter-date-range-picker', () => {
    expect(filterTypeOf({ field: 'Order Date', filter_class: 'relative-date' })).toBe(
      'filter-date-range-picker',
    );
  });

  it('maps a filter with no captured class to filter-single-select', () => {
    expect(filterTypeOf({ field: 'Category' })).toBe('filter-single-select');
  });

  it('always says the source filter selection was not captured', () => {
    const { objects, files } = filterFixture({ field: 'Category', filter_class: 'categorical' });
    const dash = objects.find((o) => o.asset_type === 'bi_dashboard')!;
    expect(dash.status).toBe('needs_review');
    expect(dash.notes).toContain(
      "Exec Dashboard: filter on 'Category' — the source filter's selection was not captured; " +
        'the widget starts unfiltered, set the original selection',
    );
    const checklist = files.get('sales-wb/rebuild_checklist.md')!;
    expect(checklist).toContain("the source filter's selection was not captured");
    // The old blanket claim that every filter is single-select is gone.
    expect(checklist).not.toContain('Dashboard filters here are emitted as `filter-single-select`');
  });
});

/* ------------------------------------------------------------ encodings (A8) */

describe('emitTableauGroupAsLakeview — mark encodings (A8)', () => {
  const encodingSheet = (
    encodings: Array<Record<string, unknown>>,
    columns?: BiColumnRow[],
  ): ReturnType<typeof emitFixture> =>
    emitFixture({
      columns,
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'),
            encodings, filters: [],
          },
        },
      ],
    });

  it('routes a text encoding to the label channel where the widget type pins one', () => {
    const { dashboard } = encodingSheet([{ channel: 'text', field: 'Category' }]);
    const enc = dashboard.pages[0].layout[0].widget.spec.encodings as Record<string, { fieldName: string }>;
    expect(enc.label.fieldName).toBe('category');
  });

  it('wraps a numeric encoding field in SUM on an aggregated widget, and says it assumed it', () => {
    const { dashboard, objects } = encodingSheet(
      [{ channel: 'color', field: 'Profit' }],
      [
        column({ id: 'c1', name: '[Sales]', data_type_canonical: 'decimal(18,2)' }),
        column({ id: 'c4', name: '[Profit]', data_type_canonical: 'decimal(18,2)' }),
      ],
    );
    const widget = dashboard.pages[0].layout[0].widget;
    const enc = widget.spec.encodings as Record<string, { fieldName: string }>;
    expect(enc.color.fieldName).toBe('sum(profit)');
    expect(widget.queries[0].query.fields!.map((f) => f.expression)).toContain('SUM(`profit`)');
    expect(objects.find((o) => o.fqn === 'wb.sales/s')!.notes.join(' ')).toContain(
      'aggregation assumed (the capture does not carry the encoding\'s aggregation)',
    );
  });

  it('gives a bound channel the column caption as its display name', () => {
    const { dashboard } = emitFixture({
      columns: [
        column({ id: 'c1', name: '[Region]', platform_properties: { caption: 'Sales Region' } }),
      ],
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Text', mark_classes: ['Text'],
            rows: [], cols: ['Region'],
            rows_raw: '', cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    const columns = dashboard.pages[0].layout[0].widget.spec.encodings.columns as Array<{
      fieldName: string;
      displayName: string;
    }>;
    expect(columns).toEqual([{ fieldName: 'region', displayName: 'Sales Region' }]);
  });
});

/* ---------------------------------------- shelf grammar edge cases (A10–A14) */

describe('emitTableauGroupAsLakeview — shelf grammar edge cases', () => {
  it('never fabricates a column for Measure Names/Values tokens (A10)', () => {
    for (const token of [
      ':Measure Names',
      'Measure Names',
      'Multiple Values',
      ':Measure Values',
      'Measure Values',
    ]) {
      const { dashboard, objects } = emitFixture({
        sheets: [
          {
            name: 'S',
            visual: {
              mark_class: 'Bar', mark_classes: ['Bar'],
              rows: ['Sales'], cols: [],
              rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf(token),
              encodings: [], filters: [],
            },
          },
        ],
      });
      const blob = JSON.stringify(dashboard);
      expect(blob, token).not.toContain('Measure Names');
      expect(blob, token).not.toContain('Measure Values');
      expect(blob, token).not.toContain('Multiple Values');
      expect(objects.find((o) => o.fqn === 'wb.sales/s')!.notes.join(' '), token).toContain(
        'Measure Names/Values shelf is not supported — pick the measures in the editor',
      );
    }
  });

  it('keeps a name-only rows shelf on the rows shelf (A11)', () => {
    const { dashboard } = emitFixture({
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            encodings: [], filters: [],
          },
        },
      ],
    });
    const enc = dashboard.pages[0].layout[0].widget.spec.encodings as Record<string, { fieldName: string }>;
    expect(enc.x.fieldName).toBe('region');
    expect(enc.y.fieldName).toBe('sales_amount');
  });

  it('names the datasource it assumed for a sheet with no datasource edge (A12)', () => {
    const { objects } = emitFixture({
      sheets: [{ name: 'S', fields: ['Sales'] }],
      noDatasourceEdge: true,
    });
    const sheet = objects.find((o) => o.fqn === 'wb.sales/s')!;
    expect(sheet.status).toBe('needs_review');
    expect(sheet.notes.join(' ')).toContain(
      "no datasource is recorded for this sheet — it was scaffolded against 'Orders'",
    );
  });

  it('notes that a combo widget collapsed its secondary axis (A14)', () => {
    const { objects } = emitFixture({
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar', 'Line'],
            rows: ['Sales', 'Profit'], cols: ['Order Date'],
            rows_raw: shelf('sum:Sales:qk', 'avg:Profit:qk'),
            cols_raw: shelf('tmn:Order Date:qk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    expect(objects.find((o) => o.fqn === 'wb.sales/s')!.notes.join(' ')).toContain(
      'secondary axis collapsed onto the primary axis',
    );
  });

  it('treats a derivation with language null as a Tableau calc (A15)', () => {
    const { files } = emitFixture({
      columns: [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Net]' })],
      derivations: [
        {
          asset_id: 'ds1',
          output_column_id: 'c_calc',
          output_name: '[Net]',
          expression_sql: '[Sales] - [Profit]',
          derivation_type: ['arithmetic'],
          language: null,
          input_refs: null,
        },
      ],
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Net'], cols: ['Region'],
            rows_raw: shelf('sum:Net:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    const checklist = files.get('sales-wb/rebuild_checklist.md')!;
    expect(checklist).toContain("'Net' translated");
  });
});

/* ------------------------------------------------ dataset identity (A5) + A13 */

describe('emitTableauGroupAsLakeview — dataset identity and shared sheets', () => {
  /** Two datasources whose DISPLAY labels collide (an embedded copy of a published
   *  datasource is the common real case), one sheet each. */
  function collidingLabelFixture(): GroupFixture {
    const top = asset({ id: 'wb1', name: 'Sales WB', asset_type: 'bi_workbook', fqn: 'wb.sales' });
    const dsA = asset({ id: 'ds1', asset_type: 'bi_datasource', name: 'Sales WB/Orders', fqn: 'wb.sales/orders' });
    const dsB = asset({ id: 'ds2', asset_type: 'bi_datasource', name: 'Orders', fqn: 'published/orders' });
    const dash = asset({ id: 'dash1', asset_type: 'bi_dashboard', name: 'Sales WB/Exec Dashboard', fqn: 'wb.sales/exec' });
    const sheets = [1, 2].map((i) =>
      asset({ id: `sh${i}`, asset_type: 'bi_sheet', name: `Sales WB/S${i}`, fqn: `wb.sales/s${i}` }),
    );
    const edges: BiEdgeRow[] = [];
    sheets.forEach((s, i) => {
      edges.push({ from_asset_id: dash.id, to_asset_id: s.id, to_column_id: null, to_column_name: null });
      edges.push({ from_asset_id: s.id, to_asset_id: i === 0 ? dsA.id : dsB.id, to_column_id: null, to_column_name: null });
      edges.push({ from_asset_id: s.id, to_asset_id: i === 0 ? dsA.id : dsB.id, to_column_id: 'col:Sales', to_column_name: 'Sales' });
    });
    const own = [dash, ...sheets, dsA, dsB];
    return {
      ctx: {
        files: new Map<string, string>(),
        objects: [] as BiManifestObject[],
        edges,
        byId: new Map([top, ...own].map((a) => [a.id, a])),
        columnsByAsset: new Map([
          ['ds1', [column({ id: 'c1', name: '[Sales]' })]],
          ['ds2', [column({ id: 'c2', asset_id: 'ds2', name: '[Sales]' })]],
        ]),
        derivationsByAsset: new Map(),
        bindingsByAsset: new Map([
          ['ds1', [binding({})]],
          ['ds2', [binding({ asset_id: 'ds2' })]],
        ]),
      },
      top,
      own,
      slug: 'sales-wb',
    };
  }

  it('seeds a dataset id from the datasource fqn, so two same-named datasources differ (A5)', () => {
    const f = collidingLabelFixture();
    emitTableauGroupAsLakeview(f.ctx, f.top, f.own, f.slug);
    const path = [...f.ctx.files.keys()].find((p) => p.endsWith('.lvdash.json'))!;
    const doc = JSON.parse(f.ctx.files.get(path)!) as LakeviewDashboardJson;
    expect(doc.datasets).toHaveLength(2);
    expect(doc.datasets[0].displayName).toBe(doc.datasets[1].displayName);
    expect(doc.datasets[0].name).not.toBe(doc.datasets[1].name);
  });

  it('gives a sheet used by two dashboards exactly one manifest object (A13)', () => {
    const top = asset({ id: 'wb1', name: 'Sales WB', asset_type: 'bi_workbook', fqn: 'wb.sales' });
    const ds = asset({ id: 'ds1', asset_type: 'bi_datasource', name: 'Sales WB/Orders', fqn: 'wb.sales/orders' });
    const shared = asset({ id: 'sh1', asset_type: 'bi_sheet', name: 'Sales WB/Shared', fqn: 'wb.sales/shared' });
    const dashes = ['A', 'B'].map((n, i) =>
      asset({ id: `dash${i + 1}`, asset_type: 'bi_dashboard', name: `Sales WB/${n}`, fqn: `wb.sales/${n.toLowerCase()}` }),
    );
    const edges: BiEdgeRow[] = [
      ...dashes.map((d) => ({ from_asset_id: d.id, to_asset_id: shared.id, to_column_id: null, to_column_name: null })),
      { from_asset_id: shared.id, to_asset_id: ds.id, to_column_id: null, to_column_name: null },
      { from_asset_id: shared.id, to_asset_id: ds.id, to_column_id: 'col:Sales', to_column_name: 'Sales' },
    ];
    const own = [...dashes, shared, ds];
    const ctx: LakeviewGroupContext = {
      files: new Map<string, string>(),
      objects: [] as BiManifestObject[],
      edges,
      byId: new Map([top, ...own].map((a) => [a.id, a])),
      columnsByAsset: new Map([['ds1', [column({ id: 'c1', name: '[Sales]' })]]]),
      derivationsByAsset: new Map([['ds1', []]]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    };
    emitTableauGroupAsLakeview(ctx, top, own, 'sales-wb');

    const sheetObjects = ctx.objects.filter((o) => o.fqn === 'wb.sales/shared');
    expect(sheetObjects).toHaveLength(1);
    expect(sheetObjects[0].file).toBe('sales-wb/dashboards/A.lvdash.json');
    // Notes merged, never doubled.
    expect(new Set(sheetObjects[0].notes).size).toBe(sheetObjects[0].notes.length);
    expect(sheetObjects[0].status).toBe('needs_review');
  });
});

describe('emitTableauGroupAsLakeview — layout from the captured dashboard zones', () => {
  it('places widgets from percent zones matched by sheet name', () => {
    const { dashboard } = emitFixture({
      sheets: [
        { name: 'Left', fields: ['Sales'] },
        { name: 'Right', fields: ['Region'] },
      ],
      zones: [
        { sheet_name: 'Left', type: 'worksheet', x: 0, y: 0, w: 50, h: 100 },
        { sheet_name: 'Right', type: 'worksheet', x: 50, y: 0, w: 50, h: 100 },
      ],
    });
    const positions = dashboard.pages[0].layout.map((l) => l.position);
    expect(positions[0]).toEqual({ x: 0, y: 0, width: 6, height: 48 });
    expect(positions[1]).toEqual({ x: 6, y: 0, width: 6, height: 48 });
  });
});

describe('emitTableauGroupAsLakeview — emitted files are secret-free', () => {
  it('never leaks descriptor secrets into any emitted file', () => {
    const f = groupFixture({
      sheets: [{ name: 'S', fields: ['Sales'] }],
      bindings: [
        binding({
          descriptor: {
            platform_hint: 'databricks',
            host: 'workspace.cloud.databricks.com',
            extra: {
              http_path: '/sql/1.0/warehouses/abc123',
              token: 'dapi-super-secret-token-value',
              password: 'hunter2-plaintext',
            },
          },
        }),
      ],
    });
    emitTableauGroupAsLakeview(f.ctx, f.top, f.own, f.slug);
    const blob = [...f.ctx.files.values()].join('\n');
    expect(blob).not.toContain('dapi-super-secret-token-value');
    expect(blob).not.toContain('hunter2-plaintext');
    expect(blob).not.toContain('/sql/1.0/warehouses/abc123');
  });
});

describe('emitTableauGroupAsLakeview — emit-time caps', () => {
  it('splits past 100 widgets onto further canvas pages, each starting at the top', () => {
    const { dashboard, objects } = emitFixture({
      sheets: Array.from({ length: 101 }, (_, i) => ({ name: `S${i}`, fields: ['Sales'] })),
    });
    expect(dashboard.pages).toHaveLength(2);
    expect(dashboard.pages[0].layout).toHaveLength(100);
    expect(dashboard.pages[1].layout).toHaveLength(1);
    for (const page of dashboard.pages) {
      expect(page.pageType).toBe('PAGE_TYPE_CANVAS');
      expect(Math.min(...page.layout.map((l) => l.position.y))).toBe(0);
    }
    const dash = objects.find((o) => o.asset_type === 'bi_dashboard')!;
    expect(dash.notes.join(' ')).toMatch(/exceed the 100-widget page limit — split across 2 pages/);
  });

  it('splits past the 15-page cap into several dashboard files instead of dropping pages', () => {
    // 1501 widgets = 16 pages of 100, one page past what a dashboard holds.
    const { files, objects } = emitFixture({
      sheets: Array.from({ length: 1501 }, (_, i) => ({ name: `S${i}`, fields: ['Sales'] })),
    });
    const paths = [...files.keys()].filter((p) => p.endsWith('.lvdash.json')).sort();
    expect(paths).toEqual([
      'sales-wb/dashboards/Exec_Dashboard_part_1_of_2.lvdash.json',
      'sales-wb/dashboards/Exec_Dashboard_part_2_of_2.lvdash.json',
    ]);
    const docs = paths.map((p) => JSON.parse(files.get(p)!) as LakeviewDashboardJson);
    // Every page — and so every widget — survives the split.
    expect(docs.map((d) => d.pages.length)).toEqual([8, 8]);
    expect(docs.flatMap((d) => d.pages).flatMap((p) => p.layout)).toHaveLength(1501);
    for (const doc of docs) {
      expect(doc.pages.length).toBeLessThanOrEqual(15);
      expect(doc.datasets.length).toBeLessThanOrEqual(100);
      expect(doc.datasets.length).toBeGreaterThan(0);
    }
    const dash = objects.find((o) => o.asset_type === 'bi_dashboard')!;
    expect(dash.notes.join(' ')).toMatch(/split into 2 dashboards, imported separately/);
    expect(dash.notes.join(' ')).toContain('Exec_Dashboard_part_2_of_2.lvdash.json');
    // …and the parts are machine-readable on the manifest object, not just prose.
    expect(dash.parts).toEqual(paths);
    expect(dash.file).toBe(paths[0]);
  });

  it('leaves `parts` off a manifest object whose rebuild fit one file', () => {
    const { objects } = emitFixture({ sheets: [{ name: 'S', fields: ['Sales'] }] });
    for (const o of objects) expect(o.parts).toBeUndefined();
  });

  it('keeps a report that fits in one file, under its unsuffixed name', () => {
    const { files, path } = emitFixture({ sheets: [{ name: 'S', fields: ['Sales'] }] });
    expect(path).toBe('sales-wb/dashboards/Exec_Dashboard.lvdash.json');
    expect([...files.keys()].filter((p) => p.endsWith('.lvdash.json'))).toHaveLength(1);
  });
});

describe('splitLakeviewPages — the logical split', () => {
  const page = (name: string, datasets: string[]): LakeviewPageJson => ({
    name,
    displayName: name,
    pageType: 'PAGE_TYPE_CANVAS',
    layout: datasets.map((d) => ({
      widget: {
        name: `w${d}`,
        queries: [{ name: 'main_query', query: { datasetName: d, fields: [], disaggregated: false } }],
        spec: { version: 3, widgetType: 'bar', encodings: {} },
      },
      position: { x: 0, y: 0, width: 12, height: 4 },
    })),
  });
  const pages = (n: number, dataset = 'd1'): LakeviewPageJson[] =>
    Array.from({ length: n }, (_, i) => page(`p${i}`, [dataset]));

  it('leaves a report that fits as a single document', () => {
    const input = pages(15);
    expect(splitLakeviewPages(input)).toEqual([input]);
  });

  it('splits an over-cap report into even parts, never one at the cap', () => {
    expect(splitLakeviewPages(pages(28)).map((d) => d.length)).toEqual([14, 14]);
    expect(splitLakeviewPages(pages(16)).map((d) => d.length)).toEqual([8, 8]);
    expect(splitLakeviewPages(pages(31)).map((d) => d.length)).toEqual([11, 11, 9]);
  });

  it('keeps every page exactly once and in order', () => {
    const input = pages(46);
    const out = splitLakeviewPages(input).flat();
    expect(out).toEqual(input);
  });

  it('closes a part on a datasource seam rather than mid-source', () => {
    // 12 pages on d1 then 14 on d2: arithmetic alone would cut at 13.
    const input = [
      ...Array.from({ length: 12 }, (_, i) => page(`a${i}`, ['d1'])),
      ...Array.from({ length: 14 }, (_, i) => page(`b${i}`, ['d2'])),
    ];
    const docs = splitLakeviewPages(input);
    expect(docs).toHaveLength(2);
    expect(docs[0].every((p) => p.displayName.startsWith('a'))).toBe(true);
    expect(docs[1].every((p) => p.displayName.startsWith('b'))).toBe(true);
  });

  it('splits on the dataset cap even when the pages would fit one document', () => {
    const input = Array.from({ length: 12 }, (_, i) => page(`p${i}`, [`d${i}`, `e${i}`]));
    // 12 pages (under the page cap) but 24 datasets — cap them at 10 per document.
    const docs = splitLakeviewPages(input, 15, 10);
    expect(docs.length).toBeGreaterThan(1);
    for (const doc of docs) {
      const names = new Set(
        doc.flatMap((p) => p.layout.map((e) => e.widget.queries[0].query.datasetName)),
      );
      expect(names.size).toBeLessThanOrEqual(10);
    }
    expect(docs.flat()).toEqual(input);
  });

  it('is deterministic', () => {
    const input = pages(31);
    expect(splitLakeviewPages(input)).toEqual(splitLakeviewPages(input));
  });
});

describe('emitTableauGroupAsLakeview — checklist and manifest honesty', () => {
  it('notes Genie and suggests the /importBI cross-check', () => {
    const { files } = emitFixture({ sheets: [{ name: 'S', fields: ['Sales'] }] });
    const checklist = files.get('sales-wb/rebuild_checklist.md')!;
    expect(checklist).toContain('Genie is enabled by default on published AI/BI dashboards');
    expect(checklist).toContain('/importBI');
  });

  it('marks a cleanly-mapped dashboard ready and every asset lands in the manifest', () => {
    const { objects, path } = emitFixture({
      sheets: [
        {
          name: 'Sales by Region',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
      zones: [{ sheet_name: 'Sales by Region', type: 'worksheet', x: 0, y: 0, w: 100, h: 100 }],
    });
    const dash = objects.find((o) => o.asset_type === 'bi_dashboard')!;
    expect(dash.status).toBe('ready');
    expect(dash.file).toBe(path);
    for (const fqn of ['wb.sales', 'wb.sales/orders', 'wb.sales/sales by region', 'wb.sales/exec dashboard']) {
      expect(objects.some((o) => o.fqn === fqn), `${fqn} should be in the manifest`).toBe(true);
    }
  });

  it('reports a blended sheet instead of silently dropping its other datasource', () => {
    const { objects, files } = emitFixture({
      sheets: [{ name: 'Blended', fields: ['Sales'] }],
      blend: true,
    });
    const sheet = objects.find((o) => o.fqn === 'wb.sales/blended')!;
    expect(sheet.status).toBe('needs_review');
    expect(sheet.notes.join(' ')).toMatch(/reads 2 datasources/);
    expect(files.get('sales-wb/rebuild_checklist.md')).toMatch(/reads 2 datasources/);
  });

  it('a sheet on no dashboard is reported, never silently dropped', () => {
    const f = groupFixture({ sheets: [{ name: 'Orphan', fields: ['Sales'] }], withDashboard: false });
    // A workbook with sheets but no dashboard gets one dashboard file for the workbook.
    emitTableauGroupAsLakeview(f.ctx, f.top, f.own, f.slug);
    expect([...f.ctx.files.keys()].some((p) => p.endsWith('.lvdash.json'))).toBe(true);
    expect(f.ctx.objects.some((o) => o.fqn === 'wb.sales/orphan')).toBe(true);
  });

  it('review notes on a top-asset dashboard reach the workbook object, not just the checklist', () => {
    // No dashboard asset ⇒ the workbook stands in for one, and its own manifest object is
    // the only place that dashboard's review notes can land. The sheet has no visual
    // capture, so the dashboard is review-worthy by construction.
    const f = groupFixture({ sheets: [{ name: 'Orphan', fields: ['Sales'] }], withDashboard: false });
    emitTableauGroupAsLakeview(f.ctx, f.top, f.own, f.slug);
    const wb = f.ctx.objects.find((o) => o.fqn === 'wb.sales' && o.asset_type === 'bi_workbook')!;
    expect(wb.status).toBe('needs_review');
    expect(wb.notes.join(' ')).toMatch(/no visual capture/);
  });

  it('a datasource with no relation gets file: null, never a phantom metric-view path', () => {
    const { objects, files } = emitFixture({
      sheets: [{ name: 'S', fields: ['Sales'] }],
      bindings: [binding({ refs: [] })],
    });
    const ds = objects.find((o) => o.fqn === 'wb.sales/orders')!;
    expect(files.has('sales-wb/metric_views/Orders.yaml')).toBe(false);
    expect(ds.file).toBeNull();
    expect(ds.status).toBe('needs_review');
  });

  it('a datasource that does get a metric view points at the file the pack actually contains', () => {
    const { objects, files } = emitFixture({ sheets: [{ name: 'S', fields: ['Sales'] }] });
    const ds = objects.find((o) => o.fqn === 'wb.sales/orders')!;
    expect(ds.file).toBe('sales-wb/metric_views/Orders.yaml');
    expect(files.has(ds.file!)).toBe(true);
  });

  it('a workbook with parameters gets a Parameters checklist section and needs_review status (Task 6)', () => {
    const { objects, files } = emitFixture({
      sheets: [{ name: 'S', fields: ['Sales'] }],
      workbookParameters: [
        {
          name: 'Parameter 1', caption: 'Select Metric', datatype: 'string',
          current_value: '"Sales"',
          allowable_values: { kind: 'list', values: ['"Sales"', '"Profit"'] },
        },
        {
          name: 'Parameter 2', datatype: 'integer', current_value: '5',
          allowable_values: { kind: 'range', min: '1', max: '20' },
        },
      ],
    });
    const checklist = files.get('sales-wb/rebuild_checklist.md')!;
    expect(checklist).toContain('## Parameters');
    expect(checklist).toContain('Parameter 1');
    expect(checklist).toContain('Parameter 2');
    expect(checklist).toContain('emitted as `:parameter_1` (STRING), bound to a `filter-single-select` widget');
    expect(checklist).toContain('emitted as `:parameter_2` (INTEGER), bound to a `filter-single-select` widget');
    const wb = objects.find((o) => o.fqn === 'wb.sales' && o.asset_type === 'bi_workbook')!;
    expect(wb.status).toBe('needs_review');
    expect(wb.notes.join(' ')).toContain("[Parameters].[Parameter 1]");
  });

  it('emits each pinnable workbook parameter as a dataset parameter + a bound filter widget in the corpus shape (plan Phase D)', () => {
    const { dashboard, path, files } = emitFixture({
      sheets: [{ name: 'S', fields: ['Sales'] }],
      workbookParameters: [
        {
          name: 'Select Metric', datatype: 'string', current_value: '"Sales"',
          allowable_values: { kind: 'list', values: ['"Sales"', '"Profit"'] },
        },
        { name: 'As Of', caption: 'As-of date', datatype: 'date', current_value: '#2024-01-15#' },
      ],
    });
    // Declared on every dataset, defaulting from the Tableau current value with its
    // Tableau-syntax delimiters stripped.
    for (const ds of dashboard.datasets) {
      expect(ds.parameters).toEqual([
        {
          displayName: 'select_metric', keyword: 'select_metric', dataType: 'STRING',
          defaultSelection: { values: { dataType: 'STRING', values: [{ value: 'Sales' }] } },
        },
        {
          displayName: 'as_of', keyword: 'as_of', dataType: 'DATE',
          defaultSelection: { values: { dataType: 'DATE', values: [{ value: '2024-01-15' }] } },
        },
      ]);
    }
    // One filter widget per parameter, first in the filter row, bound through
    // parameterName/queryName with one parameter query per dataset — no `fields`.
    const layout = dashboard.pages[0].layout;
    const select = layout[0].widget;
    const date = layout[1].widget;
    expect(select.spec.widgetType).toBe('filter-single-select');
    expect(select.spec.frame).toEqual({ showTitle: true, title: 'Select Metric' });
    expect(date.spec.widgetType).toBe('filter-date-picker');
    expect(date.spec.frame).toEqual({ showTitle: true, title: 'As-of date' });
    expect(layout[0].position).toEqual({ x: 0, y: 0, width: 3, height: 4 });
    expect(layout[1].position).toEqual({ x: 3, y: 0, width: 3, height: 4 });
    const dsName = dashboard.datasets[0].name;
    expect(select.queries).toEqual([
      {
        name: `parameter_${dsName}_select_metric`,
        query: { datasetName: dsName, parameters: [{ name: 'select_metric', keyword: 'select_metric' }], disaggregated: false },
      },
    ]);
    expect(select.spec.encodings).toEqual({
      fields: [{ parameterName: 'select_metric', queryName: `parameter_${dsName}_select_metric` }],
    });
    // The chart widget is pushed below the filter row.
    expect(layout[2].position.y).toBeGreaterThanOrEqual(4);
    // The document still round-trips through the reader, parameters included.
    const doc = parseLvdashFile(path, Buffer.from(files.get(path)!, 'utf8'));
    expect(doc.datasets[0].parameters?.map((p) => p.keyword)).toEqual(['select_metric', 'as_of']);
    expect(doc.widgets.map((w) => w.type)).toEqual(['filter-single-select', 'filter-date-picker', 'table']);
  });

  it('keeps unpinnable parameters checklist-only and says why; DATETIME is declared but unbound; keywords never collide', () => {
    const { dashboard, files, objects } = emitFixture({
      sheets: [{ name: 'S', fields: ['Sales'] }],
      workbookParameters: [
        { name: 'Show Detail', datatype: 'boolean', current_value: 'true' },
        { name: 'Region', datatype: 'string', current_value: '"West"' },
        { name: 'region!', datatype: 'string', current_value: '"East"' },
        { name: 'Cut-off', datatype: 'datetime', current_value: '#2024-01-15 10:30:00#' },
        { name: 'Top N', datatype: 'integer' },
      ],
    });
    const keywords = dashboard.datasets[0].parameters!.map((p) => p.keyword);
    expect(keywords).toEqual(['region', 'region_2', 'cut_off']);
    expect(dashboard.datasets[0].parameters![2].defaultSelection).toEqual({
      values: { dataType: 'DATETIME', values: [{ value: '2024-01-15T10:30:00' }] },
    });
    const widgetTypes = dashboard.pages[0].layout.map((l) => l.widget.spec.widgetType);
    expect(widgetTypes.filter((t) => t.startsWith('filter-'))).toEqual(['filter-single-select', 'filter-single-select']);
    const checklist = files.get('sales-wb/rebuild_checklist.md')!;
    expect(checklist).toContain("not emitted: datatype 'boolean' has no pinned AI/BI parameter type");
    expect(checklist).toContain('not emitted: no current value was captured');
    expect(checklist).toContain('the corpus never binds a DATETIME parameter to a filter widget');
    const wb = objects.find((o) => o.fqn === 'wb.sales' && o.asset_type === 'bi_workbook')!;
    expect(wb.status).toBe('needs_review');
    expect(wb.notes.join(' ')).toContain("workbook parameter 'Show Detail' not emitted");
  });

  it('a workbook with no parameters gets no Parameters checklist section', () => {
    const { files } = emitFixture({ sheets: [{ name: 'S', fields: ['Sales'] }] });
    const checklist = files.get('sales-wb/rebuild_checklist.md')!;
    expect(checklist).not.toContain('## Parameters');
  });

  it('a sheet with sorts gets a checklist line (Task 6)', () => {
    const { files } = emitFixture({
      sheets: [
        {
          name: 'Sales by Region',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
            sorts: [{ field: 'Region', direction: 'DESC' }],
          },
        },
      ],
      zones: [{ sheet_name: 'Sales by Region', type: 'worksheet', x: 0, y: 0, w: 100, h: 100 }],
    });
    const checklist = files.get('sales-wb/rebuild_checklist.md')!;
    expect(checklist).toMatch(/apply sort in dataset SQL ORDER BY or widget sort — verify/);
  });
});

/* ----------------------------------------------------- round-trip + tripwire */

describe('round-trip backstop — every emitted .lvdash.json parses through the reader', () => {
  const kitchenSink = {
    columns: [column({ id: 'c1', name: '[Sales]' })],
    zones: [
      { sheet_name: 'Bar Sheet', type: 'worksheet', x: 0, y: 0, w: 50, h: 50 },
      { sheet_name: 'Line Sheet', type: 'worksheet', x: 50, y: 0, w: 50, h: 50 },
    ],
    sheets: [
      {
        name: 'Bar Sheet',
        visual: {
          mark_class: 'Bar', mark_classes: ['Bar'],
          rows: ['Sales'], cols: ['Region'],
          rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'),
          encodings: [{ channel: 'color', field: 'Category' }],
          filters: [{ field: 'Category' }],
        },
      },
      {
        name: 'Line Sheet',
        visual: {
          mark_class: 'Line', mark_classes: ['Line'],
          rows: ['Sales'], cols: ['Order Date'],
          rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('yr:Order Date:ok'),
          encodings: [], filters: [],
        },
      },
      {
        name: 'KPI Sheet',
        visual: {
          mark_class: 'Text', mark_classes: ['Text'],
          rows: ['Sales'], cols: [],
          rows_raw: shelf('sum:Sales:qk'), cols_raw: '',
          encodings: [], filters: [],
        },
      },
      { name: 'No Capture Sheet', fields: ['Sales', 'Region'] },
    ],
  };

  it('retains every dataset (with non-null SQL), widget and position through parseLvdashFile', () => {
    const { files } = emitFixture(kitchenSink);
    const paths = [...files.keys()].filter((p) => p.endsWith('.lvdash.json'));
    expect(paths.length).toBeGreaterThan(0);

    for (const p of paths) {
      const content = files.get(p)!;
      const emitted = JSON.parse(content) as LakeviewDashboardJson;
      const doc = parseLvdashFile(p.split('/').pop()!, Buffer.from(content, 'utf8'));

      expect(doc.datasets).toHaveLength(emitted.datasets.length);
      for (const d of doc.datasets) {
        expect(d.query, `dataset ${d.name} should carry SQL`).toBeTruthy();
      }

      const emittedWidgets = emitted.pages.flatMap((pg) => pg.layout);
      expect(doc.widgets).toHaveLength(emittedWidgets.length);
      for (const w of doc.widgets) {
        expect(w.type, `widget ${w.name} should declare a type`).toBeTruthy();
        expect(LAKEVIEW_WIDGET_TYPES[w.type!], `${w.type} must be pinned`).toBeDefined();
        expect(w.datasetNames.length).toBeGreaterThan(0);
        const pos = w.position!;
        expect(pos).toBeDefined();
        for (const v of [pos.x, pos.y, pos.width, pos.height]) expect(Number.isInteger(v)).toBe(true);
        expect(pos.x).toBeGreaterThanOrEqual(0);
        expect(pos.x + pos.width).toBeLessThanOrEqual(12);
        expect(pos.width).toBeGreaterThanOrEqual(1);
        expect(pos.height).toBeGreaterThanOrEqual(1);
      }

      // …and through the upload path the connector actually uses.
      const [rec] = mapLakeviewDocs([doc], 'file');
      expect(rec.assetType).toBe('bi_dashboard');
      expect(rec.definitionSql).toBeTruthy();
      expect((rec.platformProperties!.widgets as unknown[]).length).toBe(emittedWidgets.length);
    }
  });

  it('format tripwire — every (widgetType, spec.version) the emitter produces is pinned', () => {
    const { files } = emitFixture(kitchenSink);
    const mapVariants = emitFixture({
      sheets: [
        { name: 'Filled Map', visual: { mark_class: 'Map', mark_classes: ['Map'], rows: [], cols: [], rows_raw: shelf('none:Region:nk'), cols_raw: shelf('sum:Sales:qk'), encodings: [], filters: [] } },
        { name: 'Symbol Map', visual: { mark_class: 'Circle', mark_classes: ['Circle'], rows: [], cols: [], rows_raw: shelf('none:Latitude:qk'), cols_raw: shelf('none:Longitude:qk'), encodings: [], filters: [] } },
        { name: 'Dual Axis', visual: { mark_class: 'Bar', mark_classes: ['Bar', 'Line'], rows: [], cols: [], rows_raw: shelf('sum:Sales:qk', 'avg:Profit:qk'), cols_raw: shelf('yr:Order Date:ok'), encodings: [], filters: [] } },
        { name: 'Heat', visual: { mark_class: 'Square', mark_classes: ['Square'], rows: [], cols: [], rows_raw: shelf('none:Region:nk'), cols_raw: shelf('none:Category:nk'), encodings: [], filters: [] } },
        { name: 'Dots', visual: { mark_class: 'Shape', mark_classes: ['Shape'], rows: [], cols: [], rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('sum:Profit:qk'), encodings: [], filters: [] } },
        { name: 'Slice', visual: { mark_class: 'Pie', mark_classes: ['Pie'], rows: [], cols: [], rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Category:nk'), encodings: [], filters: [] } },
        { name: 'Fill', visual: { mark_class: 'Area', mark_classes: ['Area'], rows: [], cols: [], rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('yr:Order Date:ok'), encodings: [], filters: [] } },
      ],
    });

    const unpinned: string[] = [];
    const seen = new Set<string>();
    for (const source of [files, mapVariants.files]) {
      for (const [p, content] of source) {
        if (!p.endsWith('.lvdash.json')) continue;
        const doc = JSON.parse(content) as LakeviewDashboardJson;
        for (const entry of doc.pages.flatMap((pg) => pg.layout)) {
          const { widgetType, version } = entry.widget.spec;
          seen.add(`${widgetType}@${version}`);
          if (!isPinnedLakeviewSpec(widgetType, version)) unpinned.push(`${widgetType}@${version}`);
        }
      }
    }
    expect(unpinned, `unpinned pairs emitted: ${unpinned.join(', ')}`).toEqual([]);
    // The fixture really does exercise the whole mapping table.
    expect(seen.size).toBeGreaterThanOrEqual(9);
  });
});

describe('emitTableauGroupAsLakeview — translator receives catalog types and sibling calcs (plan Phase B wiring)', () => {
  it('a calc that references another calc translates inline through the widget field', () => {
    const { dashboard, files } = emitFixture({
      columns: [
        column({ id: 'c1', name: '[Sales]', data_type_canonical: 'decimal(18,2)' }),
        column({ id: 'c_base', name: '[Base]' }),
        column({ id: 'c_total', name: '[Doubled Total]' }),
      ],
      derivations: [
        {
          asset_id: 'ds1', output_column_id: 'c_base', output_name: '[Base]',
          expression_sql: '[Sales] * 2', derivation_type: ['arithmetic'], language: 'tableau_calc', input_refs: null,
        },
        {
          asset_id: 'ds1', output_column_id: 'c_total', output_name: '[Doubled Total]',
          expression_sql: 'SUM([Base])', derivation_type: ['aggregation'], language: 'tableau_calc', input_refs: null,
        },
      ],
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Doubled Total'], cols: ['Region'],
            rows_raw: shelf('none:Doubled Total:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    const widget = dashboard.pages[0].layout.find((l) => l.widget.spec.widgetType === 'bar')!.widget;
    const field = widget.queries[0].query.fields!.find((f) => f.expression.includes('sales_amount'))!;
    expect(field.expression).toMatch(/^SUM\(\(?`sales_amount` \* 2\)?\)$/);
    const checklist = files.get('sales-wb/rebuild_checklist.md')!;
    expect(checklist).not.toContain('## Calculations to port by hand');
  });

  it('a numeric field in `[Sales] + 1` translates only because the catalog column type is known', () => {
    const base = {
      derivations: [
        {
          asset_id: 'ds1', output_column_id: 'c_calc', output_name: '[Plus One]',
          expression_sql: '[Sales] + 1', derivation_type: ['arithmetic'], language: 'tableau_calc', input_refs: null,
        },
      ],
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Plus One'], cols: ['Region'],
            rows_raw: shelf('sum:Plus One:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    };
    const typed = emitFixture({
      ...base,
      columns: [column({ id: 'c1', name: '[Sales]', data_type_canonical: 'decimal(18,2)' }), column({ id: 'c_calc', name: '[Plus One]' })],
    });
    const typedWidget = typed.dashboard.pages[0].layout.find((l) => l.widget.spec.widgetType === 'bar')!.widget;
    expect(typedWidget.queries[0].query.fields!.some((f) => f.expression === 'SUM((`sales_amount` + 1))')).toBe(true);

    const untyped = emitFixture({
      ...base,
      columns: [column({ id: 'c1', name: '[Sales]', data_type_canonical: null }), column({ id: 'c_calc', name: '[Plus One]' })],
    });
    const untypedChecklist = untyped.files.get('sales-wb/rebuild_checklist.md')!;
    expect(untypedChecklist).toContain('## Calculations to port by hand');
    expect(untypedChecklist).toContain('Plus One');
  });
});

/* ------------------------------------------- semantic layer ↔ dataset agreement */

describe('dataset SQL selects from the view the semantic layer actually emitted (F3)', () => {
  /** Two datasources that both resolve to the view name `orders`: one over a declared UC
   *  table, one custom-SQL-only whose connection is also called `orders`. Their view FILES
   *  collide, so claimPath renames the second to `orders_2.sql` — the view NAME inside it
   *  is still `orders`, and that is what each dataset must select from. */
  function twoViewFixture() {
    const top = asset({ id: 'wb1', name: 'Sales WB', asset_type: 'bi_workbook', fqn: 'wb.sales' });
    const dsTable = asset({
      id: 'ds1', asset_type: 'bi_datasource', name: 'Sales WB/Orders', fqn: 'wb.sales/orders',
    });
    const dsCustom = asset({
      id: 'ds2', asset_type: 'bi_datasource', name: 'Sales WB/Orders', fqn: 'wb.sales/orders-live',
      platform_properties: {
        customSql: [{ connection: 'orders', sql: 'SELECT region, sales_amount FROM raw.orders_live' }],
      },
    });
    const dash = asset({
      id: 'dash1', asset_type: 'bi_dashboard', name: 'Sales WB/Exec', fqn: 'wb.sales/exec',
    });
    const sheets = ['Table Sheet', 'Custom Sheet'].map((n, i) =>
      asset({
        id: `sh${i + 1}`, asset_type: 'bi_sheet', name: `Sales WB/${n}`, fqn: `wb.sales/${i}`,
        platform_properties: {
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [], captured_via: 'twb_content',
          },
        },
      }),
    );
    const edges: BiEdgeRow[] = [];
    sheets.forEach((sh, i) => {
      edges.push({ from_asset_id: dash.id, to_asset_id: sh.id, to_column_id: null, to_column_name: null });
      edges.push({
        from_asset_id: sh.id, to_asset_id: i === 0 ? dsTable.id : dsCustom.id,
        to_column_id: null, to_column_name: null,
      });
    });
    const own = [dash, ...sheets, dsTable, dsCustom];
    const ctx: LakeviewGroupContext = {
      files: new Map<string, string>(),
      objects: [] as BiManifestObject[],
      edges,
      byId: new Map([top, ...own].map((a) => [a.id, a])),
      columnsByAsset: new Map([
        ['ds1', [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c2', name: '[Region]' })]],
        ['ds2', [column({ id: 'c3', asset_id: 'ds2', name: '[Sales]' }), column({ id: 'c4', asset_id: 'ds2', name: '[Region]' })]],
      ]),
      derivationsByAsset: new Map(),
      bindingsByAsset: new Map([
        ['ds1', [binding({})]],
        // Custom-SQL-only: no `declared` ref, so the semantic layer emits no table view
        // for it and falls back to the custom SQL relation's connection name.
        ['ds2', [binding({
          asset_id: 'ds2',
          refs: [{
            parts: { catalog: 'main', schema: 'sales', object: 'orders_live' },
            via: 'custom_sql',
            columns: [
              { bi_field: 'Sales', db_column: 'sales_amount' },
              { bi_field: 'Region', db_column: 'region' },
            ],
          }],
        })]],
      ]),
    };
    return { ctx, top, own, slug: 'sales-wb' };
  }

  /** `CREATE OR REPLACE VIEW \`x\`` → `x`, for every emitted view file. */
  const viewNamesIn = (files: Map<string, string>): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [path, content] of files) {
      if (!path.startsWith('sales-wb/views/')) continue;
      const m = /CREATE OR REPLACE VIEW `([^`]+)`/.exec(content);
      if (m) out.set(path, m[1]);
    }
    return out;
  };

  it('every dataset FROM names a view the pack actually emitted', () => {
    const f = twoViewFixture();
    emitTableauGroupAsLakeview(f.ctx, f.top, f.own, f.slug);
    const path = [...f.ctx.files.keys()].find((p) => p.endsWith('.lvdash.json'))!;
    const doc = JSON.parse(f.ctx.files.get(path)!) as LakeviewDashboardJson;

    const emitted = viewNamesIn(f.ctx.files);
    // Both view files exist; the second claimed the `_2` path but kept the view NAME.
    expect([...emitted.keys()].sort()).toEqual([
      'sales-wb/views/orders.sql',
      'sales-wb/views/orders_2.sql',
    ]);
    expect(emitted.get('sales-wb/views/orders_2.sql')).toBe('orders');

    expect(doc.datasets).toHaveLength(2);
    const declared = new Set(emitted.values());
    for (const ds of doc.datasets) {
      const from = /FROM `([^`]+)`/.exec(ds.query)![1];
      expect(declared).toContain(from);
    }
  });

  it('a custom-SQL-only datasource selects from its custom SQL view, not a guessed name', () => {
    const f = twoViewFixture();
    emitTableauGroupAsLakeview(f.ctx, f.top, f.own, f.slug);
    const path = [...f.ctx.files.keys()].find((p) => p.endsWith('.lvdash.json'))!;
    const doc = JSON.parse(f.ctx.files.get(path)!) as LakeviewDashboardJson;

    // Both datasources resolve to the view name `orders` — the custom-SQL one takes it
    // from its `customSql[0].connection`, never from its display label or the file stem.
    for (const ds of doc.datasets) {
      expect(ds.query).toContain('FROM `orders`');
      expect(ds.query).not.toContain('FROM `orders_2`');
      expect(ds.query).not.toContain('FROM `Orders`');
    }
    // Nothing was reported as a placeholder view the semantic layer never emitted.
    const checklist = f.ctx.files.get('sales-wb/rebuild_checklist.md')!;
    expect(checklist).not.toContain('the semantic layer did not emit');
  });
});

describe('emitTableauGroupAsLakeview — review-pass fixes (2026-09-03)', () => {
  it('a Tableau datetime column (canonical "other") still reaches the temporal branches via the raw type', () => {
    const { dashboard, objects } = emitFixture({
      columns: [column({ id: 'c_d', name: '[Order Date]', data_type_canonical: 'other', data_type_raw: 'datetime' })],
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Line', mark_classes: ['Line'],
            rows: ['Order Date'], cols: [],
            rows_raw: shelf('none:Order Date:qk'), cols_raw: '',
            encodings: [], filters: [{ field: 'Order Date', filter_class: 'quantitative' }],
          },
        },
      ],
    });
    const widgets = dashboard.pages[0].layout.map((l) => l.widget);
    expect(widgets[0].spec.widgetType).toBe('filter-date-range-picker');
    const chart = widgets.find((w) => !w.spec.widgetType.startsWith('filter-'))!;
    const encodings = chart.spec.encodings as Record<string, { scale?: { type: string } }>;
    expect(Object.values(encodings).some((e) => e?.scale?.type === 'temporal')).toBe(true);
    expect(objects.find((o) => o.fqn === 'wb.sales/s')!.notes.join(' ')).not.toContain("'other'");
  });

  it('scalar encoding channels carry the caption as displayName', () => {
    const { dashboard } = emitFixture({
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Sales'], cols: ['Region'],
            rows_raw: shelf('sum:Sales:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    const bar = dashboard.pages[0].layout.find((l) => l.widget.spec.widgetType === 'bar')!.widget;
    const enc = bar.spec.encodings as Record<string, { fieldName: string; displayName?: string }>;
    expect(enc.x.displayName).toBeDefined();
    expect(enc.y.displayName).toBeDefined();
    expect(enc.x.displayName).not.toBe(enc.x.fieldName.includes('(') ? enc.x.fieldName : '');
  });

  it('two measures on Columns and nothing on Rows never plot a measure against itself', () => {
    const { dashboard, objects } = emitFixture({
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: [], cols: ['Sales', 'Profit'],
            rows_raw: '', cols_raw: `${shelf('sum:Sales:qk')}${shelf('sum:Profit:qk')}`,
            encodings: [], filters: [],
          },
        },
      ],
    });
    const bar = dashboard.pages[0].layout.find((l) => l.widget.spec.widgetType === 'bar')!.widget;
    const enc = bar.spec.encodings as Record<string, { fieldName: string }>;
    expect(enc.x.fieldName).not.toBe(enc.y.fieldName);
    expect(objects.find((o) => o.fqn === 'wb.sales/s')).toBeDefined();
  });

  it('an ATTR()-wrapped calculated field still carries the ATTR caveat', () => {
    const { objects } = emitFixture({
      columns: [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Net]' })],
      derivations: [
        {
          asset_id: 'ds1', output_column_id: 'c_calc', output_name: '[Net]',
          expression_sql: '[Sales] * 2', derivation_type: ['arithmetic'], language: 'tableau_calc', input_refs: null,
        },
      ],
      sheets: [
        {
          name: 'S',
          visual: {
            mark_class: 'Bar', mark_classes: ['Bar'],
            rows: ['Net'], cols: ['Region'],
            rows_raw: shelf('attr:Net:qk'), cols_raw: shelf('none:Region:nk'),
            encodings: [], filters: [],
          },
        },
      ],
    });
    const sheet = objects.find((o) => o.fqn === 'wb.sales/s')!;
    expect(sheet.notes.join(' ')).toContain('ATTR');
    expect(sheet.status).toBe('needs_review');
  });
});
