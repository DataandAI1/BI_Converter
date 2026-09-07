import type { BiAssetRow } from '../bi/grouping.js';
import { DATASOURCE_TYPES, displayName } from '../bi/grouping.js';
import { tokenizeCalc } from '../tableau/calc.js';
import { getDialect } from './dialects.js';
import { makeCalcTranslator, type CalcTranslator } from './calc-translator.js';
import {
  type BiBindingLite,
  type BiColumnRow,
  type BiDerivationRow,
  Notes,
  claimPath,
  fieldKey,
  fileSafe,
  oneLine,
} from './shared.js';

/**
 * Databricks AI/BI rebuild target — Phase 1 (plan 2026-08-10): the "data lane" of the
 * pack. Per Tableau datasource this emits a UC pass-through `CREATE OR REPLACE VIEW`
 * per relation (table-kind over the bound UC table; custom_sql verbatim with a review
 * banner — never blind-rewritten, matching the repoint policy), a UC metric-view YAML
 * (dimensions from plain fields, measures from calcs that are a single simple
 * `AGG([Field])`), and — at most once per pack — an extract-rescue Python template for
 * any datasource with no matched source system (an embedded Tableau extract with no
 * live/registered database behind it).
 *
 * Standalone module (controller scope adjustment, task-1 brief): Phase 3 owns wiring
 * this into rebuild.ts's `buildBiRebuildPack`. `emitSemanticLayer`'s `ctx` intentionally
 * mirrors a *subset* of rebuild-tableau.ts's `TableauGroupContext` field names
 * (`columnsByAsset`/`derivationsByAsset`/`bindingsByAsset`) — Phase 3 can pass the exact
 * same objects it already builds for the Tableau branch without repackaging; the
 * unused fields (`files`/`objects`/`edges`/`byId`) are simply not part of this
 * function's structural contract (a report/dashboard checklist is out of scope for the
 * data lane). Unlike `emitPowerBiGroupAsTableau` (void, mutates a shared ctx in place),
 * this function is pure — it returns its files and one aggregated `Notes` for the
 * caller to fold into its own manifest bookkeeping, which is what makes it independently
 * unit-testable without a fake pool or a shared mutable pack context.
 */

/** `{path, content}` file-entry shape — `BiPackFile` is not (yet) an exported type in
 *  shared.ts; every existing pack builder pushes this exact shape into its `files`, just
 *  via a `Map<string,string>` rather than an array (this module returns an array per its
 *  contract, since it doesn't own the shared pack-wide files map). */
export interface BiPackFile {
  path: string;
  content: string;
}

/** The subset of the rebuild ctx this emitter reads. `bindingsByAsset` must be
 *  matched-first ordered per datasource (same convention rebuild.ts's `emitTable`
 *  relies on) — `bindings[0].status === 'matched'` is read as "this datasource has a
 *  matched source system". */
export interface SemanticLayerContext {
  columnsByAsset: Map<string, BiColumnRow[]>;
  derivationsByAsset: Map<string, BiDerivationRow[]>;
  bindingsByAsset: Map<string, BiBindingLite[]>;
}

/** One top-level BI group (workbook + its members) — the same `top`/`own`/`slug` triple
 *  `emitPowerBiGroupAsTableau` takes as separate params, collapsed into one object per
 *  the brief's `emitSemanticLayer(ctx, datasourceGroup)` contract. */
export interface DatasourceGroup {
  top: BiAssetRow;
  own: BiAssetRow[];
  slug: string;
}

const databricksDialect = getDialect('databricks')!;
const ucQuote = (ident: string): string => databricksDialect.quote(ident);

const MAX_CALCS = 200;

/** Backtick-quote a physical column identifier for a metric-view `expr` (doubling any
 *  backtick inside it, Databricks' own escape). A raw `order date` is not a valid
 *  identifier; SQL that `translateTableauCalcToSql` produced is already quoted and never
 *  passes through here. */
const backtick = (ident: string): string => `\`${ident.replace(/`/g, '``')}\``;

/** Double-quoted YAML scalar — every emitted name/expr/formula rides through this so
 *  arbitrary estate text (colons, quotes, unicode) can never break the YAML structure. */
function yamlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function fieldCaption(col: BiColumnRow): string {
  const props = (col.platform_properties ?? {}) as Record<string, unknown>;
  return (props.caption as string | undefined) ?? col.name.replace(/^\[|\]$/g, '');
}

/** Custom SQL relations the mapper captured on the asset row (kind: 'custom_sql'); a
 *  Tableau datasource's `definition_sql` is always derived from this same array
 *  (mapper.ts), so there is no separate fallback to consider here. */
function customSqlOf(ds: BiAssetRow): Array<{ name: string; sql: string }> {
  const props = (ds.platform_properties ?? {}) as Record<string, unknown>;
  const custom = props.customSql as Array<{ connection?: string; sql: string }> | undefined;
  if (!Array.isArray(custom) || custom.length === 0) return [];
  return custom.map((q, i) => ({ name: q.connection ?? `custom_sql_${i + 1}`, sql: q.sql }));
}

/** `catalog`.`schema`.`object` — filters out absent parts (never fabricates a
 *  placeholder segment) and flags the gap as needs_review instead. */
function ucTableRef(
  parts: { catalog?: string; schema?: string; object: string },
  dsLabel: string,
  notes: Notes,
): string {
  const missing: string[] = [];
  if (!parts.catalog) missing.push('catalog');
  if (!parts.schema) missing.push('schema');
  if (missing.length > 0) {
    notes.review.push(
      `${dsLabel}: source table reference for '${parts.object}' is missing ${missing.join(' and ')} — verify the full catalog.schema.object name before running`,
    );
  }
  return [parts.catalog, parts.schema, parts.object]
    .filter((p): p is string => !!p)
    .map(ucQuote)
    .join('.');
}

const SQL_HEADER = (fqn: string): string[] => [
  `-- Generated by Linetria — Databricks AI/BI semantic layer (Tableau → Databricks)`,
  `-- Source datasource: ${fqn}`,
];

function emitTableView(
  files: Map<string, string>,
  slug: string,
  ds: BiAssetRow,
  ref: { parts: { catalog?: string; schema?: string; object: string } },
  dsLabel: string,
  notes: Notes,
): string {
  const viewName = ref.parts.object;
  const path = claimPath(files, `${slug}/views/${fileSafe(viewName)}.sql`);
  const reviewCountBefore = notes.review.length;
  const fromRef = ucTableRef(ref.parts, dsLabel, notes);
  const lines = [
    ...SQL_HEADER(ds.fqn),
    `CREATE OR REPLACE VIEW ${ucQuote(viewName)} AS`,
    `SELECT * FROM ${fromRef};`,
    '',
  ];
  files.set(path, lines.join('\n'));
  if (notes.review.length === reviewCountBefore) {
    notes.info.push(`${dsLabel}: view '${path}' emitted as a pass-through over ${fromRef}`);
  }
  return viewName;
}

function emitCustomSqlView(
  files: Map<string, string>,
  slug: string,
  ds: BiAssetRow,
  q: { name: string; sql: string },
  dsLabel: string,
  notes: Notes,
): string {
  const path = claimPath(files, `${slug}/views/${fileSafe(q.name)}.sql`);
  const sql = q.sql.trim();
  const lines = [
    ...SQL_HEADER(ds.fqn),
    `-- REVIEW: source dialect — verify against Databricks SQL`,
    `CREATE OR REPLACE VIEW ${ucQuote(q.name)} AS`,
    sql.endsWith(';') ? sql : `${sql};`,
    '',
  ];
  files.set(path, lines.join('\n'));
  notes.review.push(
    `${dsLabel}: custom SQL relation '${q.name}' ships verbatim as a Databricks view — verify the dialect runs on Databricks SQL`,
  );
  return q.name;
}

/** Tableau CALC FUNCTION name → Databricks SQL, for the `SIMPLE_AGG_RE` fallback below.
 *  Deliberately not shared with `tableau-shelf.ts`'s `AGG_SQL`: that table is keyed by
 *  Tableau SHELF PREFIX (`cnt`, `cntd`, plus `median`/`stdev`/`var`), this one by the
 *  uppercased function name a calc formula writes (`COUNT`, `COUNTD`). Unifying them
 *  would widen what each lane accepts — a `MEDIAN([x])` calc would start translating to a
 *  metric-view measure instead of shipping as needs_review — so the two stay separate. */
const AGG_SQL: Record<string, (col: string) => string> = {
  SUM: (c) => `SUM(${c})`,
  MIN: (c) => `MIN(${c})`,
  MAX: (c) => `MAX(${c})`,
  AVG: (c) => `AVG(${c})`,
  COUNT: (c) => `COUNT(${c})`,
  COUNTD: (c) => `COUNT(DISTINCT ${c})`,
};

/** Matches ONLY a bare `AGG([Field])` — the sole class of Tableau calc this module ever
 *  translates (global constraint: everything else ships verbatim as needs_review,
 *  never guessed). Mirrors shared.ts's `translateTableauCalc` regex, SQL output instead
 *  of DAX (shared.ts is out of scope for this task — its DAX translator doesn't fit). */
const SIMPLE_AGG_RE = /^([A-Za-z]+)\(\s*\[([^\]]+)\]\s*\)$/;

interface NeedsReviewCalc {
  name: string;
  formula: string;
  classification: string;
}

function emitMetricView(
  files: Map<string, string>,
  slug: string,
  dsLabel: string,
  sourceView: string,
  columns: BiColumnRow[],
  derivations: BiDerivationRow[],
  physicalByField: Map<string, string>,
  notes: Notes,
  translator: CalcTranslator,
): void {
  const derivByColumn = new Map<string, BiDerivationRow>();
  const derivByName = new Map<string, BiDerivationRow>();
  for (const d of derivations) {
    // A derivation with no recorded language is a Tableau calc here (the Tableau mapper
    // leaves `language` null on older rows) — the same predicate rebuild-databricks.ts's
    // calc inventory uses, so a calc is never a measure in one lane and a phantom
    // dimension in the other.
    if (d.language && d.language !== 'tableau_calc') continue;
    if (d.output_column_id) derivByColumn.set(d.output_column_id, d);
    derivByName.set(d.output_name, d);
  }
  const derivOf = (c: BiColumnRow): BiDerivationRow | undefined =>
    derivByColumn.get(c.id) ?? derivByName.get(c.name);

  const dimensionCols = columns.filter((c) => !derivOf(c));
  const calcCols = columns.filter((c) => derivOf(c));

  const plainDimensions = dimensionCols.map((c) => {
    const caption = fieldCaption(c);
    const resolved = physicalByField.get(fieldKey(c.name)) ?? physicalByField.get(fieldKey(caption));
    const unresolved = resolved === undefined;
    if (unresolved) {
      notes.review.push(
        `${dsLabel}: dimension '${caption}' has no matched physical column — expr falls back to the raw Tableau field name; verify '${caption}' exists on the bound UC view before trusting this metric view`,
      );
    }
    return { name: caption, expr: backtick(resolved ?? caption), unresolved };
  });

  let cappedCalcs = calcCols;
  if (calcCols.length > MAX_CALCS) {
    notes.review.push(
      `${dsLabel}: ${calcCols.length} calculated field(s) exceed the ${MAX_CALCS}-calc cap — only the first ${MAX_CALCS} were considered`,
    );
    cappedCalcs = calcCols.slice(0, MAX_CALCS);
  }

  const measures: Array<{ name: string; expr: string; unresolved: boolean }> = [];
  const calcDimensions: Array<{ name: string; expr: string; unresolved: boolean }> = [];
  const needsReview: NeedsReviewCalc[] = [];

  for (const c of cappedCalcs) {
    const caption = fieldCaption(c);
    const d = derivOf(c)!;
    const classification = tokenizeCalc(d.expression_sql);
    const types = classification.derivationType;

    // translateTableauCalcToSql supersedes the old bare-AGG([Field])-only regex check:
    // it covers any in-scope calc (compound aggregate expressions, row-level formulas),
    // not just a single aggregate wrapping one field. An aggregate-classified result
    // becomes a measure; anything else translates to a row-level dimension. On null
    // (out of scope OR an operand this translator can't resolve through physicalByField)
    // fall back to the narrower simple-aggregate regex, which still degrades gracefully
    // for an unresolved single-field operand instead of dropping straight to review.
    const translated = translator.translate(d.expression_sql);
    if (translated) {
      const target = types.includes('aggregation') ? measures : calcDimensions;
      target.push({ name: caption, expr: translated.sql, unresolved: false });
      notes.info.push(
        `${dsLabel}: '${caption}' translated from its Tableau formula: ${oneLine(d.expression_sql)} → ${translated.sql}`,
      );
      continue;
    }

    const m = SIMPLE_AGG_RE.exec(d.expression_sql.trim());
    const agg = m ? AGG_SQL[m[1].toUpperCase()] : undefined;
    if (types.includes('aggregation') && m && agg) {
      const operand = m[2];
      const resolved = physicalByField.get(fieldKey(operand));
      const unresolved = resolved === undefined;
      if (unresolved) {
        notes.review.push(
          `${dsLabel}: measure '${caption}' operand '${operand}' has no matched physical column — expr falls back to the raw Tableau field name; verify '${operand}' exists on the bound UC view before trusting this metric view`,
        );
      }
      measures.push({ name: caption, expr: agg(backtick(resolved ?? operand)), unresolved });
    } else {
      needsReview.push({ name: caption, formula: d.expression_sql, classification: types.join(', ') });
    }
  }

  const dimensions = [...plainDimensions, ...calcDimensions];

  if (needsReview.length > 0) {
    notes.review.push(
      `${dsLabel}: ${needsReview.length} calculation(s) could not be translated to a metric-view measure — see the needs_review block in the emitted YAML`,
    );
  }

  const lines: string[] = [];
  lines.push(`# Generated by Linetria — Databricks AI/BI semantic layer (Tableau → Databricks)`);
  lines.push('version: 0.1');
  lines.push(`source: ${yamlStr(sourceView)}`);
  if (dimensions.length === 0) {
    lines.push('dimensions: []');
  } else {
    lines.push('dimensions:');
    for (const dim of dimensions) {
      lines.push(`  - name: ${yamlStr(dim.name)}`);
      lines.push(`    expr: ${yamlStr(dim.expr)}`);
      if (dim.unresolved) {
        lines.push(
          `    # needs_review: no matched physical column for '${dim.name}' — verify it exists on the bound UC view`,
        );
      }
    }
  }
  if (measures.length === 0) {
    lines.push('measures: []');
  } else {
    lines.push('measures:');
    for (const meas of measures) {
      lines.push(`  - name: ${yamlStr(meas.name)}`);
      lines.push(`    expr: ${yamlStr(meas.expr)}`);
      if (meas.unresolved) {
        lines.push(
          `    # needs_review: measure operand has no matched physical column — verify it exists on the bound UC view`,
        );
      }
    }
  }
  if (needsReview.length > 0) {
    lines.push('# needs_review');
    for (const r of needsReview) {
      lines.push(`#   - name: ${yamlStr(r.name)}`);
      lines.push(`#     formula: ${yamlStr(oneLine(r.formula))}`);
      lines.push(`#     classification: ${yamlStr(r.classification)}`);
    }
  }
  lines.push('');

  const path = claimPath(files, `${slug}/metric_views/${fileSafe(dsLabel)}.yaml`);
  files.set(path, lines.join('\n'));
  notes.info.push(
    `${dsLabel}: metric view emitted with ${dimensions.length} dimension(s) and ${measures.length} measure(s) (${calcCols.length} calc(s) considered)`,
  );
}

/** Extract-rescue template — a Tableau datasource with no matched source system (an
 *  embedded `.hyper` extract, or a connection Linetria couldn't bind to a registered
 *  system) has no known database identity, so no view can be built. This script
 *  rescues what WAS captured: local `.hyper` → pandas (via pantab) → parquet → Delta,
 *  parameterized by the target UC catalog/schema. Secret-free: authenticates
 *  databricks-sql-connector via environment variables only (documented in the header),
 *  never embeds a credential. */
const EXTRACT_RESCUE_PY = `#!/usr/bin/env python3
"""Extract-rescue script — Linetria Databricks AI/BI semantic layer pack.

For a Tableau datasource with no matched source system (an embedded .hyper extract, or
a connection Linetria could not bind to a registered system), the upstream database
identity is unknown, so no CREATE OR REPLACE VIEW could be generated for it. This
script rescues the data that WAS captured in the .hyper extract: it reads the extract
locally, converts it to a pandas DataFrame (via pantab) and then parquet, and loads the
parquet file into a Delta table under the catalog/schema you choose.

Secret-free: no credentials are embedded in this file. Run it on a Databricks cluster
(where the Spark session is already authenticated), or locally through Databricks
Connect, which authenticates from environment variables:
  DATABRICKS_HOST        - workspace URL
  DATABRICKS_TOKEN       - personal access token or OAuth token
  DATABRICKS_CLUSTER_ID  - cluster to attach to (omit for serverless)
See https://docs.databricks.com/en/dev-tools/databricks-connect/index.html

Usage:
  python extract_rescue.py <path-to-extract.hyper> --catalog my_catalog --schema my_schema [--table my_table]

Requires: pantab, pandas, pyarrow, and either databricks-connect or a cluster runtime
"""
import argparse
import os
import sys


def _spark():
    """The active Spark session — the cluster's own, else Databricks Connect's."""
    try:
        from databricks.connect import DatabricksSession
        return DatabricksSession.builder.getOrCreate()
    except ImportError:
        from pyspark.sql import SparkSession
        return SparkSession.builder.getOrCreate()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('hyper_path', help='local path to the Tableau .hyper extract file')
    parser.add_argument('--catalog', required=True, help='target Unity Catalog catalog name')
    parser.add_argument('--schema', required=True, help='target Unity Catalog schema name')
    parser.add_argument('--table', default=None, help='target table name (defaults to the .hyper filename)')
    parser.add_argument('--parquet-out', default=None, help='intermediate parquet path (defaults next to the .hyper)')
    args = parser.parse_args()

    import pantab  # local import: keep --help usable without the extra deps installed

    table_name = args.table or os.path.splitext(os.path.basename(args.hyper_path))[0]
    parquet_path = args.parquet_out or f'{args.hyper_path}.parquet'

    # A Tableau extract can hold several tables; the conventional single-table extract
    # (named "Extract") is used when present, otherwise the first table found — nothing
    # is guessed beyond that, review the frame before trusting the load.
    frames = pantab.frames_from_hyper(args.hyper_path)
    if not frames:
        print(f'no tables found in {args.hyper_path}', file=sys.stderr)
        return 1
    key = 'Extract' if 'Extract' in frames else next(iter(frames))
    df = frames[key]
    df.to_parquet(parquet_path)
    print(f'wrote {len(df)} row(s) to {parquet_path}')

    full_table = f'{args.catalog}.{args.schema}.{table_name}'

    # Load the parquet file into a managed Delta table under the chosen catalog/schema.
    # Overwrite (not append): re-running the rescue must not double the rows. Review the
    # inferred column types before running this against production data.
    spark = _spark()
    (spark.read.parquet(parquet_path)
        .write.format('delta')
        .mode('overwrite')
        .saveAsTable(full_table))
    print(f'loaded {parquet_path} into {full_table}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
`;

/**
 * Per Tableau datasource in the group: emit its relation view(s), a metric-view YAML,
 * and — once, across the whole call — the extract-rescue script if any datasource in
 * the group has no matched source system. Pure function: notes and files are returned,
 * never mutated onto a shared pack context (unlike `emitPowerBiGroupAsTableau`).
 *
 * `viewsByDatasource` reports, per datasource id, the view name this call ACTUALLY used
 * as the metric view's source (null when it emitted no view at all). The dashboard lane
 * consumes it instead of re-deriving the name from the same bindings — one derivation,
 * so a dataset's `FROM` can never drift from the view file the pack ships.
 */
export function emitSemanticLayer(
  ctx: SemanticLayerContext,
  group: DatasourceGroup,
): { files: BiPackFile[]; notes: Notes; viewsByDatasource: Map<string, string | null> } {
  const { top, own, slug } = group;
  const datasources = [
    ...(DATASOURCE_TYPES.has(top.asset_type) ? [top] : []),
    ...own.filter((m) => DATASOURCE_TYPES.has(m.asset_type)),
  ];

  const files = new Map<string, string>();
  const notes = new Notes();
  const viewsByDatasource = new Map<string, string | null>();
  let needsRescue = false;

  for (const ds of datasources) {
    const dsLabel = displayName(top, ds);
    const columns = ctx.columnsByAsset.get(ds.id) ?? [];
    const derivations = ctx.derivationsByAsset.get(ds.id) ?? [];
    const bindings = ctx.bindingsByAsset.get(ds.id) ?? [];
    const primary = bindings[0] ?? null;
    if (primary?.status !== 'matched') needsRescue = true;

    // bi_field (lowercased, bracket-stripped) → db_column, across every retained ref —
    // matches rebuild.ts's emitTable physicalByField convention.
    const physicalByField = new Map<string, string>();
    for (const b of bindings) {
      for (const r of b.refs ?? []) {
        for (const c of r.columns ?? []) {
          const key = fieldKey(c.bi_field);
          if (!physicalByField.has(key)) physicalByField.set(key, c.db_column);
        }
      }
    }

    const tableRelations = (primary?.refs ?? []).filter((r) => r.via === 'declared');
    const customSqlRelations = customSqlOf(ds);

    const viewNames: string[] = [];
    for (const rel of tableRelations) {
      viewNames.push(emitTableView(files, slug, ds, rel, dsLabel, notes));
    }
    for (const q of customSqlRelations) {
      viewNames.push(emitCustomSqlView(files, slug, ds, q, dsLabel, notes));
    }

    // The metric view's source is the FIRST relation view; that is also the view the
    // dashboard lane's dataset must select from, so it is what gets reported back.
    viewsByDatasource.set(ds.id, viewNames[0] ?? null);

    if (viewNames.length === 0) {
      notes.review.push(`${dsLabel}: no table or custom SQL relation found — no view or metric view emitted`);
      continue;
    }
    if (viewNames.length > 1) {
      notes.review.push(
        `${dsLabel}: datasource has ${viewNames.length} relations — the metric view's source uses the first ('${viewNames[0]}'); model the others separately`,
      );
    }

    emitMetricView(
      files, slug, dsLabel, viewNames[0], columns, derivations, physicalByField, notes,
      makeCalcTranslator({ columns, derivations, physicalByField }),
    );
  }

  if (needsRescue) {
    files.set('semantic_layer/extract_rescue.py', EXTRACT_RESCUE_PY);
    notes.info.push(
      `semantic_layer/extract_rescue.py: rescue script for datasource(s) with no matched source system — converts a local .hyper extract to Delta via pantab/parquet`,
    );
  }

  return {
    files: [...files.entries()].map(([path, content]) => ({ path, content })),
    notes,
    viewsByDatasource,
  };
}
