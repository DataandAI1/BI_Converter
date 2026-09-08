import { type BiAssetRow, type BiEdgeRow, DATASOURCE_TYPES, displayName } from '../bi/grouping.js';
import { tokenizeCalc } from '../tableau/calc.js';
import {
  FILTER_HEIGHT,
  FILTER_WIDTH,
  FILTERS_PER_ROW,
  buildDataset,
  buildPage,
  buildParameterFilterWidget,
  buildWidget,
  zonesToGrid,
  type GridZone,
  type LakeviewChannel,
  type LakeviewDashboardJson,
  type LakeviewLayoutEntry,
  type LakeviewPageJson,
  type LakeviewQueryField,
  type LakeviewScaleType,
  type LakeviewWidgetJson,
} from '../lakeview/emit.js';
import {
  LAKEVIEW_PARAMETER_FILTER_WIDGETS,
  LAKEVIEW_WIDGET_TYPES,
  lakeviewParameterForm,
  type LakeviewParameterJson,
} from '../lakeview/format.js';
import { emitSemanticLayer } from './semantic-layer.js';
import { makeCalcTranslator } from './calc-translator.js';
import type { TableauSqlTranslation } from './tableau-sql.js';
import {
  AGG_SQL,
  DATE_TYPE,
  NUMERIC_TYPE,
  columnType,
  dimToken,
  grainSql,
  parseShelf,
  type ShelfToken,
} from './tableau-shelf.js';
import {
  renderRebuildChecklist,
  type ChecklistCalc,
} from './rebuild-databricks-checklist.js';
import type {
  PersistedTableauLayout,
  PersistedTableauParameter,
  PersistedTableauVisual,
} from '../tableau/mapper.js';
import {
  type BiBindingLite,
  type BiColumnRow,
  type BiDerivationRow,
  type BiManifestObject,
  Notes,
  claimPath,
  fieldKey,
  fileSafe,
  oneLine,
} from './shared.js';

/**
 * Databricks AI/BI rebuild target — Phase 3 (plan 2026-08-10): the "dashboard lane" of
 * the pack, the counterpart to `semantic-layer.ts`'s data lane and the same role in the
 * dispatcher role for the
 * Power BI → Tableau direction. Per Tableau workbook group this emits one deterministic
 * `.lvdash.json` per dashboard (datasets over the semantic layer's views, widgets mapped
 * from the captured `platform_properties.visual`, positions from the captured
 * `platform_properties.layout` zones), the pack-wide deploy artifacts
 * (`deploy_dashboards.py`, `databricks.yml`), a per-group `rebuild_checklist.md`, and —
 * folded into the same path-keyed files map — the semantic-layer files.
 *
 * Honesty rules inherited from the plan's global constraints: every JSON shape is backed
 * by `lakeview-format.ts`'s pinned table (never guessed); no calc is translated in this
 * phase (calcs land in the checklist verbatim with their `tokenizeCalc` classification);
 * every downgrade, dropped channel, unresolved field, page split and unverified widget
 * type becomes a manifest note or a checklist line; and nothing carries a credential —
 * the deploy script takes host/warehouse as arguments and authenticates from env vars.
 */

/* ------------------------------------------------------------------- context */

/** The emit context (convert.ts builds one
 *  object and hands it to whichever target emitter the dispatcher picked). */
export interface LakeviewGroupContext {
  files: Map<string, string>;
  objects: BiManifestObject[];
  edges: BiEdgeRow[];
  byId: Map<string, BiAssetRow>;
  columnsByAsset: Map<string, BiColumnRow[]>;
  derivationsByAsset: Map<string, BiDerivationRow[]>;
  bindingsByAsset: Map<string, BiBindingLite[]>;
}

/* --------------------------------------------------------------------- caps */

/** Emit-time caps (docs.databricks.com/aws/en/dashboards/limits). A cap bounds
 *  one DOCUMENT, not one report: a rebuild past a cap is split across several
 *  dashboards (splitLakeviewPages), never truncated. */
const MAX_PAGES = 15;
const MAX_WIDGETS_PER_PAGE = 100;
const MAX_DATASETS = 100;

/** How many pages early a document may close on a datasource seam. Mirrors
 *  forge's compiler/lakeview.py::_SEAM_SLACK — the two lanes split alike. */
const SEAM_SLACK = 2;

/**
 * Group pages into the fewest dashboards that each stay within the page and
 * dataset caps.
 *
 * Order is preserved, parts come out evenly sized rather than "15, 15, 3", and a
 * part prefers to close where the next page queries none of the data it already
 * holds — so a split follows the report's own seams instead of just counting to
 * fifteen. Deterministic: same pages in, same grouping out. This is the
 * TypeScript mirror of forge's compiler/lakeview.py::_partition; the two lanes
 * are meant to split the same report the same way.
 */
export function splitLakeviewPages(
  pages: LakeviewPageJson[],
  maxPages = MAX_PAGES,
  maxDatasets = MAX_DATASETS,
): LakeviewPageJson[][] {
  // Every query counts: a parameter-filter widget carries one query per dataset it drives.
  const datasetsOf = (page: LakeviewPageJson): Set<string> =>
    new Set(page.layout.flatMap((e) => e.widget.queries.map((q) => q.query.datasetName)));
  if (pages.length === 0) return [[]];
  const allDatasets = new Set(pages.flatMap((p) => [...datasetsOf(p)]));
  if (pages.length <= maxPages && allDatasets.size <= maxDatasets) return [pages];

  const nParts = Math.max(1, Math.ceil(pages.length / maxPages));
  const target = Math.ceil(pages.length / nParts);
  const seamFloor = Math.max(1, target - SEAM_SLACK);

  const parts: LakeviewPageJson[][] = [];
  let current: LakeviewPageJson[] = [];
  let held = new Set<string>();
  for (const page of pages) {
    const wants = datasetsOf(page);
    const merged = new Set([...held, ...wants]);
    const seam = current.length >= seamFloor && ![...wants].some((n) => held.has(n));
    if (current.length > 0 && (current.length >= target || merged.size > maxDatasets || seam)) {
      parts.push(current);
      current = [];
      held = new Set();
    }
    current.push(page);
    for (const n of wants) held.add(n);
  }
  if (current.length > 0) parts.push(current);

  // A seam can close a part early enough to leave a stub at the end; fold it
  // back when the part before it has room.
  if (parts.length > 1 && parts[parts.length - 1].length * 2 <= target) {
    const combined = [...parts[parts.length - 2], ...parts[parts.length - 1]];
    const names = new Set(combined.flatMap((p) => [...datasetsOf(p)]));
    if (combined.length <= maxPages && names.size <= maxDatasets) {
      parts.splice(parts.length - 2, 2, combined);
    }
  }
  return parts;
}

/* ------------------------------------------------------------ visual capture */

/* The persisted `platform_properties` sub-objects are read through the connector's own
 * exported contract (`PersistedTableauVisual` / `PersistedTableauLayout` /
 * `PersistedTableauParameter` in connectors/tableau/mapper.ts) rather than a local copy
 * of those shapes — the writer and the reader now share one declaration. */

const visualOf = (a: BiAssetRow): PersistedTableauVisual | null =>
  ((a.platform_properties ?? {}).visual as PersistedTableauVisual | undefined) ?? null;

const layoutOf = (a: BiAssetRow): PersistedTableauLayout | null =>
  ((a.platform_properties ?? {}).layout as PersistedTableauLayout | undefined) ?? null;

const parametersOf = (a: BiAssetRow): PersistedTableauParameter[] =>
  ((a.platform_properties ?? {}).parameters as PersistedTableauParameter[] | undefined) ?? [];

/* -------------------------------------------------------------- parameters */

/** Tableau parameter datatype → the pinned AI/BI dataset-parameter `dataType`. A type the
 *  corpus never showed (boolean) has no entry and stays checklist-only. */
const PARAMETER_DATA_TYPES: Record<string, LakeviewParameterJson['dataType']> = {
  string: 'STRING',
  integer: 'INTEGER',
  real: 'DECIMAL',
  date: 'DATE',
  datetime: 'DATETIME',
};

interface ParameterPlan {
  raw: PersistedTableauParameter;
  name: string;
  /** The dataset parameter to declare, or null when the plan is checklist-only. */
  json: LakeviewParameterJson | null;
  /** Pinned filter widget type for the parameter's form, or null (declared, unbound). */
  widgetType: string | null;
  /** Why nothing, or no widget, was emitted — one line for the checklist. */
  reason: string | null;
}

/** Tableau writes a string parameter's value inside its own quotes (`"Sales"`) and a
 *  date's inside hashes (`#2024-01-01#`); the wire value is the bare literal. */
function parameterLiteral(value: string, dataType: LakeviewParameterJson['dataType']): string {
  let v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
  else if (v.length >= 2 && v.startsWith('#') && v.endsWith('#')) v = v.slice(1, -1);
  if (dataType === 'DATETIME') v = v.replace(' ', 'T');
  return v;
}

/** The snake_case keyword dataset SQL references as `:keyword`, unique across the workbook
 *  (`_2`… suffixes) so two parameters can never share one binding. */
function parameterKeyword(name: string, taken: Set<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base || /^[0-9]/.test(base)) base = `p_${base}`;
  let keyword = base;
  for (let n = 2; taken.has(keyword); n++) keyword = `${base}_${n}`;
  taken.add(keyword);
  return keyword;
}

/**
 * Every workbook parameter becomes a plan: emitted as a dataset parameter (corpus shape,
 * pinned in lakeview-format.ts) whenever its Tableau datatype maps onto a pinned AI/BI
 * type and it carries a current value to default from; bound to a filter widget whenever
 * the corpus binds that parameter form to one. Anything else is declared honestly as
 * checklist-only with its reason — never a guessed shape.
 */
function planParameters(raw: PersistedTableauParameter[]): ParameterPlan[] {
  const taken = new Set<string>();
  return raw.map((p) => {
    const name = p.name ?? '(unnamed)';
    const dataType = p.datatype ? PARAMETER_DATA_TYPES[p.datatype.toLowerCase()] : undefined;
    if (!dataType) {
      return {
        raw: p, name, json: null, widgetType: null,
        reason: `datatype '${p.datatype ?? 'unknown'}' has no pinned AI/BI parameter type`,
      };
    }
    if (p.current_value === undefined || p.current_value === null) {
      return {
        raw: p, name, json: null, widgetType: null,
        reason: 'no current value was captured, and an AI/BI parameter needs a default',
      };
    }
    const keyword = parameterKeyword(name, taken);
    const json: LakeviewParameterJson = {
      displayName: keyword,
      keyword,
      dataType,
      defaultSelection: {
        values: { dataType, values: [{ value: parameterLiteral(p.current_value, dataType) }] },
      },
    };
    const widgetType = LAKEVIEW_PARAMETER_FILTER_WIDGETS[lakeviewParameterForm(dataType)] ?? null;
    return {
      raw: p, name, json, widgetType,
      reason: widgetType
        ? null
        : `the corpus never binds a ${dataType} parameter to a filter widget, so it is declared on the datasets only`,
    };
  });
}

/* ---------------------------------------------------------- datasource facts */

interface DatasourceFacts {
  id: string;
  /** The datasource's fully-qualified name — the dataset id seed. Two datasources can
   *  share a display label (an embedded copy of a published datasource); their fqns are
   *  distinct, and a dataset `name` collision inside one document is unrecoverable. */
  fqn: string;
  label: string;
  /** bi field key → physical column name. */
  physicalByField: Map<string, string>;
  /** Physical column key (and, as a fallback, the Tableau field key) → the catalog's
   *  `data_type_canonical`, lowercased. Decides whether a continuous shelf token can be
   *  summed and which filter widget a quantitative filter becomes. */
  typeByColumn: Map<string, string>;
  /** Same keys → the field's caption, for channel `displayName`s. */
  captionByColumn: Map<string, string>;
  /** Field keys that are calculated fields. */
  calcFields: Map<string, BiDerivationRow>;
  /** Memoized Tableau-calc → SQL translation over this datasource's types and calcs. */
  translate: (formula: string) => TableauSqlTranslation | null;
  /** Semantic-layer view this datasource's dataset selects from. */
  view: string;
  /** True when no relation was found and `view` is a best-effort placeholder name. */
  viewIsGuess: boolean;
  /** Physical columns the bindings retained, in binding order. */
  boundColumns: string[];
}

/**
 * `view` is NOT re-derived here: it is the name `emitSemanticLayer` reported for this
 * datasource (`viewsByDatasource`), which is the name it actually wrote into the emitted
 * `CREATE OR REPLACE VIEW`. One derivation for both lanes — a dataset's `FROM` can never
 * drift from the view file the pack ships. `null` means the semantic layer emitted no
 * view at all, and the dataset falls back to a placeholder name it reports as a guess.
 */
function factsOf(
  ctx: LakeviewGroupContext,
  top: BiAssetRow,
  ds: BiAssetRow,
  view: string | null,
): DatasourceFacts {
  const label = displayName(top, ds);
  const bindings = ctx.bindingsByAsset.get(ds.id) ?? [];
  const physicalByField = new Map<string, string>();
  const boundColumns: string[] = [];
  for (const b of bindings) {
    for (const r of b.refs ?? []) {
      for (const c of r.columns ?? []) {
        const key = fieldKey(c.bi_field);
        if (!physicalByField.has(key)) physicalByField.set(key, c.db_column);
        if (!boundColumns.includes(c.db_column)) boundColumns.push(c.db_column);
      }
    }
  }
  const calcFields = new Map<string, BiDerivationRow>();
  for (const d of ctx.derivationsByAsset.get(ds.id) ?? []) {
    // A row with no recorded language is a Tableau calc (older mapper rows leave it
    // null) — the same predicate the checklist and semantic-layer.ts use, so one calc is
    // never a calc in one lane and a phantom physical column in another.
    if (d.language && d.language !== 'tableau_calc') continue;
    calcFields.set(fieldKey(d.output_name), d);
  }
  // Catalog types/captions, keyed by BOTH the physical column and the Tableau field name:
  // a shelf token knows the field, a resolved widget field knows the column.
  const typeByColumn = new Map<string, string>();
  const captionByColumn = new Map<string, string>();
  for (const c of ctx.columnsByAsset.get(ds.id) ?? []) {
    const key = fieldKey(c.name);
    const caption =
      ((c.platform_properties ?? {}).caption as string | undefined) ??
      c.name.replace(/^\[|\]$/g, '');
    const physical = physicalByField.get(key) ?? physicalByField.get(fieldKey(caption));
    // The canonical taxonomy has no `datetime` (Tableau's most common date type
    // canonicalizes to 'other'), so fall back to the raw Tableau datatype whenever the
    // canonical one carries no information — otherwise every datetime column would
    // miss the temporal branch of the shelf and filter oracles.
    const canonical = c.data_type_canonical?.toLowerCase();
    const type =
      canonical && canonical !== 'other' ? canonical : c.data_type_raw?.toLowerCase() ?? null;
    for (const k of [physical ? fieldKey(physical) : null, key]) {
      if (!k) continue;
      if (type && !typeByColumn.has(k)) typeByColumn.set(k, type);
      if (!captionByColumn.has(k)) captionByColumn.set(k, caption);
    }
  }
  const translator = makeCalcTranslator({
    columns: ctx.columnsByAsset.get(ds.id) ?? [],
    derivations: ctx.derivationsByAsset.get(ds.id) ?? [],
    physicalByField,
  });
  return {
    id: ds.id,
    fqn: ds.fqn,
    label,
    physicalByField,
    typeByColumn,
    captionByColumn,
    calcFields,
    translate: translator.translate,
    view: view ?? label,
    viewIsGuess: view === null,
    boundColumns,
  };
}

/* ------------------------------------------------------------ widget mapping */

const DIRECT_MARKS: Record<string, string> = {
  bar: 'bar',
  line: 'line',
  area: 'area',
  pie: 'pie',
  circle: 'scatter',
  shape: 'scatter',
  square: 'scatter',
  text: 'table',
  gantt: 'gantt',
  ganttbar: 'gantt',
};

const FILLED_MAP_MARKS = new Set(['map', 'polygon', 'multipolygon', 'filled map']);
const GEO_FIELD_RE = /^(latitude|longitude|lat|long|lon)( \(generated\))?$/i;

interface MarkDecision {
  widgetType: string;
  note?: string;
}

/** Tableau mark class(es) + shelf shape → a pinned Lakeview widget type. Widens where
 *  AI/BI is richer than the mark vocabulary (dual axis → combo, single KPI → counter,
 *  square-over-two-dims → heatmap) and only ever falls back to `table`. */
function widgetTypeFor(
  markClasses: string[],
  dims: ShelfToken[],
  measures: ShelfToken[],
): MarkDecision {
  const marks = markClasses.map((m) => m.toLowerCase()).filter(Boolean);
  const mark = marks[0] ?? 'automatic';

  if (marks.length >= 2 && marks.includes('bar') && marks.includes('line')) {
    return { widgetType: 'combo' };
  }
  if (FILLED_MAP_MARKS.has(mark)) return { widgetType: 'choropleth-map' };
  const geoFields = [...dims, ...measures].filter((t) => GEO_FIELD_RE.test(t.field));
  if (geoFields.length >= 2) return { widgetType: 'point-map' };
  if (measures.length === 1 && dims.length === 0) return { widgetType: 'counter' };
  if (mark === 'square' && dims.length >= 2) return { widgetType: 'heatmap' };
  if (DIRECT_MARKS[mark]) return { widgetType: DIRECT_MARKS[mark] };
  return {
    widgetType: 'table',
    note: `mark class '${mark}' could not be mapped to an AI/BI chart type — emitted as a table; pick the right visualization in the AI/BI editor`,
  };
}

/* -------------------------------------------------------------- field naming */

interface ResolvedField {
  /** `queries[].query.fields[].name` — the widget-side handle. */
  name: string;
  expression: string;
  scaleType: LakeviewScaleType;
  /** Human label for the channel binding — the column's caption when the catalog has one,
   *  else the Tableau field name. */
  displayName: string;
}

/** One shelf/encoding token → its dataset field + expression, or null when the token is a
 *  calculated field (never translated in this phase — the checklist carries it). */
function resolveToken(
  token: ShelfToken,
  facts: DatasourceFacts,
  notes: Notes,
  sheetLabel: string,
): ResolvedField | null {
  if (token.measurePlaceholder) {
    notes.review.push(
      `${sheetLabel}: Measure Names/Values shelf is not supported — pick the measures in the editor`,
    );
    return null;
  }
  const key = fieldKey(token.field);
  const label = (column: string): string =>
    facts.captionByColumn.get(fieldKey(column)) ??
    facts.captionByColumn.get(key) ??
    token.field.replace(/^\[|\]$/g, '');
  // A shelf-level caveat (ATTR(), an ISO date part) applies whether the field turns out
  // to be a physical column or a calculation — report it before branching.
  if (token.note) notes.review.push(`${sheetLabel}: ${token.note}`);
  const calc = facts.calcFields.get(key);
  if (calc) {
    // Phase 4: try the deterministic Tableau-calc → Databricks SQL tier before giving up
    // on the field. On success the calc's SQL rides the widget's own field expression
    // (evaluated by Lakeview against the dataset's raw columns, the same mechanism a
    // plain shelf aggregation already uses) — the underlying physical columns it
    // references get pulled into the dataset SELECT automatically via the existing
    // backtick-column extraction in the caller. On null, existing behavior exactly.
    const translated = facts.translate(calc.expression_sql);
    if (translated) {
      const types = calc.derivation_type ?? tokenizeCalc(calc.expression_sql).derivationType;
      const isAggregate = types.includes('aggregation');
      notes.info.push(
        `${sheetLabel}: field '${token.field}' is a Tableau calculation, translated: ${oneLine(calc.expression_sql)} → ${translated.sql}`,
      );
      // A row-level translated calc dropped on a shelf that itself requests an
      // aggregation (`sum:NetCalc:qk`) still needs that aggregation wrapped around it —
      // same as a plain physical column would. A calc whose OWN formula already
      // aggregates (SUM(...) inside the calc) is used exactly as translated; wrapping it
      // again would double-aggregate.
      if (!isAggregate && token.isMeasure && token.agg) {
        if (token.aggDefaulted) {
          notes.review.push(
            `${sheetLabel}: field '${token.field}' is on a continuous axis but its shelf aggregation ('${token.prefix ?? 'none'}') has no Databricks SQL equivalent here — defaulted to SUM; set the right aggregation in the AI/BI editor`,
          );
        }
        return {
          name: `${token.agg}(calc:${key})`,
          expression: AGG_SQL[token.agg](translated.sql),
          scaleType: 'quantitative',
          displayName: label(key),
        };
      }
      // A date grain requested on the shelf applies to the calc's own result the same way
      // it applies to a physical column — dropping it would plot the wrong grain.
      if (token.grain && !isAggregate) {
        return {
          name: `${token.grain.label}(calc:${key})`,
          expression: grainSql(token.grain, translated.sql),
          scaleType: token.grain.kind === 'trunc' ? 'temporal' : 'categorical',
          displayName: label(key),
        };
      }
      return {
        name: `calc(${key})`,
        expression: translated.sql,
        scaleType: isAggregate ? 'quantitative' : 'categorical',
        displayName: label(key),
      };
    }
    notes.review.push(
      `${sheetLabel}: field '${token.field}' is a Tableau calculation — no expression was emitted for it (see the calculation inventory in rebuild_checklist.md)`,
    );
    return null;
  }
  const physical = facts.physicalByField.get(key);
  if (!physical) {
    notes.review.push(
      `${sheetLabel}: field '${token.field}' has no matched physical column — the widget expression falls back to the raw Tableau field name; verify it exists on the dataset`,
    );
  }
  const column = physical ?? token.field;
  const quoted = `\`${column.replace(/`/g, '``')}\``;
  const displayName = label(column);
  // A date grain is part of the field's IDENTITY, not a formatting choice: `yearly(d)` and
  // `monthly(d)` are two different query fields over one column, and `pushField` dedups by
  // name, so the grain has to be in the name for both to survive on one sheet.
  if (token.grain) {
    return {
      name: `${token.grain.label}(${column})`,
      expression: grainSql(token.grain, quoted),
      scaleType: token.grain.kind === 'trunc' ? 'temporal' : 'categorical',
      displayName,
    };
  }
  if (token.isMeasure && token.agg) {
    if (token.aggDefaulted) {
      notes.review.push(
        `${sheetLabel}: field '${token.field}' is on a continuous axis but its shelf aggregation ('${token.prefix ?? 'none'}') has no Databricks SQL equivalent here — defaulted to SUM; set the right aggregation in the AI/BI editor`,
      );
    }
    return {
      name: `${token.agg}(${column})`,
      expression: AGG_SQL[token.agg](quoted),
      scaleType: 'quantitative',
      displayName,
    };
  }
  return {
    name: column,
    expression: quoted,
    scaleType: token.dimensionScale,
    displayName,
  };
}

/* ---------------------------------------------------------------- widget plan */

interface WidgetPlan {
  /** Stable id seed. */
  logicalName: string;
  widgetType: string;
  title?: string;
  dsId: string;
  fields: LakeviewQueryField[];
  channels: LakeviewChannel[];
  disaggregated?: boolean;
  /** The widget type the mark actually asked for, when it had no pinned encodings and was
   *  emitted as a table instead — the checklist still lists it as unverified. */
  unverifiedType?: string;
  /** Matching zone in the dashboard's captured layout, when there is one. */
  zone?: GridZone;
  /** Manifest object this widget's notes belong to (the sheet), when it has one. */
  sheet?: BiAssetRow;
  /** Filter widgets take the canvas's top row; charts are laid out from their zones. */
  isFilter?: boolean;
  notes: Notes;
}

/** Adds a field to the plan once (a field used on two channels rides one query field). */
function pushField(plan: WidgetPlan, field: ResolvedField): void {
  if (!plan.fields.some((f) => f.name === field.name)) {
    plan.fields.push({ name: field.name, expression: field.expression });
  }
}

/** A mark encoding's field, as a token. On an AGGREGATED widget a numeric encoding column
 *  cannot ride the query as a bare column — every other field is grouped, so an ungrouped
 *  one makes the query invalid — so it is summed, and says the aggregation was assumed
 *  (the Tableau capture does not record the encoding's own aggregation). */
function encodingToken(field: string, facts: DatasourceFacts, aggregated: boolean): ShelfToken {
  const base = dimToken(field);
  const type = columnType(field, facts);
  if (!aggregated || !type || !NUMERIC_TYPE.test(type)) return base;
  return {
    ...base,
    isMeasure: true,
    agg: 'sum',
    note: `mark encoding on '${field}' is a numeric column — aggregation assumed (the capture does not carry the encoding's aggregation); set the right one in the AI/BI editor`,
  };
}

/** Tableau mark encoding channel → the pinned Lakeview channel it belongs on. Only these
 *  two have a home on the chart types this emitter produces; every other channel
 *  (`size`, `tooltip`, `detail`, `shape`) is reported rather than guessed onto the wire. */
function encodingChannel(raw: string | undefined): string | null {
  const c = (raw ?? '').toLowerCase();
  if (c === 'color') return 'color';
  if (c === 'text' || c === 'label') return 'label';
  return null;
}

function planForSheet(
  sheet: BiAssetRow,
  sheetLabel: string,
  facts: DatasourceFacts,
  edges: BiEdgeRow[],
  dashboardLabel: string,
): WidgetPlan {
  const notes = new Notes();
  const plan: WidgetPlan = {
    logicalName: `widget:${dashboardLabel}:${sheetLabel}`,
    widgetType: 'table',
    title: sheetLabel,
    dsId: facts.id,
    fields: [],
    channels: [],
    sheet,
    notes,
  };

  const visual = visualOf(sheet);
  if (!visual) {
    // No visual capture: fall back to the fields the sheet's column-grain usage edges
    // name, as a table. Never fabricated as a chart.
    const used: string[] = [];
    for (const e of edges) {
      if (e.from_asset_id !== sheet.id || !e.to_column_name) continue;
      if (!used.includes(e.to_column_name)) used.push(e.to_column_name);
    }
    for (const name of used) {
      const field = resolveToken(
        dimToken(name),
        facts,
        notes,
        sheetLabel,
      );
      if (!field) continue;
      pushField(plan, field);
      plan.channels.push({ channel: 'columns', fieldName: field.name, displayName: field.displayName });
    }
    plan.disaggregated = true;
    notes.review.push(
      used.length > 0
        ? `${sheetLabel}: no visual capture — emitted as a table of the ${used.length} field(s) the sheet uses; pick the right visualization in the AI/BI editor`
        : `${sheetLabel}: no visual capture and no recorded field usage — an empty table widget holds its place; rebuild this sheet by hand`,
    );
    return plan;
  }

  // Sorts (Task 6): checklist guidance only, never emitted onto the dataset/widget JSON —
  // the sheet-level note flows into the dashboard's checklist section (the plan loop below
  // funnels plan.notes.review into dashNotes.review → rebuild_checklist.md's Needs review).
  const sheetSorts = (visual.sorts ?? []).filter((s) => s.field);
  if (sheetSorts.length > 0) {
    const sortDesc = sheetSorts.map((s) => `${s.field}${s.direction ? ` ${s.direction}` : ''}`).join(', ');
    notes.review.push(
      `${sheetLabel}: sheet sorts by ${sortDesc} — apply sort in dataset SQL ORDER BY or widget sort — verify`,
    );
  }

  const marks = (visual.mark_classes ?? []).filter(Boolean);
  const markClasses = marks.length > 0 ? marks : visual.mark_class ? [visual.mark_class] : [];
  const parsed = [
    ...parseShelf(visual.cols_raw, facts).map((t) => ({ token: t, shelf: 'cols' as const })),
    ...parseShelf(visual.rows_raw, facts).map((t) => ({ token: t, shelf: 'rows' as const })),
  ];
  if (parsed.length === 0) {
    // Shelves captured only as resolved names (no raw text) — treat each as a dimension,
    // on the shelf it was actually captured on (rows on `rows`, or the chart loses its
    // y axis entirely).
    for (const name of visual.cols ?? []) parsed.push({ token: dimToken(name), shelf: 'cols' });
    for (const name of visual.rows ?? []) parsed.push({ token: dimToken(name), shelf: 'rows' });
    if (parsed.length > 0) {
      notes.review.push(
        `${sheetLabel}: shelf capture carries no aggregation detail — every field was treated as a dimension; check the aggregations in the AI/BI editor`,
      );
    }
  }

  // `[Measure Names]` / `[Measure Values]` / `[Multiple Values]` are shelf placeholders for
  // "whichever measures this sheet shows", not columns — emitting one would produce a
  // dataset SELECT that does not run.
  if (parsed.some((t) => t.token.measurePlaceholder)) {
    notes.review.push(
      `${sheetLabel}: Measure Names/Values shelf is not supported — pick the measures in the editor`,
    );
  }
  const tokens = parsed.filter((t) => !t.token.measurePlaceholder);

  const dims = tokens.filter((t) => !t.token.isMeasure).map((t) => t.token);
  const measures = tokens.filter((t) => t.token.isMeasure).map((t) => t.token);
  const decision = widgetTypeFor(markClasses, dims, measures);
  plan.widgetType = decision.widgetType;
  if (decision.note) notes.review.push(`${sheetLabel}: ${decision.note}`);

  // An unverified type with NO pinned encoding channels (choropleth-map, point-map,
  // gantt…) would render an empty widget: every field would be dropped for want of a
  // channel to hang it on. A table shows the same data and says what was intended.
  const chosen = LAKEVIEW_WIDGET_TYPES[plan.widgetType];
  if (chosen && !chosen.verified && chosen.encodings.length === 0) {
    plan.unverifiedType = plan.widgetType;
    notes.review.push(
      `${sheetLabel}: ${plan.widgetType} has no pinned encodings — emitted as a table; rebuild as ${plan.widgetType} in the editor`,
    );
    plan.widgetType = 'table';
  }

  const colTokens = tokens.filter((t) => t.shelf === 'cols').map((t) => t.token);
  const rowTokens = tokens.filter((t) => t.shelf === 'rows').map((t) => t.token);

  /** Tokens a channel took (bound or attempted) — anything left over is reported. */
  const claimed = new Set<ShelfToken>();
  const bind = (channel: string, token: ShelfToken | undefined): ResolvedField | null => {
    if (!token) return null;
    claimed.add(token);
    const field = resolveToken(token, facts, notes, sheetLabel);
    if (!field) return null;
    pushField(plan, field);
    plan.channels.push({
      channel,
      fieldName: field.name,
      displayName: field.displayName,
      scaleType: field.scaleType,
    });
    return field;
  };

  switch (plan.widgetType) {
    case 'table':
      for (const t of tokens) {
        claimed.add(t.token);
        const field = resolveToken(t.token, facts, notes, sheetLabel);
        if (!field) continue;
        pushField(plan, field);
        plan.channels.push({ channel: 'columns', fieldName: field.name, displayName: field.displayName });
      }
      plan.disaggregated = measures.length === 0;
      break;
    case 'counter':
      bind('value', measures[0]);
      break;
    case 'pie':
      bind('angle', measures[0]);
      bind('color', dims[0]);
      break;
    case 'combo':
      bind('x', colTokens.find((t) => !t.isMeasure) ?? colTokens[0]);
      for (const m of measures) bind('y', m);
      if (measures.length > 1) {
        notes.review.push(
          `${sheetLabel}: ${measures.length} measures share one combo widget — secondary axis collapsed onto the primary axis; re-split the axes in the AI/BI editor`,
        );
      }
      break;
    default:
      bind('x', colTokens.find((t) => !t.isMeasure) ?? colTokens[0] ?? dims[0]);
      // Never the token x just took: two measures on Columns and nothing on Rows would
      // otherwise plot SUM(Sales) against itself, silently.
      bind(
        'y',
        rowTokens.find((t) => t.isMeasure && !claimed.has(t)) ??
          rowTokens.find((t) => !claimed.has(t)) ??
          measures.find((m) => !claimed.has(m)),
      );
      break;
  }

  const pinnedChannels = new Set(LAKEVIEW_WIDGET_TYPES[plan.widgetType]?.encodings ?? []);
  const encodingClaims = new Set(
    (visual.encodings ?? [])
      .filter((e) => e.field)
      .map((e) => encodingChannel(e.channel))
      .filter((c): c is string => c !== null),
  );

  // A nested second dimension has a real home on most chart types: `color`. Bind it there
  // when the type pins the channel and neither the mark's own colour encoding nor the
  // widget's primary channels already own it.
  if (
    plan.widgetType !== 'table' &&
    pinnedChannels.has('color') &&
    !encodingClaims.has('color') &&
    !plan.channels.some((c) => c.channel === 'color')
  ) {
    const spare = tokens.find((t) => !claimed.has(t.token) && !t.token.isMeasure);
    if (spare) bind('color', spare.token);
  }

  // Whatever is still unbound is a field the source sheet showed and this widget does
  // not — never silently.
  if (plan.widgetType !== 'table') {
    for (const t of tokens) {
      if (claimed.has(t.token)) continue;
      notes.review.push(
        `${sheetLabel}: field '${t.token.field}' on the ${t.shelf} shelf has no AI/BI channel on a ${plan.widgetType} widget — re-add it in the editor`,
      );
    }
  }

  // Mark-level encodings. `color` and `text`→`label` have pinned homes on the chart types
  // this emitter produces; the rest are reported rather than guessed onto a channel.
  for (const enc of visual.encodings ?? []) {
    if (!enc.field) continue;
    const channel = encodingChannel(enc.channel);
    if (!channel || !pinnedChannels.has(channel)) {
      notes.info.push(
        `${sheetLabel}: mark encoding '${enc.channel ?? '?'}' (field '${enc.field}') has no pinned AI/BI channel — re-apply it in the editor if the visual needs it`,
      );
      continue;
    }
    bind(channel, encodingToken(enc.field, facts, plan.disaggregated !== true));
  }

  return plan;
}

/**
 * Captured `filter_class` (+ the filtered column's catalog type) → the pinned filter
 * widget type. All five field-filter types plus `range-slider` are corpus-verified, so
 * matching the control to the filter is free fidelity; only the SELECTION is lost (the
 * Tableau capture carries no predicate), which every filter reports.
 */
function filterWidgetType(filterClass: string | undefined, type: string | null): string {
  switch ((filterClass ?? '').toLowerCase()) {
    case 'categorical':
      return 'filter-multi-select';
    case 'quantitative':
      if (type && NUMERIC_TYPE.test(type)) return 'range-slider';
      if (type && DATE_TYPE.test(type)) return 'filter-date-range-picker';
      return 'filter-single-select';
    case 'relative-date':
      return 'filter-date-range-picker';
    default:
      return 'filter-single-select';
  }
}

/* ------------------------------------------------------------------ main emit */

interface DashboardTarget {
  /** The asset the emitted `.lvdash.json` represents (a dashboard, or the workbook when
   *  it has sheets but no dashboard). */
  asset: BiAssetRow;
  label: string;
  sheets: BiAssetRow[];
  zonesBySheet: Map<string, GridZone>;
}

/**
 * One Tableau workbook group (workbook + its dashboards/sheets/datasources) → a
 * deterministic AI/BI rebuild pack. Mutates `ctx.files`/`ctx.objects` in place, the same
 * contract the group emitters share.
 */
export function emitTableauGroupAsLakeview(
  ctx: LakeviewGroupContext,
  top: BiAssetRow,
  own: BiAssetRow[],
  slug: string,
): void {
  const members = [top, ...own];
  const datasources = members.filter((a) => DATASOURCE_TYPES.has(a.asset_type));
  const dashboards = members.filter((a) => a.asset_type === 'bi_dashboard');
  const sheets = members.filter((a) => a.asset_type === 'bi_sheet');

  // ---- data lane: the semantic layer, folded into the shared path-keyed files map.
  // That merge is what dedups semantic_layer/extract_rescue.py across groups.
  const semantic = emitSemanticLayer(ctx, { top, own, slug });
  for (const f of semantic.files) ctx.files.set(f.path, f.content);

  const factsById = new Map<string, DatasourceFacts>();
  for (const ds of datasources) {
    factsById.set(ds.id, factsOf(ctx, top, ds, semantic.viewsByDatasource.get(ds.id) ?? null));
  }

  // Widget order, dataset order, split boundaries and `_2` filename suffixes are all read
  // off this list, so it is sorted here exactly the way `loadBiEdges` sorts it in SQL —
  // the pack's bytes then depend on the catalog's content, never on row arrival order.
  const edges = [...ctx.edges].sort(
    (a, b) =>
      a.from_asset_id.localeCompare(b.from_asset_id) ||
      a.to_asset_id.localeCompare(b.to_asset_id) ||
      (a.to_column_id ?? '').localeCompare(b.to_column_id ?? ''),
  );

  // ---- containment: dashboard → sheets, sheet → datasource (asset-grain edges).
  const sheetsByDashboard = new Map<string, BiAssetRow[]>();
  const dsIdsBySheet = new Map<string, string[]>();
  const dsBySheet = new Map<string, string>();
  const sheetById = new Map(sheets.map((s) => [s.id, s]));
  for (const e of edges) {
    if (e.to_column_id) continue;
    const child = sheetById.get(e.to_asset_id);
    if (child && dashboards.some((d) => d.id === e.from_asset_id)) {
      const list = sheetsByDashboard.get(e.from_asset_id) ?? [];
      if (!list.includes(child)) list.push(child);
      sheetsByDashboard.set(e.from_asset_id, list);
      continue;
    }
    const to = ctx.byId.get(e.to_asset_id);
    if (sheetById.has(e.from_asset_id) && to && DATASOURCE_TYPES.has(to.asset_type)) {
      const list = dsIdsBySheet.get(e.from_asset_id) ?? [];
      if (!list.includes(to.id)) list.push(to.id);
      dsIdsBySheet.set(e.from_asset_id, list);
    }
  }
  // A widget reads exactly one AI/BI dataset, so a blended sheet is scaffolded against
  // its first datasource — and says so rather than quietly dropping the others.
  for (const [sheetId, ids] of dsIdsBySheet) dsBySheet.set(sheetId, ids[0]);

  const placedSheets = new Set([...sheetsByDashboard.values()].flat().map((s) => s.id));
  const targets: DashboardTarget[] = dashboards.map((d) => {
    const zonesBySheet = new Map<string, GridZone>();
    for (const z of layoutOf(d)?.zones ?? []) {
      if (!z.sheet_name) continue;
      if (typeof z.x !== 'number' || typeof z.y !== 'number' || typeof z.w !== 'number' || typeof z.h !== 'number') continue;
      if (!zonesBySheet.has(z.sheet_name)) zonesBySheet.set(z.sheet_name, { x: z.x, y: z.y, w: z.w, h: z.h });
    }
    return {
      asset: d,
      label: displayName(top, d),
      sheets: sheetsByDashboard.get(d.id) ?? [],
      zonesBySheet,
    };
  });
  // A workbook of loose worksheets (no dashboard) still deserves a dashboard file rather
  // than nothing — one page holding every unplaced sheet.
  const orphans = sheets.filter((s) => !placedSheets.has(s.id));
  if (orphans.length > 0) {
    targets.push({ asset: top, label: displayName(top, top), sheets: orphans, zonesBySheet: new Map() });
  }

  /* ------------------------------------------------ per-dashboard emission */

  // Workbook parameters are planned once and declared on every dashboard's datasets.
  const parameterPlans = planParameters(parametersOf(top));
  const declaredParameters = parameterPlans.flatMap((p) => (p.json ? [p.json] : []));

  const groupNotes = new Notes();
  /** Every review note the checklist's worklist section carries (dashboard-level notes
   *  live on their own manifest objects; the checklist is the one human-readable view of
   *  all of them). */
  const checklistReview: string[] = [];
  const unverifiedTypes = new Set<string>();
  const dashboardPaths: string[] = [];
  const emittedSheets = new Set<string>();

  /** One manifest object per SHEET, not per (dashboard, sheet): a sheet placed on three
   *  dashboards is still one thing to review. Notes merge, the file is the first dashboard
   *  that carried it, and the status is the worst of them (`Notes.status()` gives that for
   *  free once the notes are pooled). Flushed after the dashboard loop. */
  interface SheetEntry {
    sheet: BiAssetRow;
    file: string | null;
    notes: Notes;
  }
  const sheetEntries = new Map<string, SheetEntry>();
  const claimSheet = (sheet: BiAssetRow, file: string | null): Notes => {
    const existing = sheetEntries.get(sheet.id);
    if (existing) {
      if (existing.file === null) existing.file = file;
      return existing.notes;
    }
    const entry: SheetEntry = { sheet, file, notes: new Notes() };
    sheetEntries.set(sheet.id, entry);
    return entry.notes;
  };

  for (const target of targets) {
    const dashNotes = new Notes();
    const plans: WidgetPlan[] = [];

    // Filter widgets first: they own the top row of the canvas.
    const filterSeen = new Set<string>();
    for (const sheet of target.sheets) {
      const sheetLabel = displayName(top, sheet);
      const dsId = dsBySheet.get(sheet.id) ?? datasources[0]?.id;
      const facts = dsId ? factsById.get(dsId) : undefined;
      if (!facts) continue;
      for (const f of visualOf(sheet)?.filters ?? []) {
        if (!f.field) continue;
        const key = `${facts.id}::${fieldKey(f.field)}`;
        if (filterSeen.has(key)) continue;
        filterSeen.add(key);
        const notes = new Notes();
        const field = resolveToken(
          dimToken(f.field),
          facts,
          notes,
          sheetLabel,
        );
        if (!field) {
          dashNotes.review.push(...notes.review);
          continue;
        }
        // The Tableau capture records the KIND of filter but not its predicate, so the
        // widget is the right control starting from an unfiltered state — and says so.
        notes.review.push(
          `${target.label}: filter on '${f.field}' — the source filter's selection was not captured; ` +
            'the widget starts unfiltered, set the original selection',
        );
        plans.push({
          logicalName: `filter:${target.label}:${facts.label}:${f.field}`,
          widgetType: filterWidgetType(f.filter_class, columnType(f.field, facts)),
          title: f.field,
          dsId: facts.id,
          fields: [{ name: field.name, expression: field.expression }],
          channels: [{ channel: 'fields', fieldName: field.name, displayName: field.displayName }],
          isFilter: true,
          notes,
        });
      }
    }

    for (const sheet of target.sheets) {
      const sheetLabel = displayName(top, sheet);
      const dsId = dsBySheet.get(sheet.id) ?? datasources[0]?.id;
      const facts = dsId ? factsById.get(dsId) : undefined;
      if (!facts) {
        claimSheet(sheet, null).review.push(
          `${sheetLabel}: no datasource is bound to this sheet — no widget could be emitted`,
        );
        emittedSheets.add(sheet.id);
        continue;
      }
      let plan: WidgetPlan;
      try {
        plan = planForSheet(sheet, sheetLabel, facts, edges, target.label);
      } catch (err) {
        // One sheet the planner cannot handle is one checklist line, not a lost
        // dashboard: the other sheets still get their widgets.
        claimSheet(sheet, null).review.push(
          `${sheetLabel}: could not be converted — ${err instanceof Error ? err.message : String(err)}; ` +
            'no widget was emitted for it (report this with the workbook)',
        );
        emittedSheets.add(sheet.id);
        continue;
      }
      if (!dsBySheet.has(sheet.id)) {
        // No datasource edge at all: the widget is scaffolded against the group's first
        // datasource, which is a guess about which columns this sheet reads.
        plan.notes.review.push(
          `${sheetLabel}: no datasource is recorded for this sheet — it was scaffolded against '${facts.label}'; verify the fields resolve against that datasource`,
        );
      }
      const blended = dsIdsBySheet.get(sheet.id) ?? [];
      if (blended.length > 1) {
        plan.notes.review.push(
          `${sheetLabel}: the sheet reads ${blended.length} datasources — the widget was scaffolded against '${facts.label}' only; model the blend as a join in the dataset SQL`,
        );
      }
      const zone = target.zonesBySheet.get(sheetLabel);
      if (zone) plan.zone = zone;
      else if (target.zonesBySheet.size > 0) {
        plan.notes.info.push(
          `${sheetLabel}: no zone matched this sheet in the captured dashboard layout — the widget was appended below the placed ones`,
        );
      }
      plans.push(plan);
    }

    if (plans.length === 0) {
      const empty = `${target.label}: no sheets are attached to this dashboard — nothing to emit`;
      // The group's own top-level asset always gets exactly one manifest object, added
      // once at the end; anything else reports here.
      if (target.asset.id === top.id) groupNotes.review.push(empty);
      else {
        ctx.objects.push({
          fqn: target.asset.fqn, asset_type: target.asset.asset_type, system: target.asset.system_name,
          file: null, status: 'needs_review', notes: [empty],
        });
      }
      continue;
    }

    // ---- datasets: one per datasource the widgets actually read, projecting the columns
    // those widgets reference (falling back to the datasource's bound columns).
    const usedByDs = new Map<string, string[]>();
    for (const plan of plans) {
      const cols = usedByDs.get(plan.dsId) ?? [];
      for (const f of plan.fields) {
        for (const m of f.expression.matchAll(/`((?:[^`]|``)*)`/g)) {
          const col = m[1].replace(/``/g, '`');
          if (!cols.includes(col)) cols.push(col);
        }
      }
      usedByDs.set(plan.dsId, cols);
    }
    // No dataset cap applied here: the cap bounds one emitted DOCUMENT, and a
    // report needing more datasets than one dashboard allows is split across
    // several below (each carrying only the datasets its own pages query)
    // rather than losing the widgets that read the extras.
    // Every plan contributed its own `dsId` to `usedByDs` above, so this list already
    // covers every plan — no plan can be dropped for want of a dataset.
    const dsIds = [...usedByDs.keys()];
    const datasetNameByDs = new Map<string, string>();
    const datasets = dsIds.map((dsId) => {
      const facts = factsById.get(dsId)!;
      const columns = usedByDs.get(dsId) ?? [];
      if (facts.viewIsGuess) {
        dashNotes.review.push(
          `${facts.label}: no table or custom SQL relation was retained — the dataset selects from a view named '${facts.view}' that the semantic layer did not emit; create it or repoint the dataset`,
        );
      }
      if (columns.length === 0) {
        dashNotes.review.push(
          `${facts.label}: no widget field could be grounded — the dataset falls back to SELECT *`,
        );
      }
      const dataset = buildDataset({
        slug,
        // Seeded from the fqn, never the display label: an embedded copy of a published
        // datasource shows the same label, and two datasets with one `name` in a document
        // is a broken dashboard.
        logicalName: `dataset:${facts.fqn}`,
        displayName: facts.label,
        view: facts.view,
        columns: columns.length > 0 ? columns : facts.boundColumns,
        parameters: declaredParameters,
      });
      datasetNameByDs.set(dsId, dataset.name);
      return dataset;
    });

    // ---- widgets + positions. Filters take a row of their own at the top; charts are
    // placed from their captured zones and pushed below the filter row.
    const filterPlans = plans.filter((p) => p.isFilter);
    const chartPlans = plans.filter((p) => !p.isFilter);

    // ---- parameter widgets share the filter row. Each one drives its parameter on the
    // datasets the FIRST page's widgets query (the page it sits on): binding the whole
    // dashboard's datasets would make that page look like it queries all of them and
    // push a big report past the dataset cap for no reason.
    const boundPlans = parameterPlans.filter((p) => p.json && p.widgetType);
    const firstPageCharts = chartPlans.slice(
      0,
      Math.max(0, MAX_WIDGETS_PER_PAGE - boundPlans.length - filterPlans.length),
    );
    const firstPageDatasets = new Set(
      [...filterPlans, ...firstPageCharts].map((p) => datasetNameByDs.get(p.dsId)!),
    );
    const parameterDatasetNames = datasets.map((d) => d.name).filter((n) => firstPageDatasets.has(n));
    const parameterWidgets: LakeviewWidgetJson[] = [];
    for (const plan of parameterPlans) {
      if (!plan.json) continue;
      const widget = plan.widgetType
        ? buildParameterFilterWidget({
            slug,
            logicalName: `parameter:${target.label}:${plan.json.keyword}`,
            title: plan.raw.caption ?? plan.name,
            parameter: plan.json,
            datasetNames: parameterDatasetNames,
          })
        : null;
      if (widget) parameterWidgets.push(widget);
      dashNotes.review.push(
        `${target.label}: parameter ':${plan.json.keyword}' (Tableau '${plan.name}') is declared on ` +
          `${datasets.length} dataset(s)` +
          (widget
            ? ` and bound to a ${plan.widgetType} widget`
            : ` with no filter widget (${plan.reason ?? 'no dataset on the first page to bind'})`) +
          ` — no dataset SQL references it yet; use :${plan.json.keyword} where the Tableau ` +
          `calculations used [Parameters].[${plan.name}]`,
      );
    }

    const filterSlots = parameterWidgets.length + filterPlans.length;
    const filterRows = Math.ceil(filterSlots / FILTERS_PER_ROW);
    const filterOffset = filterRows * FILTER_HEIGHT;
    const slotPosition = (slot: number) => ({
      x: (slot % FILTERS_PER_ROW) * FILTER_WIDTH,
      y: Math.floor(slot / FILTERS_PER_ROW) * FILTER_HEIGHT,
      width: FILTER_WIDTH,
      height: FILTER_HEIGHT,
    });
    const chartPositions = zonesToGrid(chartPlans.map((p) => p.zone));

    const entries: LakeviewLayoutEntry[] = parameterWidgets.map((widget, i) => ({
      widget,
      position: slotPosition(i),
    }));
    [...filterPlans, ...chartPlans].forEach((plan, i) => {
      const built = buildWidget({
        slug,
        logicalName: plan.logicalName,
        widgetType: plan.widgetType,
        datasetName: datasetNameByDs.get(plan.dsId)!,
        title: plan.title,
        fields: plan.fields,
        channels: plan.channels,
        disaggregated: plan.disaggregated,
      });
      for (const n of built.notes) plan.notes.review.push(`${plan.title ?? plan.logicalName}: ${n}`);
      // A field bound to two channels reports the same gap twice — say it once.
      plan.notes.review = [...new Set(plan.notes.review)];
      plan.notes.info = [...new Set(plan.notes.info)];
      if (built.unverified) unverifiedTypes.add(built.widget.spec.widgetType);
      // A type that lost its widget to the table fallback (no pinned encodings) still
      // belongs on the unverified worklist under the name the author asked for.
      if (plan.unverifiedType) unverifiedTypes.add(plan.unverifiedType);
      // A filter widget has no sheet of its own to hang notes on — they belong to the
      // dashboard (a sheet's notes ride its own manifest object, added below).
      if (!plan.sheet) {
        dashNotes.review.push(...plan.notes.review);
        dashNotes.info.push(...plan.notes.info);
      }
      const position =
        i < filterPlans.length
          ? slotPosition(parameterWidgets.length + i)
          : (() => {
              const p = chartPositions[i - filterPlans.length];
              return { ...p, y: p.y + filterOffset };
            })();
      entries.push({ widget: built.widget, position });
    });

    // ---- pages: chunk on the widgets-per-page cap, then the pages-per-dashboard cap.
    const chunks: LakeviewLayoutEntry[][] = [];
    for (let i = 0; i < entries.length; i += MAX_WIDGETS_PER_PAGE) {
      chunks.push(entries.slice(i, i + MAX_WIDGETS_PER_PAGE));
    }
    if (chunks.length > 1) {
      dashNotes.review.push(
        `${target.label}: ${entries.length} widgets exceed the ${MAX_WIDGETS_PER_PAGE}-widget page limit — split across ${chunks.length} pages`,
      );
    }
    const pages: LakeviewPageJson[] = chunks.map((layout, i) => {
      // Each page starts at the top of its own canvas.
      const minY = layout.reduce((m, e) => Math.min(m, e.position.y), Number.POSITIVE_INFINITY);
      const shift = Number.isFinite(minY) ? minY : 0;
      return buildPage({
        slug,
        logicalName: `page:${target.label}:${i + 1}`,
        displayName: chunks.length === 1 ? target.label : `${target.label} (${i + 1})`,
        layout: layout.map((e) => ({
          widget: e.widget,
          position: { ...e.position, y: e.position.y - shift },
        })),
      });
    });

    // ---- documents: a dashboard holds at most MAX_PAGES pages and MAX_DATASETS
    // datasets, so a report past either cap becomes SEVERAL dashboards rather
    // than a truncated one. Pages keep their order; each document declares only
    // the datasets its own pages query.
    const documents = splitLakeviewPages(pages, MAX_PAGES, MAX_DATASETS);
    if (documents.length > 1) {
      dashNotes.review.push(
        `${target.label}: ${pages.length} page(s) and ${datasets.length} dataset(s) exceed what one ` +
          `AI/BI dashboard holds (${MAX_PAGES} pages, ${MAX_DATASETS} datasets) — split into ` +
          `${documents.length} dashboards, imported separately`,
      );
      if (filterPlans.length > 0) {
        // Filters were laid out on the first page, so only the first document
        // carries them — say so rather than let them look lost.
        dashNotes.review.push(
          `${target.label}: the filter widgets sit on the first page, so only the first of the ` +
            `${documents.length} dashboards has them — re-add filters to the others in the AI/BI editor`,
        );
      }
    }
    // An unsplit rebuild keeps the filename it has always had. A split one
    // numbers EVERY document, first included — no file may look like the whole
    // dashboard when it is a fraction of one. The manifest object can name only
    // one, so it points at the first and the notes list them all.
    let file = '';
    const partPaths: string[] = [];
    documents.forEach((docPages, i) => {
      // "part N of M" rather than "(N of M)": fileSafe() turns parentheses into
      // underscores, and the deploy scripts fall back to this filename for a
      // dashboard with no page title — a trailing `_` would ride into the workspace.
      const name =
        documents.length === 1
          ? target.label
          : `${target.label} part ${i + 1} of ${documents.length}`;
      // Filtering the ORIGINAL list (rather than collecting names off the
      // widgets) keeps dataset order stable, so an unsplit rebuild emits the
      // same bytes it always has — the golden corpus compares them.
      const queried = new Set(
        docPages.flatMap((p) => p.layout.flatMap((e) => e.widget.queries.map((q) => q.query.datasetName))),
      );
      const doc: LakeviewDashboardJson = {
        datasets: documents.length === 1 ? datasets : datasets.filter((d) => queried.has(d.name)),
        pages: docPages,
      };
      const path = claimPath(ctx.files, `${slug}/dashboards/${fileSafe(name)}.lvdash.json`);
      ctx.files.set(path, JSON.stringify(doc, null, 2) + '\n');
      dashboardPaths.push(path);
      partPaths.push(path);
      if (i === 0) file = path;
    });

    for (const plan of plans) {
      if (!plan.sheet) continue;
      emittedSheets.add(plan.sheet.id);
      const mine = claimSheet(plan.sheet, file);
      mine.review.push(...plan.notes.review);
      mine.info.push(...plan.notes.info);
      for (const n of plan.notes.review) dashNotes.review.push(n);
    }
    // A dashboard is only 'ready' when every widget on it mapped exactly and every dataset
    // is clean — a widget-level review note is a dashboard-level review note.
    dashNotes.info.push(
      `${pages.length} page(s), ${entries.length} widget(s), ${datasets.length} dataset(s)` +
        (documents.length > 1 ? ` across ${documents.length} dashboard files` : ''),
    );
    // The manifest object can name one file; a split rebuild has more, and the
    // reader needs all of them to have the whole report.
    if (partPaths.length > 1) dashNotes.info.push(`files: ${partPaths.join(', ')}`);
    // Every dashboard-level review note is also a checklist line — the manifest is the
    // machine-readable view, rebuild_checklist.md is the human worklist.
    checklistReview.push(...dashNotes.review);
    if (target.asset.id !== top.id) {
      ctx.objects.push({
        fqn: target.asset.fqn, asset_type: target.asset.asset_type, system: target.asset.system_name,
        file,
        // A split rebuild's other documents are not decoration: without them the manifest
        // reader has a fraction of the report and no way to know it.
        ...(partPaths.length > 1 ? { parts: partPaths } : {}),
        status: dashNotes.status(), notes: dashNotes.all(),
      });
    } else {
      // The group's top asset stands in for this dashboard, so its manifest object (added
      // once at the end) is the only place these notes can land — review notes included,
      // or a workbook could read 'ready' while its own .lvdash.json needed review.
      groupNotes.review.push(...dashNotes.review);
      groupNotes.info.push(...dashNotes.info);
    }
  }

  for (const entry of sheetEntries.values()) {
    ctx.objects.push({
      fqn: entry.sheet.fqn, asset_type: entry.sheet.asset_type, system: entry.sheet.system_name,
      file: entry.file, status: entry.notes.status(), notes: [...new Set(entry.notes.all())],
    });
  }

  for (const sheet of sheets) {
    if (emittedSheets.has(sheet.id)) continue;
    ctx.objects.push({
      fqn: sheet.fqn, asset_type: sheet.asset_type, system: sheet.system_name,
      file: null, status: 'needs_review',
      notes: [`${displayName(top, sheet)}: no widget was emitted for this sheet — rebuild it by hand`],
    });
  }

  /* ------------------------------------------------------------- checklist */

  const calcs: ChecklistCalc[] = [];
  const translatedCalcNotes: string[] = [];
  for (const ds of datasources) {
    const facts = factsById.get(ds.id)!;
    for (const d of ctx.derivationsByAsset.get(ds.id) ?? []) {
      if (d.language && d.language !== 'tableau_calc') continue;
      const types = d.derivation_type ?? tokenizeCalc(d.expression_sql).derivationType;
      // Phase 4: a calc that translates end-to-end no longer needs porting by hand — it
      // drops off this checklist and surfaces instead as an info note (downgraded from
      // the review-worthy "port by hand" TODO it would otherwise be).
      const translated = facts.translate(d.expression_sql);
      if (translated) {
        translatedCalcNotes.push(
          `${facts.label}: '${d.output_name.replace(/^\[|\]$/g, '')}' translated: ${oneLine(d.expression_sql)} → ${translated.sql}`,
        );
        continue;
      }
      calcs.push({
        ds: facts.label,
        name: d.output_name.replace(/^\[|\]$/g, ''),
        formula: d.expression_sql,
        classification: types.join(', '),
      });
    }
  }
  groupNotes.info.push(...translatedCalcNotes);

  // Parameters land on the checklist worklist AND as needs_review notes here: the
  // generated SQL never references `:keyword` on its own, so the substitution is the
  // reader's job. These notes are pooled into `reviewNotes` below, so they reach the
  // checklist's own "Needs review" section too.
  for (const p of parameterPlans) {
    groupNotes.review.push(
      p.json
        ? `workbook parameter '${p.name}' emitted as dataset parameter ':${p.json.keyword}' — ` +
            `reference it in the dataset SQL where the Tableau calculations used [Parameters].[${p.name}]`
        : `workbook parameter '${p.name}' not emitted (${p.reason}) — recreate it as an AI/BI ` +
            'dashboard parameter by hand',
    );
  }

  const reviewNotes = [
    ...new Set([...checklistReview, ...groupNotes.review, ...semantic.notes.review]),
  ];

  const checklistFile = `${slug}/rebuild_checklist.md`;
  ctx.files.set(
    checklistFile,
    renderRebuildChecklist({
      workbookName: top.name,
      slug,
      dashboardPaths,
      unverifiedTypes: [...unverifiedTypes],
      translatedCalcNotes,
      calcs,
      parameterPlans,
      reviewNotes,
    }),
  );

  /* -------------------------------------------------------- manifest objects */

  // Semantic-layer notes are prefixed with the datasource's display label by
  // emitSemanticLayer; that prefix is how each datasource object claims its own notes.
  // The group's own top-level asset is skipped here — it always gets exactly one object
  // (below), even when the group IS a standalone published datasource.
  // A datasource's manifest file is the metric view emitSemanticLayer ACTUALLY returned —
  // never a reconstructed path. The semantic layer skips the metric view entirely for a
  // datasource with no relation, and claimPath suffixes `_2` when two datasources share a
  // fileSafe label; guessing the path produces manifest entries pointing at files the pack
  // does not contain. Paths are consumed in datasource order (the same order the semantic
  // layer emitted them in), so the `_2` sibling lands on the second claimant.
  const metricViewPool = semantic.files
    .map((f) => f.path)
    .filter((p) => p.startsWith(`${slug}/metric_views/`));
  const claimedPrefixes: string[] = [];
  for (const ds of datasources) {
    const facts = factsById.get(ds.id)!;
    if (ds.id === top.id) continue;
    claimedPrefixes.push(`${facts.label}: `);
    const stem = `${slug}/metric_views/${fileSafe(facts.label)}`;
    const at = metricViewPool.findIndex((p) => p === `${stem}.yaml` || /^_\d+\.yaml$/.test(p.slice(stem.length)));
    const file = at === -1 ? null : metricViewPool.splice(at, 1)[0];
    const mine = new Notes();
    mine.review.push(...semantic.notes.review.filter((n) => n.startsWith(`${facts.label}: `)));
    mine.info.push(...semantic.notes.info.filter((n) => n.startsWith(`${facts.label}: `)));
    ctx.objects.push({
      fqn: ds.fqn, asset_type: ds.asset_type, system: ds.system_name,
      file, status: mine.status(), notes: mine.all(),
    });
  }

  const unclaimed = (n: string): boolean => !claimedPrefixes.some((p) => n.startsWith(p));
  const topNotes = new Notes();
  topNotes.review.push(...groupNotes.review, ...semantic.notes.review.filter(unclaimed));
  topNotes.info.push(
    ...groupNotes.info,
    ...semantic.notes.info.filter(unclaimed),
    `${dashboardPaths.length} dashboard file(s), ${datasources.length} datasource(s)`,
  );
  ctx.objects.push({
    fqn: top.fqn, asset_type: top.asset_type, system: top.system_name,
    file: checklistFile, status: topNotes.status(), notes: topNotes.all(),
  });
}
