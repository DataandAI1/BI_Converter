import type { BiColumnRow, BiDerivationRow } from './shared.js';
import {
  fieldTypeFromCanonical,
  translateTableauCalcToSql,
  type TableauFieldType,
  type TableauSqlTranslation,
} from './tableau-sql.js';

/**
 * One memoized Tableau-calc → Databricks SQL translator per datasource, built from the
 * catalog facts both Databricks emitters already load (`columnsByAsset`,
 * `derivationsByAsset`, the binding-derived `physicalByField`). It threads the two
 * optional inputs `translateTableauCalcToSql` accepts into every call:
 *
 * - `fieldTypes` — the catalog's `data_type_canonical`/`data_type_raw` per Tableau field,
 *   which is what lets `[Sales] + 1` translate (numeric field) and `[A] + [B]` become
 *   `concat` (string fields) instead of both being rejected as ambiguous;
 * - `calcs` — every other Tableau calc on the datasource, so a calc that references a
 *   calc translates inline instead of failing on an "unresolved field".
 *
 * Both emitters used to call the translator up to three times per calc (widget field,
 * checklist, metric view), each a full re-lex/re-parse; the memo makes that free.
 */
export interface CalcTranslator {
  translate(formula: string): TableauSqlTranslation | null;
  /** fieldKey → type, for callers that need the same oracle the translator uses. */
  fieldTypes: Map<string, TableauFieldType>;
}

/** Codebase-wide `fieldKey` convention: lowercased, surrounding brackets stripped. */
const fieldKey = (name: string): string => name.toLowerCase().replace(/^\[|\]$/g, '');

/** A derivation row with no recorded language is a Tableau calc (older mapper rows leave
 *  it null) — the one predicate every Databricks lane shares. */
export const isTableauCalc = (d: BiDerivationRow): boolean =>
  !d.language || d.language === 'tableau_calc';

export function makeCalcTranslator(opts: {
  columns: BiColumnRow[];
  derivations: BiDerivationRow[];
  physicalByField: Map<string, string>;
}): CalcTranslator {
  const fieldTypes = new Map<string, TableauFieldType>();
  for (const c of opts.columns) {
    const type = fieldTypeFromCanonical(c.data_type_canonical, c.data_type_raw);
    if (!type) continue;
    const caption = (c.platform_properties ?? {}).caption as string | undefined;
    for (const k of [fieldKey(c.name), caption ? fieldKey(caption) : null]) {
      if (k && !fieldTypes.has(k)) fieldTypes.set(k, type);
    }
  }
  const calcs = new Map<string, string>();
  for (const d of opts.derivations) {
    if (!isTableauCalc(d)) continue;
    const k = fieldKey(d.output_name);
    if (!calcs.has(k)) calcs.set(k, d.expression_sql);
  }
  const memo = new Map<string, TableauSqlTranslation | null>();
  return {
    fieldTypes,
    translate(formula: string): TableauSqlTranslation | null {
      const hit = memo.get(formula);
      if (hit !== undefined) return hit;
      const result = translateTableauCalcToSql(formula, opts.physicalByField, { fieldTypes, calcs });
      memo.set(formula, result);
      return result;
    },
  };
}
