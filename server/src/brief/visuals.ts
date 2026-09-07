// Chart-type mapping + brief visual/layout assembly (spec 2026-07-27
// tableau-visual-rebuild, Part B). Turns the platform_properties.visual /
// platform_properties.layout blocks Part A captured per Tableau element
// (snake_case, straight off the .twb) into the brief's IR-shaped
// BriefElementVisual / BriefElementLayout. Never fabricates: an element
// without a capture gets no visual/layout block at all — downgrades and
// inferences are recorded as notes, not silently applied.

import type { BriefElementLayout, BriefElementVisual, BriefElementZone } from './types.js';

/** IR vocabulary: the schema's 6 rebuild-author chart types. Tableau mark
 *  classes that map onto one directly. */
const DIRECT: Record<string, string> = {
  bar: 'bar',
  line: 'line',
  area: 'area',
  circle: 'scatter',
  shape: 'scatter',
  text: 'text_table',
};

/** Marks the IR has no equivalent for — downgraded to the closest type,
 *  always with a 'chart_type_downgraded: <mark>' note. */
const DOWNGRADE: Record<string, string> = {
  pie: 'bar',
  // A Tableau `Square` mark is a matrix/heatmap reading, and the IR's nearest
  // name is `scatter` — same as `circle`/`shape`, which really are scatters. It
  // is a downgrade, not a direct mapping, so it says so (and points the
  // databricks target at `heatmap`, which renders the original reading).
  square: 'scatter',
  ganttbar: 'bar',
  map: 'text_table',
  polygon: 'text_table',
};

/**
 * Marks the SHARED IR has no name for but Databricks AI/BI renders natively.
 *
 * The downgrade itself stays: `chart_type` is the six-type vocabulary every
 * rebuild target reads, and Tableau/Power BI genuinely have no better answer for
 * a pie than a bar. But the databricks target's chart set is wider, and its
 * prompt is told to prefer `source_mark_class` over `chart_type` — so the note
 * names the native type it should reach for instead of only recording the loss.
 * `map`/`polygon`/`ganttbar` are absent on purpose: Lakeview's map and gantt
 * widget types are unverified in the golden corpus, so nothing here may point at
 * them.
 */
const LAKEVIEW_NATIVE: Record<string, string> = {
  pie: 'pie',
  square: 'heatmap',
};

/** A `:qk]` shelf token is a continuous quantitative field (measure on a
 *  continuous axis) — both shelves continuous reads as a scatter. */
const CONTINUOUS_RE = /:qk\]/;

/** Date-part shelf tokens (year/quarter/month/week/day, and their
 *  truncated/ISO/my/mdy variants) — either shelf carrying one reads as a
 *  time series. */
const DATE_PART_RE = /\[(?:yr|qr|mn|wk|dy|tyr|tqr|tmn|twk|tdy|iso[a-z]*|my|mdy):/;

/** Tableau mark class(es) + raw shelf strings → IR chart_type, with notes
 *  for any downgrade or inference performed along the way. */
export function chartTypeForVisual(v: {
  mark_classes: string[];
  rows_raw?: string;
  cols_raw?: string;
}): { chart_type: string; notes: string[] } {
  const marks = v.mark_classes.map((m) => m.toLowerCase());
  if (marks.length >= 2 && marks.includes('bar') && marks.includes('line')) {
    return { chart_type: 'dual_axis_bar_line', notes: [] };
  }
  const mark = marks[0] ?? 'automatic';
  if (DIRECT[mark]) return { chart_type: DIRECT[mark], notes: [] };
  if (DOWNGRADE[mark]) {
    const native = LAKEVIEW_NATIVE[mark];
    return {
      chart_type: DOWNGRADE[mark],
      notes: [`chart_type_downgraded: ${mark}${native ? ` (databricks: ${native})` : ''}`],
    };
  }
  // 'automatic' (or anything unknown): infer from shelf shape.
  const rows = v.rows_raw ?? '';
  const cols = v.cols_raw ?? '';
  let inferred = 'bar';
  if (CONTINUOUS_RE.test(rows) && CONTINUOUS_RE.test(cols)) inferred = 'scatter';
  else if (DATE_PART_RE.test(cols) || DATE_PART_RE.test(rows)) inferred = 'line';
  return { chart_type: inferred, notes: ['chart_type_inferred'] };
}

interface RawEncoding {
  channel?: string;
  field?: string;
}

interface RawFilter {
  field?: string;
  filter_class?: string;
}

interface RawSort {
  field?: string;
  direction?: string;
}

/** platform_properties (or null/undefined) + a BI-field → brief-field
 *  translator → the brief's visual block, or undefined when the element
 *  carries no captured visual at all. */
export function buildElementVisual(
  props: Record<string, unknown> | null | undefined,
  translate: (name: string) => string,
): BriefElementVisual | undefined {
  const visual = (props?.visual ?? null) as Record<string, unknown> | null;
  if (!visual) return undefined;
  const markClass = visual.mark_class as string | undefined;
  const markClasses = (visual.mark_classes as string[] | undefined)?.filter(Boolean) ?? [];
  if (!markClass && markClasses.length === 0) return undefined;

  const { chart_type, notes } = chartTypeForVisual({
    mark_classes: markClasses.length > 0 ? markClasses : markClass ? [markClass] : [],
    rows_raw: visual.rows_raw as string | undefined,
    cols_raw: visual.cols_raw as string | undefined,
  });

  const rows = ((visual.rows as string[] | undefined) ?? []).map(translate);
  const cols = ((visual.cols as string[] | undefined) ?? []).map(translate);

  const result: BriefElementVisual = {
    chart_type,
    source_mark_class: markClass ?? markClasses[0],
    rows,
    cols,
    notes,
  };

  // Encodings → color/size/label. Channel 'text' is the label channel; first
  // occurrence per channel wins. Other channels are left in the catalog's
  // raw block and ignored here — the brief only carries the channels the
  // rebuild author needs.
  const encodings = (visual.encodings as RawEncoding[] | undefined) ?? [];
  for (const enc of encodings) {
    if (!enc.field) continue;
    if (enc.channel === 'color' && result.color === undefined) {
      result.color = translate(enc.field);
    } else if (enc.channel === 'size' && result.size === undefined) {
      result.size = translate(enc.field);
    } else if (enc.channel === 'text' && result.label === undefined) {
      result.label = translate(enc.field);
    }
  }

  const filters = (visual.filters as RawFilter[] | undefined) ?? [];
  const translatedFilters = filters.filter((f) => f.field).map((f) => translate(f.field!));
  if (translatedFilters.length > 0) result.filters = translatedFilters;

  // Explicit worksheet sort order (Task 6 fidelity backfill) — field translated the same
  // way rows/cols/filters are; direction rides Tableau's raw vocabulary unchanged.
  const sorts = (visual.sorts as RawSort[] | undefined) ?? [];
  const translatedSorts = sorts
    .filter((s) => s.field)
    .map((s) => ({
      field: translate(s.field!),
      ...(s.direction !== undefined ? { direction: s.direction } : {}),
    }));
  if (translatedSorts.length > 0) result.sorts = translatedSorts;

  return result;
}

interface RawZone {
  sheet_name?: string;
  type?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  confidence?: number;
}

/** platform_properties (or null/undefined) → the brief's layout block, or
 *  undefined when the element carries no captured layout at all. */
export function buildElementLayout(
  props: Record<string, unknown> | null | undefined,
): BriefElementLayout | undefined {
  const layout = (props?.layout ?? null) as Record<string, unknown> | null;
  if (!layout) return undefined;

  const rawZones = (layout.zones as RawZone[] | undefined) ?? [];
  const zones: BriefElementZone[] = [];
  for (const z of rawZones) {
    const w = z.w ?? 0;
    const h = z.h ?? 0;
    if (w <= 0 || h <= 0) continue;
    const x = z.x ?? 0;
    const y = z.y ?? 0;
    const zone: BriefElementZone = z.sheet_name
      ? { worksheet: z.sheet_name, kind: 'worksheet', x, y, w, h }
      : { kind: z.type === 'text' ? 'text' : 'blank', x, y, w, h };
    if (typeof z.confidence === 'number') zone.confidence = z.confidence;
    zones.push(zone);
  }

  const result: BriefElementLayout = { observed: true, source: 'twb', zones };
  const width = layout.width;
  const height = layout.height;
  if (typeof width === 'number' && typeof height === 'number') {
    result.size = { width, height };
  }
  return result;
}
