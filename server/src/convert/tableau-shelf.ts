import type { LakeviewScaleType } from '../lakeview/emit.js';
import { type BiDerivationRow, fieldKey } from './shared.js';

/**
 * Tableau shelf grammar — the parser that turns a captured shelf expression
 * (`[federated.x].[sum:Sales:qk]`) into classified tokens, plus the aggregation and
 * date-grain vocabularies it classifies against.
 *
 * Split out of `rebuild-databricks.ts` (Phase F, plan 2026-09-03) so the grammar can be
 * read and tested on its own: nothing here knows about Lakeview documents, files or the
 * catalog context — a token only needs the datasource facts in `TokenFacts` to decide
 * what it is. `rebuild-databricks.ts` owns turning a classified token into a dataset
 * field expression (`resolveToken`).
 *
 * The honesty rule of the emitter holds here too: a token this grammar cannot translate
 * exactly carries a `note` saying what was emitted instead, rather than being guessed
 * onto the wire.
 */

/** Tableau shelf aggregation prefix → Databricks SQL. Only the mechanically-exact ones:
 *  every function here means the same thing in both engines (`MEDIAN` is Databricks'
 *  exact-percentile median, `stdev`/`var` are Tableau's SAMPLE forms, matching
 *  `stddev_samp`/`var_samp`). See `shelfToken` for what happens to a continuous token
 *  whose prefix isn't one of them.
 *
 *  Deliberately NOT the same table as `semantic-layer.ts`'s `AGG_SQL`: these keys are
 *  Tableau SHELF PREFIXES (`cnt`, `cntd`), that one's keys are Tableau CALC FUNCTION
 *  names (`COUNT`, `COUNTD`) matched by `SIMPLE_AGG_RE` after `.toUpperCase()`. The two
 *  vocabularies do not overlap key-for-key, and merging them would silently widen each
 *  lane's accepted set (a `MEDIAN([x])` calc would start translating to a metric-view
 *  measure), so they stay separate on purpose. */
export const AGG_SQL: Record<string, (col: string) => string> = {
  sum: (c) => `SUM(${c})`,
  avg: (c) => `AVG(${c})`,
  min: (c) => `MIN(${c})`,
  max: (c) => `MAX(${c})`,
  cnt: (c) => `COUNT(${c})`,
  cntd: (c) => `COUNT(DISTINCT ${c})`,
  median: (c) => `MEDIAN(${c})`,
  stdev: (c) => `stddev_samp(${c})`,
  var: (c) => `var_samp(${c})`,
};

/** One date grain a shelf prefix can request. `trunc` keeps the value a date (Tableau's
 *  "continuous" green date pill → `DATE_TRUNC`, the corpus shape:
 *  `{"name": "daily(usage_end_time)", "expression": "DATE_TRUNC(\"DAY\", `usage_end_time`)"}`);
 *  `part` extracts an integer component (Tableau's "discrete" blue pill → `date_part`),
 *  which is a category, not a point in time. */
export interface DateGrain {
  kind: 'trunc' | 'part';
  /** Databricks unit string (`YEAR`, `MONTH`, …). */
  unit: string;
  /** Field-name prefix — `daily(col)` for a truncation, `day(col)` for a part. */
  label: string;
}

/** Date-grain shelf prefixes. Tableau writes a truncation as `t<unit>` (plus the two
 *  legacy compound forms `my` = month/year and `mdy` = month/day/year) and a discrete
 *  part as the bare unit. Mirrors build/visuals.ts's DATE_PART_RE, but each entry now
 *  carries the SQL it means instead of only saying "this is a date". */
export const DATE_GRAINS: Record<string, DateGrain> = {
  tyr: { kind: 'trunc', unit: 'YEAR', label: 'yearly' },
  tqr: { kind: 'trunc', unit: 'QUARTER', label: 'quarterly' },
  tmn: { kind: 'trunc', unit: 'MONTH', label: 'monthly' },
  twk: { kind: 'trunc', unit: 'WEEK', label: 'weekly' },
  tdy: { kind: 'trunc', unit: 'DAY', label: 'daily' },
  thr: { kind: 'trunc', unit: 'HOUR', label: 'hourly' },
  tmi: { kind: 'trunc', unit: 'MINUTE', label: 'minutely' },
  tse: { kind: 'trunc', unit: 'SECOND', label: 'secondly' },
  my: { kind: 'trunc', unit: 'MONTH', label: 'monthly' },
  mdy: { kind: 'trunc', unit: 'DAY', label: 'daily' },
  yr: { kind: 'part', unit: 'YEAR', label: 'year' },
  qr: { kind: 'part', unit: 'QUARTER', label: 'quarter' },
  mn: { kind: 'part', unit: 'MONTH', label: 'month' },
  wk: { kind: 'part', unit: 'WEEK', label: 'week' },
  dy: { kind: 'part', unit: 'DAY', label: 'day' },
  hr: { kind: 'part', unit: 'HOUR', label: 'hour' },
  mi: { kind: 'part', unit: 'MINUTE', label: 'minute' },
  se: { kind: 'part', unit: 'SECOND', label: 'second' },
};

/** ISO-week/ISO-year prefixes (`isoyr`, `isoqr`, `isowk`, …). Databricks' `date_part`
 *  week/year are NOT ISO-8601, so there is no mechanical equivalent — the raw column is
 *  emitted and the grain becomes a review note. */
const ISO_GRAIN_PREFIX = /^iso[a-z]*$/;

export const grainSql = (grain: DateGrain, quoted: string): string =>
  grain.kind === 'trunc'
    ? `DATE_TRUNC("${grain.unit}", ${quoted})`
    : `date_part('${grain.unit}', ${quoted})`;

/** Tableau's measure-name/measure-value shelf placeholders. These are not columns — they
 *  stand for "whichever measures are on the sheet" — so a dataset SELECT that named one
 *  would not run. */
const MEASURE_PLACEHOLDER = /^(measure names|measure values|multiple values)$/;

/** Canonical types (`data_type_canonical`) that can carry an aggregation. */
export const NUMERIC_TYPE = /^(integer|int|bigint|smallint|tinyint|float|double|real|decimal|numeric)/;
/** Canonical types that are points in time. */
export const DATE_TYPE = /^(date|datetime|timestamp)/;

export interface ShelfToken {
  /** Resolved Tableau field name (the shelf token's middle segment). */
  field: string;
  /** Lowercased prefix segment ('sum', 'none', 'yr', …), or null for a bare token. */
  prefix: string | null;
  /** The aggregation to emit (an AGG_SQL key), or null when the token is a dimension. */
  agg: string | null;
  isMeasure: boolean;
  /** true when `agg` was defaulted because the token is continuous (`:qk`) over a numeric
   *  column but its prefix names no aggregation this emitter can translate — always noted. */
  aggDefaulted: boolean;
  /** The date grain the prefix requested, when it named one this emitter can emit. */
  grain: DateGrain | null;
  /** Scale a dimension token lands on: a date is temporal, everything else categorical. */
  dimensionScale: LakeviewScaleType;
  /** A `[Measure Names]`-family placeholder — noted, never emitted as a column. */
  measurePlaceholder: boolean;
  /** A review note this token owes the sheet, pushed when it is resolved (so a token that
   *  is never bound to a channel doesn't report a problem the reader can't see). */
  note: string | null;
}

/** The datasource facts a token needs to classify itself — a structural subset of
 *  rebuild-databricks.ts's `DatasourceFacts` (its `factsOf` builds the maps). */
export interface TokenFacts {
  /** bi field key → physical column name. */
  physicalByField: Map<string, string>;
  /** Physical column key (and, as a fallback, the Tableau field key) → the catalog's
   *  `data_type_canonical`, lowercased. */
  typeByColumn: Map<string, string>;
  /** Field keys that are calculated fields. */
  calcFields: Map<string, BiDerivationRow>;
}

/** Canonical type of the column a Tableau field resolves to, or null when the catalog
 *  never told us (an unbound field, or a column row with no `data_type_canonical`). */
export function columnType(field: string, facts?: TokenFacts): string | null {
  if (!facts) return null;
  const key = fieldKey(field);
  const physical = facts.physicalByField.get(key);
  return (physical ? facts.typeByColumn.get(fieldKey(physical)) : undefined) ??
    facts.typeByColumn.get(key) ??
    null;
}

/** One shelf token → its classification. The interesting case is a CONTINUOUS (`:qk`)
 *  token whose prefix names no aggregation: reading it as a measure and summing it was
 *  wrong for `none:Order Date:qk` (a date) and `none:Region:qk` (a string) — the dataset
 *  query fails at load — so the catalog's `data_type_canonical` decides, and every branch
 *  that is not a plain SUM says what it did. */
export function shelfToken(
  field: string,
  prefix: string | null,
  continuous: boolean,
  facts?: TokenFacts,
): ShelfToken {
  const base: ShelfToken = {
    field,
    prefix,
    agg: null,
    isMeasure: false,
    aggDefaulted: false,
    grain: null,
    dimensionScale: 'categorical',
    measurePlaceholder: false,
    note: null,
  };
  if (MEASURE_PLACEHOLDER.test(field.replace(/^:/, '').trim().toLowerCase())) {
    return { ...base, measurePlaceholder: true };
  }
  if (prefix && prefix in AGG_SQL) return { ...base, isMeasure: true, agg: prefix };
  const grain = prefix ? (DATE_GRAINS[prefix] ?? null) : null;
  if (grain) {
    return { ...base, grain, dimensionScale: grain.kind === 'trunc' ? 'temporal' : 'categorical' };
  }
  if (prefix && ISO_GRAIN_PREFIX.test(prefix)) {
    return {
      ...base,
      dimensionScale: 'temporal',
      note: `field '${field}' uses an ISO date part ('${prefix}') — Databricks' week/year parts are not ISO-8601, so the raw date column was emitted instead; re-apply the grain in the AI/BI editor`,
    };
  }
  if (!continuous) return base;
  if (prefix === 'attr') {
    return {
      ...base,
      dimensionScale: DATE_TYPE.test(columnType(field, facts) ?? '') ? 'temporal' : 'categorical',
      note: `field '${field}' is wrapped in ATTR() on the shelf — ATTR has no exact SQL equivalent, so it was emitted as a plain dimension; verify it collapses to one value per mark`,
    };
  }
  // A calculated field keeps the old behaviour: its own formula decides whether the
  // result aggregates, and `resolveToken` reads that off the translation.
  if (facts?.calcFields.has(fieldKey(field))) {
    return { ...base, isMeasure: true, agg: 'sum', aggDefaulted: true };
  }
  const type = columnType(field, facts);
  if (type && NUMERIC_TYPE.test(type)) {
    return { ...base, isMeasure: true, agg: 'sum', aggDefaulted: true };
  }
  if (type && DATE_TYPE.test(type)) {
    return {
      ...base,
      dimensionScale: 'temporal',
      note: `field '${field}' sits on a continuous axis but the catalog calls it a date column ('${type}') — emitted as a temporal dimension rather than an aggregate; pick a date grain in the AI/BI editor`,
    };
  }
  return {
    ...base,
    note: `field '${field}' sits on a continuous axis but ${type ? `its catalog type ('${type}')` : 'the catalog'} is not a numeric column — emitted as a dimension rather than SUM; set the right aggregation in the AI/BI editor`,
  };
}

/** A field that carries no shelf context of its own (an encoding, a filter, a column-grain
 *  usage edge) — always read as a dimension. */
export const dimToken = (field: string): ShelfToken => shelfToken(field, null, false);

/**
 * `[federated.x].[sum:Sales:qk] / [federated.x].[none:Region:nk]` → ordered tokens.
 * Mirrors connectors/tableau/files.ts's `shelfFieldNames`, keeping the two segments that
 * function throws away: the prefix (where the aggregation and the date grain live) and the
 * trailing kind (`qk` = continuous/quantitative, `nk` = nominal, `ok` = ordinal).
 */
export function parseShelf(raw: string | undefined, facts?: TokenFacts): ShelfToken[] {
  if (!raw) return [];
  const tokens: ShelfToken[] = [];
  const re = /\[[^\]]*\]\.\[([^\]]*)\]/g;
  for (let m = re.exec(raw); m; m = re.exec(raw)) {
    const parts = m[1].split(':');
    tokens.push(
      parts.length >= 3
        ? shelfToken(
            parts.slice(1, -1).join(':'),
            parts[0].toLowerCase(),
            parts[parts.length - 1].toLowerCase() === 'qk',
            facts,
          )
        : shelfToken(m[1], null, false, facts),
    );
  }
  return tokens;
}
