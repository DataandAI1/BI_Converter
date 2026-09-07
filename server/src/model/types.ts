// Canonical metadata model (spec §5).

export type Platform =
  | 'databricks'
  | 'snowflake'
  | 'azure_sql'
  | 'synapse_dedicated'
  | 'synapse_serverless'
  | 'postgres'
  | 'tableau'
  | 'power_bi';

export type ConnectionMode = 'live' | 'offline';

export type AssetType =
  | 'table'
  | 'external_table'
  | 'view'
  | 'materialized_view'
  | 'procedure'
  | 'function'
  | 'table_function'
  | 'trigger'
  | 'sequence'
  | 'stage'
  | 'pipe'
  | 'volume'
  | 'streaming_table'
  | 'bi_datasource'
  | 'bi_workbook'
  | 'bi_dashboard'
  | 'bi_report'
  | 'bi_sheet'
  | 'bi_dataset'
  | 'bi_semantic_model';

export type EdgeType =
  | 'fk_declared_enforced'
  | 'fk_declared_informational'
  | 'view_dependency_catalog'
  | 'lineage_native'
  | 'parsed_from_definition'
  | 'bi_declared'
  | 'name_inferred'
  | 'manual';

export type EvidenceSource =
  | 'catalog'
  | 'native_lineage'
  | 'parser'
  | 'bi_api'
  | 'bi_file'
  | 'name_heuristic'
  | 'manual';

export type RunStatus = 'running' | 'complete' | 'complete_with_warnings' | 'failed';

/** Edge lifecycle (spec §5.3): quarantined edges join the working graph only on confirm. */
export type EdgeStatus = 'active' | 'pending_review' | 'rejected';

export type FindingStatus = 'open' | 'accepted' | 'resolved';

/** Parser outcome per definition (spec §7); coverage is first-class run reporting. */
export type ParseStatus = 'full' | 'partial' | 'failed';

/**
 * Mechanical transformation classification (spec §5.2/§7.1, Phase 2) — what the SQL
 * does, never what it means (§2.3). mask_candidate / non_portable are heuristics and
 * surface as findings, never trusted assertions.
 */
export type DerivationType =
  | 'passthrough'
  | 'rename'
  | 'cast'
  | 'arithmetic'
  | 'aggregation'
  | 'window'
  | 'case_switch'
  | 'string_transform'
  | 'udf_call'
  | 'mask_candidate'
  | 'non_portable'
  | 'constant';

/** Expression dialect a column_derivation was captured in (spec §8, BI calc capture). */
export type DerivationLanguage = 'sql' | 'tableau_calc' | 'dax' | 'm';

/** How one output column of a view/routine is produced (spec §5.2 ColumnDerivation). */
export interface ColumnDerivation {
  id: string;
  assetId: string;
  outputColumnId: string | null; // null for routine writes into a target table
  outputName: string;
  outputTargetFqn: string | null;
  expressionSql: string;
  derivationType: DerivationType[];
  inputRefs: Array<{ asset_fqn: string; column: string; resolution: string }>;
  inputsResolved: boolean;
  nonPortableConstructs: string[];
  flags: string[];
  parserVersion: string | null;
  parseStatus: ParseStatus | null;
}

/** Connection descriptor a BI asset declares for one of its upstream refs (spec §8). */
export interface BiDescriptor {
  platform_hint: string;
  host?: string | null;
  account?: string | null;
  database?: string | null;
  warehouse?: string | null;
  schema?: string | null;
  connection_type?: string | null;
  extra?: Record<string, unknown> | null;
}

/** One upstream table/column ref retained under a BI descriptor (spec §8). A column
 *  entry marked `method: 'expression_ref'` was derived by our expression tokenizer, not
 *  declared by the platform — the stitcher materializes it at 0.85 with
 *  `details.method='expression_ref'` instead of the declared 0.95 (global constraint). */
export interface BiBindingRef {
  parts: { catalog?: string; schema?: string; object: string };
  columns?: Array<{ bi_field: string; db_column: string; method?: 'expression_ref' }>;
  via: 'declared' | 'custom_sql' | 'm_query';
  /** The BI-side object this ref was extracted from, when the mapper knows it — e.g. the
   *  Power BI model table whose partition M declared this upstream ref. The reverse
   *  rebuild direction (migration/bi/rebuild-tableau.ts) needs this link to put the right
   *  connection on each per-table datasource scaffold; without it the table→connection
   *  attribution would be a name-match guess. */
  bi_object?: string;
}

/**
 * A BI asset's connection descriptor + retained upstream refs, matched (or not) to a
 * registered source system (spec §8 stitching rule).
 */
export interface BiBinding {
  id: string;
  projectId: string;
  assetId: string;
  descriptor: BiDescriptor;
  normalizedKey: string;
  refs: BiBindingRef[];
  matchedSourceSystemId: string | null;
  matchMethod: 'exact' | 'manual' | null;
  status: 'matched' | 'unmatched' | 'ignored';
  firstSeenRunId: string | null;
  lastSeenRunId: string | null;
}

export interface RunStats {
  passes?: Record<string, Record<string, number>>;
  assets?: number;
  columns?: number;
  constraints?: number;
  edges?: number;
  parse?: {
    parsed: number;
    full: number;
    partial: number;
    failed: number;
    coveragePct: number | null;
    edges: number;
    /** Oversized definitions skipped by the parser (spec §7 guardrail). */
    skipped?: number;
    /** Extension-provided / built-in objects recognized with no SQL body to analyze. */
    recognized?: number;
    /** Phase 2 (spec §7.1): expression-grain capture written this run. */
    derivations?: number;
    /** Phase 2 (spec §5.3): column-grain parsed_from_definition edges (0.70). */
    columnEdges?: number;
  };
  /** spec §8: BI descriptor stitching outcome for this run. */
  bi?: { assets: number; bindings: number; matched: number; unmatched: number };
}
