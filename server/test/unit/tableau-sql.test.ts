import { describe, it, expect } from 'vitest';
import {
  fieldTypeFromCanonical,
  translateTableauCalcToSql,
  type TableauFieldType,
  type TranslateOptions,
} from '../../src/convert/tableau-sql.js';

/**
 * translateTableauCalcToSql (Databricks AI/BI rebuild plan, Phase 4 — deterministic
 * Tableau-calc → Databricks SQL tier). Table-driven: one row per supported pattern from
 * the task brief's scope list, one row per explicit-null category, plus compound
 * formulas mixing categories. Reject-by-default is the load-bearing behavior here — a
 * wrong-but-plausible translation is worse than no translation, so every null row exists
 * to prove a specific unsupported construct comes back `null`, never a guess.
 *
 * Review-round-1 (controller ruling: binding constraint governs over brief scope text)
 * tightened five spots — see the rows/comments tagged accordingly below:
 *  1. `+` is Tableau's overloaded operator (numeric add vs. string concat); Databricks
 *     `+` is not. Only translated when both operands are provably numeric.
 *  2. CONTAINS/STARTSWITH's old LIKE fast-path could misread `%`/`_` inside a literal as
 *     wildcards. CONTAINS always uses `instr`; STARTSWITH's literal branch uses
 *     `left(a, len) = lit` (length is a translate-time constant, not a LIKE pattern).
 *  3. IIF's implicit NULL/unknown-test branch needs an explicit `WHEN NOT (test)` arm —
 *     a plain `CASE...ELSE` would wrongly fall through to the false-branch on NULL.
 *  4. `'week'` is dropped from DATEPART/DATETRUNC/DATEDIFF (Tableau's week start is
 *     configurable; Databricks' is ISO/Monday) but kept for DATEADD (`n * 7` days is
 *     convention-independent).
 *  5. SPLIT is dropped from scope entirely: Tableau's out-of-range token is NULL,
 *     `split_part`'s is `''`, and `nullif(x, '')` would wrongly NULL a legitimately
 *     empty in-range token too — no provably-equivalent form exists.
 */

const FM = new Map<string, string>([
  ['sales', 'sales_amt'],
  ['cost', 'cost_amt'],
  ['profit', 'profit_amt'],
  ['region', 'region_name'],
  ['name', 'cust_name'],
  ['flag', 'is_active'],
  ['order date', 'order_date'],
  ['ship date', 'ship_date'],
  ['code', 'code_val'],
  ['pct', 'pct_val'],
]);

function run(formula: string): string | null {
  const r = translateTableauCalcToSql(formula, FM);
  return r ? r.sql : null;
}

/** Same, with the Phase B optional third argument. Every `opts` case below asserts the
 *  no-opts result too where the point is that types/calcs are what unlocked it. */
function runWith(formula: string, opts: TranslateOptions): string | null {
  const r = translateTableauCalcToSql(formula, FM, opts);
  return r ? r.sql : null;
}

/** Catalog types for the same fields `FM` maps (Phase B2). */
const TYPES = new Map<string, TableauFieldType>([
  ['sales', 'numeric'],
  ['cost', 'numeric'],
  ['profit', 'numeric'],
  ['name', 'string'],
  ['region', 'string'],
  ['code', 'string'],
  ['flag', 'boolean'],
  ['order date', 'date'],
  ['ship date', 'datetime'],
]);

describe('translateTableauCalcToSql — supported scope', () => {
  const rows: Array<[string, string, string]> = [
    // ---- constants
    ['numeric constant', '42', '42'],
    ['string constant', "'hello'", "'hello'"],
    ['string constant with embedded quote (escaped)', "'It''s a test'", "'It''s a test'"],
    ['boolean TRUE', 'TRUE', 'TRUE'],
    ['boolean FALSE (lowercase input)', 'false', 'FALSE'],
    ['NULL literal', 'NULL', 'NULL'],

    // ---- field passthrough
    ['bare field passthrough', '[Sales]', '`sales_amt`'],

    // ---- arithmetic
    ['addition of numeric literals (provably numeric)', '1 + 2', '(1 + 2)'],
    ['addition of two aggregates (finding 1: provably numeric)', 'SUM([Sales]) + SUM([Cost])', '(SUM(`sales_amt`) + SUM(`cost_amt`))'],
    ['addition mixing a literal and a numeric-returning function (finding 1)', '1 + LEN([Name])', '(1 + length(`cust_name`))'],
    ['subtraction', '[Sales] - [Cost]', '(`sales_amt` - `cost_amt`)'],
    ['multiplication', '[Sales] * 2', '(`sales_amt` * 2)'],
    ['division', '[Sales] / [Cost]', '(`sales_amt` / `cost_amt`)'],
    ['modulo', '[Sales] % 2', '(`sales_amt` % 2)'],
    ['parens override precedence (aggregates, provably numeric)', '(SUM([Sales]) + SUM([Cost])) * 2', '((SUM(`sales_amt`) + SUM(`cost_amt`)) * 2)'],
    ['unary minus on a field', '-[Sales]', '-(`sales_amt`)'],
    ['unary minus on a numeric literal', '-5', '-5'],

    // ---- string
    ['LEFT', 'LEFT([Name], 3)', 'left(`cust_name`, 3)'],
    ['RIGHT', 'RIGHT([Name], 3)', 'right(`cust_name`, 3)'],
    ['MID 2-arg', 'MID([Name], 2)', 'substr(`cust_name`, 2)'],
    ['MID 3-arg', 'MID([Name], 2, 3)', 'substr(`cust_name`, 2, 3)'],
    ['UPPER', 'UPPER([Name])', 'upper(`cust_name`)'],
    ['LOWER', 'LOWER([Name])', 'lower(`cust_name`)'],
    ['TRIM', 'TRIM([Name])', 'trim(`cust_name`)'],
    ['LTRIM', 'LTRIM([Name])', 'ltrim(`cust_name`)'],
    ['RTRIM', 'RTRIM([Name])', 'rtrim(`cust_name`)'],
    ['LEN', 'LEN([Name])', 'length(`cust_name`)'],
    ['CONTAINS with literal (finding 2: always instr, never LIKE)', "CONTAINS([Name], 'a')", "instr(`cust_name`, 'a') > 0"],
    ['CONTAINS with non-literal', 'CONTAINS([Name], [Region])', 'instr(`cust_name`, `region_name`) > 0'],
    ['CONTAINS with a `_` LIKE-metachar in the literal (finding 2)', "CONTAINS([Code], 'A_B')", "instr(`code_val`, 'A_B') > 0"],
    ['CONTAINS with a `%` LIKE-metachar in the literal (finding 2)', "CONTAINS([Pct], '50%')", "instr(`pct_val`, '50%') > 0"],
    ['STARTSWITH with literal (finding 2: LEFT + exact-length compare, never LIKE)', "STARTSWITH([Name], 'Mr')", "left(`cust_name`, 2) = 'Mr'"],
    ['STARTSWITH with a `_` LIKE-metachar in the literal (finding 2)', "STARTSWITH([Code], 'A_')", "left(`code_val`, 2) = 'A_'"],
    [
      'STARTSWITH with a non-literal (B4: length() computed per row)',
      'STARTSWITH([Name], [Region])',
      'left(`cust_name`, length(`region_name`)) = `region_name`',
    ],
    ['ENDSWITH with a literal (B4)', "ENDSWITH([Name], 'Ltd')", "right(`cust_name`, 3) = 'Ltd'"],
    [
      'ENDSWITH with a `%` LIKE-metachar in the literal (B4: no LIKE, no wildcard risk)',
      "ENDSWITH([Pct], '50%')",
      "right(`pct_val`, 3) = '50%'",
    ],
    [
      'ENDSWITH with a non-literal (B4)',
      'ENDSWITH([Name], [Region])',
      'right(`cust_name`, length(`region_name`)) = `region_name`',
    ],
    ['FIND', "FIND([Name], 'a')", "instr(`cust_name`, 'a')"],
    ['REPLACE', "REPLACE([Name], 'a', 'b')", "replace(`cust_name`, 'a', 'b')"],

    // ---- conditional
    [
      'IF/ELSE/END',
      "IF [Sales] > 100 THEN 'High' ELSE 'Low' END",
      "CASE WHEN (`sales_amt` > 100) THEN 'High' ELSE 'Low' END",
    ],
    [
      'IF/ELSEIF/ELSE/END',
      "IF [Sales] > 100 THEN 'High' ELSEIF [Sales] > 50 THEN 'Mid' ELSE 'Low' END",
      "CASE WHEN (`sales_amt` > 100) THEN 'High' WHEN (`sales_amt` > 50) THEN 'Mid' ELSE 'Low' END",
    ],
    [
      'IIF 3-arg (finding 3: explicit WHEN NOT (test) branch for the NULL/unknown case)',
      "IIF([Flag], 'Y', 'N')",
      "CASE WHEN `is_active` THEN 'Y' WHEN NOT (`is_active`) THEN 'N' END",
    ],
    [
      'IIF 4-arg (finding 3: explicit unknown branch via ELSE)',
      "IIF([Flag], 'Y', 'N', 'U')",
      "CASE WHEN `is_active` THEN 'Y' WHEN NOT (`is_active`) THEN 'N' ELSE 'U' END",
    ],
    [
      'CASE/WHEN/END',
      "CASE [Region] WHEN 'West' THEN 1 WHEN 'East' THEN 2 ELSE 0 END",
      "CASE `region_name` WHEN 'West' THEN 1 WHEN 'East' THEN 2 ELSE 0 END",
    ],

    // ---- logic / comparison
    ['equals =', '[Sales] = [Cost]', '(`sales_amt` = `cost_amt`)'],
    ['equals == normalizes to =', '[Sales] == [Cost]', '(`sales_amt` = `cost_amt`)'],
    ['not-equals <>', '[Sales] <> [Cost]', '(`sales_amt` <> `cost_amt`)'],
    ['not-equals != normalizes to <>', '[Sales] != [Cost]', '(`sales_amt` <> `cost_amt`)'],
    ['less than', '[Sales] < [Cost]', '(`sales_amt` < `cost_amt`)'],
    ['greater than', '[Sales] > [Cost]', '(`sales_amt` > `cost_amt`)'],
    ['less-or-equal', '[Sales] <= [Cost]', '(`sales_amt` <= `cost_amt`)'],
    ['greater-or-equal', '[Sales] >= [Cost]', '(`sales_amt` >= `cost_amt`)'],
    [
      'AND / NOT',
      "[Sales] > 0 AND NOT [Region] = 'West'",
      "((`sales_amt` > 0) AND NOT (`region_name` = 'West'))",
    ],
    ['OR', '[Sales] > 0 OR [Cost] > 0', '((`sales_amt` > 0) OR (`cost_amt` > 0))'],

    // ---- date
    ["DATEPART('year', d)", "DATEPART('year', [Order Date])", "date_part('year', `order_date`)"],
    ["DATETRUNC('month', d)", "DATETRUNC('month', [Order Date])", "date_trunc('MONTH', `order_date`)"],
    ['TODAY()', 'TODAY()', 'current_date'],
    ['NOW()', 'NOW()', 'current_timestamp'],
    ['YEAR(d)', 'YEAR([Order Date])', 'extract(year FROM `order_date`)'],
    ['MONTH(d)', 'MONTH([Order Date])', 'extract(month FROM `order_date`)'],
    ['DAY(d)', 'DAY([Order Date])', 'extract(day FROM `order_date`)'],
    ["DATEADD('month', n, d)", "DATEADD('month', 3, [Order Date])", 'dateadd(month, 3, `order_date`)'],
    [
      "DATEADD('week', n, d) — week stays supported here (finding 4: n*7 days is convention-independent)",
      "DATEADD('week', 2, [Order Date])",
      'dateadd(week, 2, `order_date`)',
    ],
    [
      // Phase B1: the 2-arg (date-based) form, end first — see the DATEDIFF block below.
      "DATEDIFF('day', a, b)",
      "DATEDIFF('day', [Order Date], [Ship Date])",
      'datediff(`ship_date`, `order_date`)',
    ],

    // ---- aggregates
    ['SUM', 'SUM([Sales])', 'SUM(`sales_amt`)'],
    ['MIN', 'MIN([Sales])', 'MIN(`sales_amt`)'],
    ['MAX', 'MAX([Sales])', 'MAX(`sales_amt`)'],
    ['AVG', 'AVG([Sales])', 'AVG(`sales_amt`)'],
    ['COUNT', 'COUNT([Sales])', 'COUNT(`sales_amt`)'],
    ['COUNTD', 'COUNTD([Sales])', 'COUNT(DISTINCT `sales_amt`)'],
    ['MEDIAN', 'MEDIAN([Sales])', 'median(`sales_amt`)'],
    ['STDEV', 'STDEV([Sales])', 'stddev_samp(`sales_amt`)'],
    ['VAR', 'VAR([Sales])', 'var_samp(`sales_amt`)'],
    ['aggregate argument itself translates', 'SUM([Sales] - [Cost])', 'SUM((`sales_amt` - `cost_amt`))'],
    ['standalone MIN over a field stays translatable outside a numeric-only context (fix-round-2)', 'MIN([Name])', 'MIN(`cust_name`)'],
    [
      'MIN/MAX count as provably numeric only when their own argument does (fix-round-2)',
      'MIN(LEN([Name])) + 1',
      '(MIN(length(`cust_name`)) + 1)',
    ],

    // ---- null handling
    ['IFNULL', 'IFNULL([Sales], 0)', 'coalesce(`sales_amt`, 0)'],
    ['ZN', 'ZN([Sales])', 'coalesce(`sales_amt`, 0)'],
    ['ISNULL', 'ISNULL([Sales])', '(`sales_amt` IS NULL)'],

    // ---- type
    ['STR', 'STR([Sales])', 'cast(`sales_amt` as string)'],
    ['INT', 'INT([Sales])', 'cast(`sales_amt` as int)'],
    ['FLOAT', 'FLOAT([Sales])', 'cast(`sales_amt` as double)'],
    ['DATE', "DATE('2020-01-01')", "to_date('2020-01-01')"],
    ['ABS', 'ABS([Sales])', 'abs(`sales_amt`)'],
    ['ROUND 1-arg', 'ROUND([Sales])', 'round(`sales_amt`)'],
    ['ROUND 2-arg', 'ROUND([Sales], 2)', 'round(`sales_amt`, 2)'],
    ['CEILING', 'CEILING([Sales])', 'ceil(`sales_amt`)'],
    ['FLOOR', 'FLOOR([Sales])', 'floor(`sales_amt`)'],

    // ---- Phase B4 additions: math
    ['POWER', 'POWER([Sales], 2)', 'power(`sales_amt`, 2)'],
    ['SQRT', 'SQRT([Sales])', 'sqrt(`sales_amt`)'],
    ['EXP', 'EXP([Sales])', 'exp(`sales_amt`)'],
    ['LN', 'LN([Sales])', 'ln(`sales_amt`)'],
    ['LOG 1-arg defaults to base 10', 'LOG([Sales])', 'log10(`sales_amt`)'],
    ['LOG 2-arg swaps the base to the front (Tableau LOG(x, base) vs Databricks log(base, x))', 'LOG([Sales], 2)', 'log(2, `sales_amt`)'],
    ['SIGN', 'SIGN([Sales])', 'sign(`sales_amt`)'],
    ['DIV', 'DIV([Sales], [Cost])', 'div(`sales_amt`, `cost_amt`)'],

    // ---- Phase B4 additions: row-level MIN/MAX
    [
      '2-arg MIN → NULL-guarded least (Tableau returns NULL when either side is NULL; least skips NULLs)',
      'MIN([Sales], [Cost])',
      'CASE WHEN `sales_amt` IS NULL OR `cost_amt` IS NULL THEN NULL ELSE least(`sales_amt`, `cost_amt`) END',
    ],
    [
      '2-arg MAX → NULL-guarded greatest',
      'MAX([Sales], [Cost])',
      'CASE WHEN `sales_amt` IS NULL OR `cost_amt` IS NULL THEN NULL ELSE greatest(`sales_amt`, `cost_amt`) END',
    ],
    [
      '2-arg MIN is row-level, so it is legal INSIDE an aggregate',
      'SUM(MIN([Sales], [Cost]))',
      'SUM(CASE WHEN `sales_amt` IS NULL OR `cost_amt` IS NULL THEN NULL ELSE least(`sales_amt`, `cost_amt`) END)',
    ],

    // ---- Phase B4 additions: date/aggregate
    ['MAKEDATE', 'MAKEDATE(2020, 1, 5)', 'make_date(2020, 1, 5)'],
    ['DATETIME over a column', 'DATETIME([Order Date])', 'cast(`order_date` as timestamp)'],
    ['DATETIME over an ISO literal', "DATETIME('2020-01-05 10:30:00')", "cast('2020-01-05 10:30:00' as timestamp)"],
    ['PERCENTILE with a literal percentile', 'PERCENTILE([Sales], 0.9)', 'percentile(`sales_amt`, 0.9)'],
    [
      "DATENAME('year', d) — numeric part rendered as text",
      "DATENAME('year', [Order Date])",
      "cast(extract(year FROM `order_date`) as string)",
    ],
    [
      "DATENAME('quarter', d)",
      "DATENAME('quarter', [Order Date])",
      "cast(extract(quarter FROM `order_date`) as string)",
    ],
    [
      "DATENAME('day', d)",
      "DATENAME('day', [Order Date])",
      "cast(extract(day FROM `order_date`) as string)",
    ],
  ];

  for (const [label, formula, expected] of rows) {
    it(`${label}: ${formula}`, () => {
      expect(run(formula)).toBe(expected);
    });
  }
});

describe('translateTableauCalcToSql — compound formulas mixing categories', () => {
  it('IF/aggregate/arithmetic (brief example)', () => {
    expect(run('IF SUM([Sales]) > 0 THEN SUM([Profit]) / SUM([Sales]) ELSE 0 END')).toBe(
      'CASE WHEN (SUM(`sales_amt`) > 0) THEN (SUM(`profit_amt`) / SUM(`sales_amt`)) ELSE 0 END',
    );
  });

  it('null-handling + arithmetic', () => {
    expect(run('IFNULL([Sales], 0) - IFNULL([Cost], 0)')).toBe(
      '(coalesce(`sales_amt`, 0) - coalesce(`cost_amt`, 0))',
    );
  });

  it('nested string functions', () => {
    expect(run('UPPER(LEFT([Name], 3))')).toBe('upper(left(`cust_name`, 3))');
  });

  it('string + logic + comparison', () => {
    expect(run("CONTAINS(UPPER([Name]), 'A') AND [Sales] > 0")).toBe(
      '(instr(upper(`cust_name`), \'A\') > 0 AND (`sales_amt` > 0))',
    );
  });
});

describe('translateTableauCalcToSql — explicit null (never translated)', () => {
  const nulls: Array<[string, string]> = [
    ['LOD FIXED', '{FIXED [Region]: SUM([Sales])}'],
    ['LOD INCLUDE', '{INCLUDE [Region]: SUM([Sales])}'],
    ['LOD EXCLUDE', '{EXCLUDE [Region]: SUM([Sales])}'],
    ['WINDOW_SUM', 'WINDOW_SUM(SUM([Sales]))'],
    ['RUNNING_SUM', 'RUNNING_SUM(SUM([Sales]))'],
    ['INDEX()', 'INDEX()'],
    ['FIRST()', 'FIRST()'],
    ['LAST()', 'LAST()'],
    ['LOOKUP', 'LOOKUP(SUM([Sales]), -1)'],
    ['RANK', 'RANK(SUM([Sales]))'],
    ['RANK_DENSE (a RANK variant)', 'RANK_DENSE(SUM([Sales]))'],
    ['TOTAL', 'TOTAL(SUM([Sales]))'],
    ['ATTR', 'ATTR([Region])'],
    ['[Parameters].[X] ref', '[Parameters].[Threshold]'],
    ['[Parameter 1] legacy ref', '[Parameter 1]'],
    ['RAWSQL_AGG', "RAWSQL_AGG('sum(%1)', [Sales])"],
    ['USERNAME()', 'USERNAME()'],
    ['ISMEMBEROF', "ISMEMBEROF('admins')"],
    ['unimplemented regex function', "REGEXP_MATCH([Name], '^A')"],
    ['unknown/unsupported function generic', 'FOOBAR([Sales])'],
    ['nested aggregate', 'SUM(SUM([Sales]))'],
    ['unresolved field', '[Bogus]'],
    ['unresolved field inside arithmetic (isolated from the + gate via -)', '[Sales] - [Bogus]'],
    ['SPLIT — dropped from scope entirely (finding 5)', "SPLIT([Name], '-', 1)"],
    ["DATEPART('week', ...) — week dropped for DATEPART (finding 4)", "DATEPART('week', [Order Date])"],
    ["DATETRUNC('week', ...) — week dropped for DATETRUNC (finding 4)", "DATETRUNC('week', [Order Date])"],
    [
      "DATEDIFF('week', ...) — week dropped for DATEDIFF (finding 4)",
      "DATEDIFF('week', [Order Date], [Ship Date])",
    ],
    ['+ with a string literal and a field (finding 1: ambiguous, not provably numeric)', "'x' + [Name]"],
    ['+ with two fields (finding 1: ambiguous, not provably numeric)', '[Sales] + [Cost]'],
    ['+ with a field and a numeric literal (finding 1: field is never provably numeric)', '[Sales] + 1'],
    [
      'MIN/MAX over a bare field ref are NOT provably numeric — they preserve argument type (fix-round-2)',
      'MIN([Sales]) + MAX([Cost])',
    ],

    // ---- Phase B3: DATE/DATETIME parse only ISO, never a locale format
    ["DATE('3/4/2020') — locale-ambiguous literal (US March 4 vs. UK April 3)", "DATE('3/4/2020')"],
    ["DATE('Jan 5, 2020') — locale month name", "DATE('Jan 5, 2020')"],
    ["DATETIME('3/4/2020 10:30') — locale-ambiguous literal", "DATETIME('3/4/2020 10:30')"],
    [
      'DATE over a provably-string expression — Tableau would locale-parse it',
      'DATE(STR([Sales]))',
    ],

    // ---- Phase B2: date subtraction (days in Tableau, INTERVAL in Databricks)
    ['TODAY() minus a column — TODAY() is provably a date', 'TODAY() - [Order Date]'],
    ["DATEADD result minus a column", "DATEADD('day', 1, [Order Date]) - [Order Date]"],
    ['a column minus NOW() — the date operand can be on either side', '[Order Date] - NOW()'],

    // ---- Phase B4: rejections inside the new whitelist entries
    ['LOG with 3 args', 'LOG([Sales], 2, 3)'],
    ['3-arg MIN — neither the aggregate nor the least/greatest form', 'MIN([Sales], [Cost], [Profit])'],
    ['PERCENTILE with a non-literal percentile', 'PERCENTILE([Sales], [Pct])'],
    ['PERCENTILE with an out-of-range percentile', 'PERCENTILE([Sales], 90)'],
    ['PERCENTILE nested inside another aggregate', 'SUM(PERCENTILE([Sales], 0.9))'],
    ['PERCENTILE wrapping another aggregate', 'PERCENTILE(SUM([Sales]), 0.9)'],
    ["DATENAME('month', d) — locale month name", "DATENAME('month', [Order Date])"],
    ["DATENAME('weekday', d) — locale weekday name", "DATENAME('weekday', [Order Date])"],
    ["DATENAME('week', d) — week start is convention-dependent", "DATENAME('week', [Order Date])"],
    ['DATENAME with the optional start_of_week third argument', "DATENAME('day', [Order Date], 'monday')"],
    ['ENDSWITH arity', 'ENDSWITH([Name])'],
    ['MAKEDATE arity', 'MAKEDATE(2020, 1)'],
  ];

  for (const [label, formula] of nulls) {
    it(`${label}: ${formula} -> null`, () => {
      expect(run(formula)).toBeNull();
    });
  }
});

/* ------------------------------------------------------------------ Phase B1 */

describe('DATEDIFF boundary semantics (Phase B1)', () => {
  // Tableau's DATEDIFF counts CALENDAR-BOUNDARY CROSSINGS; Databricks' 3-arg
  // datediff(unit, …) counts COMPLETE units. The canonical divergence is
  // DATEDIFF('year', 2020-12-31, 2021-01-01): Tableau says 1, Databricks says 0. What
  // the assertions below pin is that the emitted SQL expresses the boundary count — a
  // difference of calendar-part numbers, never a whole-unit `datediff(year, …)`.
  const rows: Array<[string, string, string]> = [
    [
      'year → difference of the calendar year numbers',
      "DATEDIFF('year', [Order Date], [Ship Date])",
      '(year(`ship_date`) - year(`order_date`))',
    ],
    [
      'quarter → 4 per year plus the quarter-number difference',
      "DATEDIFF('quarter', [Order Date], [Ship Date])",
      '((year(`ship_date`) - year(`order_date`)) * 4 + (quarter(`ship_date`) - quarter(`order_date`)))',
    ],
    [
      'month → 12 per year plus the month-number difference',
      "DATEDIFF('month', [Order Date], [Ship Date])",
      '((year(`ship_date`) - year(`order_date`)) * 12 + (month(`ship_date`) - month(`order_date`)))',
    ],
    [
      'day → the 2-arg date-based form, end date first',
      "DATEDIFF('day', [Order Date], [Ship Date])",
      'datediff(`ship_date`, `order_date`)',
    ],
    [
      'hour → integer division of hour-truncated epoch seconds',
      "DATEDIFF('hour', [Order Date], [Ship Date])",
      "div(unix_timestamp(date_trunc('HOUR', `ship_date`)) - unix_timestamp(date_trunc('HOUR', `order_date`)), 3600)",
    ],
    [
      'minute → same shape, 60 seconds',
      "DATEDIFF('minute', [Order Date], [Ship Date])",
      "div(unix_timestamp(date_trunc('MINUTE', `ship_date`)) - unix_timestamp(date_trunc('MINUTE', `order_date`)), 60)",
    ],
    [
      'second → same shape, 1 second (div by 1 kept for branch uniformity)',
      "DATEDIFF('second', [Order Date], [Ship Date])",
      "div(unix_timestamp(date_trunc('SECOND', `ship_date`)) - unix_timestamp(date_trunc('SECOND', `order_date`)), 1)",
    ],
  ];

  for (const [label, formula, expected] of rows) {
    it(`${label}: ${formula}`, () => {
      expect(run(formula)).toBe(expected);
    });
  }

  it("week stays rejected (Tableau's week start is configurable, Databricks' is ISO)", () => {
    expect(run("DATEDIFF('week', [Order Date], [Ship Date])")).toBeNull();
  });

  it('reads Tableau argument order — DATEDIFF(part, start, end), so the END date leads the SQL', () => {
    // 2020-12-31 → 2021-01-01 is ONE year boundary in Tableau. The emitted expression is
    // year(end) - year(start) = 2021 - 2020 = 1, which is the Tableau answer, not the
    // whole-year answer (0). Swapping the operands would compute -1.
    const sql = run("DATEDIFF('year', [Order Date], [Ship Date])")!;
    expect(sql.indexOf('`ship_date`')).toBeLessThan(sql.indexOf('`order_date`'));
  });

  it('a non-literal unit is still rejected', () => {
    expect(run('DATEDIFF([Region], [Order Date], [Ship Date])')).toBeNull();
  });
});

/* ------------------------------------------------------------------ Phase B5 */

describe('// comment stripping (Phase B5)', () => {
  it('a trailing comment translates identically to the same formula without one', () => {
    const bare = run('SUM([Sales]) / SUM([Cost])');
    expect(bare).toBe('(SUM(`sales_amt`) / SUM(`cost_amt`))');
    expect(run('SUM([Sales]) / SUM([Cost]) // margin ratio')).toBe(bare);
  });

  it('a comment on its own line inside a multi-line formula is dropped', () => {
    expect(run("// headline bucket\nIF [Sales] > 100 THEN 'High' // big deals\nELSE 'Low' END")).toBe(
      "CASE WHEN (`sales_amt` > 100) THEN 'High' ELSE 'Low' END",
    );
  });

  it('a comment mentioning an out-of-scope function does not trip the window gate', () => {
    expect(run('SUM([Sales]) // replaced WINDOW_SUM(SUM([Sales])) during the rebuild')).toBe(
      'SUM(`sales_amt`)',
    );
  });

  it('`//` inside a string literal is data, not a comment', () => {
    expect(run("IFNULL([Name], 'http://example.com')")).toBe(
      "coalesce(`cust_name`, 'http://example.com')",
    );
  });

  it('`//` inside a bracketed field name is data, not a comment', () => {
    const fm = new Map([['a // b', 'weird_col']]);
    expect(translateTableauCalcToSql('[A // B]', fm)?.sql).toBe('`weird_col`');
  });

  it('a single `/` is still division', () => {
    expect(run('[Sales] / [Cost]')).toBe('(`sales_amt` / `cost_amt`)');
  });

  it('a formula that is nothing but a comment is rejected, not silently empty', () => {
    expect(run('// nothing here')).toBeNull();
  });
});

/* ------------------------------------------------------------------ Phase B2 */

describe('catalog types (Phase B2)', () => {
  const withTypes = (formula: string) => runWith(formula, { fieldTypes: TYPES });

  describe('+ resolves to arithmetic when both sides are provably numeric', () => {
    const rows: Array<[string, string]> = [
      ['[Sales] + 1', '(`sales_amt` + 1)'],
      ['[Sales] + [Cost]', '(`sales_amt` + `cost_amt`)'],
      ['[Sales] + [Cost] + [Profit]', '((`sales_amt` + `cost_amt`) + `profit_amt`)'],
      ['SUM([Sales]) + [Cost]', '(SUM(`sales_amt`) + `cost_amt`)'],
    ];
    for (const [formula, expected] of rows) {
      it(`${formula}`, () => {
        expect(withTypes(formula)).toBe(expected);
        // Without the type map the same formula stays rejected — the pre-Phase-B answer.
        expect(run(formula)).toBeNull();
      });
    }
  });

  describe('+ resolves to concat when both sides are provably strings', () => {
    const rows: Array<[string, string]> = [
      ["[Name] + ' Ltd'", "concat(`cust_name`, ' Ltd')"],
      ['[Name] + [Region]', 'concat(`cust_name`, `region_name`)'],
      ["[Name] + ' - ' + [Region]", "concat(concat(`cust_name`, ' - '), `region_name`)"],
      ['UPPER([Name]) + [Region]', 'concat(upper(`cust_name`), `region_name`)'],
    ];
    for (const [formula, expected] of rows) {
      it(`${formula}`, () => {
        expect(withTypes(formula)).toBe(expected);
      });
    }

    it("two string-returning functions concat without any type map (they are provably strings on their own)", () => {
      expect(run("LEFT([Name], 3) + RIGHT([Name], 3)")).toBe(
        'concat(left(`cust_name`, 3), right(`cust_name`, 3))',
      );
    });
  });

  describe('+ stays rejected when the operand kinds are mixed or unknown', () => {
    const rows: string[] = [
      '[Sales] + [Name]',
      '[Name] + 1',
      '[Sales] + [Order Date]',
      '[Sales] + [Pct]', // pct has no catalog type
      '[Flag] + 1',
    ];
    for (const formula of rows) {
      it(`${formula} -> null`, () => {
        expect(withTypes(formula)).toBeNull();
      });
    }
  });

  describe('- is rejected when either operand is provably a date or datetime', () => {
    const rows: string[] = [
      '[Ship Date] - [Order Date]',
      '[Order Date] - 1',
      '1 - [Order Date]',
      "DATETRUNC('month', [Order Date]) - [Order Date]",
      'MAKEDATE(2020, 1, 1) - [Order Date]',
    ];
    for (const formula of rows) {
      it(`${formula} -> null`, () => {
        expect(withTypes(formula)).toBeNull();
      });
    }

    it('numeric subtraction is untouched by the date gate', () => {
      expect(withTypes('[Sales] - [Cost]')).toBe('(`sales_amt` - `cost_amt`)');
    });

    it('DATEDIFF is the supported way to express the same intent', () => {
      expect(withTypes("DATEDIFF('day', [Order Date], [Ship Date])")).toBe(
        'datediff(`ship_date`, `order_date`)',
      );
    });
  });

  describe('DATE()/DATETIME() over a typed string field (Phase B3)', () => {
    it('DATE([<string field>]) is rejected — Tableau would parse it by locale', () => {
      expect(withTypes('DATE([Code])')).toBeNull();
    });

    it('DATETIME([<string field>]) is rejected for the same reason', () => {
      expect(withTypes('DATETIME([Code])')).toBeNull();
    });

    it('DATE([<untyped field>]) still translates — an unknown type withholds nothing', () => {
      expect(run('DATE([Code])')).toBe('to_date(`code_val`)');
    });

    it('DATE([<date field>]) translates', () => {
      expect(withTypes('DATE([Ship Date])')).toBe('to_date(`ship_date`)');
    });

    it('an ISO literal is always fine', () => {
      expect(withTypes("DATE('2020-01-05')")).toBe("to_date('2020-01-05')");
    });
  });

  it('an empty type map behaves exactly like no options at all', () => {
    const empty = { fieldTypes: new Map<string, TableauFieldType>() };
    for (const formula of ['[Sales] + 1', '[Sales] - [Cost]', 'DATE([Code])', 'SUM([Sales])']) {
      expect(runWith(formula, empty)).toBe(run(formula));
    }
  });
});

describe('fieldTypeFromCanonical (Phase B2)', () => {
  const rows: Array<[string | null | undefined, string | null | undefined, TableauFieldType | undefined]> = [
    ['string', null, 'string'],
    ['integer', null, 'numeric'],
    ['float', null, 'numeric'],
    ['decimal(18,2)', null, 'numeric'],
    ['DECIMAL(10,0)', null, 'numeric'],
    ['boolean', null, 'boolean'],
    ['date', null, 'date'],
    ['timestamp', null, 'datetime'],
    ['timestamp_tz', null, 'datetime'],
    // Canonical types with no scalar analogue resolve to undefined EXPLICITLY, so a
    // mismatched raw hint cannot promote them.
    ['time', 'date', undefined],
    ['geography', 'string', undefined],
    ['variant/json', 'string', undefined],
    // Raw Tableau datatypes, used when the canonical column is empty or unrecognized.
    [null, 'integer', 'numeric'],
    [null, 'real', 'numeric'],
    [null, 'string', 'string'],
    [null, 'boolean', 'boolean'],
    [null, 'date', 'date'],
    [null, 'datetime', 'datetime'],
    ['not-a-canonical-type', 'real', 'numeric'],
    // Nothing known either way.
    [null, null, undefined],
    [undefined, undefined, undefined],
    ['', '', undefined],
    [null, 'money', undefined],
  ];

  for (const [canonical, raw, expected] of rows) {
    it(`canonical=${JSON.stringify(canonical)} raw=${JSON.stringify(raw)} -> ${expected}`, () => {
      expect(fieldTypeFromCanonical(canonical, raw)).toBe(expected);
    });
  }

  it('the raw argument is optional', () => {
    expect(fieldTypeFromCanonical('integer')).toBe('numeric');
    expect(fieldTypeFromCanonical(null)).toBeUndefined();
  });

  it('feeds straight into translation', () => {
    const types = new Map<string, TableauFieldType>();
    for (const [key, canonical] of [['sales', 'decimal(18,2)'], ['name', 'string']] as const) {
      const t = fieldTypeFromCanonical(canonical, null);
      if (t) types.set(key, t);
    }
    expect(runWith('[Sales] + 1', { fieldTypes: types })).toBe('(`sales_amt` + 1)');
    expect(runWith("[Name] + '!'", { fieldTypes: types })).toBe("concat(`cust_name`, '!')");
  });
});

/* ------------------------------------------------------------------ Phase B6 */

describe('calc-referencing-calc (Phase B6)', () => {
  it('a ref that is not a column but IS another calc is inlined', () => {
    const calcs = new Map([['net', '[Sales] - [Cost]']]);
    expect(runWith('SUM([Net])', { calcs })).toBe('SUM((`sales_amt` - `cost_amt`))');
  });

  it('the inlined formula is parenthesized so it cannot re-associate', () => {
    const calcs = new Map([['total sales', 'SUM([Sales])']]);
    expect(runWith('[Total Sales] / 2', { calcs })).toBe('((SUM(`sales_amt`)) / 2)');
  });

  it('a physical column always wins over a same-named calc', () => {
    const calcs = new Map([['sales', 'SUM([Cost])']]);
    expect(runWith('[Sales]', { calcs })).toBe('`sales_amt`');
  });

  it('chains through several calcs, and the type oracle follows the chain', () => {
    const calcs = new Map([
      ['doubled', '[Sales] * 2'],
      ['bumped', '[Doubled] + 1'],
      ['final', '[Bumped] - [Cost]'],
    ]);
    // `[Doubled] + 1` only translates because `[Doubled]` resolves to `[Sales] * 2`,
    // which is provably numeric — the + gate reasons through the reference.
    expect(runWith('[Final]', { calcs })).toBe('(((`sales_amt` * 2) + 1) - `cost_amt`)');
  });

  it('string concat also reasons through a calc reference', () => {
    const calcs = new Map([['label', "UPPER([Name])"]]);
    expect(runWith("[Label] + ' Ltd'", { calcs })).toBe("concat((upper(`cust_name`)), ' Ltd')");
  });

  it('a direct cycle is rejected', () => {
    const calcs = new Map([['a', '[B] * 2'], ['b', '[A] * 3']]);
    expect(runWith('[A]', { calcs })).toBeNull();
    expect(runWith('[A] * 10', { calcs })).toBeNull();
  });

  it('a self-reference is rejected', () => {
    const calcs = new Map([['loop', 'SUM([Loop])']]);
    expect(runWith('[Loop]', { calcs })).toBeNull();
  });

  it('a longer cycle is rejected', () => {
    const calcs = new Map([['a', '[B] * 2'], ['b', '[C] * 2'], ['c', '[A] * 2']]);
    expect(runWith('[A]', { calcs })).toBeNull();
  });

  it('a chain of exactly 8 expansions is allowed', () => {
    const calcs = new Map<string, string>();
    for (let i = 0; i < 7; i++) calcs.set(`step${i}`, `[Step${i + 1}] * 2`);
    calcs.set('step7', '[Sales]');
    expect(runWith('[Step0]', { calcs })).not.toBeNull();
  });

  it('a chain of 9 expansions hits the depth limit and is rejected', () => {
    const calcs = new Map<string, string>();
    for (let i = 0; i < 8; i++) calcs.set(`step${i}`, `[Step${i + 1}] * 2`);
    calcs.set('step8', '[Sales]');
    expect(runWith('[Step0]', { calcs })).toBeNull();
  });

  it('a referenced calc that is itself out of scope makes the whole formula null', () => {
    const calcs = new Map([['windowed', 'WINDOW_SUM(SUM([Sales]))']]);
    expect(runWith('[Windowed] * 2', { calcs })).toBeNull();
  });

  it('a referenced calc with an unresolved field of its own makes the whole formula null', () => {
    const calcs = new Map([['broken', '[Bogus] * 2']]);
    expect(runWith('[Broken] * 2', { calcs })).toBeNull();
  });

  it('a referenced calc referencing a parameter makes the whole formula null', () => {
    const calcs = new Map([['thresholded', '[Sales] * [Parameters].[Factor]']]);
    expect(runWith('[Thresholded] * 2', { calcs })).toBeNull();
  });

  it('an aggregate reached THROUGH a calc reference is still a nested aggregate', () => {
    const calcs = new Map([['total sales', 'SUM([Sales])']]);
    expect(runWith('SUM([Total Sales])', { calcs })).toBeNull();
    expect(runWith('AVG([Total Sales] * 2)', { calcs })).toBeNull();
    // …but outside an aggregate the same reference translates.
    expect(runWith('[Total Sales] * 2', { calcs })).toBe('((SUM(`sales_amt`)) * 2)');
  });

  it('a date-typed calc reference still blocks subtraction', () => {
    const calcs = new Map([['month start', "DATETRUNC('month', [Order Date])"]]);
    expect(runWith('[Month Start] - [Order Date]', { calcs, fieldTypes: TYPES })).toBeNull();
  });

  it('comments inside a referenced calc are stripped too', () => {
    const calcs = new Map([['net', '[Sales] - [Cost] // gross margin']]);
    expect(runWith('SUM([Net])', { calcs })).toBe('SUM((`sales_amt` - `cost_amt`))');
  });

  it('an empty calc map behaves exactly like no options at all', () => {
    const empty = { calcs: new Map<string, string>() };
    for (const formula of ['[Bogus]', 'SUM([Sales])', '[Sales] - [Cost]']) {
      expect(runWith(formula, empty)).toBe(run(formula));
    }
  });
});

/* --------------------------------------------------- two-argument call parity */

describe('the two-argument call signature is unchanged', () => {
  it('translateTableauCalcToSql(formula, fieldMap) still works and reports confidence', () => {
    const r = translateTableauCalcToSql('SUM([Sales])', FM);
    expect(r).toEqual({ sql: 'SUM(`sales_amt`)', confidence: 'exact' });
  });

  it('an explicit undefined third argument is the same as omitting it', () => {
    expect(translateTableauCalcToSql('SUM([Sales])', FM, undefined)?.sql).toBe('SUM(`sales_amt`)');
  });

  it('an empty options object is the same as omitting it', () => {
    expect(translateTableauCalcToSql('[Sales] + 1', FM, {})).toBeNull();
  });
});
