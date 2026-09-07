import { describe, it, expect } from 'vitest';
import {
  emitSemanticLayer,
  type SemanticLayerContext,
  type DatasourceGroup,
} from '../../src/convert/semantic-layer.js';
import type { BiAssetRow } from '../../src/bi/grouping.js';
import type { BiBindingLite, BiColumnRow, BiDerivationRow } from '../../src/convert/shared.js';

/**
 * emitSemanticLayer (Databricks AI/BI rebuild plan, Phase 1 — data lane): per-datasource
 * `CREATE OR REPLACE VIEW` SQL over the matched UC table (or verbatim custom SQL with a
 * review banner), a UC metric-view YAML (dimensions from plain fields, measures from
 * single-simple-aggregate calcs), and a shared extract-rescue Python template for any
 * datasource with no matched source system. Standalone module — Phase 3 wires it into
 * rebuild.ts; these are pure-function tests over hand-built ctx fixtures mirroring
 * rebuild-tableau.test-style fixtures (asset/column/binding/derivation builders).
 */

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
      columns: [{ bi_field: 'Sales', db_column: 'sales_amount' }],
    },
  ],
  status: 'matched',
  ...over,
});

const deriv = (over: Partial<BiDerivationRow>): BiDerivationRow => ({
  asset_id: 'ds1',
  output_column_id: 'c_calc',
  output_name: '[Total Sales]',
  expression_sql: 'SUM([Sales])',
  derivation_type: ['aggregation'],
  language: 'tableau_calc',
  input_refs: null,
  ...over,
});

function ctxOf(over: Partial<SemanticLayerContext> = {}): SemanticLayerContext {
  return {
    columnsByAsset: new Map(),
    derivationsByAsset: new Map(),
    bindingsByAsset: new Map(),
    ...over,
  };
}

function groupOf(over: Partial<DatasourceGroup> = {}): DatasourceGroup {
  const ds = asset({ id: 'ds1', asset_type: 'bi_datasource', name: 'Sales WB/Orders', fqn: 'wb.sales/orders' });
  return {
    top: asset({ id: 'wb1', asset_type: 'bi_workbook' }),
    own: [ds],
    slug: 'sales-wb',
    ...over,
  };
}

describe('emitSemanticLayer — table relation', () => {
  it('emits a pass-through CREATE OR REPLACE VIEW over the bound UC table, backtick-quoted three-part name', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([['ds1', [column({ id: 'c1', name: '[Sales]' })]]]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    });
    const { files, notes } = emitSemanticLayer(ctx, groupOf());

    const viewFile = files.find((f) => f.path === 'sales-wb/views/orders.sql');
    expect(viewFile).toBeDefined();
    expect(viewFile!.content).toContain('CREATE OR REPLACE VIEW');
    expect(viewFile!.content).toContain('`main`.`sales`.`orders`');
    expect(notes.review).toHaveLength(0);
  });

  it('flags a missing catalog/schema on the ref but still emits best-effort SQL', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([['ds1', [column({ id: 'c1', name: '[Sales]' })]]]),
      bindingsByAsset: new Map([
        [
          'ds1',
          [
            binding({
              refs: [{ parts: { object: 'orders' }, via: 'declared' }],
            }),
          ],
        ],
      ]),
    });
    const { files, notes } = emitSemanticLayer(ctx, groupOf());
    const viewFile = files.find((f) => f.path === 'sales-wb/views/orders.sql');
    expect(viewFile!.content).toContain('`orders`');
    expect(notes.review.some((n) => n.includes('catalog') && n.includes('schema'))).toBe(true);
  });
});

describe('emitSemanticLayer — custom_sql relation', () => {
  it('embeds the verbatim custom SQL with a review banner, never rewritten', () => {
    const ds = asset({
      id: 'ds1',
      asset_type: 'bi_datasource',
      name: 'Sales WB/Custom',
      fqn: 'wb.sales/custom',
      platform_properties: { customSql: [{ connection: 'my_conn', sql: 'SELECT * FROM weird_legacy_syntax(1)' }] },
    });
    const ctx = ctxOf({
      columnsByAsset: new Map([['ds1', []]]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    });
    const { files, notes } = emitSemanticLayer(ctx, groupOf({ own: [ds] }));

    const viewFile = files.find((f) => f.path === 'sales-wb/views/my_conn.sql');
    expect(viewFile).toBeDefined();
    expect(viewFile!.content).toContain('-- REVIEW: source dialect — verify against Databricks SQL');
    expect(viewFile!.content).toContain('SELECT * FROM weird_legacy_syntax(1)');
    expect(notes.review.some((n) => n.includes('custom SQL'))).toBe(true);
  });
});

describe('emitSemanticLayer — metric-view YAML measures', () => {
  it('translates a single simple-aggregate calc (SUM) to a measure using the physical column', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([
        ['ds1', [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Total Sales]' })]],
      ]),
      derivationsByAsset: new Map([['ds1', [deriv({})]]]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    });
    const { files, notes } = emitSemanticLayer(ctx, groupOf());

    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml');
    expect(yamlFile).toBeDefined();
    expect(yamlFile!.content).toContain('version: 0.1');
    expect(yamlFile!.content).toContain('source: "orders"');
    expect(yamlFile!.content).toMatch(/measures:\s*\n\s*- name: "Total Sales"\s*\n\s*expr: "SUM\(`sales_amount`\)"/);
    // Every physical column identifier in an `expr` is backtick-quoted (a column named
    // `order date` would otherwise be invalid SQL in the metric view).
    expect(yamlFile!.content).toMatch(/- name: "Sales"\s*\n\s*expr: "`sales_amount`"/);
    expect(yamlFile!.content).not.toContain('needs_review');
    expect(notes.info.some((n) => n.includes('metric view'))).toBe(true);
  });

  it('maps COUNTD to COUNT(DISTINCT …)', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([
        ['ds1', [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Distinct Sales]' })]],
      ]),
      derivationsByAsset: new Map([
        ['ds1', [deriv({ output_name: '[Distinct Sales]', expression_sql: 'COUNTD([Sales])' })]],
      ]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    });
    const { files } = emitSemanticLayer(ctx, groupOf());
    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml')!;
    expect(yamlFile.content).toContain('COUNT(DISTINCT `sales_amount`)');
  });

  it('non-simple calcs (not a bare AGG([Field])) go to the needs_review block verbatim, never guessed', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([
        ['ds1', [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Profit Ratio]' })]],
      ]),
      derivationsByAsset: new Map([
        [
          'ds1',
          [
            deriv({
              output_name: '[Profit Ratio]',
              expression_sql: 'SUM([Sales]) / SUM([Cost])',
              derivation_type: ['aggregation'],
            }),
          ],
        ],
      ]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    });
    const { files, notes } = emitSemanticLayer(ctx, groupOf());
    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml')!;
    expect(yamlFile.content).toContain('# needs_review');
    expect(yamlFile.content).toContain('SUM([Sales]) / SUM([Cost])');
    expect(yamlFile.content).toContain('aggregation');
    // Must NOT be silently fabricated as a measure.
    expect(yamlFile.content).not.toMatch(/- name: "Profit Ratio"\s*\n\s*expr:/);
    expect(notes.review.some((n) => n.includes('could not be translated'))).toBe(true);
  });

  it('a row-level (non-aggregation) calc also lands in needs_review, not as a dimension', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([
        ['ds1', [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Net]' })]],
      ]),
      derivationsByAsset: new Map([
        [
          'ds1',
          [
            deriv({
              output_name: '[Net]',
              expression_sql: '[Sales] - [Cost]',
              derivation_type: ['arithmetic'],
            }),
          ],
        ],
      ]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    });
    const { files } = emitSemanticLayer(ctx, groupOf());
    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml')!;
    expect(yamlFile.content).toContain('# needs_review');
    expect(yamlFile.content).toContain('[Sales] - [Cost]');
    expect(yamlFile.content).not.toMatch(/name: "Net"[\s\S]{0,40}expr: "\[Sales\] - \[Cost\]"/);
  });
});

describe('emitSemanticLayer — tableau-sql translation tier (Phase 4)', () => {
  const twoFieldBinding = (): BiBindingLite =>
    binding({
      refs: [
        {
          parts: { catalog: 'main', schema: 'sales', object: 'orders' },
          via: 'declared',
          columns: [
            { bi_field: 'Sales', db_column: 'sales_amount' },
            { bi_field: 'Cost', db_column: 'cost_amount' },
          ],
        },
      ],
    });

  it('a compound aggregate calc that now translates end-to-end lands as a measure, not needs_review', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([
        [
          'ds1',
          [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Profit Ratio]' })],
        ],
      ]),
      derivationsByAsset: new Map([
        [
          'ds1',
          [
            deriv({
              output_name: '[Profit Ratio]',
              expression_sql: 'SUM([Sales]) / SUM([Cost])',
              derivation_type: ['aggregation'],
            }),
          ],
        ],
      ]),
      bindingsByAsset: new Map([['ds1', [twoFieldBinding()]]]),
    });
    const { files, notes } = emitSemanticLayer(ctx, groupOf());
    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml')!;
    expect(yamlFile.content).toMatch(
      /measures:\s*\n\s*- name: "Profit Ratio"\s*\n\s*expr: "\(SUM\(`sales_amount`\) \/ SUM\(`cost_amount`\)\)"/,
    );
    expect(yamlFile.content).not.toContain('# needs_review');
    expect(
      notes.info.some((n) => n.includes("'Profit Ratio' translated") && n.includes('SUM([Sales]) / SUM([Cost])')),
    ).toBe(true);
  });

  it('a row-level calc that now translates end-to-end lands as a dimension', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([
        ['ds1', [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Net]' })]],
      ]),
      derivationsByAsset: new Map([
        [
          'ds1',
          [
            deriv({
              output_name: '[Net]',
              expression_sql: '[Sales] - [Cost]',
              derivation_type: ['arithmetic'],
            }),
          ],
        ],
      ]),
      bindingsByAsset: new Map([['ds1', [twoFieldBinding()]]]),
    });
    const { files } = emitSemanticLayer(ctx, groupOf());
    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml')!;
    expect(yamlFile.content).toMatch(
      /- name: "Net"\s*\n\s*expr: "\(`sales_amount` - `cost_amount`\)"/,
    );
    expect(yamlFile.content).not.toContain('# needs_review');
  });

  it('an out-of-scope calc (LOD) still lands in needs_review, translator returns null', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([
        ['ds1', [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Regional Total]' })]],
      ]),
      derivationsByAsset: new Map([
        [
          'ds1',
          [
            deriv({
              output_name: '[Regional Total]',
              expression_sql: '{FIXED [Region]: SUM([Sales])}',
              derivation_type: ['window'],
            }),
          ],
        ],
      ]),
      bindingsByAsset: new Map([['ds1', [twoFieldBinding()]]]),
    });
    const { files, notes } = emitSemanticLayer(ctx, groupOf());
    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml')!;
    expect(yamlFile.content).toContain('# needs_review');
    expect(yamlFile.content).toContain('{FIXED [Region]: SUM([Sales])}');
    expect(notes.review.some((n) => n.includes('could not be translated'))).toBe(true);
  });
});

describe('emitSemanticLayer — partial physical binding (unmatched fields never silently pass through)', () => {
  it('flags an unmatched dimension AND an unmatched measure operand: review note + inline YAML comment, never a silent raw-name fallback', () => {
    // The binding only maps 'Sales' -> 'sales_amount'; 'Region' (a plain dimension) and
    // 'Cost' (a measure operand) have no entry in refs[].columns[] — e.g. a partially
    // matched datasource, or refs derived only from custom_sql extraction.
    const ctx = ctxOf({
      columnsByAsset: new Map([
        [
          'ds1',
          [
            column({ id: 'c1', name: '[Sales]' }),
            column({ id: 'c2', name: '[Region]' }),
            column({ id: 'c_calc', name: '[Total Cost]' }),
          ],
        ],
      ]),
      derivationsByAsset: new Map([
        ['ds1', [deriv({ output_name: '[Total Cost]', expression_sql: 'SUM([Cost])' })]],
      ]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]), // refs only cover 'Sales' -> 'sales_amount'
    });

    const { files, notes } = emitSemanticLayer(ctx, groupOf());
    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml')!;

    // Unmatched dimension: falls back to the raw caption (backtick-quoted, like every
    // other identifier in an expr), but flagged, not silent.
    expect(yamlFile.content).toMatch(
      /- name: "Region"\s*\n\s*expr: "`Region`"\s*\n\s*# needs_review: no matched physical column/,
    );
    expect(
      notes.review.some(
        (n) => n.includes("dimension 'Region'") && n.includes('no matched physical column'),
      ),
    ).toBe(true);

    // Unmatched measure operand: SUM(Cost) falls back to the raw field token, flagged.
    expect(yamlFile.content).toMatch(
      /- name: "Total Cost"\s*\n\s*expr: "SUM\(`Cost`\)"\s*\n\s*# needs_review: measure operand has no matched physical column/,
    );
    expect(
      notes.review.some(
        (n) => n.includes("measure 'Total Cost' operand 'Cost'") && n.includes('no matched physical column'),
      ),
    ).toBe(true);

    // The matched 'Sales' dimension stays clean — no false positives.
    expect(yamlFile.content).toMatch(/- name: "Sales"\s*\n\s*expr: "`sales_amount`"\s*\n\s*- name:/);
  });
});

describe('emitSemanticLayer — dimensions from non-calculated fields', () => {
  it('emits a dimension per plain field using the physical (bound) column name', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([['ds1', [column({ id: 'c1', name: '[Sales]' })]]]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    });
    const { files } = emitSemanticLayer(ctx, groupOf());
    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml')!;
    expect(yamlFile.content).toMatch(/dimensions:\s*\n\s*- name: "Sales"\s*\n\s*expr: "`sales_amount`"/);
  });

  it('backtick-escapes a physical column name that itself contains a backtick', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([['ds1', [column({ id: 'c1', name: '[Odd]' })]]]),
      bindingsByAsset: new Map([
        [
          'ds1',
          [
            binding({
              refs: [
                {
                  parts: { catalog: 'main', schema: 'sales', object: 'orders' },
                  via: 'declared',
                  columns: [{ bi_field: 'Odd', db_column: 'we`ird' }],
                },
              ],
            }),
          ],
        ],
      ]),
    });
    const { files } = emitSemanticLayer(ctx, groupOf());
    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml')!;
    expect(yamlFile.content).toContain('expr: "`we``ird`"');
  });
});

describe('emitSemanticLayer — derivation language predicate (A15)', () => {
  it('treats a derivation with language null as a Tableau calc, same as an explicit one', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([
        ['ds1', [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Total Sales]' })]],
      ]),
      derivationsByAsset: new Map([['ds1', [deriv({ language: null })]]]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    });
    const { files } = emitSemanticLayer(ctx, groupOf());
    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml')!;
    // The calc column becomes a measure, NOT a plain dimension over a phantom column.
    expect(yamlFile.content).toMatch(/measures:\s*\n\s*- name: "Total Sales"/);
    expect(yamlFile.content).not.toMatch(/- name: "Total Sales"\s*\n\s*expr: "`Total Sales`"/);
  });

  it('still ignores a derivation written in another language', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([
        ['ds1', [column({ id: 'c1', name: '[Sales]' }), column({ id: 'c_calc', name: '[Total Sales]' })]],
      ]),
      derivationsByAsset: new Map([['ds1', [deriv({ language: 'dax' })]]]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    });
    const { files } = emitSemanticLayer(ctx, groupOf());
    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml')!;
    expect(yamlFile.content).toContain('measures: []');
  });
});

describe('emitSemanticLayer — hard limits (global constraint: ≤200 custom calcs/dataset)', () => {
  it('caps measures/needs_review consideration at 200 calc columns and flags the overflow', () => {
    const calcColumns = Array.from({ length: 210 }, (_, i) =>
      column({ id: `c_calc_${i}`, name: `[Calc ${i}]` }),
    );
    const derivations = calcColumns.map((c, i) =>
      deriv({ output_column_id: c.id, output_name: c.name, expression_sql: `SUM([Sales${i}])` }),
    );
    const ctx = ctxOf({
      columnsByAsset: new Map([['ds1', [column({ id: 'c1', name: '[Sales]' }), ...calcColumns]]]),
      derivationsByAsset: new Map([['ds1', derivations]]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    });
    const { files, notes } = emitSemanticLayer(ctx, groupOf());
    const yamlFile = files.find((f) => f.path === 'sales-wb/metric_views/Orders.yaml')!;
    const measureCount = (yamlFile.content.match(/- name: "Calc \d+"/g) ?? []).length;
    expect(measureCount).toBe(200);
    expect(notes.review.some((n) => n.includes('200-calc cap'))).toBe(true);
  });
});

describe('emitSemanticLayer — extract-rescue script', () => {
  it('emits extract_rescue.py exactly once when a datasource has no matched source system', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([['ds1', []]]),
      bindingsByAsset: new Map(), // no binding at all → unmatched
    });
    const { files, notes } = emitSemanticLayer(ctx, groupOf());
    const rescueFiles = files.filter((f) => f.path === 'semantic_layer/extract_rescue.py');
    expect(rescueFiles).toHaveLength(1);
    expect(rescueFiles[0].content).toContain('--catalog');
    expect(rescueFiles[0].content).toContain('--schema');
    expect(rescueFiles[0].content).toContain('hyper');
    expect(rescueFiles[0].content).toContain('DATABRICKS_TOKEN');
    // No credentials — env-var auth only, documented not embedded.
    expect(rescueFiles[0].content).not.toMatch(/token\s*=\s*['"][^'"]+['"]/);
    expect(notes.info.some((n) => n.includes('rescue'))).toBe(true);
  });

  it('finishes the job: a real parquet → Delta load parameterized by --catalog/--schema, no TODO (A18)', () => {
    const ctx = ctxOf({ columnsByAsset: new Map([['ds1', []]]), bindingsByAsset: new Map() });
    const { files } = emitSemanticLayer(ctx, groupOf());
    const script = files.find((f) => f.path === 'semantic_layer/extract_rescue.py')!.content;
    expect(script).toContain('spark.read.parquet(parquet_path)');
    expect(script).toContain(".write.format('delta')");
    expect(script).toContain(".mode('overwrite')");
    expect(script).toContain('saveAsTable(');
    expect(script).toContain('{args.catalog}');
    expect(script).toContain('{args.schema}');
    expect(script).not.toContain('TODO');
  });

  it('does not emit a rescue script when every datasource has a matched binding', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([['ds1', []]]),
      bindingsByAsset: new Map([['ds1', [binding({})]]]),
    });
    const { files } = emitSemanticLayer(ctx, groupOf());
    expect(files.some((f) => f.path === 'semantic_layer/extract_rescue.py')).toBe(false);
  });

  it('an unmatched (but present) binding also triggers the rescue script', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([['ds1', []]]),
      bindingsByAsset: new Map([['ds1', [binding({ status: 'unmatched' })]]]),
    });
    const { files } = emitSemanticLayer(ctx, groupOf());
    expect(files.some((f) => f.path === 'semantic_layer/extract_rescue.py')).toBe(true);
  });
});

describe('emitSemanticLayer — secret-free invariant', () => {
  it('never leaks descriptor secrets/tokens/httpPath even when ctx carries them', () => {
    const ctx = ctxOf({
      columnsByAsset: new Map([['ds1', [column({ id: 'c1', name: '[Sales]' })]]]),
      bindingsByAsset: new Map([
        [
          'ds1',
          [
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
        ],
      ]),
    });
    const { files } = emitSemanticLayer(ctx, groupOf());
    const blob = files.map((f) => f.content).join('\n');
    expect(blob).not.toContain('dapi-super-secret-token-value');
    expect(blob).not.toContain('hunter2-plaintext');
    expect(blob).not.toContain('/sql/1.0/warehouses/abc123');
  });
});

describe('emitSemanticLayer — multiple datasources in one group', () => {
  it('emits independent view/metric-view files per datasource, path-safe, no collisions', () => {
    const ds1 = asset({ id: 'ds1', asset_type: 'bi_datasource', name: 'Sales WB/Orders', fqn: 'wb.sales/orders' });
    const ds2 = asset({ id: 'ds2', asset_type: 'bi_datasource', name: 'Sales WB/Returns', fqn: 'wb.sales/returns' });
    const ctx = ctxOf({
      columnsByAsset: new Map([
        ['ds1', [column({ id: 'c1', asset_id: 'ds1', name: '[Sales]' })]],
        ['ds2', [column({ id: 'c2', asset_id: 'ds2', name: '[Returns]' })]],
      ]),
      bindingsByAsset: new Map([
        ['ds1', [binding({})]],
        [
          'ds2',
          [
            binding({
              asset_id: 'ds2',
              refs: [
                {
                  parts: { catalog: 'main', schema: 'sales', object: 'returns' },
                  via: 'declared',
                  columns: [{ bi_field: 'Returns', db_column: 'returns_amount' }],
                },
              ],
            }),
          ],
        ],
      ]),
    });
    const { files } = emitSemanticLayer(ctx, groupOf({ own: [ds1, ds2] }));
    expect(files.some((f) => f.path === 'sales-wb/views/orders.sql')).toBe(true);
    expect(files.some((f) => f.path === 'sales-wb/views/returns.sql')).toBe(true);
    expect(files.some((f) => f.path === 'sales-wb/metric_views/Orders.yaml')).toBe(true);
    expect(files.some((f) => f.path === 'sales-wb/metric_views/Returns.yaml')).toBe(true);
  });
});
