// Build-area types (spec docs/specs/2026-07-22-build-tab-tableauforge.md §6/§7).

import type {
  ArtifactPart,
  BuildTarget,
  ForgeDatabaseBlock,
  TranslationEntry,
} from '../forge/client.js';

export type BuildRunStatus =
  | 'queued'
  | 'running'
  | 'complete'
  | 'complete_with_warnings'
  | 'failed'
  | 'cancelled';

export type ForgeDatatype = 'string' | 'integer' | 'real' | 'boolean' | 'date' | 'datetime';

/**
 * Prefix marking an INFORMATIONAL entry inside `build_run.warnings`.
 *
 * Forge returns compile-time caveats in two channels — review-worthy `warnings`
 * and informational `notes` — but the run row has exactly one `warnings` column,
 * and adding a second would cost a migration for what is a presentation
 * distinction. So notes are persisted in the same column behind this prefix, and
 * every consumer that decides "does a human need to look at this?" filters them
 * out with `isReviewWarning`: the runner's needs_review computation and the build
 * pack's per-report status. Everything that merely DISPLAYS warnings (the run
 * detail, the translation report) keeps showing them, prefix and all, because
 * they are true and worth reading.
 */
export const NOTE_PREFIX = 'info: ';

/** True for a warning a person should act on — i.e. not an `info:` note. */
export const isReviewWarning = (warning: string): boolean =>
  !warning.startsWith(NOTE_PREFIX);

export interface BriefField {
  /** Physical column name where the binding retained a bi_field → db_column
   *  mapping, else the BI field name — the name the compiled .twb queries. */
  name: string;
  /** The BI-side field name, when it differs from the physical name. */
  caption?: string;
  datatype: ForgeDatatype;
  role: 'dimension' | 'measure';
  default_aggregation?: string;
}

export interface BriefCalculation {
  name: string;
  formula: string;
  language: 'dax' | 'tableau_calc' | 'm' | 'sql';
  derivation_type: string[];
  flags: string[];
}

export interface BriefDatasource {
  /** forge identifier (^[a-z][a-z0-9_]{0,63}$), unique within the brief. */
  id: string;
  name: string;
  /** Ready-made forge live_database block; carries what is known — degradations
   *  are notes, never fabrication. */
  connection: ForgeDatabaseBlock;
  fields: BriefField[];
  calculations: BriefCalculation[];
  notes: string[];
}

export interface BriefElementVisual {
  chart_type: string;
  source_mark_class: string;
  rows: string[];
  cols: string[];
  color?: string;
  size?: string;
  label?: string;
  filters?: string[];
  /** Explicit worksheet sort order (Task 6 fidelity backfill), brief-field-translated;
   *  `direction` rides Tableau's raw vocabulary ('ASC'/'DESC') as captured. */
  sorts?: { field: string; direction?: string }[];
  notes: string[];
}

export interface BriefElementZone {
  worksheet?: string;
  kind: 'worksheet' | 'text' | 'blank';
  x: number;
  y: number;
  w: number;
  h: number;
  confidence?: number;
}

export interface BriefElementLayout {
  observed: true;
  source: 'twb' | 'screenshot_analysis';
  size?: { width: number; height: number };
  zones: BriefElementZone[];
}

export interface BriefElement {
  name: string;
  kind: string;
  fields: string[];
  visual?: BriefElementVisual;
  layout?: BriefElementLayout;
  screenshot_available?: boolean;
}

/** A workbook-scope Tableau parameter, surfaced for the rebuild author/checklist (Task 6
 *  fidelity backfill). Controller ruling (plan 2026-08-10): fixture-verified extraction
 *  only — no downstream target may fabricate `.lvdash.json` parameter JSON from this. */
export interface BriefParameter {
  name: string;
  caption?: string;
  datatype?: string;
  current_value?: string;
  allowable?: {
    kind: 'all' | 'list' | 'range';
    values?: string[];
    min?: string;
    max?: string;
  };
}

export interface RebuildBrief {
  brief_version: '1';
  report: {
    name: string;
    platform: 'power_bi' | 'tableau';
    fqn: string;
    elements: BriefElement[];
    /** Workbook-scope parameters (Tableau only; absent when the workbook declares none —
     *  never an empty array). Capped at 64 with a `notes` drop line. */
    parameters?: BriefParameter[];
    notes: string[];
  };
  datasources: BriefDatasource[];
  notes: string[];
}

/** A report container's dashboard/sheet (Tableau) or the report itself (Power BI) —
 *  id + raw catalog asset name + the exact name it appears under in
 *  RebuildBrief.report.elements[].name. The join key screenshot→element matching
 *  uses (spec 2026-07-27 visual-informed-rebuild §7): by asset id, never
 *  endsWith-fuzzy name matching. */
export interface ElementAssetRef {
  id: string;
  name: string;
  briefName: string;
}

export interface AssembledBrief {
  brief: RebuildBrief;
  workbookName: string;
  /** Brief-level degradations, surfaced onto the build_run row as warnings. */
  warnings: string[];
  /** Every element's underlying BI asset, for id-exact screenshot matching. */
  elementAssets: ElementAssetRef[];
}

/** Per-element summary of which captured evidence informed the rebuild (spec
 *  2026-07-27 visual-informed-rebuild §7) — a run-provenance record, never bytes. */
export interface VisualInputEntry {
  element: string;
  visual: boolean;
  layout: string | null;
  screenshot: string | null;
  notes: string[];
}

export interface BuildRunRow {
  id: string;
  project_id: string;
  report_asset_id: string;
  report_fqn: string;
  report_platform: string;
  workbook_name: string;
  status: BuildRunStatus;
  target: BuildTarget;
  instructions: string | null;
  brief: RebuildBrief | null;
  spec: Record<string, unknown> | null;
  translation: TranslationEntry[] | null;
  validation: Record<string, unknown> | null;
  forge_artifact_id: string | null;
  llm_usage: Record<string, unknown> | null;
  warnings: string[];
  error: string | null;
  parent_run_id: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancel_requested_at: string | null;
  /** Queue-time toggle (spec §7): whether the run should thread captured
   *  screenshots into the forge call as vision input. Defaults true. */
  include_visual_capture: boolean;
  /** Per-element evidence summary persisted after the forge call — null until
   *  the run has executed at least once. */
  visual_inputs: VisualInputEntry[] | null;
  /** One entry per emitted dashboard when the report was too big for a single
   *  artifact and the target split it (databricks: >15 pages). null for an
   *  unsplit run, whose one artifact is the whole report. */
  artifact_parts: ArtifactPart[] | null;
}
