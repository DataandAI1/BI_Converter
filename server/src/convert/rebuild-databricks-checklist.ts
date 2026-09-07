import type { LakeviewParameterJson } from '../lakeview/format.js';
import type { PersistedTableauParameter } from '../tableau/mapper.js';

/**
 * `rebuild_checklist.md` rendering for the Databricks AI/BI rebuild target — the human
 * worklist that sits beside the machine-readable manifest.
 *
 * Split out of `rebuild-databricks.ts` (Phase F, plan 2026-09-03): one pure function over
 * a plain data object, so the markdown can be read, diffed and tested without building a
 * catalog context. It computes nothing about the rebuild — every fact it prints was
 * decided by the emitter and handed over — with one exception: the AI/BI construct
 * suggestions below, which are a property of the calc's classification alone.
 */

/** One Tableau calculation the deterministic translator could NOT handle — it ships
 *  verbatim on the checklist with its classification. */
export interface ChecklistCalc {
  /** Datasource display label. */
  ds: string;
  name: string;
  formula: string;
  /** `', '`-joined `tokenizeCalc` derivation types (`''` when unclassified). */
  classification: string;
}

/** The parameter-plan fields the checklist prints — structurally satisfied by
 *  `rebuild-databricks.ts`'s `ParameterPlan` (kept as its own shape here so the checklist
 *  module does not import back into the emitter it is called from). */
export interface ChecklistParameter {
  raw: PersistedTableauParameter;
  name: string;
  json: LakeviewParameterJson | null;
  widgetType: string | null;
  reason: string | null;
}

export interface RebuildChecklistInput {
  /** The workbook the pack rebuilds — the checklist's title. */
  workbookName: string;
  /** Pack slug; the checklist's own path is `${slug}/rebuild_checklist.md`, which the
   *  caller (which owns the files map) writes. */
  slug: string;
  /** Emitted `.lvdash.json` paths, in emission order. */
  dashboardPaths: string[];
  /** Widget types emitted from a docs pin rather than a corpus fixture (sorted here). */
  unverifiedTypes: string[];
  /** One line per calc the translator DID handle. */
  translatedCalcNotes: string[];
  /** Calcs to port by hand. */
  calcs: ChecklistCalc[];
  parameterPlans: ChecklistParameter[];
  /** Every review note the worklist carries, already pooled and deduplicated. */
  reviewNotes: string[];
}

/** docs/specs/2026-08-10-databricks-aibi-rebuild-research.md §3 — the AI/BI construct a
 *  Tableau calc of each classification should be rebuilt as. */
function suggestedConstruct(types: string[]): string {
  if (types.includes('window')) {
    return 'SQL window function in the dataset SELECT, or an `AGGREGATE OVER (…)` custom calculation (LOD INCLUDE/EXCLUDE → `PARTITION BY * EXCEPT (…)`) — behavior differs from Tableau table calcs, verify the numbers';
  }
  if (types.includes('aggregation')) {
    return 'custom-calculation measure on the dataset, or a metric-view measure';
  }
  return 'SQL expression in the dataset SELECT (or a calculated dimension)';
}

/** For a calc `translateTableauCalcToSql` could not translate (returns `null`) but whose
 *  `tokenizeCalc` classification includes `window` — an LOD EXCLUDE or a moving-window
 *  function — a best-effort UNVERIFIED text suggestion for the checklist. Text only,
 *  never emitted into dataset SQL: the exact partition/order-by shape of a real
 *  `AGGREGATE OVER` rebuild still needs a human to verify against the source calc. */
function windowCandidate(formula: string): string | null {
  const exclude = /\{\s*EXCLUDE\s+\[([^\]]+)\]\s*:/i.exec(formula);
  if (exclude) {
    return `UNVERIFIED candidate: AGGREGATE OVER (PARTITION BY * EXCEPT (${exclude[1]}))`;
  }
  if (/\b(WINDOW_|RUNNING_)[A-Z_]*\s*\(/i.test(formula)) {
    return 'UNVERIFIED candidate: AGGREGATE OVER (ORDER BY … TRAILING n …)';
  }
  return null;
}

/** A parameter's domain, in one human-readable line for the checklist. */
function parameterDomainText(p: PersistedTableauParameter): string {
  const av = p.allowable_values;
  if (!av || !av.kind || av.kind === 'all') return 'unrestricted';
  if (av.kind === 'list') {
    const values = av.values ?? [];
    return values.length > 0 ? `list: ${values.join(', ')}` : 'list (no values captured)';
  }
  if (av.kind === 'range') return `range ${av.min ?? '?'}–${av.max ?? '?'}`;
  return 'unrestricted';
}

/**
 * The whole `rebuild_checklist.md`, byte for byte. Pure: same input, same string.
 */
export function renderRebuildChecklist(input: RebuildChecklistInput): string {
  const { dashboardPaths, unverifiedTypes, translatedCalcNotes, calcs, parameterPlans, reviewNotes } =
    input;
  const sections: string[] = [];

  sections.push(
    [
      '## Dashboards emitted',
      ...(dashboardPaths.length > 0
        ? dashboardPaths.map((p) => `- \`${p}\``)
        : ['- _none — this group has no dashboard or worksheet content_']),
      '',
      'Deploy with `deploy_dashboards.py` (REST/SDK) or `databricks.yml` (Asset Bundle) at the',
      'pack root. Both take the workspace host and SQL warehouse id as arguments/variables —',
      'no workspace identity or credential is baked into this pack.',
    ].join('\n'),
  );

  if (unverifiedTypes.length > 0) {
    sections.push(
      [
        '## Unverified widget types used',
        '',
        'These widget types are pinned from Databricks documentation, not from an exported',
        'dashboard. Where the pinned entry lists no encoding channels the widget was emitted',
        'as a TABLE of the same fields instead (a channel-less widget renders nothing) — the',
        'sheet-level note says which. Rebuild each as the intended type in the AI/BI editor,',
        'and verify rendering:',
        '',
        ...[...unverifiedTypes].sort().map((t) => `- [ ] \`${t}\``),
      ].join('\n'),
    );
  }

  if (translatedCalcNotes.length > 0) {
    sections.push(
      [
        '## Calculations translated automatically',
        '',
        'These Tableau calculations were translated deterministically to Databricks SQL and',
        'need no manual porting — the SQL is already inlined into the relevant dataset/widget:',
        '',
        ...translatedCalcNotes.map((n) => `- [x] ${n}`),
      ].join('\n'),
    );
  }

  if (calcs.length > 0) {
    sections.push(
      [
        '## Calculations to port by hand',
        '',
        'These Tableau calculations could not be translated automatically — each ships',
        'verbatim below with its mechanical classification and the AI/BI construct that fits',
        'it (docs/specs/2026-08-10-databricks-aibi-rebuild-research.md §3). Calculations the',
        'deterministic translator DID handle are listed in the section above instead.',
        '',
        ...calcs.map((c) => {
          const types = c.classification.split(', ');
          // An LOD-EXCLUDE / moving-window calc gets a best-effort UNVERIFIED text
          // suggestion on top of the generic construct line — never SQL.
          const candidate = types.includes('window') ? windowCandidate(c.formula) : null;
          return [
            `- [ ] **${c.name}** (${c.ds}) — classification: ${c.classification || 'unclassified'}`,
            `      → ${suggestedConstruct(types)}`,
            ...(candidate ? [`      → ${candidate}`] : []),
            '',
            '  ```',
            ...c.formula.split(/\r\n|\r|\n/).map((l) => `  ${l}`),
            '  ```',
          ].join('\n');
        }),
      ].join('\n'),
    );
  }

  // Parameters: emitted as dataset parameters (+ a bound filter widget where the corpus
  // pins one) — every one still lands on the worklist AND as a needs_review note, because
  // the generated SQL never references `:keyword` on its own; that substitution is the
  // reader's job, where the Tableau calculations used `[Parameters].[Name]`.
  if (parameterPlans.length > 0) {
    sections.push(
      [
        '## Parameters',
        '',
        'Tableau parameters become AI/BI dataset parameters (`datasets[].parameters[]`,',
        'referenced as `:keyword` in dataset SQL), declared on every dataset of each',
        'dashboard, plus a filter widget bound to the parameter wherever the pinned format',
        'table has a binding for its type. No generated SQL references them yet — add',
        '`:keyword` where the Tableau calculations used `[Parameters].[Name]`:',
        '',
        ...parameterPlans.map((p) => {
          const head =
            `- [ ] **${p.name}**${p.raw.datatype ? ` (${p.raw.datatype})` : ''} — current value: ` +
            `${p.raw.current_value ?? 'unknown'}; domain: ${parameterDomainText(p.raw)}`;
          if (!p.json) {
            return `${head}\n      → not emitted: ${p.reason}; recreate it by hand in the AI/BI editor`;
          }
          const binding = p.widgetType ? `, bound to a \`${p.widgetType}\` widget` : ` — ${p.reason}`;
          return `${head}\n      → emitted as \`:${p.json.keyword}\` (${p.json.dataType})${binding}`;
        }),
      ].join('\n'),
    );
  }

  if (reviewNotes.length > 0) {
    sections.push(['## Needs review', '', ...reviewNotes.map((n) => `- [ ] ${n}`)].join('\n'));
  }

  sections.push(
    [
      '## After deploying',
      '',
      '- Genie is enabled by default on published AI/BI dashboards — an "Ask Genie" space is',
      '  created automatically, no `uiSettings` entry is emitted for it.',
      '- Cross-check this deterministic rebuild against Databricks\' own importer: upload the',
      '  original `.twb`/`.twbx`/`.tds` to Genie Code `/importBI` and compare the dashboards it',
      '  builds with the ones in this pack.',
      "- Each dashboard filter is emitted as the widget its captured filter class implies (a",
      '  categorical filter becomes `filter-multi-select`, a quantitative one a `range-slider`',
      '  or `filter-date-range-picker`), but the filter\'s SELECTION is not captured by the',
      '  Tableau reader — every filter widget starts unfiltered. Set the original selection',
      '  (and check the control type) in the AI/BI editor.',
    ].join('\n'),
  );

  return `# Rebuild checklist — ${input.workbookName}\n\nGenerated by BI_Converter — Databricks AI/BI rebuild pack (Tableau → Databricks).\nSemantic-layer SQL and metric views are under \`views/\` and \`metric_views/\`; dashboards\nare under \`dashboards/\`.\n\n${sections.join('\n\n')}\n`;
}
