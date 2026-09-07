// RebuildBrief assembly: the converter's in-memory rows → the JSON package the forge
// rebuild-author designs from. The assembler never fabricates: whatever the workbook
// didn't state becomes a note (pages_not_captured, no_field_usage, custom-SQL
// degradation, unresolved connections), and the brief is secret-free — the only
// connection value it may carry is a Databricks SQL warehouse HTTP path, passed in as a
// plain map rather than read from a credential.
//
// Ported from Linetria's build/brief.ts. Only the pure half comes over: the Postgres
// loader that fed it (`assembleRebuildBrief`, `loadElementAssets`) is replaced by
// ingest/adapter.ts plus bind/resolve.ts, which produce the same row shapes.

import {
  type BiAssetRow,
  type BiEdgeRow,
  DATASOURCE_TYPES,
  displayName,
} from '../bi/grouping.js';
import type { BiBindingRef, BiDescriptor } from '../model/types.js';
import {
  type BiColumnRow,
  type BiDerivationRow,
  tableauTypeFor,
  withDerivedHost,
} from '../convert/shared.js';
import type { ForgeDatabaseBlock } from '../forge/client.js';
import type {
  AssembledBrief,
  BriefCalculation,
  BriefDatasource,
  BriefElement,
  BriefField,
  BriefParameter,
  ElementAssetRef,
  ForgeDatatype,
  RebuildBrief,
} from './types.js';
import { buildElementLayout, buildElementVisual } from './visuals.js';

/** Derivation row plus the flags column (the shared rebuild loader doesn't
 *  select it; the brief carries flags through to the forge author). */
export interface BriefDerivationRow extends BiDerivationRow {
  flags?: string[] | null;
}

/** Binding row incl. the matched system (the rebuild loader's BiBindingLite plus
 *  matched_source_system_id, which the databricks http_path lift needs). */
export interface BriefBindingRow {
  asset_id: string;
  descriptor: BiDescriptor;
  refs: BiBindingRef[] | null;
  status: string;
  matched_source_system_id: string | null;
}

export interface BriefInputs {
  top: BiAssetRow;
  members: BiAssetRow[];
  edges: BiEdgeRow[];
  columnsByAsset: Map<string, BiColumnRow[]>;
  derivationsByAsset: Map<string, BriefDerivationRow[]>;
  bindingsByAsset: Map<string, BriefBindingRow[]>;
  /** source_system id → databricks SQL warehouse HTTP path (the one config value
   *  the brief may carry; extracted server-side so no secret object flows here). */
  httpPathBySystem: Map<string, string>;
  /** Tableau element asset ids with a captured bi_screenshot row (spec 2026-07-27
   *  tableau-visual-rebuild): drives BriefElement.screenshot_available. */
  screenshotAssetIds?: Set<string>;
}

/* ----------------------------------------------------------------- helpers */

const TABLE_COLUMN_RE = /^([^[\]]+)\[([^\]]+)\]$/;

/** `Sales[Amount]` → `Amount`; `[Total Sales]` → `Total Sales`. */
const fieldNameOf = (columnName: string): string => {
  const tableCol = TABLE_COLUMN_RE.exec(columnName);
  return tableCol ? tableCol[2] : columnName.replace(/^\[|\]$/g, '');
};

/** Connection platform_hint → forge live_database dialect. */
export function forgeDialectFor(platformHint: string): ForgeDatabaseBlock['dialect'] | null {
  switch (platformHint) {
    case 'postgres':
      return 'postgres';
    case 'mysql':
      return 'mysql';
    case 'snowflake':
      return 'snowflake';
    case 'azure_sql':
    case 'synapse_dedicated':
    case 'synapse_serverless':
      return 'sqlserver';
    case 'databricks':
      return 'databricks';
    default:
      return null;
  }
}

/** canonical/raw type → forge field datatype (rides tableauTypeFor — the exact
 *  mapping the .tds scaffolder already ships). */
export function forgeDatatypeFor(
  canonical: string | null,
  raw: string | null,
): { datatype: ForgeDatatype; note?: string } {
  const mapped = tableauTypeFor(canonical, raw);
  return { datatype: mapped.type as ForgeDatatype, note: mapped.note };
}

/** forge identifier: ^[a-z][a-z0-9_]{0,63}$, deduplicated within one brief. */
export function forgeIdFor(name: string, used: Set<string>): string {
  let slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(slug)) slug = `ds_${slug}`;
  slug = slug.slice(0, 60) || 'ds';
  let candidate = slug;
  for (let n = 2; used.has(candidate); n++) candidate = `${slug}_${n}`;
  used.add(candidate);
  return candidate;
}

/** Structural upstream-table refs: a declared table, not custom SQL. */
const isStructuralRef = (r: BiBindingRef): boolean => r.via === 'declared' || r.via === 'm_query';

interface ResolvedConnection {
  binding: BriefBindingRow;
  ref: BiBindingRef | null;
  how: 'declared attribution' | 'name match' | 'sole connection';
}

/** Table → binding attribution: pair a ref with the connection that owns it. */
export function connectionFor(
  table: string,
  bindings: BriefBindingRow[],
): ResolvedConnection | null {
  for (const b of bindings) {
    const ref = (b.refs ?? []).find((r) => isStructuralRef(r) && r.bi_object === table);
    if (ref) return { binding: b, ref, how: 'declared attribution' };
  }
  const lower = table.toLowerCase();
  for (const b of bindings) {
    const ref = (b.refs ?? []).find(
      (r) => isStructuralRef(r) && r.parts.object.toLowerCase() === lower,
    );
    if (ref) return { binding: b, ref, how: 'name match' };
  }
  if (bindings.length === 1) {
    const declared = (bindings[0].refs ?? []).filter(isStructuralRef);
    return {
      binding: bindings[0],
      ref: declared.length === 1 ? declared[0] : null,
      how: 'sole connection',
    };
  }
  return null;
}

/** Render one resolved (or unresolved) connection as a forge live_database block.
 *  Never fabricates: unknowns become 'unknown' + a note, never plausible guesses. */
export function connectionBlock(
  tableName: string,
  resolved: ResolvedConnection | null,
  httpPathBySystem: Map<string, string>,
  notes: string[],
): ForgeDatabaseBlock {
  if (!resolved) {
    notes.push(
      `no matched connection for '${tableName}' — bind the model on the Catalog page; the connection must be fixed in the rebuilt report after opening it`,
    );
    return { dialect: 'sqlserver', host: 'unknown', database: 'unknown', table: tableName };
  }
  const d = withDerivedHost(resolved.binding.descriptor);
  const dialect = forgeDialectFor(d.platform_hint);
  if (dialect === null) {
    notes.push(
      `platform '${d.platform_hint}' has no live-connection dialect — connection defaults to sqlserver; fix it in the rebuilt report after opening it`,
    );
  }
  if (resolved.how !== 'declared attribution') {
    notes.push(`connection for '${tableName}' attributed by ${resolved.how} — verify it is the real source`);
  }
  if (resolved.binding.status !== 'matched') {
    // Spec §6: an unmatched descriptor degrades to a needs_review note even when
    // it carries a complete-looking host/database.
    notes.push(
      `connection for '${tableName}' is not matched to a registered source system — verify host/database (bind the model on the Catalog page)`,
    );
  }
  // Target-neutral wording throughout: the brief is built before the target
  // picks a compiler, so a note must not tell a Databricks build to open Tableau.
  if (!d.host) notes.push(`connection for '${tableName}' has no host — fill it in in the rebuilt report after opening it`);
  if (!d.database) notes.push(`connection for '${tableName}' has no database — fill it in in the rebuilt report after opening it`);
  const block: ForgeDatabaseBlock = {
    dialect: dialect ?? 'sqlserver',
    host: d.host ?? 'unknown',
    database: d.database ?? 'unknown',
    table: resolved.ref?.parts.object ?? tableName,
  };
  const schema = resolved.ref?.parts.schema ?? d.schema;
  if (schema) block.db_schema = schema;
  if (d.warehouse) block.warehouse = d.warehouse;
  const port = Number(d.extra?.port);
  if (Number.isInteger(port) && port > 0 && port <= 65535) block.port = port;
  if (!resolved.ref) {
    notes.push(`no declared table reference retained for '${tableName}' — the relation targets the model table name`);
  }
  if (block.dialect === 'databricks') {
    const systemId = resolved.binding.matched_source_system_id;
    const httpPath = systemId ? httpPathBySystem.get(systemId) : undefined;
    if (httpPath) {
      block.http_path = httpPath;
    } else {
      notes.push(
        `databricks http_path unknown for '${tableName}' — set the SQL warehouse HTTP path in the rebuilt report after opening it`,
      );
    }
  }
  return block;
}

/** A workbook's dashboards and sheets reduced to {id, raw name, brief element name} — the
 *  exact join key screenshot matching uses: by asset id, never endsWith-fuzzy matching. */
function elementAssetsOf(top: BiAssetRow, members: BiAssetRow[]): ElementAssetRef[] {
  return members
    .filter((m) => m.asset_type === 'bi_dashboard' || m.asset_type === 'bi_sheet')
    .map((m) => ({ id: m.id, name: m.name, briefName: displayName(top, m) }));
}

/** report.parameters brief field cap — the schema's structural caps (§ datasources/fields)
 *  set the precedent; parameters get the same degrade-with-note treatment rather than an
 *  unbounded array. */
const MAX_PARAMETERS = 64;

interface RawParameterAllowable {
  kind?: string;
  values?: string[];
  min?: string;
  max?: string;
}

interface RawParameter {
  name?: string;
  caption?: string;
  datatype?: string;
  current_value?: string;
  allowable_values?: RawParameterAllowable;
}

/** `top.platform_properties.parameters` (mapper.ts's snake_case, Task 6) → the brief's
 *  `report.parameters` — capped at MAX_PARAMETERS with a drop note. Undefined when the
 *  workbook declares none (never an empty array, mirroring every other optional brief
 *  block). Controller ruling: extraction/surfacing only — this never emits guessed
 *  `.lvdash.json` parameter JSON, it just carries what the twb actually declared. */
function buildReportParameters(top: BiAssetRow, notes: string[]): BriefParameter[] | undefined {
  const props = (top.platform_properties ?? {}) as Record<string, unknown>;
  const raw = (props.parameters as RawParameter[] | undefined) ?? [];
  if (raw.length === 0) return undefined;
  const dropped = raw.length > MAX_PARAMETERS ? raw.length - MAX_PARAMETERS : 0;
  const kept = dropped > 0 ? raw.slice(0, MAX_PARAMETERS) : raw;
  const parameters: BriefParameter[] = kept.map((p) => {
    const param: BriefParameter = { name: p.name ?? '' };
    if (p.caption !== undefined) param.caption = p.caption;
    if (p.datatype !== undefined) param.datatype = p.datatype;
    if (p.current_value !== undefined) param.current_value = p.current_value;
    const av = p.allowable_values;
    if (av && (av.kind === 'all' || av.kind === 'list' || av.kind === 'range')) {
      const allowable: NonNullable<BriefParameter['allowable']> = { kind: av.kind };
      if (av.values) allowable.values = av.values;
      if (av.min !== undefined) allowable.min = av.min;
      if (av.max !== undefined) allowable.max = av.max;
      param.allowable = allowable;
    }
    return param;
  });
  if (dropped > 0) {
    notes.push(
      `workbook declares ${raw.length} parameters — only the first ${MAX_PARAMETERS} were scaffolded (brief cap); dropped ${dropped}`,
    );
  }
  return parameters;
}

/* --------------------------------------------------------------- assembly */

const languageOf = (d: BriefDerivationRow): BriefCalculation['language'] => {
  const l = (d.language ?? 'sql') as BriefCalculation['language'];
  return l === 'dax' || l === 'tableau_calc' || l === 'm' || l === 'sql' ? l : 'sql';
};

/** Table prefixes a measure's input refs name. */
const refTablesOf = (deriv: BriefDerivationRow): Set<string> => {
  const out = new Set<string>();
  for (const r of deriv.input_refs ?? []) {
    const m = /^([^[\]]+)\[/.exec(r.column);
    if (m) out.add(m[1]);
  }
  return out;
};

/** Pure core: grouped catalog rows → RebuildBrief. */
export function buildBrief(inputs: BriefInputs): AssembledBrief {
  const { top, members, edges } = inputs;
  // The brief's `platform` is the AUTHORING contract: it tells the rebuild author
  // what the source formulas are written in (DAX vs Tableau calc) and what shape
  // its elements have. Coercing anything unrecognized to 'tableau' briefed, for
  // example, a Databricks AI/BI container as a Tableau workbook — with zero
  // datasources, because none of the Tableau extraction paths matched — and then
  // spent three LLM calls discovering that. A source platform this lane has no
  // reader for is a failed run with a name in it, not a silent mislabel. The
  // runner turns a thrown error into a `failed` build_run carrying this message.
  if (top.platform !== 'tableau') {
    throw new Error(
      `BI platform '${top.platform}' cannot be converted: the rebuild brief reads Tableau ` +
        `reports only, and a '${top.platform}' report's structure would be briefed as ` +
        `something it is not.`,
    );
  }
  const briefNotes: string[] = [];
  const usedIds = new Set<string>();
  const byId = new Map([[top.id, top], ...members.map((m) => [m.id, m] as const)]);

  const datasourceAssets = [
    ...(DATASOURCE_TYPES.has(top.asset_type) ? [top] : []),
    ...members.filter((m) => DATASOURCE_TYPES.has(m.asset_type)),
  ];

  const datasources: BriefDatasource[] = [];
  /** BI field name (lowercased) → brief field name, for element field lists. */
  const briefNameByBiField = new Map<string, string>();

  for (const dsAsset of datasourceAssets) {
    const columns = inputs.columnsByAsset.get(dsAsset.id) ?? [];
    const derivations = inputs.derivationsByAsset.get(dsAsset.id) ?? [];
    const bindings = inputs.bindingsByAsset.get(dsAsset.id) ?? [];
    const derivByColumn = new Map<string, BiDerivationRow>();
    const derivByName = new Map<string, BiDerivationRow>();
    for (const d of derivations) {
      if (d.output_column_id) derivByColumn.set(d.output_column_id, d);
      derivByName.set(d.output_name, d);
    }

    // Physical column names the stitcher retained (bi_field → db_column).
    const physicalByField = new Map<string, string>();
    for (const b of bindings) {
      for (const r of b.refs ?? []) {
        for (const col of r.columns ?? []) {
          const key = col.bi_field.toLowerCase().replace(/^\[|\]$/g, '');
          if (!physicalByField.has(key)) physicalByField.set(key, col.db_column);
        }
      }
    }

    const fieldOf = (c: BiColumnRow): BriefField => {
      const props = (c.platform_properties ?? {}) as Record<string, unknown>;
      const biName = (props.caption as string | undefined) ?? fieldNameOf(c.name);
      const physical = physicalByField.get(biName.toLowerCase()) ??
        physicalByField.get(fieldNameOf(c.name).toLowerCase());
      const mapped = forgeDatatypeFor(
        c.data_type_canonical,
        c.data_type_raw ?? ((props.datatype as string | undefined) ?? null),
      );
      const role =
        (props.role as string | undefined) === 'measure' ||
        ((props.role as string | undefined) == null &&
          (mapped.datatype === 'integer' || mapped.datatype === 'real'))
          ? 'measure'
          : 'dimension';
      const name = physical ?? biName;
      briefNameByBiField.set(biName.toLowerCase(), name);
      briefNameByBiField.set(fieldNameOf(c.name).toLowerCase(), name);
      const field: BriefField = { name, datatype: mapped.datatype, role };
      if (physical && physical !== biName) field.caption = biName;
      if (role === 'measure') field.default_aggregation = 'sum';
      return field;
    };

    // A calc input the catalog could not resolve to any column of its datasource
    // is, on a Tableau workbook, most often a workbook parameter ([p Design
    // Scheme]) — carried as `unresolved_ref:<name>` so the rebuild author knows
    // the formula reads something the brief does not declare, rather than
    // guessing (review 2026-09-04: 'cx summary' legend calcs).
    const calcOf = (name: string, deriv: BriefDerivationRow, extraFlags: string[] = []): BriefCalculation => ({
      name,
      formula: deriv.expression_sql,
      language: languageOf(deriv),
      derivation_type: deriv.derivation_type ?? [],
      flags: [
        ...(deriv.flags ?? []),
        ...(deriv.input_refs ?? [])
          .filter((r) => r.resolution === 'unresolved')
          .map((r) => `unresolved_ref:${r.column}`),
        ...extraFlags,
      ],
    });

    // Fields and calcs at datasource grain.
    const dsName = displayName(top, dsAsset);
    const notes: string[] = [];
    const sourceCols = columns.filter((c) => !(derivByColumn.has(c.id) || derivByName.has(c.name)));
    const calcCols = columns.filter((c) => derivByColumn.has(c.id) || derivByName.has(c.name));
    const calcs: BriefCalculation[] = calcCols.map((c) => {
      const deriv = derivByColumn.get(c.id) ?? derivByName.get(c.name)!;
      const props = (c.platform_properties ?? {}) as Record<string, unknown>;
      return calcOf((props.caption as string | undefined) ?? fieldNameOf(c.name), deriv);
    });
    // Pair the ref with the binding that OWNS it — a federated datasource has
    // one binding per named connection, and grafting another connection's
    // table onto bindings[0]'s host would be silently wrong (review
    // 2026-07-22). Multi-binding pairings are flagged for verification.
    const withRef =
      bindings.find((b) => (b.refs ?? []).some(isStructuralRef)) ?? null;
    const pairedRef = withRef?.refs?.find(isStructuralRef) ?? null;
    const resolved: ResolvedConnection | null =
      withRef && pairedRef
        ? {
            binding: withRef,
            ref: pairedRef,
            how: bindings.length === 1 ? 'declared attribution' : 'name match',
          }
        : bindings.length > 0
          ? { binding: bindings[0], ref: null, how: 'sole connection' }
          : null;
    if (withRef && pairedRef && bindings.length > 1) {
      notes.push(
        `datasource declares ${bindings.length} connections — the one carrying the declared table reference was scaffolded; model the others separately`,
      );
    }
    datasources.push({
      id: forgeIdFor(dsName, usedIds),
      name: dsName,
      connection: connectionBlock(dsName, resolved, inputs.httpPathBySystem, notes),
      fields: sourceCols.map(fieldOf),
      calculations: calcs,
      notes,
    });
  }

  /* forge structural caps (schema: 1–8 datasources, 1–256 fields each) — enforced
   * here with degrade-with-notes so an out-of-range estate cannot send the
   * rebuild author into a retry loop it can never satisfy (review 2026-07-22). */
  for (let i = datasources.length - 1; i >= 0; i--) {
    const ds = datasources[i];
    // BI docs can define several local fields over one physical column (same
    // name, different captions/datatypes — a date column read both as date and
    // string). The compiled workbook gets ONE column per name; duplicates fail
    // forge's round-trip datatype check, so collapse to the first occurrence.
    const byName = new Map<string, number>();
    for (const f of ds.fields) byName.set(f.name, (byName.get(f.name) ?? 0) + 1);
    const dupes = [...byName.entries()].filter(([, n]) => n > 1);
    if (dupes.length > 0) {
      const seen = new Set<string>();
      ds.fields = ds.fields.filter((f) => !seen.has(f.name) && (seen.add(f.name), true));
      briefNotes.push(
        `table '${ds.name}' declares ${dupes.length} field name(s) more than once ` +
          `(${dupes.slice(0, 3).map(([n, c]) => `'${n}' ×${c}`).join(', ')}) — kept the first ` +
          `of each; verify the column type in the rebuilt report after opening it`,
      );
    }
    if (ds.fields.length === 0) {
      briefNotes.push(
        `table '${ds.name}' has no source columns (all derived or none captured) — omitted from the workbook${ds.calculations.length > 0 ? `; its ${ds.calculations.length} calculation(s) were not scaffolded` : ''}`,
      );
      datasources.splice(i, 1);
    } else if (ds.fields.length > 256) {
      briefNotes.push(
        `table '${ds.name}' has ${ds.fields.length} columns — only the first 256 were scaffolded (forge field cap)`,
      );
      ds.fields = ds.fields.slice(0, 256);
    }
  }
  if (datasources.length > 8) {
    // Keep the 8 tables the report's elements actually reference the most.
    const usage = new Map<string, number>();
    for (const e of edges) {
      if (e.to_column_name) {
        const name = briefNameByBiField.get(fieldNameOf(e.to_column_name).toLowerCase());
        if (name) usage.set(name, (usage.get(name) ?? 0) + 1);
      }
    }
    const score = (ds: BriefDatasource): number =>
      ds.fields.reduce((n, f) => n + (usage.get(f.name) ?? 0), 0) * 1000 +
      ds.calculations.length * 10 +
      ds.fields.length;
    const ranked = [...datasources].sort((a, b) => score(b) - score(a));
    const kept = new Set(ranked.slice(0, 8).map((d) => d.id));
    const dropped = datasources.filter((d) => !kept.has(d.id)).map((d) => d.name);
    briefNotes.push(
      `model has ${datasources.length} tables but the rebuild spec supports at most 8 datasources — kept the most-referenced; omitted: ${dropped.join(', ')}`,
    );
    for (let i = datasources.length - 1; i >= 0; i--) {
      if (!kept.has(datasources[i].id)) datasources.splice(i, 1);
    }
  }
  // Calculation names must be brief-unique: the translation report is keyed by
  // bare name, so same-named calcs on two tables would collapse (review
  // 2026-07-22). Later duplicates get a table-qualified name.
  const calcNamesSeen = new Set<string>();
  for (const ds of datasources) {
    for (const c of ds.calculations) {
      if (calcNamesSeen.has(c.name)) {
        const qualified = `${c.name} (${ds.name})`;
        ds.notes.push(
          `calculation '${c.name}' also exists on another table — scaffolded here as '${qualified}'`,
        );
        c.name = qualified;
      }
      calcNamesSeen.add(c.name);
    }
  }

  /* elements */
  const elements: BriefElement[] = [];
  const reportNotes: string[] = [];
  const translateFields = (names: Iterable<string>): string[] => [
    ...new Set(
      [...names].map(
        (n) => briefNameByBiField.get(fieldNameOf(n).toLowerCase()) ?? fieldNameOf(n),
      ),
    ),
  ];

  const els = members.filter(
    (m) => m.asset_type === 'bi_dashboard' || m.asset_type === 'bi_sheet',
  );
  const translateOne = (n: string): string =>
    briefNameByBiField.get(fieldNameOf(n).toLowerCase()) ?? fieldNameOf(n);
  for (const el of els) {
    const used = edges
      .filter((e) => e.from_asset_id === el.id && e.to_column_name)
      .map((e) => e.to_column_name!);
    const element: BriefElement = {
      name: displayName(top, el),
      kind: el.asset_type.replace(/^bi_/, ''),
      fields: translateFields(used),
    };
    const props = (el.platform_properties ?? {}) as Record<string, unknown>;
    const vis = buildElementVisual(props, translateOne);
    if (vis) element.visual = vis;
    const layout = buildElementLayout(props);
    if (layout) element.layout = layout;
    if (inputs.screenshotAssetIds?.has(el.id)) element.screenshot_available = true;
    elements.push(element);
  }
  if (elements.length === 0) {
    reportNotes.push('no_sheets_captured');
  }

  /* Brief honesty: an element may only name fields the brief actually declares.
     A captured Tableau shelf routinely carries things that are not columns of any
     datasource — generated geo fields ('Latitude (generated)'), clustering groups
     ('Country/Region (clusters)'), internal 'Calculation_<id>' references, the
     'Multiple Values' Measure-Names placeholder, or a raw shelf token that never
     resolved ('sum:GDP:qk'). translateFields/translateOne pass those through
     unchanged, and the rebuild prompt forbids referencing anything undeclared —
     so the brief was telling the model to do precisely what the cross-check then
     rejects. Observed on 'world indicators': 8 of 14 elements affected, and every
     authoring attempt failed on it. Drop them, and say what was dropped. */
  const declaredFields = new Set<string>();
  for (const ds of datasources) {
    for (const f of ds.fields) declaredFields.add(f.name);
    for (const c of ds.calculations) declaredFields.add(c.name);
  }
  const droppedRefs = new Set<string>();
  const declared = (name: string | undefined): boolean => {
    if (name === undefined) return false;
    if (declaredFields.has(name)) return true;
    droppedRefs.add(name);
    return false;
  };
  for (const el of elements) {
    el.fields = el.fields.filter(declared);
    const v = el.visual;
    if (!v) continue;
    v.rows = v.rows.filter(declared);
    v.cols = v.cols.filter(declared);
    if (!declared(v.color)) delete v.color;
    if (!declared(v.size)) delete v.size;
    if (!declared(v.label)) delete v.label;
    if (v.filters) {
      v.filters = v.filters.filter(declared);
      if (v.filters.length === 0) delete v.filters;
    }
    if (v.sorts) {
      v.sorts = v.sorts.filter((s) => declared(s.field));
      if (v.sorts.length === 0) delete v.sorts;
    }
  }
  if (droppedRefs.size > 0) {
    const shown = [...droppedRefs].sort().slice(0, 8);
    reportNotes.push(
      `dropped ${droppedRefs.size} shelf/field reference(s) not declared by any datasource ` +
        `(generated, clustering, or unresolved Tableau fields): ${shown.join(', ')}` +
        (droppedRefs.size > shown.length ? `, +${droppedRefs.size - shown.length} more` : ''),
    );
  }

  const parameters = buildReportParameters(top, reportNotes);
  // Unresolved calc inputs on a workbook that carries NO captured parameters:
  // either the workbook really declares none, or the extraction predates
  // parameter capture (2026-08-10) — the brief cannot tell, so it says which
  // action would settle it instead of letting the model guess at the calc.
  if (!parameters) {
    const unresolved = new Map<string, number>();
    for (const ds of datasources) {
      for (const c of ds.calculations) {
        for (const f of c.flags) {
          if (f.startsWith('unresolved_ref:')) {
            const ref = f.slice('unresolved_ref:'.length);
            unresolved.set(ref, (unresolved.get(ref) ?? 0) + 1);
          }
        }
      }
    }
    if (unresolved.size > 0) {
      const shown = [...unresolved.keys()].sort().slice(0, 8);
      reportNotes.push(
        `calculations read ${unresolved.size} reference(s) no datasource resolves (${shown.join(', ')}` +
          `${unresolved.size > shown.length ? `, +${unresolved.size - shown.length} more` : ''}) and the ` +
          `workbook carries no captured parameters — if these are workbook parameters, re-run extraction ` +
          `for this source (parameter capture was added 2026-08-10) so the calculations can be translated`,
      );
    }
  }

  const brief: RebuildBrief = {
    brief_version: '1',
    report: {
      name: top.name,
      platform: 'tableau',
      fqn: top.fqn,
      elements,
      ...(parameters ? { parameters } : {}),
      notes: reportNotes,
    },
    datasources,
    notes: briefNotes,
  };
  const warnings = [...briefNotes, ...datasources.flatMap((d) => d.notes)];
  void byId;
  return { brief, workbookName: top.name, warnings, elementAssets: elementAssetsOf(top, members) };
}

/* ------------------------------------------------------------------ loader */

/** Load everything buildBrief needs for one report container and assemble. */
