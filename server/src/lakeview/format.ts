/**
 * Pinned Databricks AI/BI (Lakeview) `.lvdash.json` widget format table (rebuild-plan
 * Task 0 — the ground-truth harness later JSON emitter phases build against). `.lvdash.json`
 * is officially undocumented, so every VERIFIED entry below is derived from real dashboards
 * Databricks itself publishes in its public GitHub repos — never guessed. The golden corpus
 * lives at `server/test/fixtures/lakeview/` (provenance + fetch dates in that directory's
 * README.md); `server/test/unit/lakeview-format.test.ts`'s tripwire test fails if any
 * fixture uses a `(widgetType, spec.version)` pair not pinned here — that's the mechanism
 * that catches Databricks format drift.
 *
 * Entries NOT backed by a fixture are still listed (so callers have one stable place to look
 * up any widget type) but carry `verified: false` — their `specVersion`/`encodings` are
 * best-effort from `docs.databricks.com/aws/en/dashboards/{visualization-types,filters}`,
 * never a wire capture. Later phases (JSON emitters) must treat `verified: false` entries as
 * `needs_review`, the same convention `migration/bi/shared.ts`'s `Notes`/`ObjectStatus` use
 * elsewhere in this codebase for "scaffolded, not machine-verified" output.
 *
 * This table is the ONE source of truth, but it is consumed from two languages: forge's
 * Python compiler/validator read a hand-maintained JSON mirror at
 * `forge/tableauforge/spec/lakeview_widget_types.json`. Any edit to LAKEVIEW_WIDGET_TYPES
 * below must be mirrored into that file — `server/test/unit/lakeview-format-mirror.test.ts`
 * deep-equals the two and fails otherwise.
 *
 * Two findings from building the corpus that don't fit the table shape below (full write-up
 * in server/test/fixtures/lakeview/README.md and the task-0 report):
 *
 * - `text` widgets carry NO `spec` object at all — no `widgetType`, no `version`. Two
 *   incompatible shapes coexist in the wild: `textbox_spec` (a bare markdown string) and
 *   `multilineTextboxSpec: { lines: string[] }`. `specVersion: 0` below is an explicit
 *   sentinel meaning "no version was ever observed," not a captured value.
 * - the "range slider" field filter's wire string is `range-slider` — no `filter-` prefix,
 *   unlike its four siblings. Pinned as observed, not normalized to match the others.
 */

/** Widget geometry from `pages[].layout[].position` (12-column grid, post-Feb-2026 layout —
 *  positions are integer cell coordinates, not pixels). */
export interface LakeviewPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LakeviewWidgetTypeInfo {
  /** `spec.version` for this `widgetType`, pinned from the golden corpus when `verified`. */
  specVersion: number;
  /** Top-level keys of `spec.encodings` observed for this widget type. Empty for
   *  unverified entries — no fixture exists to derive them from. */
  encodings: string[];
  /** true when at least one golden-corpus fixture (server/test/fixtures/lakeview/) actually
   *  contains this exact (widgetType, specVersion) pair; false when the entry is a
   *  docs-derived placeholder that has never been observed on the wire. */
  verified: boolean;
}

/** `widgetType` string → pinned spec shape. See the file header for the `text` and
 *  `range-slider` special cases. */
export const LAKEVIEW_WIDGET_TYPES: Record<string, LakeviewWidgetTypeInfo> = {
  // ---- verified against server/test/fixtures/lakeview/ ----
  area: { specVersion: 3, encodings: ['color', 'x', 'y'], verified: true },
  bar: { specVersion: 3, encodings: ['color', 'extra', 'label', 'x', 'y'], verified: true },
  combo: { specVersion: 1, encodings: ['x', 'y'], verified: true },
  counter: { specVersion: 2, encodings: ['target', 'value'], verified: true },
  heatmap: { specVersion: 3, encodings: ['color', 'label', 'x', 'y'], verified: true },
  line: { specVersion: 3, encodings: ['color', 'label', 'x', 'y'], verified: true },
  pie: { specVersion: 3, encodings: ['angle', 'color', 'label'], verified: true },
  pivot: { specVersion: 3, encodings: ['cell', 'columns', 'rows'], verified: true },
  scatter: { specVersion: 3, encodings: ['color', 'x', 'y'], verified: true },
  table: { specVersion: 1, encodings: ['columns'], verified: true },
  'filter-date-picker': { specVersion: 2, encodings: ['fields'], verified: true },
  'filter-date-range-picker': { specVersion: 2, encodings: ['fields'], verified: true },
  'filter-multi-select': { specVersion: 2, encodings: ['fields'], verified: true },
  'filter-single-select': { specVersion: 2, encodings: ['fields'], verified: true },
  // The 6th field-filter type per docs.databricks.com/aws/en/dashboards/filters ("range
  // slider") — see file header re: the missing `filter-` prefix.
  'range-slider': { specVersion: 2, encodings: ['fields'], verified: true },
  // No `spec` wrapper observed — see file header. specVersion 0 is a sentinel.
  text: { specVersion: 0, encodings: [], verified: true },

  // ---- NOT observed in any fixture — docs-derived placeholders, verified: false ----
  // The 21-chart-type list from docs.databricks.com/aws/en/dashboards/visualization-types;
  // entries already verified above (area/bar/combo/counter/heatmap/line/pie/pivot/scatter/
  // table) are that same list's other 10 members.
  box: { specVersion: 3, encodings: [], verified: false },
  bubble: { specVersion: 3, encodings: [], verified: false },
  'choropleth-map': { specVersion: 3, encodings: [], verified: false },
  cohort: { specVersion: 3, encodings: [], verified: false },
  custom: { specVersion: 3, encodings: [], verified: false },
  funnel: { specVersion: 3, encodings: [], verified: false },
  gantt: { specVersion: 3, encodings: [], verified: false },
  histogram: { specVersion: 3, encodings: [], verified: false },
  'point-map': { specVersion: 3, encodings: [], verified: false },
  sankey: { specVersion: 3, encodings: [], verified: false },
  waterfall: { specVersion: 3, encodings: [], verified: false },
  image: { specVersion: 3, encodings: [], verified: false },
  // Docs call this "Text entry" (a field/parameter filter type); no internal wire string
  // was ever observed, so this key is a best-effort slug, not a confirmed identifier —
  // treat it as more speculative than the other unverified entries.
  'filter-text-input': { specVersion: 2, encodings: ['fields'], verified: false },
};

/** Every `(widgetType, spec.version)` pair a `.lvdash.json` widget entry can legally use,
 *  per the pinned table above. `undefined` on an unknown `widgetType` (never invents a
 *  pin) — that is itself the format-drift signal the tripwire test checks for. */
export function isPinnedLakeviewSpec(widgetType: string, specVersion: number): boolean {
  return LAKEVIEW_WIDGET_TYPES[widgetType]?.specVersion === specVersion;
}

/* ------------------------------------------------------------ dataset parameters */

/**
 * Dashboard parameters ride each DATASET (`datasets[].parameters[]`), not the dashboard:
 * the dataset SQL references one as `:keyword`, a widget's query lists the ones it binds as
 * `query.parameters: [{name, keyword}]`, and a `filter-*` widget binds one through
 * `encodings.fields[].parameterName` (+ `queryName` naming that query). Every value below
 * is observed in the golden corpus (`account-usage-v2`, `dbsql-cost-dashboard`,
 * `serverless-migration-assistance`); `lakeview-format.test.ts` fails on any corpus
 * parameter whose `dataType`/`complexType`/`defaultSelection` shape is not pinned here.
 */
export const LAKEVIEW_PARAMETER_DATA_TYPES = ['STRING', 'INTEGER', 'DECIMAL', 'DATE', 'DATETIME'] as const;
export type LakeviewParameterDataType = (typeof LAKEVIEW_PARAMETER_DATA_TYPES)[number];

/** `complexType` is absent for a single-value parameter; `MULTI` (a value list) and `RANGE`
 *  (min/max) are the two observed complex forms. */
export const LAKEVIEW_PARAMETER_COMPLEX_TYPES = ['MULTI', 'RANGE'] as const;
export type LakeviewParameterComplexType = (typeof LAKEVIEW_PARAMETER_COMPLEX_TYPES)[number];

export interface LakeviewParameterValueSelection {
  values: { dataType: LakeviewParameterDataType; values: Array<{ value: string }> };
}
export interface LakeviewParameterRangeSelection {
  range: { dataType: LakeviewParameterDataType; min: { value: string }; max: { value: string } };
}

/** `datasets[].parameters[]` entry, exactly as the corpus carries it. `RANGE` parameters
 *  use the `range` selection shape; every other form uses `values`. */
export interface LakeviewParameterJson {
  displayName: string;
  keyword: string;
  dataType: LakeviewParameterDataType;
  complexType?: LakeviewParameterComplexType;
  defaultSelection: LakeviewParameterValueSelection | LakeviewParameterRangeSelection;
}

/** Parameter form (`dataType` or `dataType:complexType`) → the filter widget type the corpus
 *  binds it through. A form absent here (plain `DATETIME`) has been observed as a dataset
 *  parameter but never bound to a widget — emitters must not invent a binding for it. */
export const LAKEVIEW_PARAMETER_FILTER_WIDGETS: Record<string, string> = {
  STRING: 'filter-single-select',
  'STRING:MULTI': 'filter-multi-select',
  INTEGER: 'filter-single-select',
  DECIMAL: 'filter-single-select',
  DATE: 'filter-date-picker',
  'DATE:RANGE': 'filter-date-range-picker',
  'DATETIME:RANGE': 'filter-date-range-picker',
};

export const lakeviewParameterForm = (dataType: string, complexType?: string | null): string =>
  complexType ? `${dataType}:${complexType}` : dataType;

/** True when the (dataType, complexType) form is one the corpus has actually shown. */
export function isPinnedLakeviewParameter(dataType: string, complexType?: string | null): boolean {
  if (!(LAKEVIEW_PARAMETER_DATA_TYPES as readonly string[]).includes(dataType)) return false;
  if (complexType && !(LAKEVIEW_PARAMETER_COMPLEX_TYPES as readonly string[]).includes(complexType)) return false;
  return true;
}
