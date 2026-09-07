import { buildFqn } from '../model/fqn.js';
import type { BiBindingRef, BiDescriptor } from '../model/types.js';
import { normalizeDescriptor } from './descriptors.js';
import type {
  StagingAssetRec,
  StagingBatch,
  StagingBiBindingRec,
  StagingColumnRec,
  StagingDependencyRec,
  StagingScreenshotRec,
} from './staging.js';
import { tokenizeCalc, type TokenizeCalcResult } from './calc.js';
import type {
  TableauDashboardDoc,
  TableauDatasourceDoc,
  TableauParameterDoc,
  TableauSheetDoc,
  TableauTableParts,
  TableauWorkbookDoc,
} from './model.js';

/** column_derivation.parser_version for tokenizer-classified Tableau calcs (decision 3). */
export const BI_CALC_PARSER_VERSION = 'bi-calc/1.0';

/**
 * Tableau doc → StagingBatch mapper (BI connectors plan Task 4) — the single normalizer
 * both delivery modes converge on (spec §4). `mode` is accepted for interface symmetry
 * with Task 5's live mapper call site; the merge logic itself never branches on it —
 * whichever fields a doc actually carries (`upstream` is live-only, `formula` is present
 * on either mode) drive the output, so file mode and live mode literally share this code.
 */

function refKey(parts: TableauTableParts): string {
  return buildFqn(parts.catalog, parts.schema, parts.object);
}

type BindingColumnRef = NonNullable<BiBindingRef['columns']>[number];

/** Last entry wins per (bi_field, db_column) pair — so a platform-declared entry (no
 *  `method`, live mode) merged after a tokenizer-derived one replaces it, and the pair is
 *  stitched at the declared 0.95 rather than the derived 0.85. */
function mergeColumns(
  existing: BindingColumnRef[] | undefined,
  added: BindingColumnRef[],
): BindingColumnRef[] {
  const seen = new Map<string, BindingColumnRef>();
  for (const c of existing ?? []) seen.set(`${c.bi_field}::${c.db_column}`, c);
  for (const c of added) seen.set(`${c.bi_field}::${c.db_column}`, c);
  return [...seen.values()];
}

/** A datasource's own asset-identity FQN "object" segment (decision 2): a published
 *  datasource stands on its own name; an embedded one is workbook-scoped. */
function datasourceObjectName(workbookName: string, ds: TableauDatasourceDoc): string {
  return ds.published ? ds.name : `${workbookName}/${ds.name}`;
}

/* ------------------------------------------- persisted platform_properties shapes */

/**
 * The `platform_properties` sub-objects this mapper writes, as they are read back off
 * `bi_asset.platform_properties` downstream (the rebuild targets, briefs, catalog views).
 * Exported so a consumer imports the contract instead of re-declaring its own copy of it
 * (`rebuild-databricks.ts` used to carry `RawVisual`/`RawLayout`/`RawParameter`).
 *
 * Every field is optional on purpose: these describe a JSON column that is also filled by
 * OLDER connector versions, so a reader must treat any key as possibly absent even where
 * the mapper below always writes it. The mapper's own objects are annotated with these
 * types (a stricter object satisfies a looser one) — the annotation is documentation and
 * a compile-time guard, never a runtime change.
 */
export interface PersistedTableauVisual {
  mark_class?: string;
  mark_classes?: string[];
  /** Resolved shelf field names. */
  rows?: string[];
  cols?: string[];
  /** Raw shelf expression text (`[federated.x].[sum:Sales:qk]`). */
  rows_raw?: string;
  cols_raw?: string;
  encodings?: Array<{ channel?: string; field?: string }>;
  filters?: Array<{ field?: string; filter_class?: string }>;
  /** Explicit worksheet sort order (Task 6 fidelity backfill) — checklist guidance only,
   *  per the controller ruling; no dataset/widget JSON is generated from this. */
  sorts?: Array<{ field?: string; direction?: string }>;
  captured_via?: TableauWorkbookDoc['visualSource'];
}

/** `platform_properties.layout` on a dashboard asset — percent zones 0–100. */
export interface PersistedTableauLayout {
  width?: number;
  height?: number;
  sizing?: string;
  zones?: Array<{ sheet_name?: string; type?: string; x?: number; y?: number; w?: number; h?: number }>;
  captured_via?: TableauWorkbookDoc['visualSource'];
}

/** One entry of `platform_properties.parameters` on a bi_workbook asset (Task 6 fidelity
 *  backfill). Checklist-only per the controller ruling: the Phase-0 corpus has no
 *  dashboard-parameter fixture evidence, so nothing emits guessed `.lvdash.json`
 *  parameter JSON from this. */
export interface PersistedTableauParameter {
  name?: string;
  caption?: string;
  datatype?: string;
  current_value?: string;
  allowable_values?: { kind?: string; values?: string[]; min?: string; max?: string };
}

/** Dashboard `platform_properties` (Tableau visual-rebuild feature, Task A4) — snake_case
 *  `layout` (zone geometry + canvas size) plus `luid` when known; undefined when neither
 *  is present so a dashboard with no capture stages no platform_properties at all. */
function dashboardPlatformProperties(
  dash: TableauDashboardDoc,
  capturedVia: TableauWorkbookDoc['visualSource'],
): Record<string, unknown> | undefined {
  if (!dash.luid && !dash.layout) return undefined;
  const props: Record<string, unknown> = {};
  if (dash.luid) props.luid = dash.luid;
  if (dash.layout) {
    const layout = dash.layout;
    const persisted: PersistedTableauLayout = {
      ...(layout.width !== undefined ? { width: layout.width } : {}),
      ...(layout.height !== undefined ? { height: layout.height } : {}),
      ...(layout.sizing !== undefined ? { sizing: layout.sizing } : {}),
      zones: layout.zones.map((z) => ({
        ...(z.sheetName ? { sheet_name: z.sheetName } : {}),
        type: z.type, x: z.x, y: z.y, w: z.w, h: z.h,
      })),
      captured_via: capturedVia,
    };
    props.layout = persisted;
  }
  return props;
}

/** Sheet `platform_properties` (Task A4) — snake_case `visual` (mark/shelf/encoding/
 *  filter/sort structure) plus `luid` when known; undefined when neither is present. */
function sheetPlatformProperties(
  sheet: TableauSheetDoc,
  capturedVia: TableauWorkbookDoc['visualSource'],
): Record<string, unknown> | undefined {
  if (!sheet.luid && !sheet.visual) return undefined;
  const props: Record<string, unknown> = {};
  if (sheet.luid) props.luid = sheet.luid;
  if (sheet.visual) {
    const v = sheet.visual;
    const persisted: PersistedTableauVisual = {
      mark_class: v.markClass,
      mark_classes: v.markClasses,
      rows: v.rows,
      cols: v.cols,
      rows_raw: v.rowsRaw,
      cols_raw: v.colsRaw,
      encodings: v.encodings,
      filters: v.filters.map((f) => ({
        field: f.field,
        ...(f.filterClass !== undefined ? { filter_class: f.filterClass } : {}),
      })),
      // Task 6 fidelity backfill: explicit worksheet sort order, when the twb declared any.
      ...(v.sorts && v.sorts.length > 0
        ? {
            sorts: v.sorts.map((s) => ({
              field: s.field,
              ...(s.direction !== undefined ? { direction: s.direction } : {}),
            })),
          }
        : {}),
      captured_via: capturedVia,
    };
    props.visual = persisted;
  }
  return props;
}

/** Workbook `platform_properties` (Task 6 fidelity backfill) — snake_case `parameters`,
 *  one entry per `TableauParameterDoc`; undefined when the workbook declares none (never
 *  an empty array — mirrors sheet/dashboard platform_properties' undefined-when-absent
 *  convention). Controller ruling: this is catalog/brief/checklist fodder only — never a
 *  step toward emitting guessed `.lvdash.json` parameter JSON. */
function workbookPlatformProperties(doc: TableauWorkbookDoc): Record<string, unknown> | undefined {
  if (!doc.parameters || doc.parameters.length === 0) return undefined;
  return {
    parameters: doc.parameters.map((p: TableauParameterDoc): PersistedTableauParameter => ({
      name: p.name,
      ...(p.caption !== undefined ? { caption: p.caption } : {}),
      ...(p.datatype !== undefined ? { datatype: p.datatype } : {}),
      ...(p.currentValue !== undefined ? { current_value: p.currentValue } : {}),
      ...(p.allowableValues
        ? {
            allowable_values: {
              kind: p.allowableValues.kind,
              ...(p.allowableValues.values ? { values: p.allowableValues.values } : {}),
              ...(p.allowableValues.min !== undefined ? { min: p.allowableValues.min } : {}),
              ...(p.allowableValues.max !== undefined ? { max: p.allowableValues.max } : {}),
            },
          }
        : {}),
    })),
  };
}

/** A relation's table ref, catalog-filled-in from the owning connection descriptor when the
 *  ref itself doesn't carry one — a 2-part Tableau relation (`[SCHEMA].[TABLE]`, the common
 *  case for a single-database named connection) never states the database explicitly, but
 *  the connection's own `dbname`/`database.name` names it unambiguously (both modes: file
 *  mode's `dbname` attribute, live mode's Metadata API `database.name`). Without this, a
 *  binding ref can never resolve against a real (always fully-qualified) target-system asset
 *  — discovered during Task 5's live-vs-file parity work; applies uniformly to both modes. */
function withCatalog(
  parts: TableauTableParts,
  database: string | null | undefined,
): TableauTableParts {
  if (parts.catalog || !database) return parts;
  return { ...parts, catalog: database };
}

/** Relation-declared + calc-tokenizer-derived + (live-mode) API-declared upstream refs for
 *  one datasource's one connection, keyed by table FQN so every source merges onto the
 *  same ref instead of producing duplicate rows for the same table. */
function buildBindingRefs(
  ds: TableauDatasourceDoc,
  descriptor: BiDescriptor,
  tokByField: Map<string, TokenizeCalcResult>,
): BiBindingRef[] {
  const namedConnectionId = (descriptor.extra as Record<string, unknown> | null)?.[
    'named_connection'
  ] as string | undefined;
  const byKey = new Map<string, BiBindingRef>();

  for (const rel of ds.relations) {
    if (rel.kind !== 'table' || !rel.table || rel.connection !== namedConnectionId) continue;
    const parts = withCatalog(rel.table, descriptor.database);
    byKey.set(refKey(parts), { parts, via: 'declared' });
  }

  // Calc-tokenizer-derived column refs (coverage matrix: file mode's upstream columns are
  // "calc/tokenizer-derived only"): a calculated field whose formula resolves to a bare
  // reference to a *non-calculated* sibling field is retained as {bi_field, db_column} —
  // mechanical, no semantics (spec §2.3), and marked `method: 'expression_ref'` so the
  // stitcher materializes it at 0.85 (we derived it — the platform didn't declare it).
  // Attributed to the datasource's sole declared table relation; with zero or multiple
  // table relations there's no honest way to pick which table a field belongs to from
  // file-mode XML alone, so none is attached (no fabricated refs, spec §7 ethos).
  const soloKey = byKey.size === 1 ? [...byKey.keys()][0] : null;
  if (soloKey) {
    const solo = byKey.get(soloKey)!;
    const derivedCols: BindingColumnRef[] = [];
    for (const field of ds.fields) {
      if (!field.formula) continue;
      const refs = tokByField.get(field.name)?.refs ?? [];
      for (const ref of refs) {
        if (ref.ds) continue; // cross-datasource refs aren't this datasource's own column
        const target = ds.fields.find((f) => f.name === ref.field && !f.formula);
        if (target) {
          derivedCols.push({ bi_field: field.name, db_column: target.name, method: 'expression_ref' });
        }
      }
    }
    if (derivedCols.length > 0) {
      byKey.set(soloKey, { ...solo, columns: mergeColumns(solo.columns, derivedCols) });
    }
  }

  // Live-mode-only (Task 5): API-resolved upstream tables/columns for this connection.
  if (ds.upstream) {
    for (const t of ds.upstream.tables) {
      if (t.connection !== namedConnectionId) continue;
      const parts = withCatalog(t.parts, descriptor.database);
      const key = refKey(parts);
      if (!byKey.has(key)) byKey.set(key, { parts, via: 'declared' });
    }
    for (const c of ds.upstream.columns) {
      const key = refKey(withCatalog(c.table, descriptor.database));
      const existing = byKey.get(key);
      if (existing) {
        byKey.set(key, {
          ...existing,
          columns: mergeColumns(existing.columns, [{ bi_field: c.field, db_column: c.column }]),
        });
      }
    }
  }

  return [...byKey.values()];
}

export function mapTableauDocs(docs: TableauWorkbookDoc[], _mode: 'live' | 'file'): StagingBatch[] {
  const assets: StagingAssetRec[] = [];
  const columns: StagingColumnRec[] = [];
  const dependencies: StagingDependencyRec[] = [];
  const bindings: StagingBiBindingRec[] = [];
  const screenshots: StagingScreenshotRec[] = [];

  // Published datasources are pinned to the SITE-level namespace (schema null), never the
  // carrying workbook's project: live mode dedups a shared published DS into whichever
  // referencing workbook happened to arrive first, so inheriting that workbook's project
  // would make the DS's FQN (and binding identity, and other workbooks' sheet-dep
  // resolution) churn with reference ordering — and diverge from file mode, whose `.tds`
  // docs have no project context. This doc-set-wide name index also lets a sheet in a
  // DIFFERENT workbook (whose own doc no longer carries the deduped DS) resolve its ref
  // to the site-level FQN instead of falling back to its workbook's namespace.
  const publishedNames = new Set<string>();
  for (const doc of docs) {
    for (const d of doc.datasources) if (d.published) publishedNames.add(d.name);
  }

  for (const doc of docs) {
    const catalog = doc.site || 'default';
    const schemaName = doc.project || null;
    const wb = doc.name;

    assets.push({
      catalog, schemaName, name: wb, assetType: 'bi_workbook',
      platformProperties: workbookPlatformProperties(doc),
    });

    for (const dash of doc.dashboards) {
      const dashName = `${wb}/${dash.name}`;
      assets.push({
        catalog, schemaName, name: dashName, assetType: 'bi_dashboard',
        platformProperties: dashboardPlatformProperties(dash, doc.visualSource),
      });
      for (const sheetName of dash.sheetNames) {
        dependencies.push({
          fromCatalog: catalog, fromSchema: schemaName, fromName: dashName,
          toCatalog: catalog, toSchema: schemaName, toName: `${wb}/${sheetName}`,
          dependencyKind: 'bi_declared',
        });
      }
    }

    for (const sheet of doc.sheets) {
      const sheetName = `${wb}/${sheet.name}`;
      assets.push({
        catalog, schemaName, name: sheetName, assetType: 'bi_sheet',
        platformProperties: sheetPlatformProperties(sheet, doc.visualSource),
      });
      // Resolves a sheet's datasource ref to its dep target namespace: local embedded DS
      // → workbook namespace; local or cross-workbook published DS → site level (schema
      // null); anything else keeps the workbook's namespace (the historical fallback).
      const dsTarget = (dsRef: string): { schema: string | null; name: string } => {
        const ds = doc.datasources.find((d) => d.name === dsRef);
        if (ds) {
          return { schema: ds.published ? null : schemaName, name: datasourceObjectName(wb, ds) };
        }
        return { schema: publishedNames.has(dsRef) ? null : schemaName, name: dsRef };
      };
      for (const dsRef of sheet.datasourceRefs) {
        const target = dsTarget(dsRef);
        dependencies.push({
          fromCatalog: catalog, fromSchema: schemaName, fromName: sheetName,
          toCatalog: catalog, toSchema: target.schema, toName: target.name,
          dependencyKind: 'bi_declared',
        });
      }
      // Decision 6: sheet→field usage is ALSO emitted column-grain — one dep per used
      // field with toColumn set (to_column_id = the field on the datasource asset).
      // The asset-grain guards keep these out of traversal; they exist for field-level
      // impact analysis. Deduped: a field used twice in a sheet is one usage edge.
      const seenFieldRefs = new Set<string>();
      for (const ref of sheet.fieldRefs) {
        const key = `${ref.ds}::${ref.field}`;
        if (seenFieldRefs.has(key)) continue;
        seenFieldRefs.add(key);
        const target = dsTarget(ref.ds);
        dependencies.push({
          fromCatalog: catalog, fromSchema: schemaName, fromName: sheetName,
          toCatalog: catalog, toSchema: target.schema, toName: target.name,
          dependencyKind: 'bi_declared',
          toColumn: ref.field,
        });
      }
    }

    // Embedded `.twb` thumbnails (Task A4) → twb_thumbnail screenshot recs, typed by
    // whichever asset (dashboard preferred, then sheet) the thumbnail's name matches.
    // Opt-out mirrors collectVisuals' rest_image capture (spec §6): LINETRIA_BI_SCREENSHOTS
    // = 'off' skips capture in either mode.
    if (process.env.LINETRIA_BI_SCREENSHOTS !== 'off') {
      for (const t of doc.thumbnails ?? []) {
        const isDash = doc.dashboards.some((d) => d.name === t.name);
        const isSheet = !isDash && doc.sheets.some((s) => s.name === t.name);
        if (!isDash && !isSheet) continue;
        screenshots.push({
          catalog, schemaName, name: `${wb}/${t.name}`,
          assetType: isDash ? 'bi_dashboard' : 'bi_sheet',
          source: 'twb_thumbnail', contentType: 'image/png', base64: t.base64,
        });
      }
    }

    // Datasource-FQN lookup by internal name, for cross-datasource calc refs.
    const dsFqnByName = new Map<string, string>(
      doc.datasources.map((d) => [
        d.name,
        buildFqn(catalog, d.published ? null : schemaName, datasourceObjectName(wb, d)),
      ]),
    );

    for (const ds of doc.datasources) {
      const objectName = datasourceObjectName(wb, ds);
      const dsSchema = ds.published ? null : schemaName;
      const assetFqn = buildFqn(catalog, dsSchema, objectName);
      const customSql = ds.relations.filter((r) => r.kind === 'custom_sql' && r.sql);
      const definitionSql = customSql.length > 0 ? customSql.map((r) => r.sql).join(';\n') : null;

      // Tokenize each calc formula once; binding-ref derivation and the expression's
      // persisted classification (below) both read from this map.
      const tokByField = new Map<string, TokenizeCalcResult>(
        ds.fields.filter((f) => f.formula).map((f) => [f.name, tokenizeCalc(f.formula!)]),
      );

      assets.push({
        catalog, schemaName: dsSchema, name: objectName, assetType: 'bi_datasource',
        definitionSql, language: definitionSql ? 'sql' : null,
        platformProperties: {
          published: ds.published,
          connectionCount: ds.connections.length,
          // Server-side stable identity (live mode only) — retained for future
          // name-collision disambiguation across projects/sites.
          ...(ds.luid ? { luid: ds.luid } : {}),
          ...(customSql.length > 0
            ? { customSql: customSql.map((r) => ({ connection: r.connection, sql: r.sql })) }
            : {}),
        },
      });

      ds.fields.forEach((field, i) => {
        // spec §8 decision 3: caption/role/datatype ride platform_properties (datatype
        // additionally lands in data_type_raw, its structured home).
        const props: Record<string, unknown> = {};
        if (field.caption !== undefined) props.caption = field.caption;
        if (field.role !== undefined) props.role = field.role;
        if (field.datatype !== undefined) props.datatype = field.datatype;
        const col: StagingColumnRec = {
          catalog, schemaName: dsSchema, objectName, ordinal: i + 1,
          columnName: field.name,
          dataTypeRaw: field.datatype ?? null,
          isNullable: null,
          platformProperties: Object.keys(props).length > 0 ? props : null,
        };
        if (field.formula) {
          // Decision 3: the classification persists with the expression — derivation
          // types + refs from the tokenizer, parser_version = the tokenizer version.
          // inputRefs are same-asset column refs (the referenced sibling fields);
          // [DS].[Field] refs resolve against the doc's other datasources.
          const tok = tokByField.get(field.name)!;
          col.expression = {
            text: field.formula,
            language: 'tableau_calc',
            derivationTypes: tok.derivationType,
            inputRefs: tok.refs.map((ref) => {
              if (ref.ds) {
                const targetFqn = dsFqnByName.get(ref.ds);
                const target = doc.datasources.find((d) => d.name === ref.ds);
                const exists = target?.fields.some((f) => f.name === ref.field) ?? false;
                return {
                  asset_fqn: targetFqn ?? ref.ds.toLowerCase(),
                  column: ref.field,
                  resolution: targetFqn && exists ? 'exact' : 'unresolved',
                };
              }
              const exists = ds.fields.some((f) => f.name === ref.field);
              return {
                asset_fqn: assetFqn,
                column: ref.field,
                resolution: exists ? 'exact' : 'unresolved',
              };
            }),
            parserVersion: BI_CALC_PARSER_VERSION,
            flags: tok.flags,
          };
        }
        columns.push(col);
      });

      for (const descriptor of ds.connections) {
        bindings.push({
          assetFqn,
          assetType: 'bi_datasource',
          descriptor,
          normalizedKey: normalizeDescriptor(descriptor),
          refs: buildBindingRefs(ds, descriptor, tokByField),
        });
      }
    }
  }

  return [
    {
      pass: 'bi', assets, columns, dependencies, bindings,
      ...(screenshots.length > 0 ? { screenshots } : {}),
    },
  ];
}
