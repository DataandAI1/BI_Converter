// Tableau doc model (BI connectors plan, Task 4) — the shape both delivery modes produce.
// File mode (files.ts, this task) builds these from parsed .twb/.twbx/.tds/.tdsx XML; live
// mode (Task 5) will build the identical shape from Metadata API GraphQL responses. mapper.ts
// is the single normalizer that turns either into StagingBatch[] (spec §4 invariant).

import type { BiDescriptor } from '../model/types.js';

/** A relation/upstream table reference's namespace parts (spec §5.1 three-level FQN). */
export interface TableauTableParts {
  catalog?: string;
  schema?: string;
  object: string;
}

export interface TableauFieldDoc {
  /** Raw XML field identity, bracket-stripped (e.g. 'Order Date') — stable across a
   *  formula's field refs, `datasource-dependencies`, and the field's own identity. */
  name: string;
  caption?: string;
  datatype?: string;
  role?: string;
  /** Present ⇒ a calculated field; the raw Tableau calc formula. */
  formula?: string;
}

export interface TableauRelationDoc {
  kind: 'table' | 'custom_sql';
  /** 'table' relations only — the declared upstream table (spec §8 binding refs). */
  table?: TableauTableParts;
  /** 'custom_sql' relations only — the relation's SQL text. */
  sql?: string;
  /** The owning `<named-connection>`'s identity — correlates to `connections[]` via
   *  `BiDescriptor.extra.named_connection` (files.ts sets both ends of this link). */
  connection: string;
}

/** Live-mode-only (Metadata API-resolved) upstream refs — Task 5 populates this; file mode
 *  never does (spec coverage matrix: file mode's upstream columns are tokenizer-derived
 *  only). The mapper merges this in when present, on either mode, so both converge on one
 *  normalizer without a mode branch in the merge logic itself. */
export interface TableauUpstreamDoc {
  tables: { parts: TableauTableParts; connection: string }[];
  columns: { field: string; table: TableauTableParts; column: string }[];
}

export interface TableauDatasourceDoc {
  /** Internal Tableau identity (the XML `name` attribute) — what workbook-scoped
   *  references (`sheets[].datasourceRefs`, `fieldRefs[].ds`) point at. */
  name: string;
  /** true ⇒ a published datasource (own FQN, no workbook prefix, spec §5.1 decision 2);
   *  false ⇒ embedded in the workbook (`<workbook>/<name>` FQN). */
  published: boolean;
  /** Server-side stable identity (Metadata API `luid`) — live mode, published DSs only;
   *  file mode has no server context. Retained in platform_properties for future
   *  name-collision disambiguation. */
  luid?: string;
  connections: BiDescriptor[];
  relations: TableauRelationDoc[];
  fields: TableauFieldDoc[];
  upstream?: TableauUpstreamDoc;
}

/** One worksheet's visual structure (mark type, shelves, encodings, filters) — the
 *  Tableau visual-rebuild feature's raw material (Task A1). Populated only when the
 *  worksheet's `<table>` carries `<panes>` (mark info) — a `<table>` with no panes has
 *  nothing worth reporting, so `TableauSheetDoc.visual` stays undefined for it. */
export interface TableauSheetVisual {
  /** Primary pane's mark class, raw Tableau vocabulary (e.g. 'Bar', 'Automatic'). */
  markClass: string;
  /** One per pane, order preserved (a dual-axis chart has 2). */
  markClasses: string[];
  /** Resolved field names, order preserved. */
  rows: string[];
  cols: string[];
  /** Raw shelf expression text ('' if empty). */
  rowsRaw: string;
  colsRaw: string;
  /** color/size/text/shape/… channel → resolved field name, first pane only. */
  encodings: { channel: string; field: string }[];
  filters: { field: string; filterClass?: string }[];
  /** Explicit `<sort>` definitions captured from the worksheet's `<view>` (Task 6 fidelity
   *  backfill: docs/specs/2026-07-27-tableau-visual-capture.md §5 named this but it was
   *  never implemented). `direction` carries Tableau's own vocabulary ('ASC'/'DESC') raw,
   *  as the XML wrote it; absent only when the `<sort>` element itself carries none. */
  sorts?: { field: string; direction?: string }[];
}

/** One flattened dashboard zone (nested `<zone>` trees collapsed to a flat list) — the
 *  layout geometry a visual rebuild needs to place worksheets/text/filters. */
export interface TableauDashboardZone {
  sheetName?: string;
  /** 'worksheet' | 'text' | 'filter' | 'color' | 'layout-basic' | … */
  type: string;
  /** Percentages 0-100, 2-decimal rounded, from the XML's 100000-unit zone grid. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TableauDashboardLayout {
  /** From the dashboard's `<size>` attrs. */
  width?: number;
  height?: number;
  sizing?: string;
  zones: TableauDashboardZone[];
}

/** One embedded `<thumbnails>/<thumbnail>` entry — base64-encoded PNG bytes as Tableau
 *  wrote them into the `.twb`. */
export interface TableauThumbnailDoc {
  name: string;
  base64: string;
}

export interface TableauSheetDoc {
  name: string;
  /** Datasource identities (TableauDatasourceDoc.name) this sheet draws from. */
  datasourceRefs: string[];
  fieldRefs: { ds: string; field: string }[];
  /** Server-side stable identity (Metadata API `luid`) — live mode only; file mode has
   *  no server context. */
  luid?: string;
  /** Mark/shelf/encoding/filter structure (Task A1) — present only when the source XML's
   *  `<table>` for this worksheet carried `<panes>` (mark info); otherwise undefined. */
  visual?: TableauSheetVisual;
}

export interface TableauDashboardDoc {
  name: string;
  sheetNames: string[];
  /** Server-side stable identity (Metadata API `luid`) — live mode only; file mode has
   *  no server context. */
  luid?: string;
  /** Zone geometry + canvas size (Task A1) — present only when the source XML carried a
   *  `<size>` element or at least one coordinate-bearing (`x`/`y`/`w`/`h`) zone for this
   *  dashboard; a `<zones>` element whose zones carry no coordinates (and no `<size>`)
   *  leaves this undefined. */
  layout?: TableauDashboardLayout;
}

/** One workbook-scope parameter (Task 6 fidelity backfill). Tableau stores parameters as
 *  calculated fields inside a reserved `<datasource name='Parameters'>` — files.ts extracts
 *  them here instead of letting that pseudo-datasource flow through as a real
 *  `TableauDatasourceDoc`. Controller ruling (plan 2026-08-10): the corpus has no
 *  dashboard-parameter fixture evidence, so nothing downstream may emit guessed
 *  `.lvdash.json` parameter JSON from this — it flows into the doc model, catalog, briefs,
 *  and the rebuild checklist as a `needs_review` note only. */
export interface TableauParameterDoc {
  /** Bracket-stripped parameter name (e.g. 'Parameter 1'). */
  name: string;
  caption?: string;
  datatype?: string;
  /** The parameter's current value, exactly as the XML `value` attribute wrote it (a
   *  string-typed parameter's literal keeps its Tableau-syntax quotes, matching how
   *  `TableauFieldDoc.formula` preserves literal quoting). */
  currentValue?: string;
  /** Tableau's `param-domain-type` ('all' | 'list' | 'range') plus its domain data —
   *  `<members>/<member value=…>` for 'list', the nested `<range min= max=>` element's
   *  attributes for 'range' (NOT attributes on `<column>` itself — see files.ts). */
  allowableValues?: {
    kind: 'all' | 'list' | 'range';
    values?: string[];
    min?: string;
    max?: string;
  };
}

export interface TableauWorkbookDoc {
  /** Site content-URL, or 'default' (spec §5.1 decision 2); file mode has no server
   *  context, so files.ts always sets 'default'. */
  site: string;
  /** Project path, '/'-joined; file mode has no server context, so files.ts sets ''. */
  project: string;
  /** Workbook name — for file mode this is derived from the uploaded filename, since
   *  `.twb`/`.twbx` XML does not carry it (renaming the file renames the workbook on
   *  Server). A lone `.tds`/`.tdsx` (no workbook) also uses the filename here purely as
   *  a doc identifier; its one datasource is `published: true` and stands on its own FQN. */
  name: string;
  /** Server-side stable identity (Metadata API `luid`) — live mode only; file mode has
   *  no server context. */
  luid?: string;
  /** Embedded datasources, plus references to published ones (spec §8: both live here —
   *  a workbook can mix embedded and published-datasource references). */
  datasources: TableauDatasourceDoc[];
  sheets: TableauSheetDoc[];
  dashboards: TableauDashboardDoc[];
  /** Which delivery mode produced this doc's visual structure — file mode always sets
   *  'twb_file'; live mode (Task 5) will set 'twb_content' when it downloads the .twb
   *  from the Metadata API rather than reading an uploaded file. */
  visualSource?: 'twb_content' | 'twb_file';
  /** Embedded dashboard thumbnails, base64-encoded PNG bytes as Tableau wrote them. */
  thumbnails?: TableauThumbnailDoc[];
  /** Workbook-scope parameters, extracted from the `Parameters` pseudo-datasource and
   *  excluded from `datasources` (Task 6 fidelity backfill). Absent when the workbook
   *  declares no parameters — never an empty array. */
  parameters?: TableauParameterDoc[];
}
