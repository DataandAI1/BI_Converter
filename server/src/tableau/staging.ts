// Connector contract (spec §6): every platform implements the same interface, and both
// live connectors and offline uploads produce identical staging records.

import type {
  BiBindingRef,
  BiDescriptor,
  DerivationLanguage,
  DerivationType,
} from '../model/types.js';

export interface ConnectionHealth {
  ok: boolean;
  serverVersion?: string;
  readOnly: boolean;
  warnings: string[];
  error?: string;
}

export interface CatalogTree {
  catalogs: Array<{ name: string; schemas: string[] }>;
}

export interface ScopeSelection {
  /** Schemas to extract; undefined = everything visible to the credential. */
  schemas?: string[];
  /**
   * Databases/catalogs to extract for platforms whose catalog queries are
   * per-database (Snowflake, Azure SQL); undefined = the connection's default.
   */
  databases?: string[];
}

export interface StagingAssetRec {
  catalog: string | null;
  schemaName: string | null;
  name: string;
  assetType: string;
  definitionSql?: string | null;
  language?: string | null;
  owner?: string | null;
  comment?: string | null;
  createdAtSource?: string | null;
  lastAlteredAtSource?: string | null;
  rowCountEstimate?: number | null;
  bytesEstimate?: number | null;
  platformProperties?: Record<string, unknown> | null;
}

export interface StagingColumnRec {
  catalog: string | null;
  schemaName: string | null;
  objectName: string;
  ordinal: number;
  columnName: string;
  dataTypeRaw: string | null;
  isNullable: boolean | null;
  defaultExpr?: string | null;
  isPartitionKey?: boolean;
  comment?: string | null;
  /** Calculated field / DAX measure / M expression (spec §8) — rides the column batch,
   *  promoted to a column_derivation row. The optional classification fields (decision 3)
   *  mirror the parse pass's derivation row shape: the connector's tokenizer fills them
   *  (`parserVersion` e.g. 'bi-calc/1.0'); absent ⇒ promoted unclassified. `inputRefs`
   *  for a BI calc are the referenced sibling fields as same-asset column refs. */
  expression?: {
    text: string;
    language: DerivationLanguage;
    derivationTypes?: DerivationType[];
    inputRefs?: Array<{ asset_fqn: string; column: string; resolution: string }>;
    parserVersion?: string;
    flags?: string[];
  };
  /** Platform extras with no dedicated slot (spec §8 decision 3: BI field caption/role/
   *  datatype) — promoted verbatim to asset_column.platform_properties. */
  platformProperties?: Record<string, unknown> | null;
}

export interface StagingConstraintRec {
  catalog: string | null;
  schemaName: string | null;
  tableName: string;
  constraintName: string | null;
  constraintType: 'pk' | 'fk' | 'unique' | 'check';
  isEnforced: boolean;
  columns: string[] | null;
  refCatalog?: string | null;
  refSchema?: string | null;
  refTable?: string | null;
  refColumns?: string[] | null;
  definition?: string | null;
}

export interface StagingDependencyRec {
  fromCatalog: string | null;
  fromSchema: string | null;
  fromName: string;
  toCatalog: string | null;
  toSchema: string | null;
  toName: string;
  /** 'view_dependency_catalog'/'lineage_native'/'lineage_native_column' (spec §5.3/§6.2/
   *  §6.3), or 'bi_declared' (spec §8: BI-declared structure/upstream refs). */
  dependencyKind:
    | 'view_dependency_catalog'
    | 'lineage_native'
    | 'lineage_native_column'
    | 'bi_declared';
  /** Column-grain BI usage (spec §8 decision 6): names the target asset's column
   *  (`to_column_id` = the field). bi_declared only; absent ⇒ asset-grain as ever. */
  toColumn?: string | null;
  /** Event metadata for native lineage (event_time, entity_type, …). */
  properties?: Record<string, unknown> | null;
}

/** One BI connection descriptor + retained upstream refs (spec §8), staging twin of
 *  bi_source_binding — promoted by the normalizer, matched by the stitcher. */
export interface StagingBiBindingRec {
  assetFqn: string;
  assetType: string;
  descriptor: BiDescriptor;
  normalizedKey: string;
  refs: BiBindingRef[];
}

/** One captured dashboard/sheet screenshot (Tableau visual-rebuild feature, spec
 *  2026-07-27) — live-mode-only, base64-encoded image bytes staged alongside the asset
 *  they depict. */
export interface StagingScreenshotRec {
  catalog: string | null;
  schemaName: string | null;
  /** Asset name, e.g. 'wb/Regional Overview'. */
  name: string;
  assetType: 'bi_dashboard' | 'bi_sheet';
  /** 'rest_image' ⇒ live REST view-image capture; 'twb_thumbnail' ⇒ the .twb's embedded
   *  `<thumbnails>` entry. */
  source: 'rest_image' | 'twb_thumbnail';
  contentType: string;
  base64: string;
}

export type ExtractionPass =
  | 'containers'
  | 'tables_columns'
  | 'constraints'
  | 'views'
  | 'routines'
  | 'dependencies'
  | 'lineage'
  | 'bi';

export interface StagingBatch {
  pass: ExtractionPass;
  assets?: StagingAssetRec[];
  columns?: StagingColumnRec[];
  constraints?: StagingConstraintRec[];
  dependencies?: StagingDependencyRec[];
  bindings?: StagingBiBindingRec[];
  screenshots?: StagingScreenshotRec[];
  /** Per-pass degradations (capability gaps, budget exhaustion, data latency notes). */
  warnings?: string[];
}

export interface MetadataConnector {
  testConnection(): Promise<ConnectionHealth>;
  enumerateScope(): Promise<CatalogTree>;
  extract(scope: ScopeSelection): AsyncGenerator<StagingBatch>;
  /** Renders the minimal-privilege grant script for a DBA to review and run. */
  requiredPrivileges(): string;
}
