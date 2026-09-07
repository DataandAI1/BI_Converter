import { tokenizeCalc } from '../tableau/calc.js';

/**
 * Tableau calc → Databricks SQL deterministic translation tier (Databricks AI/BI rebuild
 * plan, Phase 4; hardened by the 2026-09-03 improvement plan, Phase B).
 * `translateTableauCalcToSql` is a small recursive-descent tokenizer/parser/emitter over
 * an explicit supported-scope function list — reject-by-default: any token or function
 * this file doesn't explicitly recognize returns `null` for the WHOLE formula, never a
 * partial or best-guess translation. Same contract philosophy as `shared.ts`'s
 * `translateTableauCalc` (DAX sibling): tiny, honest, null on anything uncertain.
 *
 * `fieldMap` keys follow the codebase-wide `fieldKey` convention (lowercased, bracket
 * text as-is) so callers can hand this function the exact `physicalByField` map they
 * already build for the rest of the rebuild pipeline (semantic-layer.ts,
 * rebuild-databricks.ts) with no repackaging. Values are raw (unquoted) column
 * identifiers — this module does the backtick-quoting on the way out.
 *
 * The optional third argument (`TranslateOptions`) only ever ADDS information the
 * translator can prove things with; every existing two-argument call keeps its exact
 * behaviour except where the extra knowledge turns a previously-emitted (and provably
 * wrong) translation into a `null` — the direction this module is allowed to move in.
 *  - `fieldTypes` lets `+` disambiguate numeric addition from string concatenation, and
 *    lets `-` refuse a date operand (Tableau's `date - date` is a day count; Databricks'
 *    is an INTERVAL).
 *  - `calcs` lets a calc that references another calculated field translate by inlining
 *    that field's own formula (depth-limited, cycle-safe).
 */

export interface TableauSqlTranslation {
  sql: string;
  confidence: 'exact';
}

/** The scalar-type vocabulary this module reasons about. Deliberately coarse: it only
 *  needs to answer "provably numeric / provably string / provably a date" for the three
 *  gates below. Anything the catalog can't place lands outside the map entirely, and the
 *  gates then behave exactly as they did before types existed. */
export type TableauFieldType = 'numeric' | 'string' | 'date' | 'datetime' | 'boolean';

export interface TranslateOptions {
  /** fieldKey (lowercased, bracket-stripped Tableau field name) → type, when the catalog
   *  knows it. A missing entry means "unknown", never "not that type". */
  fieldTypes?: Map<string, TableauFieldType>;
  /** fieldKey → Tableau formula of OTHER calculated fields on the same datasource, so a
   *  calc that references a calc translates inline. Consulted only for field refs that
   *  are NOT in `fieldMap` (a physical column always wins). */
  calcs?: Map<string, string>;
}

/** Internal-only: every rejection path throws this so the top-level function can turn
 *  it into `null` in one place. Any OTHER thrown error is a real bug and is allowed to
 *  propagate (never silently swallowed) — only this class means "formula out of scope". */
class Unsupported extends Error {}

/* ------------------------------------------------------------------- lexer */

type TokType = 'num' | 'str' | 'ident' | 'field' | 'punct' | 'eof';
interface Tok {
  type: TokType;
  value: string;
}

const TWO_CHAR_PUNCT = new Set(['<=', '>=', '<>', '!=', '==']);
const ONE_CHAR_PUNCT = new Set(['(', ')', ',', '+', '-', '*', '/', '%', '=', '<', '>']);

/** A Tableau `[Parameters].[X]` or legacy `[Parameter 1]` reference is categorically
 *  unsupported — checked independent of `fieldMap` contents so a coincidental map entry
 *  can never accidentally "translate" a parameter. */
function isParameterRef(bracketContent: string): boolean {
  return /^parameters\./i.test(bracketContent) || /^parameter\s/i.test(bracketContent);
}

/**
 * Strip Tableau's only comment syntax — `//` to end of line — before lexing (Phase B5).
 * Without this, any commented calc is rejected outright (`/` `/` lexes as two division
 * operators and then fails to parse), which is a false negative: a comment carries no
 * semantics at all, so a formula and the same formula with trailing commentary must
 * translate identically.
 *
 * The scan is string- and bracket-aware for the same reason the lexer is: a `//` inside
 * `'http://x'` or inside a `[Field // Name]` bracket token is data, not a comment. It
 * preserves the newline that terminates a comment so the remaining text still tokenizes
 * with the correct whitespace boundaries, and it is idempotent (a second pass over the
 * output is a no-op), so callers may apply it more than once.
 */
function stripLineComments(formula: string): string {
  let out = '';
  let i = 0;
  const n = formula.length;
  while (i < n) {
    const c = formula[i];
    if (c === '/' && formula[i + 1] === '/') {
      while (i < n && formula[i] !== '\n') i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      out += quote;
      let j = i + 1;
      while (j < n) {
        out += formula[j];
        if (formula[j] === quote) {
          // Doubled quote = an escaped quote inside the literal, not the terminator.
          if (formula[j + 1] === quote) {
            out += quote;
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }
    if (c === '[') {
      const end = formula.indexOf(']', i + 1);
      if (end === -1) {
        // Unterminated — hand the rest through untouched so `lex` reports the real error.
        out += formula.slice(i);
        i = n;
        continue;
      }
      out += formula.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function lex(formula: string): Tok[] {
  const toks: Tok[] = [];
  const n = formula.length;
  let i = 0;
  while (i < n) {
    const c = formula[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // Any LOD open (`{FIXED`, `{INCLUDE`, `{EXCLUDE`, or any other `{...}` block) is out
    // of scope categorically — reject the instant one appears, anywhere in the formula.
    if (c === '{') throw new Unsupported('LOD block');
    if (c === '[') {
      const end = formula.indexOf(']', i + 1);
      if (end === -1) throw new Unsupported('unterminated field ref');
      const content = formula.slice(i + 1, end);
      toks.push({ type: 'field', value: content });
      i = end + 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let out = '';
      let closed = false;
      while (j < n) {
        if (formula[j] === quote) {
          if (formula[j + 1] === quote) {
            out += quote;
            j += 2;
            continue;
          }
          closed = true;
          j++;
          break;
        }
        out += formula[j];
        j++;
      }
      if (!closed) throw new Unsupported('unterminated string literal');
      toks.push({ type: 'str', value: out });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      let seenDot = false;
      while (j < n && (/[0-9]/.test(formula[j]) || (formula[j] === '.' && !seenDot))) {
        if (formula[j] === '.') seenDot = true;
        j++;
      }
      toks.push({ type: 'num', value: formula.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(formula[j])) j++;
      toks.push({ type: 'ident', value: formula.slice(i, j) });
      i = j;
      continue;
    }
    const two = formula.slice(i, i + 2);
    if (TWO_CHAR_PUNCT.has(two)) {
      toks.push({ type: 'punct', value: two });
      i += 2;
      continue;
    }
    if (ONE_CHAR_PUNCT.has(c)) {
      toks.push({ type: 'punct', value: c });
      i++;
      continue;
    }
    // Anything else — including a stray '.' from a `[DS].[Field]` cross-datasource ref,
    // which this module does not support — is an immediate reject.
    throw new Unsupported(`unexpected character '${c}'`);
  }
  toks.push({ type: 'eof', value: '' });
  return toks;
}

/* --------------------------------------------------------------------- AST */

type Node =
  | { t: 'num'; v: string }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'field'; v: string }
  | { t: 'unary'; a: Node }
  | { t: 'not'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'call'; name: string; args: Node[] }
  | { t: 'if'; branches: Array<{ cond: Node; then: Node }>; else?: Node }
  | { t: 'case'; subject?: Node; branches: Array<{ when: Node; then: Node }>; else?: Node };

const COMPARISON_OPS = new Set(['=', '==', '<>', '!=', '<', '>', '<=', '>=']);
const normalizeCmp = (op: string): string => (op === '==' ? '=' : op === '!=' ? '<>' : op);

/* ------------------------------------------------------------------ parser */

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.i];
  }
  private advance(): Tok {
    return this.toks[this.i++];
  }
  private isIdent(kw: string): boolean {
    const t = this.peek();
    return t.type === 'ident' && t.value.toUpperCase() === kw;
  }
  private expectIdent(kw: string): void {
    if (!this.isIdent(kw)) throw new Unsupported(`expected ${kw}`);
    this.advance();
  }
  private isPunct(v: string): boolean {
    const t = this.peek();
    return t.type === 'punct' && t.value === v;
  }
  private expectPunct(v: string): void {
    if (!this.isPunct(v)) throw new Unsupported(`expected '${v}'`);
    this.advance();
  }

  expectEnd(): void {
    if (this.peek().type !== 'eof') throw new Unsupported('trailing tokens after formula');
  }

  parseExpr(): Node {
    return this.parseOr();
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.isIdent('OR')) {
      this.advance();
      left = { t: 'bin', op: 'OR', a: left, b: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseNot();
    while (this.isIdent('AND')) {
      this.advance();
      left = { t: 'bin', op: 'AND', a: left, b: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Node {
    if (this.isIdent('NOT')) {
      this.advance();
      return { t: 'not', a: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Node {
    const left = this.parseAdd();
    const t = this.peek();
    if (t.type === 'punct' && COMPARISON_OPS.has(t.value)) {
      this.advance();
      const right = this.parseAdd();
      return { t: 'bin', op: normalizeCmp(t.value), a: left, b: right };
    }
    return left;
  }

  private parseAdd(): Node {
    let left = this.parseMul();
    while (this.isPunct('+') || this.isPunct('-')) {
      const op = this.advance().value;
      left = { t: 'bin', op, a: left, b: this.parseMul() };
    }
    return left;
  }

  private parseMul(): Node {
    let left = this.parseUnary();
    while (this.isPunct('*') || this.isPunct('/') || this.isPunct('%')) {
      const op = this.advance().value;
      left = { t: 'bin', op, a: left, b: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Node {
    if (this.isPunct('-')) {
      this.advance();
      return { t: 'unary', a: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const t = this.peek();

    if (t.type === 'num') {
      this.advance();
      return { t: 'num', v: t.value };
    }
    if (t.type === 'str') {
      this.advance();
      return { t: 'str', v: t.value };
    }
    if (t.type === 'field') {
      this.advance();
      if (isParameterRef(t.value)) throw new Unsupported('parameter reference');
      return { t: 'field', v: t.value };
    }
    if (t.type === 'punct' && t.value === '(') {
      this.advance();
      const inner = this.parseExpr();
      this.expectPunct(')');
      return inner;
    }
    if (t.type === 'ident') {
      const upper = t.value.toUpperCase();
      if (upper === 'TRUE') {
        this.advance();
        return { t: 'bool', v: true };
      }
      if (upper === 'FALSE') {
        this.advance();
        return { t: 'bool', v: false };
      }
      if (upper === 'NULL') {
        this.advance();
        return { t: 'null' };
      }
      if (upper === 'IF') {
        this.advance();
        return this.parseIf();
      }
      if (upper === 'CASE') {
        this.advance();
        return this.parseCase();
      }
      this.advance();
      if (!this.isPunct('(')) throw new Unsupported(`bare identifier '${t.value}'`);
      this.advance();
      const args: Node[] = [];
      if (!this.isPunct(')')) {
        args.push(this.parseExpr());
        while (this.isPunct(',')) {
          this.advance();
          args.push(this.parseExpr());
        }
      }
      this.expectPunct(')');
      return { t: 'call', name: upper, args };
    }
    throw new Unsupported('unexpected token');
  }

  private parseIf(): Node {
    const branches: Array<{ cond: Node; then: Node }> = [];
    const cond = this.parseExpr();
    this.expectIdent('THEN');
    const then = this.parseExpr();
    branches.push({ cond, then });
    while (this.isIdent('ELSEIF')) {
      this.advance();
      const c = this.parseExpr();
      this.expectIdent('THEN');
      const th = this.parseExpr();
      branches.push({ cond: c, then: th });
    }
    let elseNode: Node | undefined;
    if (this.isIdent('ELSE')) {
      this.advance();
      elseNode = this.parseExpr();
    }
    this.expectIdent('END');
    return { t: 'if', branches, else: elseNode };
  }

  private parseCase(): Node {
    let subject: Node | undefined;
    if (!this.isIdent('WHEN')) subject = this.parseExpr();
    this.expectIdent('WHEN');
    const branches: Array<{ when: Node; then: Node }> = [];
    let when = this.parseExpr();
    this.expectIdent('THEN');
    let then = this.parseExpr();
    branches.push({ when, then });
    while (this.isIdent('WHEN')) {
      this.advance();
      when = this.parseExpr();
      this.expectIdent('THEN');
      then = this.parseExpr();
      branches.push({ when, then });
    }
    let elseNode: Node | undefined;
    if (this.isIdent('ELSE')) {
      this.advance();
      elseNode = this.parseExpr();
    }
    this.expectIdent('END');
    return { t: 'case', subject, branches, else: elseNode };
  }
}

/** Comment-strip → lex → parse → assert nothing is left over. Used both for the formula
 *  the caller handed in and for every calc inlined through `opts.calcs`, so a referenced
 *  calc is held to exactly the same scope rules as a top-level one. */
function parseFormula(formula: string): Node {
  const parser = new Parser(lex(stripLineComments(formula)));
  const ast = parser.parseExpr();
  parser.expectEnd();
  return ast;
}

/* ------------------------------------------------------------------ emitter */

/** Inlining bound (Phase B6). A calc chain deeper than this is refused rather than
 *  expanded — the emitted SQL would be unreadable and the cost superlinear, and a real
 *  workbook's calc chains are shallow. */
const MAX_CALC_DEPTH = 8;

interface Ctx {
  fieldMap: Map<string, string>;
  fieldTypes: Map<string, TableauFieldType>;
  calcs: Map<string, string>;
  /** How many `opts.calcs` expansions deep we currently are. */
  depth: number;
  /** fieldKeys on the current expansion path — a repeat is a cycle, not a deeper chain. */
  expanding: ReadonlySet<string>;
  /** Parse-once cache for `opts.calcs` formulas (parsing is pure, so sharing is safe). */
  astCache: Map<string, Node>;
}

const sqlStr = (v: string): string => `'${v.replace(/'/g, "''")}'`;
const quoteIdent = (col: string): string => `\`${col.replace(/`/g, '``')}\``;

/** Character count as Databricks' `length`/`left`/`right` count it. Spark measures a
 *  string in code points; JavaScript's `String.length` measures UTF-16 code units, so an
 *  astral character (emoji, rare CJK) would make a precomputed length one too large and
 *  silently break a STARTSWITH/ENDSWITH prefix comparison. Spreading the string iterates
 *  code points, which is what Spark counts. */
const charLength = (v: string): number => [...v].length;

/** `DATEADD('week', n, d)` is convention-independent (it's just `n * 7` days), so `week`
 *  stays supported there. `DATEPART`/`DATETRUNC`/`DATEDIFF` need to know WHERE a week
 *  starts to be correct — Tableau's week start is configurable (defaults to Sunday, but
 *  is a workbook/data-source setting) while Databricks' `date_part`/`date_trunc`/
 *  `datediff` use the ISO convention (Monday start). Since that start day can silently
 *  differ from whatever the source workbook was configured with, `week` is not provably
 *  equivalent for these three — reject-by-default (review-round-1 finding 4). */
const DATE_UNITS = new Set(['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second']);
const DATE_UNITS_NO_WEEK = new Set(['year', 'quarter', 'month', 'day', 'hour', 'minute', 'second']);

/** DATENAME's supported units (Phase B4). `year`/`quarter`/`day` render as a plain
 *  number in Tableau ("2004", "2", "15"), so `cast(extract(<unit> FROM d) as string)` is
 *  exactly the same text. `month` and `weekday` render as LOCALE NAMES ("April",
 *  "Thursday") that depend on the workbook locale and have no Databricks equivalent that
 *  is provably the same string — rejected, along with `week` (see DATE_UNITS_NO_WEEK). */
const DATENAME_UNITS = new Set(['year', 'quarter', 'day']);

/** DATEPART/DATETRUNC/DATEADD/DATEDIFF/DATENAME's unit argument must be a literal string
 *  naming one of `allowed`'s units — a computed/dynamic unit, or one outside that list,
 *  is rejected rather than passed through unchecked. */
function literalUnit(node: Node, fn: string, allowed: Set<string>): string {
  if (node.t !== 'str') throw new Unsupported(`${fn} unit must be a string literal`);
  const v = node.v.toLowerCase();
  if (!allowed.has(v)) throw new Unsupported(`${fn} unsupported unit '${v}'`);
  return v;
}

const AGG_FUNCS = new Set(['SUM', 'MIN', 'MAX', 'AVG', 'COUNT', 'COUNTD', 'MEDIAN', 'STDEV', 'VAR']);

/** Aggregates whose result is numeric-only in Tableau regardless of the argument's own
 *  type — `COUNT`/`COUNTD` always return an integer, and `SUM`/`AVG`/`MEDIAN`/`STDEV`/
 *  `VAR`/`PERCENTILE` are only ever defined over a numeric argument in the first place.
 *  `MIN`/`MAX` are deliberately excluded: unlike the rest of `AGG_FUNCS`, they PRESERVE
 *  their argument's type in Tableau (`MIN([Name])` is a string), so `isProvably` handles
 *  them separately below by recursing into their arguments instead of trusting
 *  membership alone (review-round-1 fix-round-2). */
const UNCONDITIONALLY_NUMERIC_AGGS = new Set([
  'SUM', 'AVG', 'COUNT', 'COUNTD', 'MEDIAN', 'STDEV', 'VAR', 'PERCENTILE',
]);

/** Functions whose result is provably numeric regardless of argument content — the
 *  whitelist `isProvably('numeric')` consults for the `+` ambiguity gate (review-round-1
 *  finding 1). Deliberately narrow: anything not listed here is treated as "unknown
 *  type" for that gate, even if it happens to be numeric in a given formula. */
const NUMERIC_RESULT_FUNCS = new Set([
  'LEN', 'ROUND', 'ABS', 'CEILING', 'FLOOR', 'INT', 'FLOAT', 'DATEDIFF', 'DATEPART', 'YEAR',
  'MONTH', 'DAY', 'ZN', 'FIND', 'POWER', 'SQRT', 'EXP', 'LN', 'LOG', 'SIGN', 'DIV',
]);

/** Functions whose result is provably a string regardless of argument content — the
 *  mirror of `NUMERIC_RESULT_FUNCS` for the `+` → `concat` branch and for the
 *  "don't hand a locale-formatted string to `to_date`" gate on DATE/DATETIME. */
const STRING_RESULT_FUNCS = new Set([
  'LEFT', 'RIGHT', 'MID', 'UPPER', 'LOWER', 'TRIM', 'LTRIM', 'RTRIM', 'STR', 'REPLACE', 'DATENAME',
]);

/** Functions whose result is provably a date/datetime. Drives the `-` rejection: Tableau
 *  evaluates `date - date` to a NUMBER OF DAYS, Databricks evaluates it to an INTERVAL,
 *  so the two are not the same expression and there is no cast that makes them one
 *  without changing the surrounding arithmetic. `DATEPARSE` is deliberately absent (it
 *  takes a locale format string this module cannot verify). */
const DATE_RESULT_FUNCS = new Set([
  'DATE', 'TODAY', 'NOW', 'DATETRUNC', 'DATEADD', 'MAKEDATE', 'DATETIME',
]);

type ProvableKind = 'numeric' | 'string' | 'date';

function kindMatches(t: TableauFieldType, kind: ProvableKind): boolean {
  if (kind === 'numeric') return t === 'numeric';
  if (kind === 'string') return t === 'string';
  return t === 'date' || t === 'datetime';
}

/**
 * "Is this subexpression PROVABLY of `kind`?" — the single conservative type oracle
 * behind three gates:
 *
 *  1. `+`. Tableau's `+` is overloaded: numeric addition on numbers, string
 *     concatenation on strings. Databricks SQL `+` is not — it coerces both sides to
 *     DOUBLE, so translating `[Name] + [City]` as `+` would produce a type error or an
 *     unrelated numeric result instead of the concatenation. Both-numeric → `+`;
 *     both-string → `concat` (Spark's `concat` returns NULL when any argument is NULL,
 *     matching Tableau's NULL propagation through `+`); anything else → reject.
 *  2. `-`. Rejected outright when either side is provably a date (see
 *     `DATE_RESULT_FUNCS`).
 *  3. `DATE(x)` / `DATETIME(x)`. Rejected when `x` is provably a string, because Tableau
 *     parses locale-formatted strings there and Spark's `to_date`/`cast` accept only ISO
 *     — a locale literal would silently become NULL.
 *
 * "Unknown" always answers `false`, which for gate 1 means reject and for gates 2/3
 * means "translate as before" — i.e. missing type information never invents a
 * translation, it only ever withholds one.
 *
 * A field ref resolves the same way it does at emit time: a physical column (in
 * `fieldMap`) takes its type from `fieldTypes` or stays unknown; otherwise a referenced
 * calc from `opts.calcs` is classified by recursing into ITS formula, with the same
 * cycle/depth guard the emitter uses.
 */
function isProvably(
  node: Node,
  ctx: Ctx,
  kind: ProvableKind,
  seen: ReadonlySet<string> = ctx.expanding,
): boolean {
  switch (node.t) {
    case 'num':
      return kind === 'numeric';
    case 'str':
      return kind === 'string';
    case 'unary':
      // Unary minus only ever applies to a number in Tableau.
      return kind === 'numeric';
    case 'bin':
      // `a + b` preserves the (single) operand kind: number + number is a number,
      // string + string is a string. Every other arithmetic operator is numeric-only.
      if (node.op === '+') {
        return isProvably(node.a, ctx, kind, seen) && isProvably(node.b, ctx, kind, seen);
      }
      if (node.op === '-' || node.op === '*' || node.op === '/' || node.op === '%') {
        return kind === 'numeric';
      }
      return false;
    case 'field': {
      const key = node.v.toLowerCase();
      const t = ctx.fieldTypes.get(key);
      if (t !== undefined) return kindMatches(t, kind);
      // A physical column with no catalog type is unknown — never fall through to a
      // same-named calc, because the emitter would not either.
      if (ctx.fieldMap.has(key)) return false;
      if (!ctx.calcs.has(key) || seen.has(key) || seen.size >= MAX_CALC_DEPTH) return false;
      let ast: Node;
      try {
        ast = calcAst(key, ctx);
      } catch {
        // A referenced calc that does not even parse is unknown here; the emitter will
        // reject the whole formula when it reaches that reference anyway.
        return false;
      }
      return isProvably(ast, ctx, kind, new Set([...seen, key]));
    }
    case 'call':
      // MIN/MAX preserve their arguments' type in both their 1-arg (aggregate) and
      // 2-arg (row-level least/greatest) forms, so they are of `kind` exactly when
      // every argument is.
      if (node.name === 'MIN' || node.name === 'MAX') {
        return (
          (node.args.length === 1 || node.args.length === 2) &&
          node.args.every((a) => isProvably(a, ctx, kind, seen))
        );
      }
      if (kind === 'numeric') {
        return UNCONDITIONALLY_NUMERIC_AGGS.has(node.name) || NUMERIC_RESULT_FUNCS.has(node.name);
      }
      if (kind === 'string') return STRING_RESULT_FUNCS.has(node.name);
      return DATE_RESULT_FUNCS.has(node.name);
    default:
      // Field-free literals of other kinds, comparisons, IF/CASE — deliberately unknown.
      return false;
  }
}

function arity(args: Node[], allowed: number[], name: string): void {
  if (!allowed.includes(args.length)) throw new Unsupported(`${name} arity`);
}

type ScalarHandler = (args: Node[], ctx: Ctx, inAgg: boolean) => string;

function e(node: Node, ctx: Ctx, inAgg: boolean): string {
  return emitNode(node, ctx, inAgg);
}

/** ISO calendar date, the only literal form Spark's `to_date(str)` parses without a
 *  format argument. Tableau's `DATE('…')` additionally accepts the workbook's locale
 *  formats (`3/4/2020` is March 4th in en-US and April 3rd in en-GB), which is precisely
 *  why a non-ISO literal is refused instead of translated (Phase B3). */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Same argument for `DATETIME('…')`, extended with the ISO time part. */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/;

/** Shared DATE/DATETIME argument gate: an ISO literal is emitted as-is, a provably
 *  string expression is refused (locale parsing is not provable), and anything else —
 *  a bare column, a date-returning call — passes through to the cast/`to_date`, which is
 *  what this module already did before types existed. */
function dateLikeArg(node: Node, ctx: Ctx, inAgg: boolean, fn: string, iso: RegExp): string {
  if (node.t === 'str') {
    if (!iso.test(node.v)) {
      throw new Unsupported(`${fn} literal '${node.v}' is not ISO — Tableau parses it by locale`);
    }
    return sqlStr(node.v);
  }
  if (isProvably(node, ctx, 'string')) {
    throw new Unsupported(`${fn} over a string expression — locale parsing is not provable`);
  }
  return e(node, ctx, inAgg);
}

/**
 * DATEDIFF for the sub-day units (Phase B1). Tableau counts BOUNDARY CROSSINGS, not
 * complete units: `DATEDIFF('hour', 10:59, 11:00)` is 1, while Databricks'
 * `datediff('hour', …)` returns 0 because less than one whole hour elapsed. Truncating
 * both endpoints to the unit boundary first turns "boundaries crossed" into "whole units
 * between the truncated endpoints", which is then exact.
 *
 * The subtraction of two unit-truncated epoch seconds is always an exact multiple of
 * `seconds` (both endpoints sit on a boundary of the same unit, and DST shifts move
 * whole hours), so the division is exact and the choice of rounding is immaterial —
 * `div` is used rather than `cast(… / n as bigint)` because it is Databricks' integral
 * division operator and yields a BIGINT directly, matching Tableau's integer result,
 * where the cast form would first produce a DOUBLE and lose precision on second-level
 * differences beyond 2^53. `div(x, 1)` for `second` is `x`; it is emitted for uniformity
 * of the three branches.
 */
function truncatedUnitDiff(unit: string, seconds: number, start: string, end: string): string {
  const at = (x: string) => `unix_timestamp(date_trunc('${unit}', ${x}))`;
  return `div(${at(end)} - ${at(start)}, ${seconds})`;
}

const SCALAR_FUNCS: Record<string, ScalarHandler> = {
  LEFT: (a, ctx, ia) => {
    arity(a, [2], 'LEFT');
    return `left(${e(a[0], ctx, ia)}, ${e(a[1], ctx, ia)})`;
  },
  RIGHT: (a, ctx, ia) => {
    arity(a, [2], 'RIGHT');
    return `right(${e(a[0], ctx, ia)}, ${e(a[1], ctx, ia)})`;
  },
  MID: (a, ctx, ia) => {
    arity(a, [2, 3], 'MID');
    return a.length === 2
      ? `substr(${e(a[0], ctx, ia)}, ${e(a[1], ctx, ia)})`
      : `substr(${e(a[0], ctx, ia)}, ${e(a[1], ctx, ia)}, ${e(a[2], ctx, ia)})`;
  },
  UPPER: (a, ctx, ia) => {
    arity(a, [1], 'UPPER');
    return `upper(${e(a[0], ctx, ia)})`;
  },
  LOWER: (a, ctx, ia) => {
    arity(a, [1], 'LOWER');
    return `lower(${e(a[0], ctx, ia)})`;
  },
  TRIM: (a, ctx, ia) => {
    arity(a, [1], 'TRIM');
    return `trim(${e(a[0], ctx, ia)})`;
  },
  LTRIM: (a, ctx, ia) => {
    arity(a, [1], 'LTRIM');
    return `ltrim(${e(a[0], ctx, ia)})`;
  },
  RTRIM: (a, ctx, ia) => {
    arity(a, [1], 'RTRIM');
    return `rtrim(${e(a[0], ctx, ia)})`;
  },
  LEN: (a, ctx, ia) => {
    arity(a, [1], 'LEN');
    return `length(${e(a[0], ctx, ia)})`;
  },
  // CONTAINS always emits instr(...) > 0 — a fixed substring search, immune to LIKE
  // metacharacters (`%`, `_`) inside the second argument. A LIKE-based fast path for a
  // literal second argument (the original design) is NOT provably equivalent whenever
  // that literal itself contains `%` or `_`, since those would then match as wildcards
  // instead of literal characters (review-round-1 finding 2) — so the fast path is
  // dropped entirely rather than patched with a metacharacter-escaping special case.
  CONTAINS: (a, ctx, ia) => {
    arity(a, [2], 'CONTAINS');
    return `instr(${e(a[0], ctx, ia)}, ${e(a[1], ctx, ia)}) > 0`;
  },
  // STARTSWITH/ENDSWITH are provable via LEFT/RIGHT + an exact-length comparison instead
  // of LIKE, for the same metacharacter reason: there is no pattern for `%`/`_` to be
  // misread in. With a literal second argument the length is a translate-time constant
  // (counted in CODE POINTS, the unit Spark's `left`/`right` use — see `charLength`);
  // with a non-literal one it is `length(y)`, computed per row, which is equally exact
  // (Phase B4 lifts the old literal-only restriction).
  //   Equivalence on the edges: an empty `y` gives `left(x, 0) = ''` → true, matching
  //   Tableau; a `y` longer than `x` gives back all of `x`, which cannot equal a strictly
  //   longer `y`, → false, again matching; a NULL on either side makes both sides of the
  //   comparison NULL-propagating, as Tableau's do.
  STARTSWITH: (a, ctx, ia) => {
    arity(a, [2], 'STARTSWITH');
    const hay = e(a[0], ctx, ia);
    if (a[1].t === 'str') return `left(${hay}, ${charLength(a[1].v)}) = ${sqlStr(a[1].v)}`;
    const needle = e(a[1], ctx, ia);
    return `left(${hay}, length(${needle})) = ${needle}`;
  },
  ENDSWITH: (a, ctx, ia) => {
    arity(a, [2], 'ENDSWITH');
    const hay = e(a[0], ctx, ia);
    if (a[1].t === 'str') return `right(${hay}, ${charLength(a[1].v)}) = ${sqlStr(a[1].v)}`;
    const needle = e(a[1], ctx, ia);
    return `right(${hay}, length(${needle})) = ${needle}`;
  },
  FIND: (a, ctx, ia) => {
    arity(a, [2], 'FIND');
    return `instr(${e(a[0], ctx, ia)}, ${e(a[1], ctx, ia)})`;
  },
  REPLACE: (a, ctx, ia) => {
    arity(a, [3], 'REPLACE');
    return `replace(${e(a[0], ctx, ia)}, ${e(a[1], ctx, ia)}, ${e(a[2], ctx, ia)})`;
  },
  // SPLIT is deliberately NOT in scope (review-round-1 finding 5): Tableau's
  // out-of-range token returns NULL, `split_part` returns `''` — and `nullif(x, '')`
  // would wrongly convert a legitimately-empty (in-range) token to NULL too, so there is
  // no provably-equivalent translation. Any `SPLIT(...)` call falls through to the
  // "unsupported function" rejection below (not listed in SCALAR_FUNCS).

  // 3-arg IIF(test, t, f) → CASE WHEN test THEN t WHEN NOT (test) THEN f END — the extra
  // `WHEN NOT (test)` branch matters: Tableau's IIF returns NULL when `test` itself is
  // unknown/NULL, but a plain `CASE WHEN test THEN t ELSE f END` would fall through to
  // `f` in that case (SQL's ELSE catches every non-true WHEN, including NULL). With no
  // ELSE, a NULL `test` matches neither WHEN and the CASE itself evaluates to NULL,
  // matching IIF exactly (review-round-1 finding 3). 4-arg IIF(test, t, f, u) supplies
  // that ELSE explicitly. (Plain IF/ELSEIF/ELSE and CASE/WHEN/END stay a direct CASE
  // translation with no such branch: Tableau's own IF documentation states an
  // unknown/NULL condition falls through to ELSE, the same behavior SQL CASE already
  // has — there is no divergence to correct there.)
  IIF: (a, ctx, ia) => {
    arity(a, [3, 4], 'IIF');
    const test = e(a[0], ctx, ia);
    const t = e(a[1], ctx, ia);
    const f = e(a[2], ctx, ia);
    const elseClause = a.length === 4 ? ` ELSE ${e(a[3], ctx, ia)}` : '';
    return `CASE WHEN ${test} THEN ${t} WHEN NOT (${test}) THEN ${f}${elseClause} END`;
  },

  DATEPART: (a, ctx, ia) => {
    arity(a, [2], 'DATEPART');
    const unit = literalUnit(a[0], 'DATEPART', DATE_UNITS_NO_WEEK);
    return `date_part(${sqlStr(unit)}, ${e(a[1], ctx, ia)})`;
  },
  // DATENAME('year'|'quarter'|'day', d): Tableau renders these three parts as the bare
  // number as text ("2004", "2", "15"), which `cast(extract(<unit> FROM d) as string)`
  // reproduces exactly. 'month'/'weekday' render locale NAMES and are refused above.
  DATENAME: (a, ctx, ia) => {
    arity(a, [2], 'DATENAME');
    const unit = literalUnit(a[0], 'DATENAME', DATENAME_UNITS);
    return `cast(extract(${unit} FROM ${e(a[1], ctx, ia)}) as string)`;
  },
  DATETRUNC: (a, ctx, ia) => {
    arity(a, [2], 'DATETRUNC');
    const unit = literalUnit(a[0], 'DATETRUNC', DATE_UNITS_NO_WEEK);
    return `date_trunc(${sqlStr(unit.toUpperCase())}, ${e(a[1], ctx, ia)})`;
  },
  TODAY: (a) => {
    arity(a, [0], 'TODAY');
    return 'current_date';
  },
  NOW: (a) => {
    arity(a, [0], 'NOW');
    return 'current_timestamp';
  },
  YEAR: (a, ctx, ia) => {
    arity(a, [1], 'YEAR');
    return `extract(year FROM ${e(a[0], ctx, ia)})`;
  },
  MONTH: (a, ctx, ia) => {
    arity(a, [1], 'MONTH');
    return `extract(month FROM ${e(a[0], ctx, ia)})`;
  },
  DAY: (a, ctx, ia) => {
    arity(a, [1], 'DAY');
    return `extract(day FROM ${e(a[0], ctx, ia)})`;
  },
  // Bare-identifier unit form (`dateadd(MONTH, 3, d)`) is the documented Databricks SQL
  // extended syntax for DATEADD — see
  // https://docs.databricks.com/aws/en/sql/language-manual/functions/dateadd — not a
  // shorthand this module invented.
  DATEADD: (a, ctx, ia) => {
    arity(a, [3], 'DATEADD');
    const unit = literalUnit(a[0], 'DATEADD', DATE_UNITS);
    return `dateadd(${unit}, ${e(a[1], ctx, ia)}, ${e(a[2], ctx, ia)})`;
  },
  /**
   * DATEDIFF(part, start, end) — Tableau's argument order, start first (Phase B1).
   *
   * Databricks' 3-arg `datediff(unit, start, end)` counts COMPLETE units; Tableau counts
   * CALENDAR-BOUNDARY CROSSINGS. `DATEDIFF('year', 2020-12-31, 2021-01-01)` is 1 in
   * Tableau (one new-year boundary was crossed) and 0 in Databricks (one day is not a
   * whole year). Passing the unit straight through was therefore silently wrong for
   * every unit except `day`, and this emits boundary-counting SQL instead:
   *  - year:    difference of the calendar year numbers — one term per boundary crossed.
   *  - quarter: years × 4 quarters + the quarter-number difference; the same identity,
   *             since quarters partition a year into exactly 4.
   *  - month:   years × 12 + the month-number difference (12 months partition a year).
   *  - day:     the 2-arg `datediff(end, start)`, which is date-based (its arguments are
   *             cast to DATE), i.e. already a count of midnight boundaries — exact.
   *  - hour/minute/second: see `truncatedUnitDiff`.
   * All six double-evaluate their endpoint expressions; those are pure scalar SQL, so
   * this is a readability/cost tradeoff, not a semantic one.
   */
  DATEDIFF: (a, ctx, ia) => {
    arity(a, [3], 'DATEDIFF');
    const unit = literalUnit(a[0], 'DATEDIFF', DATE_UNITS_NO_WEEK);
    const start = e(a[1], ctx, ia);
    const end = e(a[2], ctx, ia);
    switch (unit) {
      case 'year':
        return `(year(${end}) - year(${start}))`;
      case 'quarter':
        return `((year(${end}) - year(${start})) * 4 + (quarter(${end}) - quarter(${start})))`;
      case 'month':
        return `((year(${end}) - year(${start})) * 12 + (month(${end}) - month(${start})))`;
      case 'day':
        return `datediff(${end}, ${start})`;
      case 'hour':
        return truncatedUnitDiff('HOUR', 3600, start, end);
      case 'minute':
        return truncatedUnitDiff('MINUTE', 60, start, end);
      case 'second':
        return truncatedUnitDiff('SECOND', 1, start, end);
    }
    /* c8 ignore next */
    throw new Unsupported(`DATEDIFF unsupported unit '${unit}'`);
  },

  IFNULL: (a, ctx, ia) => {
    arity(a, [2], 'IFNULL');
    return `coalesce(${e(a[0], ctx, ia)}, ${e(a[1], ctx, ia)})`;
  },
  ZN: (a, ctx, ia) => {
    arity(a, [1], 'ZN');
    return `coalesce(${e(a[0], ctx, ia)}, 0)`;
  },
  ISNULL: (a, ctx, ia) => {
    arity(a, [1], 'ISNULL');
    return `(${e(a[0], ctx, ia)} IS NULL)`;
  },

  STR: (a, ctx, ia) => {
    arity(a, [1], 'STR');
    return `cast(${e(a[0], ctx, ia)} as string)`;
  },
  INT: (a, ctx, ia) => {
    arity(a, [1], 'INT');
    return `cast(${e(a[0], ctx, ia)} as int)`;
  },
  FLOAT: (a, ctx, ia) => {
    arity(a, [1], 'FLOAT');
    return `cast(${e(a[0], ctx, ia)} as double)`;
  },
  DATE: (a, ctx, ia) => {
    arity(a, [1], 'DATE');
    return `to_date(${dateLikeArg(a[0], ctx, ia, 'DATE', ISO_DATE_RE)})`;
  },
  DATETIME: (a, ctx, ia) => {
    arity(a, [1], 'DATETIME');
    return `cast(${dateLikeArg(a[0], ctx, ia, 'DATETIME', ISO_TIMESTAMP_RE)} as timestamp)`;
  },
  // MAKEDATE(year, month, day) → make_date(...): both build a date from three integer
  // parts with the same argument order, and both yield NULL for an impossible date
  // (2020-02-30) rather than a silently shifted one.
  MAKEDATE: (a, ctx, ia) => {
    arity(a, [3], 'MAKEDATE');
    return `make_date(${e(a[0], ctx, ia)}, ${e(a[1], ctx, ia)}, ${e(a[2], ctx, ia)})`;
  },
  ABS: (a, ctx, ia) => {
    arity(a, [1], 'ABS');
    return `abs(${e(a[0], ctx, ia)})`;
  },
  ROUND: (a, ctx, ia) => {
    arity(a, [1, 2], 'ROUND');
    return a.length === 1 ? `round(${e(a[0], ctx, ia)})` : `round(${e(a[0], ctx, ia)}, ${e(a[1], ctx, ia)})`;
  },
  CEILING: (a, ctx, ia) => {
    arity(a, [1], 'CEILING');
    return `ceil(${e(a[0], ctx, ia)})`;
  },
  FLOOR: (a, ctx, ia) => {
    arity(a, [1], 'FLOOR');
    return `floor(${e(a[0], ctx, ia)})`;
  },
  // Elementary math, one-for-one with Databricks' identically-named IEEE-754 functions
  // over the same domains: POWER(x, y)/power, SQRT/sqrt, EXP/exp, LN/ln, SIGN/sign
  // (-1/0/1 in both). Out-of-domain inputs are NaN/NULL in both engines rather than
  // differently-defined values, so there is no divergence to correct.
  POWER: (a, ctx, ia) => {
    arity(a, [2], 'POWER');
    return `power(${e(a[0], ctx, ia)}, ${e(a[1], ctx, ia)})`;
  },
  SQRT: (a, ctx, ia) => {
    arity(a, [1], 'SQRT');
    return `sqrt(${e(a[0], ctx, ia)})`;
  },
  EXP: (a, ctx, ia) => {
    arity(a, [1], 'EXP');
    return `exp(${e(a[0], ctx, ia)})`;
  },
  LN: (a, ctx, ia) => {
    arity(a, [1], 'LN');
    return `ln(${e(a[0], ctx, ia)})`;
  },
  // Tableau's LOG(number, [base]) defaults to base 10, and puts the base SECOND;
  // Databricks' `log(base, expr)` puts it FIRST and has no 1-arg base-10 form (its 1-arg
  // `log` is the natural log). Hence the explicit `log10` for the 1-arg case and the
  // deliberate argument swap for the 2-arg case — passing them through in source order
  // would compute log_x(base).
  LOG: (a, ctx, ia) => {
    arity(a, [1, 2], 'LOG');
    return a.length === 1
      ? `log10(${e(a[0], ctx, ia)})`
      : `log(${e(a[1], ctx, ia)}, ${e(a[0], ctx, ia)})`;
  },
  SIGN: (a, ctx, ia) => {
    arity(a, [1], 'SIGN');
    return `sign(${e(a[0], ctx, ia)})`;
  },
  // Tableau's DIV(integer1, integer2) returns the integer part of the division —
  // truncation toward zero — which is exactly Databricks' `div` (IntegralDivide).
  DIV: (a, ctx, ia) => {
    arity(a, [2], 'DIV');
    return `div(${e(a[0], ctx, ia)}, ${e(a[1], ctx, ia)})`;
  },
};

function emitCall(node: Extract<Node, { t: 'call' }>, ctx: Ctx, inAgg: boolean): string {
  const { name, args } = node;

  // Two-argument MIN/MAX are ROW-LEVEL in Tableau (the element-wise minimum/maximum of
  // two expressions), not aggregates — Databricks spells those `least`/`greatest`. They
  // are therefore legal inside an aggregate and do not themselves open one, so `inAgg`
  // passes through unchanged. Checked before the AGG_FUNCS branch, which owns the 1-arg
  // aggregate forms of the same two names.
  //   Databricks' `least`/`greatest` SKIP NULL arguments (`least(5, NULL)` = 5) while
  //   Tableau's two-argument MIN/MAX return NULL when either argument is NULL, so the
  //   bare function is NOT equivalent. The explicit NULL guard makes it exact; the two
  //   operands are evaluated twice, which is a cost, not a semantic difference.
  if ((name === 'MIN' || name === 'MAX') && args.length === 2) {
    const fn = name === 'MIN' ? 'least' : 'greatest';
    const a = e(args[0], ctx, inAgg);
    const b = e(args[1], ctx, inAgg);
    return `CASE WHEN ${a} IS NULL OR ${b} IS NULL THEN NULL ELSE ${fn}(${a}, ${b}) END`;
  }

  // PERCENTILE(expr, p) is an aggregate in Tableau, so it obeys the same
  // no-nested-aggregate rule as AGG_FUNCS. Databricks' `percentile(col, p)` is the exact
  // (interpolating) percentile over the same 0..1 percentage domain. `p` must be a
  // literal in range: a computed percentage cannot be range-checked at translate time,
  // and Spark errors rather than returning NULL when it is out of range.
  if (name === 'PERCENTILE') {
    if (inAgg) throw new Unsupported('nested aggregate');
    arity(args, [2], 'PERCENTILE');
    const p = args[1];
    if (p.t !== 'num') throw new Unsupported('PERCENTILE percentile must be a numeric literal');
    const pv = Number(p.v);
    if (!Number.isFinite(pv) || pv < 0 || pv > 1) {
      throw new Unsupported('PERCENTILE percentile must be between 0 and 1');
    }
    return `percentile(${e(args[0], ctx, true)}, ${p.v})`;
  }

  if (AGG_FUNCS.has(name)) {
    // Reject-by-default extends to nesting: Tableau never nests aggregates, and a
    // translation that silently flattened SUM(SUM(...)) would be exactly the
    // wrong-but-plausible outcome this module exists to avoid.
    if (inAgg) throw new Unsupported('nested aggregate');
    arity(args, [1], name);
    const arg = e(args[0], ctx, true);
    switch (name) {
      case 'SUM':
        return `SUM(${arg})`;
      case 'MIN':
        return `MIN(${arg})`;
      case 'MAX':
        return `MAX(${arg})`;
      case 'AVG':
        return `AVG(${arg})`;
      case 'COUNT':
        return `COUNT(${arg})`;
      case 'COUNTD':
        return `COUNT(DISTINCT ${arg})`;
      case 'MEDIAN':
        return `median(${arg})`;
      case 'STDEV':
        return `stddev_samp(${arg})`;
      case 'VAR':
        return `var_samp(${arg})`;
    }
  }
  const handler = SCALAR_FUNCS[name];
  if (!handler) throw new Unsupported(`unsupported function '${name}'`);
  return handler(args, ctx, inAgg);
}

/** Node kinds whose emitted SQL is already self-delimiting — an atom (`42`, `'x'`,
 *  `` `col` ``), a binary expression (always emitted wrapped in its own parentheses, or
 *  as `concat(…)`), or a `CASE … END`. An inlined calc of one of these kinds needs no
 *  extra parentheses around it, which keeps a chain of calc references readable instead
 *  of accreting a paren level per link. Everything else — `NOT x`, `-x`, and calls,
 *  since a few of those (CONTAINS/STARTSWITH/ENDSWITH) emit a bare comparison — is
 *  wrapped so it can never re-associate with the surrounding operators. */
const SELF_DELIMITED_NODES = new Set<Node['t']>(['num', 'str', 'bool', 'null', 'field', 'bin', 'if', 'case']);

/** Parse (and memoize) one `opts.calcs` formula. Pure, so the cache is shared across the
 *  whole translation; cycle and depth control live with the callers, which know the
 *  current expansion path. */
function calcAst(key: string, ctx: Ctx): Node {
  const cached = ctx.astCache.get(key);
  if (cached !== undefined) return cached;
  const formula = ctx.calcs.get(key);
  if (formula === undefined) throw new Unsupported(`no calc formula for '${key}'`);
  const ast = parseFormula(formula);
  ctx.astCache.set(key, ast);
  return ast;
}

function emitNode(node: Node, ctx: Ctx, inAgg: boolean): string {
  switch (node.t) {
    case 'num':
      return node.v;
    case 'str':
      return sqlStr(node.v);
    case 'bool':
      return node.v ? 'TRUE' : 'FALSE';
    case 'null':
      return 'NULL';
    case 'field': {
      const key = node.v.toLowerCase();
      const col = ctx.fieldMap.get(key);
      if (col !== undefined) return quoteIdent(col);
      // Phase B6: a ref that names another calculated field on the same datasource is
      // translated by inlining that calc's own formula, parenthesized so it can never
      // re-associate with the surrounding operators. `inAgg` threads through unchanged,
      // so `SUM([Calc])` where `[Calc]` is itself `SUM(...)` is still rejected as a
      // nested aggregate — inlining must not become a way around that rule.
      if (!ctx.calcs.has(key)) throw new Unsupported(`unresolved field '${node.v}'`);
      if (ctx.expanding.has(key)) throw new Unsupported(`calc reference cycle at '${node.v}'`);
      if (ctx.depth >= MAX_CALC_DEPTH) throw new Unsupported('calc reference chain too deep');
      const inner: Ctx = {
        ...ctx,
        depth: ctx.depth + 1,
        expanding: new Set([...ctx.expanding, key]),
      };
      const ast = calcAst(key, ctx);
      const sql = emitNode(ast, inner, inAgg);
      return SELF_DELIMITED_NODES.has(ast.t) ? sql : `(${sql})`;
    }
    case 'unary':
      // A plain negative numeric literal reads cleanly as `-5`; anything else is
      // parenthesized so a nested unary/binary can never collapse into `--` (a SQL
      // line-comment marker) or a silently wrong precedence.
      return node.a.t === 'num' ? `-${node.a.v}` : `-(${emitNode(node.a, ctx, inAgg)})`;
    case 'not':
      return `NOT ${emitNode(node.a, ctx, inAgg)}`;
    case 'bin': {
      // `date - date` is the one arithmetic operator whose MEANING differs between the
      // two engines: Tableau evaluates it to a number of days, Databricks to an INTERVAL.
      // Whenever either operand is provably a date/datetime the whole formula is refused
      // rather than translated into an expression of a different type (Phase B2).
      if (node.op === '-' && (isProvably(node.a, ctx, 'date') || isProvably(node.b, ctx, 'date'))) {
        throw new Unsupported('date subtraction (Tableau yields days, Databricks an INTERVAL)');
      }
      // `+` is the one Tableau operator this module cannot translate unconditionally:
      // see `isProvably`'s docstring. Every other binary operator (arithmetic `- * / %`,
      // every comparison, AND/OR) has no string-vs-numeric ambiguity.
      if (node.op === '+' && !(isProvably(node.a, ctx, 'numeric') && isProvably(node.b, ctx, 'numeric'))) {
        if (isProvably(node.a, ctx, 'string') && isProvably(node.b, ctx, 'string')) {
          return `concat(${emitNode(node.a, ctx, inAgg)}, ${emitNode(node.b, ctx, inAgg)})`;
        }
        throw new Unsupported('+ is ambiguous (numeric addition vs. string concatenation) unless both operands are provably numeric or provably strings');
      }
      return `(${emitNode(node.a, ctx, inAgg)} ${node.op} ${emitNode(node.b, ctx, inAgg)})`;
    }
    case 'call':
      return emitCall(node, ctx, inAgg);
    case 'if': {
      const whens = node.branches.map(
        (b) => `WHEN ${emitNode(b.cond, ctx, inAgg)} THEN ${emitNode(b.then, ctx, inAgg)}`,
      );
      const elseClause = node.else ? [`ELSE ${emitNode(node.else, ctx, inAgg)}`] : [];
      return ['CASE', ...whens, ...elseClause, 'END'].join(' ');
    }
    case 'case': {
      const head = node.subject ? `CASE ${emitNode(node.subject, ctx, inAgg)}` : 'CASE';
      const whens = node.branches.map(
        (b) => `WHEN ${emitNode(b.when, ctx, inAgg)} THEN ${emitNode(b.then, ctx, inAgg)}`,
      );
      const elseClause = node.else ? [`ELSE ${emitNode(node.else, ctx, inAgg)}`] : [];
      return [head, ...whens, ...elseClause, 'END'].join(' ');
    }
  }
}

/* -------------------------------------------------------------------- entry */

const NO_TYPES: Map<string, TableauFieldType> = new Map();
const NO_CALCS: Map<string, string> = new Map();

/**
 * Canonical taxonomy (`model/typemap.ts`: `string`, `integer`, `float`, `decimal(p,s)`,
 * `boolean`, `date`, `timestamp`, …) or, failing that, a raw Tableau datatype
 * (`integer`, `real`, `string`, `date`, `datetime`, `boolean`) → the coarse
 * `TableauFieldType` this module reasons about. `undefined` means "not known to be any
 * of these", which every gate treats as "unknown" — never as a negative assertion.
 *
 * Canonical types with no scalar analogue here (`time`, `binary`, `variant/json`,
 * `array`, `map`, `struct`, `geography`, `vector`) resolve to `undefined` explicitly
 * rather than falling through to `raw`, so a mismatched raw hint cannot promote them.
 * Mirrors the shape of `shared.ts`'s `tabularTypeFor`/`tableauTypeFor` so all three read
 * the same catalog columns the same way.
 */
export function fieldTypeFromCanonical(
  canonical: string | null | undefined,
  raw?: string | null,
): TableauFieldType | undefined {
  const c = (canonical ?? '').toLowerCase().trim();
  if (c) {
    if (c.startsWith('decimal')) return 'numeric';
    switch (c) {
      case 'string':
        return 'string';
      case 'integer':
      case 'float':
        return 'numeric';
      case 'boolean':
        return 'boolean';
      case 'date':
        return 'date';
      case 'timestamp':
      case 'timestamp_tz':
        return 'datetime';
      case 'time':
      case 'binary':
      case 'variant/json':
      case 'array':
      case 'map':
      case 'struct':
      case 'geography':
      case 'vector':
        return undefined;
      default:
        break; // unrecognized canonical → fall through to the raw hint
    }
  }
  switch ((raw ?? '').toLowerCase().trim()) {
    case 'integer':
    case 'real':
      return 'numeric';
    case 'string':
      return 'string';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    default:
      return undefined;
  }
}

/**
 * Translate a Tableau calculated-field formula into Databricks SQL, or `null` when any
 * part of it falls outside the supported scope (see the module docstring). `fieldMap`
 * keys are the codebase's `fieldKey` convention: lowercased, bracket-stripped Tableau
 * field names → raw (unquoted) SQL column identifiers. `opts` is purely additive — see
 * `TranslateOptions`.
 */
export function translateTableauCalcToSql(
  formula: string,
  fieldMap: Map<string, string>,
  opts?: TranslateOptions,
): TableauSqlTranslation | null {
  try {
    // Comments are stripped before ANY analysis (Phase B5) so a `// TODO: use
    // WINDOW_SUM` note can neither trip the window gate below nor reach the lexer.
    const cleaned = stripLineComments(formula);
    // Quick gate (brief-suggested reuse of tokenizeCalc's classification): LOD blocks
    // and every window/table-calc/rank function tokenizeCalc recognizes collapse to one
    // derivation type. The parser's own whitelist rejects the same constructs on its
    // own, but this short-circuits before spending a full parse on formulas we already
    // know are out of scope.
    const classification = tokenizeCalc(cleaned);
    if (classification.derivationType.includes('window')) return null;

    const ctx: Ctx = {
      fieldMap,
      fieldTypes: opts?.fieldTypes ?? NO_TYPES,
      calcs: opts?.calcs ?? NO_CALCS,
      depth: 0,
      expanding: new Set<string>(),
      astCache: new Map<string, Node>(),
    };
    const sql = emitNode(parseFormula(cleaned), ctx, false);
    return { sql, confidence: 'exact' };
  } catch (err) {
    if (err instanceof Unsupported) return null;
    throw err;
  }
}
