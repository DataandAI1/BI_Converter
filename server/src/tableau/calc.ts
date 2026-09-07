import type { DerivationType } from '../model/types.js';

/**
 * Tableau calc tokenizer (BI connectors plan decision 8) — mechanical classification onto
 * the existing `DerivationType` taxonomy (spec §2.3: what the formula does, never what it
 * means) plus ref extraction. Both mapper.ts (file mode, this task) and Task 5's live
 * mapper call this on the identical formula text, so classification never drifts between
 * modes.
 *
 * Refs: every `\[([^\]]+)\]` bracket token is a field reference, except that a
 * `[DS].[Field]` pair (two adjacent bracket tokens joined by a bare `.`) is one
 * cross-datasource ref, not two bare ones.
 */

export interface TokenizeCalcResult {
  refs: { ds?: string; field: string }[];
  derivationType: DerivationType[];
  flags: string[];
}

const AGGREGATION_FUNCS = new Set([
  'SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNTD', 'MEDIAN', 'STDEV', 'STDEVP', 'VAR', 'VARP',
  'PERCENTILE', 'ATTR',
]);

const WINDOW_FUNCS = new Set(['LOOKUP', 'INDEX']);
const WINDOW_PREFIX = /^(WINDOW_|RUNNING_)/;
const RANK_PREFIX = /^RANK/;

const ARITHMETIC_FUNCS = new Set([
  'DATEADD', 'DATEDIFF', 'DATEPART', 'DATETRUNC', 'DATENAME', 'TODAY', 'NOW', 'ABS', 'ROUND',
  'CEILING', 'FLOOR', 'SQRT', 'POWER', 'EXP', 'LOG', 'LN', 'SIGN', 'ZN', 'DIV', 'INT',
]);

const STRING_FUNCS = new Set([
  'LEFT', 'RIGHT', 'MID', 'LEN', 'UPPER', 'LOWER', 'TRIM', 'LTRIM', 'RTRIM', 'REPLACE',
  'SPLIT', 'CONTAINS', 'STARTSWITH', 'ENDSWITH', 'FIND', 'SUBSTITUTE',
]);

const CASE_SWITCH_FUNCS = new Set(['IIF']);

const ALL_KNOWN_FUNCS = new Set([
  ...AGGREGATION_FUNCS,
  ...WINDOW_FUNCS,
  ...ARITHMETIC_FUNCS,
  ...STRING_FUNCS,
  ...CASE_SWITCH_FUNCS,
]);

function isKnownFunc(name: string): boolean {
  if (ALL_KNOWN_FUNCS.has(name)) return true;
  if (WINDOW_PREFIX.test(name)) return true;
  if (RANK_PREFIX.test(name)) return true;
  return false;
}

/** Bracket-token refs, splitting out the `[DS].[Field]` cross-datasource pair form. */
function extractRefs(formula: string): { ds?: string; field: string }[] {
  const refs: { ds?: string; field: string }[] = [];
  const consumedRanges: Array<[number, number]> = [];

  const crossDsRe = /\[([^\]]+)\]\.\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = crossDsRe.exec(formula))) {
    refs.push({ ds: m[1], field: m[2] });
    consumedRanges.push([m.index, m.index + m[0].length]);
  }

  const bracketRe = /\[([^\]]+)\]/g;
  while ((m = bracketRe.exec(formula))) {
    const start = m.index;
    const end = start + m[0].length;
    if (consumedRanges.some(([s, e]) => start >= s && end <= e)) continue;
    refs.push({ field: m[1] });
  }
  return refs;
}

/** Bare `FUNC(` call names — Tableau's `IF`/`CASE` are keyword syntax (no parens), so
 *  they're detected separately, not here. */
function extractFunctionNames(formula: string): string[] {
  const names: string[] = [];
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(formula))) names.push(m[1].toUpperCase());
  return names;
}

const PASSTHROUGH_RE = /^\[[^\]]+\]$/;
const STRING_LITERAL_RE = /^(['"]).*\1$/;
const NUMERIC_LITERAL_RE = /^-?\d+(\.\d+)?$/;
const BOOL_LITERAL_RE = /^(true|false)$/i;

export function tokenizeCalc(formula: string): TokenizeCalcResult {
  const trimmed = formula.trim();
  const refs = extractRefs(formula);

  // Bare `[Field]` — the entire formula is one field reference, nothing else. Exclusive:
  // a passthrough calc is definitionally not also an aggregation/case_switch/etc.
  if (PASSTHROUGH_RE.test(trimmed)) {
    return { refs, derivationType: ['passthrough'], flags: [] };
  }

  // A pure literal with no field refs and no function calls.
  if (
    refs.length === 0 &&
    (STRING_LITERAL_RE.test(trimmed) || NUMERIC_LITERAL_RE.test(trimmed) || BOOL_LITERAL_RE.test(trimmed))
  ) {
    return { refs, derivationType: ['constant'], flags: [] };
  }

  const funcNames = extractFunctionNames(formula);
  const types = new Set<DerivationType>();
  const flags: string[] = [];

  if (/\bIF\b/i.test(formula) || /\bCASE\b/i.test(formula) || funcNames.includes('IIF')) {
    types.add('case_switch');
  }
  if (funcNames.some((f) => AGGREGATION_FUNCS.has(f))) {
    types.add('aggregation');
  }
  if (
    /\{\s*(FIXED|INCLUDE|EXCLUDE)\b/i.test(formula) ||
    funcNames.some((f) => WINDOW_PREFIX.test(f) || WINDOW_FUNCS.has(f) || RANK_PREFIX.test(f))
  ) {
    types.add('window');
  }
  if (funcNames.some((f) => ARITHMETIC_FUNCS.has(f))) {
    types.add('arithmetic');
  }
  if (funcNames.some((f) => STRING_FUNCS.has(f))) {
    types.add('string_transform');
  }

  const unknownFuncs = [...new Set(funcNames.filter((f) => !isKnownFunc(f)))];
  if (unknownFuncs.length > 0) {
    types.add('udf_call');
    for (const f of unknownFuncs) flags.push(`unknown_function:${f}`);
  }

  if (types.size === 0) {
    // No recognized function, no keyword — fall back to bare-operator arithmetic
    // (e.g. `[Sales] - [Cost]`), stripping bracket refs and string literals first so a
    // hyphen inside a field name or quoted string never masquerades as an operator.
    const stripped = formula.replace(/\[[^\]]*\]/g, '').replace(/(['"]).*?\1/g, '');
    if (/[+\-*/]/.test(stripped)) {
      types.add('arithmetic');
    } else {
      types.add('udf_call');
    }
  }

  return { refs, derivationType: [...types], flags };
}
