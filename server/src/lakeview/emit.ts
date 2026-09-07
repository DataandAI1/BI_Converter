import { createHash } from 'node:crypto';
import {
  LAKEVIEW_WIDGET_TYPES,
  LAKEVIEW_PARAMETER_FILTER_WIDGETS,
  lakeviewParameterForm,
  type LakeviewParameterJson,
  type LakeviewPosition,
} from './format.js';

/**
 * Pure `.lvdash.json` JSON builders for the Databricks AI/BI rebuild target (plan
 * 2026-08-10, Phase 3). Everything here is catalog-agnostic — no BI asset/column/binding
 * types, no pg, no file paths — so the JSON shapes can be unit-tested in isolation;
 * `rebuild-databricks.ts` owns turning catalog rows into these builders' inputs.
 *
 * Two rules bind every function below:
 *
 * - **Never emit a shape the pinned table can't back.** `spec.version` always comes from
 *   `LAKEVIEW_WIDGET_TYPES[widgetType].specVersion`, encoding channels are filtered
 *   against that entry's `encodings` list, and an unknown `widgetType` degrades to
 *   `table` rather than inventing a pin. `verified: false` entries may be emitted but
 *   always carry the standard review note.
 * - **Deterministic output.** `name` fields are the first 8 lowercase hex characters of a
 *   sha1 over (pack slug + a stable logical name), so re-running the pack over an
 *   unchanged catalog produces a byte-identical document and a clean diff.
 *
 * Not emitted, deliberately: `uiSettings` (the `genieSpace` shape is unverified in the
 * Phase-0 corpus — the rebuild checklist carries the Genie note instead) and `queryLines`
 * (dataset SQL ships as the verified plain-`query` string form).
 */

/* ------------------------------------------------------------- emitted shapes */

/** One `queries[].query.fields[]` entry: the output name and its SQL expression. */
export interface LakeviewQueryField {
  name: string;
  expression: string;
}

export interface LakeviewDatasetJson {
  name: string;
  displayName: string;
  query: string;
  /** Dashboard parameters live on the dataset (`:keyword` in its SQL) — present only when
   *  the rebuild declared any (corpus shape, pinned in lakeview-format.ts). */
  parameters?: LakeviewParameterJson[];
}

/** `queries[].query.parameters[]` — a widget query that binds a dataset parameter
 *  (rather than projecting fields). Corpus shape: `{name, keyword}`, both the keyword. */
export interface LakeviewQueryParameterRef {
  name: string;
  keyword: string;
}

export interface LakeviewWidgetSpec {
  version: number;
  widgetType: string;
  encodings: Record<string, unknown>;
  frame?: { showTitle: boolean; title: string };
}

export interface LakeviewWidgetJson {
  name: string;
  queries: Array<{
    name: string;
    query: {
      datasetName: string;
      /** Projected fields — every chart/table/field-filter query. */
      fields?: LakeviewQueryField[];
      /** Bound parameters — a parameter-filter widget's per-dataset query. */
      parameters?: LakeviewQueryParameterRef[];
      disaggregated: boolean;
    };
  }>;
  spec: LakeviewWidgetSpec;
}

export interface LakeviewLayoutEntry {
  widget: LakeviewWidgetJson;
  position: LakeviewPosition;
}

export interface LakeviewPageJson {
  name: string;
  displayName: string;
  pageType: 'PAGE_TYPE_CANVAS';
  layout: LakeviewLayoutEntry[];
}

export interface LakeviewDashboardJson {
  datasets: LakeviewDatasetJson[];
  pages: LakeviewPageJson[];
}

/* --------------------------------------------------------------- identifiers */

/** The single `queries[].name` this emitter uses; filter widgets' `encodings.fields[]`
 *  entries reference it by `queryName`, exactly as the corpus fixtures do. */
export const MAIN_QUERY = 'main_query';

/**
 * A deterministic Databricks-style id: 8 lowercase hex characters (the corpus convention
 * for `datasets[].name`, `pages[].name` and `layout[].widget.name`). Seeded with the pack
 * slug so the same logical name in two workbooks never collides.
 *
 * The separator must stay a printable ASCII string: a control byte here would make this
 * module a binary file to git (unreviewable diffs forever) and any tool that normalized
 * the byte would silently change every id in every emitted pack.
 */
export function lakeviewId(slug: string, logicalName: string): string {
  return createHash('sha1').update(`${slug}::${logicalName}`).digest('hex').slice(0, 8);
}

/* ------------------------------------------------------------------ datasets */

const backtick = (ident: string): string => `\`${ident.replace(/`/g, '``')}\``;

/**
 * One dataset: a read-only SELECT over the semantic layer's view for a datasource (AI/BI
 * datasets are SELECT-only — no DDL/DML). `columns` are physical column names; an empty
 * list falls back to `SELECT *` (the caller notes why it couldn't ground the projection).
 */
export function buildDataset(opts: {
  slug: string;
  /** Stable id seed — usually `dataset:<datasource label>`. */
  logicalName: string;
  displayName: string;
  /** Semantic-layer view name, unquoted. */
  view: string;
  columns: string[];
  /** Dashboard parameters to declare on this dataset (omitted from the JSON when empty). */
  parameters?: LakeviewParameterJson[];
}): LakeviewDatasetJson {
  const projection =
    opts.columns.length > 0
      ? `SELECT\n${opts.columns.map((c) => `  ${backtick(c)}`).join(',\n')}`
      : 'SELECT *';
  return {
    name: lakeviewId(opts.slug, opts.logicalName),
    displayName: opts.displayName,
    query: `${projection}\nFROM ${backtick(opts.view)}`,
    ...(opts.parameters && opts.parameters.length > 0 ? { parameters: opts.parameters } : {}),
  };
}

/* ------------------------------------------------------- parameter filter widgets */

/** The corpus's parameter-query naming: one query per dataset the widget drives. */
export const parameterQueryName = (datasetName: string, keyword: string): string =>
  `parameter_${datasetName}_${keyword}`;

/**
 * A `filter-*` widget bound to a dataset parameter on every dataset of the document —
 * the corpus shape: one `queries[]` entry per dataset carrying `parameters: [{name,
 * keyword}]` (no `fields`), and `encodings.fields[]` holding one `{parameterName,
 * queryName}` per query. The widget type comes from the pinned parameter-form →
 * widget table; a form with no pinned binding returns `null` (never a guessed widget).
 */
export function buildParameterFilterWidget(opts: {
  slug: string;
  logicalName: string;
  title: string;
  parameter: LakeviewParameterJson;
  datasetNames: string[];
}): LakeviewWidgetJson | null {
  const form = lakeviewParameterForm(opts.parameter.dataType, opts.parameter.complexType);
  const widgetType = LAKEVIEW_PARAMETER_FILTER_WIDGETS[form];
  const info = widgetType ? LAKEVIEW_WIDGET_TYPES[widgetType] : undefined;
  if (!widgetType || !info || opts.datasetNames.length === 0) return null;
  const keyword = opts.parameter.keyword;
  return {
    name: lakeviewId(opts.slug, opts.logicalName),
    queries: opts.datasetNames.map((datasetName) => ({
      name: parameterQueryName(datasetName, keyword),
      query: { datasetName, parameters: [{ name: keyword, keyword }], disaggregated: false },
    })),
    spec: {
      version: info.specVersion,
      widgetType,
      encodings: {
        fields: opts.datasetNames.map((datasetName) => ({
          parameterName: keyword,
          queryName: parameterQueryName(datasetName, keyword),
        })),
      },
      frame: { showTitle: true, title: opts.title },
    },
  };
}

/* ------------------------------------------------------------------- widgets */

export type LakeviewScaleType = 'quantitative' | 'categorical' | 'temporal';

/** One requested encoding binding. Channels the pinned table doesn't list for the widget
 *  type are dropped with a note rather than guessed onto the wire. */
export interface LakeviewChannel {
  channel: string;
  fieldName: string;
  displayName?: string;
  scaleType?: LakeviewScaleType;
}

export const unverifiedTypeNote = (widgetType: string): string =>
  `widget type '${widgetType}' pinned from docs, not from an exported fixture — verify rendering`;

/** Channels whose pinned shape is a LIST of field entries rather than a single binding
 *  (`table`/`pivot` columns+rows, the filter widgets' fields) — corpus-derived. */
const ARRAY_CHANNELS = new Set(['columns', 'fields', 'rows']);

/** What `buildWidget` produced, and what the caller has to say about it. `unverified` and
 *  `degradedFrom` are structured facts, not prose: a caller that needs to know whether the
 *  emitted type came from a docs pin (for the checklist's unverified worklist) reads the
 *  flag rather than substring-matching the human-readable notes. */
export interface BuiltWidget {
  widget: LakeviewWidgetJson;
  /** The emitted `spec.widgetType` is pinned from Databricks docs, not from an exported
   *  corpus fixture — its rendering still needs a human. */
  unverified: boolean;
  /** Set when the requested type was not in the pinned table at all and the widget was
   *  emitted as a `table` instead — the name the author actually asked for. */
  degradedFrom?: string;
  /** Every downgrade, dropped channel and unverified pin, in reader-facing prose. */
  notes: string[];
}

/**
 * One widget: a single `main_query` against `datasetName` plus a `spec` whose version and
 * legal channels come from the pinned table. Returns the notes the caller must surface
 * (unverified type, degraded type, dropped channel) — nothing is ever dropped silently.
 */
export function buildWidget(opts: {
  slug: string;
  /** Stable id seed — usually `widget:<dashboard>:<sheet>`. */
  logicalName: string;
  widgetType: string;
  datasetName: string;
  title?: string;
  fields: LakeviewQueryField[];
  channels: LakeviewChannel[];
  /** Tables render row-level results; charts aggregate at widget level (the default). */
  disaggregated?: boolean;
}): BuiltWidget {
  const notes: string[] = [];

  let widgetType = opts.widgetType;
  let degradedFrom: string | undefined;
  let info = LAKEVIEW_WIDGET_TYPES[widgetType];
  if (!info) {
    notes.push(
      `widget type '${widgetType}' is not in the pinned Lakeview format table — emitted as 'table' instead; rebuild this visual by hand`,
    );
    degradedFrom = widgetType;
    widgetType = 'table';
    info = LAKEVIEW_WIDGET_TYPES.table;
  }
  const unverified = !info.verified;
  if (unverified) notes.push(unverifiedTypeNote(widgetType));

  const allowed = new Set(info.encodings);
  const encodings: Record<string, unknown> = {};

  for (const ch of opts.channels) {
    const displayName = ch.displayName ?? ch.fieldName;
    if (!allowed.has(ch.channel)) {
      notes.push(
        `encoding channel '${ch.channel}' (field '${ch.fieldName}') is not a pinned channel for widget type '${widgetType}' — dropped; re-add it in the AI/BI editor if the visual needs it`,
      );
      continue;
    }
    if (widgetType === 'combo' && ch.channel === 'y') {
      // The corpus's combo y is a primary/secondary series holder, not a single binding.
      const existing = (encodings.y as { primary: { fields: unknown[] } } | undefined) ?? {
        primary: { fields: [] as unknown[] },
        scale: { type: 'quantitative' },
      };
      existing.primary.fields.push({ fieldName: ch.fieldName, displayName });
      encodings.y = existing;
      continue;
    }
    if (ARRAY_CHANNELS.has(ch.channel)) {
      const list = (encodings[ch.channel] as unknown[] | undefined) ?? [];
      list.push(
        ch.channel === 'fields'
          ? { fieldName: ch.fieldName, displayName, queryName: MAIN_QUERY }
          : { fieldName: ch.fieldName, displayName },
      );
      encodings[ch.channel] = list;
      continue;
    }
    if (encodings[ch.channel] !== undefined) {
      notes.push(
        `encoding channel '${ch.channel}' on widget type '${widgetType}' takes one field — '${ch.fieldName}' was dropped`,
      );
      continue;
    }
    // Corpus scalar channels carry `displayName` (nyc-taxi's x/y "Pickup Hour" /
    // "Number of Rides") — the axis label a reader sees instead of `sum(sls_amt)`.
    encodings[ch.channel] = {
      fieldName: ch.fieldName,
      displayName,
      ...(ch.scaleType ? { scale: { type: ch.scaleType } } : {}),
    };
  }

  const spec: LakeviewWidgetSpec = {
    version: info.specVersion,
    widgetType,
    encodings,
    ...(opts.title ? { frame: { showTitle: true, title: opts.title } } : {}),
  };

  return {
    widget: {
      name: lakeviewId(opts.slug, opts.logicalName),
      queries: [
        {
          name: MAIN_QUERY,
          query: {
            datasetName: opts.datasetName,
            fields: opts.fields,
            disaggregated: opts.disaggregated ?? false,
          },
        },
      ],
      spec,
    },
    unverified,
    ...(degradedFrom !== undefined ? { degradedFrom } : {}),
    notes,
  };
}

/* --------------------------------------------------------------------- pages */

/** One canvas page. `PAGE_TYPE_CANVAS` is the corpus's content-page type; the emitter
 *  never produces a `PAGE_TYPE_GLOBAL_FILTERS` page (filter widgets ride the canvas). */
export function buildPage(opts: {
  slug: string;
  /** Stable id seed — usually `page:<dashboard>:<index>`. */
  logicalName: string;
  displayName: string;
  layout: LakeviewLayoutEntry[];
}): LakeviewPageJson {
  return {
    name: lakeviewId(opts.slug, opts.logicalName),
    displayName: opts.displayName,
    pageType: 'PAGE_TYPE_CANVAS',
    layout: opts.layout,
  };
}

/* ---------------------------------------------------------------- zonesToGrid */

/** A captured Tableau dashboard zone: percentages 0–100 of the canvas (the shape
 *  `connectors/tableau/mapper.ts` writes to `platform_properties.layout.zones`). */
export interface GridZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Lakeview's grid is 12 columns wide (expanded from 6 in Feb 2026). */
export const GRID_COLUMNS = 12;
/** Grid rows are much finer than columns: a full-height zone is 12 × ROW_SCALE rows. */
const ROW_SCALE = 4;
const MIN_HEIGHT = 4;

/* Filter/parameter row geometry — filter and parameter-filter widgets take a band of
 * their own at the TOP of the canvas (they have no captured Tableau zone of their own),
 * and the charts below them are shifted down by the height of that band. Lives here, with
 * the rest of the grid vocabulary, rather than inside the emitter's dashboard loop. */
/** Columns one filter widget spans — 4 per row across the 12-column grid. */
export const FILTER_WIDTH = 3;
/** Rows one filter widget spans (the MIN_HEIGHT floor a zoned widget also gets). */
export const FILTER_HEIGHT = 4;
export const FILTERS_PER_ROW = 4;
/** Unpositioned widgets tile below everything else, two per row. */
const DEFAULT_WIDTH = 6;
const DEFAULT_HEIGHT = 8;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const usable = (z: GridZone | null | undefined): z is GridZone =>
  !!z &&
  [z.x, z.y, z.w, z.h].every((v) => typeof v === 'number' && Number.isFinite(v)) &&
  z.w > 0 &&
  z.h > 0;

function scaleZone(z: GridZone): LakeviewPosition {
  const width = clamp(Math.max(1, Math.round((z.w / 100) * GRID_COLUMNS)), 1, GRID_COLUMNS);
  const x = clamp(Math.round((z.x / 100) * GRID_COLUMNS), 0, GRID_COLUMNS - width);
  // Round against the FULL row count (12 × ROW_SCALE), not against 12 rows and then
  // scaled: rounding first threw away three quarters of the vertical resolution, so a
  // 10%-tall zone and a 12%-tall one landed on the same 4 rows.
  const height = Math.max(MIN_HEIGHT, Math.round((z.h / 100) * GRID_COLUMNS * ROW_SCALE));
  const y = Math.max(0, Math.round((z.y / 100) * GRID_COLUMNS * ROW_SCALE));
  return { x, y, width, height };
}

const overlaps = (a: LakeviewPosition, b: LakeviewPosition): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Percent zones → integer 12-column grid positions, one per input (index-aligned, so the
 * caller can zip them back onto its widgets).
 *
 * - `x`/`width` scale against 12 columns (width floors at 1, and the widget is nudged left
 *   rather than allowed to overflow the grid);
 * - `y`/`height` scale against the full `12 × ROW_SCALE` row viewport, because Lakeview's
 *   grid rows are far finer than its columns (height floors at 4);
 * - overlaps are resolved by pushing the later widget (reading order: top-left first, then
 *   input order) below whatever it collides with;
 * - a widget with no zone — or a zero-size/malformed one — is appended below everything
 *   else, two per row, rather than being given fabricated geometry.
 *
 * Fully deterministic: identical input always yields identical output.
 */
export function zonesToGrid(zones: Array<GridZone | null | undefined>): LakeviewPosition[] {
  const out: LakeviewPosition[] = new Array(zones.length);
  const placed: LakeviewPosition[] = [];

  const zoned = zones
    .map((z, index) => ({ index, position: usable(z) ? scaleZone(z) : null }))
    .filter((e): e is { index: number; position: LakeviewPosition } => e.position !== null)
    .sort((a, b) =>
      a.position.y - b.position.y || a.position.x - b.position.x || a.index - b.index,
    );

  for (const entry of zoned) {
    const pos = entry.position;
    // Push down until the widget clears every already-placed one. Each pass can only move
    // it further down, so this terminates (bounded by the number of placed widgets).
    for (;;) {
      const hits = placed.filter((p) => overlaps(pos, p));
      if (hits.length === 0) break;
      pos.y = Math.max(...hits.map((p) => p.y + p.height));
    }
    placed.push(pos);
    out[entry.index] = pos;
  }

  const baseY = placed.reduce((max, p) => Math.max(max, p.y + p.height), 0);
  let n = 0;
  for (let i = 0; i < zones.length; i++) {
    if (out[i] !== undefined) continue;
    out[i] = {
      x: (n % 2) * DEFAULT_WIDTH,
      y: baseY + Math.floor(n / 2) * DEFAULT_HEIGHT,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    };
    n += 1;
  }
  return out;
}
