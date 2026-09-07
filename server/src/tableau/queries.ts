import type { BiApiFetch } from './docsource.js';
import type { BiDescriptor } from '../model/types.js';
import type {
  TableauDashboardDoc,
  TableauDatasourceDoc,
  TableauFieldDoc,
  TableauRelationDoc,
  TableauSheetDoc,
  TableauTableParts,
  TableauUpstreamDoc,
  TableauWorkbookDoc,
} from './model.js';

/**
 * Tableau live-mode GraphQL (Metadata API) — request builders + response → doc-model
 * assembly (BI connectors plan Task 5). The doc shape produced here (`buildWorkbookDoc`)
 * is bit-for-bit `TableauWorkbookDoc` — mapper.ts (Task 4) consumes it unchanged (spec §4
 * one-normalizer invariant), the only difference from file mode being that `upstream` is
 * populated (the live-only, API-declared 0.95 upstream-column source).
 *
 * Table refs here carry only `schema`/`object` (no catalog) — mapper.ts backfills catalog
 * from the owning connection descriptor's `database` for both modes, so this file doesn't
 * need to duplicate that logic.
 */

const SNOWFLAKE_HOST_RE = /^([a-z0-9-]+)\.snowflakecomputing\.com$/i;

// ---------------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------------

/** `signin` stepId's request payload — content is irrelevant (TableauLiveExecutor builds
 *  the real REST signin body from its own config), but ApiDocSource always serializes
 *  *some* request, and an explicit empty object beats `undefined` in replay fixtures. */
export function signinRequest(): unknown {
  return {};
}

/** `serverinfo` stepId's request payload — the live executor routes this stepId to the REST
 *  `GET /api/3.22/serverinfo` endpoint (the Metadata API GraphQL schema has no server-version
 *  field), so like `signin` the body content is irrelevant. */
export function serverInfoRequest(): unknown {
  return {};
}

// The cheapest query the Metadata API schema actually supports — used by testConnection to
// prove the Metadata API is enabled (on Tableau Server it can be off: `tsm maintenance
// metadata-services enable`) before extraction relies on it.
const METADATA_PING_QUERY = `query MetadataPing { tableauSites { name } }`;

export function metadataPingRequest(): unknown {
  return { query: METADATA_PING_QUERY };
}

// Interface-safe selections. The Metadata API only defines `name` (plus lineage helpers
// like `upstreamColumns`) on the `Field`/`Table`/`Database` INTERFACES — dataType/role/
// formula live on the concrete types (ColumnField/CalculatedField), `schema`/`database`
// on DatabaseTable, `hostName` on DatabaseServer. Selecting them at interface level is a
// GraphQL validation error on real servers (FieldUndefined), so every subtype-only field
// rides an inline fragment. There is no `caption` anywhere in the Metadata API (`name` IS
// the display name), and `isCalculated` is implied by the CalculatedField type.
const DATABASE_REF = `{ name connectionType ... on DatabaseServer { hostName } }`;

// The datasource selection is identical for embedded and published (upstream) datasources —
// kept as one fragment-shaped constant so the two can never drift.
const DATASOURCE_FIELDS = `
        name
        fields {
          name
          ... on ColumnField { dataType role }
          ... on CalculatedField { dataType role formula }
          upstreamColumns {
            name
            table {
              name
              ... on DatabaseTable { schema database ${DATABASE_REF} }
            }
          }
        }
        upstreamTables { name schema fullName database ${DATABASE_REF} }`;

const WORKBOOKS_QUERY = `
query Workbooks($first: Int!, $after: String) {
  workbooksConnection(first: $first, after: $after) {
    nodes {
      luid
      name
      projectName
      sheets {
        luid
        name
        upstreamFields { name datasource { name } }
      }
      dashboards { luid name sheets { name } }
      embeddedDatasources {${DATASOURCE_FIELDS}
      }
      upstreamDatasources {
        luid${DATASOURCE_FIELDS}
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export function workbooksRequest(cursor: string | null): unknown {
  return { query: WORKBOOKS_QUERY, variables: { first: 100, after: cursor } };
}

// Custom SQL is NOT reachable through the datasource types (no `customSQLTablesConnection`
// field exists on Embedded/PublishedDatasource in the real schema) — it is a top-level
// connection, associated back to its owners via lineage: `downstreamDatasources` (published
// datasources only, by schema) and `downstreamWorkbooks` (for embedded datasources).
const CUSTOM_SQL_QUERY = `
query CustomSQLTables($first: Int!, $after: String) {
  customSQLTablesConnection(first: $first, after: $after) {
    nodes {
      query
      database ${DATABASE_REF}
      downstreamWorkbooks { luid name }
      downstreamDatasources { luid name }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export function customSqlRequest(cursor: string | null): unknown {
  return { query: CUSTOM_SQL_QUERY, variables: { first: 100, after: cursor } };
}

// ---------------------------------------------------------------------------------
// Response shapes (loosely typed — this is arbitrary JSON off the wire/fixture)
// ---------------------------------------------------------------------------------

interface GqlDatabaseRef {
  name?: string | null;
  connectionType?: string | null;
  hostName?: string | null;
}

interface GqlTableRef {
  name?: string | null;
  schema?: string | null;
  fullName?: string | null;
  database?: GqlDatabaseRef | null;
}

interface GqlFieldNode {
  name: string;
  dataType?: string | null;
  role?: string | null;
  formula?: string | null;
  upstreamColumns?: Array<{ name: string; table?: GqlTableRef | null }> | null;
}

interface GqlEmbeddedDatasource {
  name: string;
  /** Server-side stable identity — requested on upstreamDatasources (published) only. */
  luid?: string | null;
  fields?: GqlFieldNode[] | null;
  upstreamTables?: GqlTableRef[] | null;
}

interface GqlOwnerRef {
  luid?: string | null;
  name?: string | null;
}

interface GqlCustomSqlNode {
  query: string;
  database?: GqlDatabaseRef | null;
  downstreamWorkbooks?: GqlOwnerRef[] | null;
  /** Published datasources only (schema: PublishedDatasource_Filter). */
  downstreamDatasources?: GqlOwnerRef[] | null;
}

interface CustomSqlConnectionResponse {
  data: {
    customSQLTablesConnection: {
      nodes: GqlCustomSqlNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

interface GqlSheetNode {
  luid?: string | null;
  name: string;
  upstreamFields?: Array<{ name: string; datasource?: { name: string } | null }> | null;
}

interface GqlDashboardNode {
  luid?: string | null;
  name: string;
  sheets?: Array<{ name: string }> | null;
}

interface GqlWorkbookNode {
  luid?: string | null;
  name: string;
  projectName?: string | null;
  sheets?: GqlSheetNode[] | null;
  dashboards?: GqlDashboardNode[] | null;
  embeddedDatasources?: GqlEmbeddedDatasource[] | null;
  /** Published datasources this workbook references — identical selection shape to
   *  embeddedDatasources (coverage matrix: live mode covers "published+embedded DS"). */
  upstreamDatasources?: GqlEmbeddedDatasource[] | null;
}

interface WorkbooksConnectionResponse {
  data: {
    workbooksConnection: {
      nodes: GqlWorkbookNode[];
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  };
}

// ---------------------------------------------------------------------------------
// Response → doc-model assembly
// ---------------------------------------------------------------------------------

function tableParts(t: GqlTableRef): TableauTableParts {
  const parts: TableauTableParts = { object: t.name ?? '' };
  if (t.schema) parts.schema = t.schema;
  return parts;
}

/** One (connectionType, database) pair's stable identity — plays the role file mode's
 *  `<named-connection name=...>` XML id plays: correlates a relation/upstream ref to the
 *  `BiDescriptor` it belongs to (files.ts sets both ends the same way, via
 *  `extra.named_connection`). */
function connectionId(connType: string, db: GqlDatabaseRef | null | undefined): string {
  return `${connType}:${db?.name ?? ''}`;
}

function buildDescriptor(connType: string, db: GqlDatabaseRef | null | undefined): BiDescriptor {
  const host = db?.hostName ?? null;
  const account =
    connType === 'snowflake' && host ? (SNOWFLAKE_HOST_RE.exec(host)?.[1] ?? null) : null;
  return {
    platform_hint: connType,
    host,
    account,
    database: db?.name ?? null,
    warehouse: null,
    schema: null,
    connection_type: connType,
    extra: { named_connection: connectionId(connType, db) },
  };
}

function buildField(f: GqlFieldNode): TableauFieldDoc {
  const field: TableauFieldDoc = { name: f.name };
  // GraphQL enums come back uppercase ("INTEGER"/"DIMENSION"); file mode's XML attrs are
  // lowercase — normalize so both modes land the same vocabulary in platform_properties.
  if (f.dataType != null) field.datatype = f.dataType.toLowerCase();
  if (f.role != null) field.role = f.role.toLowerCase();
  if (f.formula != null) field.formula = f.formula;
  return field;
}

function buildDatasourceDoc(
  node: GqlEmbeddedDatasource,
  published: boolean,
  customSql: readonly GqlCustomSqlNode[] = [],
): TableauDatasourceDoc {
  const fields = (node.fields ?? []).map(buildField);
  const relations: TableauRelationDoc[] = [];
  const connections: BiDescriptor[] = [];
  const seenConnIds = new Set<string>();
  const addConnection = (connType: string, db: GqlDatabaseRef | null | undefined): string => {
    const id = connectionId(connType, db);
    if (!seenConnIds.has(id)) {
      seenConnIds.add(id);
      connections.push(buildDescriptor(connType, db));
    }
    return id;
  };

  for (const cs of customSql) {
    const connType = cs.database?.connectionType ?? 'unknown';
    const id = addConnection(connType, cs.database);
    relations.push({ kind: 'custom_sql', sql: cs.query, connection: id });
  }

  const upstreamTables = node.upstreamTables ?? [];
  for (const t of upstreamTables) {
    const connType = t.database?.connectionType ?? 'unknown';
    const id = addConnection(connType, t.database);
    relations.push({ kind: 'table', table: tableParts(t), connection: id });
  }

  // Live-only (decision: API-declared upstream tables/columns → 0.95). Tables mirror the
  // relations built above (same connection id); columns come from each field's own
  // `upstreamColumns` — only non-calculated fields carry these in practice (a calculated
  // field is derived, not directly sourced from a physical column).
  const upstreamTableRefs = upstreamTables.map((t) => ({
    parts: tableParts(t),
    connection: connectionId(t.database?.connectionType ?? 'unknown', t.database),
  }));
  const upstreamColumnRefs: TableauUpstreamDoc['columns'] = [];
  for (const f of node.fields ?? []) {
    for (const uc of f.upstreamColumns ?? []) {
      if (!uc.table) continue;
      upstreamColumnRefs.push({ field: f.name, table: tableParts(uc.table), column: uc.name });
    }
  }

  const doc: TableauDatasourceDoc = {
    name: node.name,
    published,
    connections,
    relations,
    fields,
    upstream:
      upstreamTableRefs.length > 0 || upstreamColumnRefs.length > 0
        ? { tables: upstreamTableRefs, columns: upstreamColumnRefs }
        : undefined,
  };
  if (node.luid != null) doc.luid = node.luid;
  return doc;
}

/** Does a custom SQL table's downstream owner list include this (luid, name) identity?
 *  luid is the server-side stable id (always present in real responses) — name is the
 *  fixture-friendly fallback. */
function ownedBy(refs: GqlOwnerRef[] | null | undefined, luid: string | null | undefined, name: string): boolean {
  return (refs ?? []).some((r) => (luid != null && r.luid === luid) || r.name === name);
}

/** Custom SQL → EMBEDDED datasource association. The schema only links a CustomSQLTable to
 *  its workbooks (`downstreamWorkbooks`) and to PUBLISHED datasources — the owning embedded
 *  datasource must be inferred. Attach only when unambiguous (never fabricate ownership):
 *  1. exactly one embedded DS already references the custom SQL's database (via
 *     upstreamTables) — the SQL runs on a connection that DS demonstrably holds;
 *  2. else exactly one embedded DS has no table relations at all (the custom-SQL-only DS
 *     shape: Tableau reports no DatabaseTable upstreams for a pure custom-SQL source);
 *  3. else the workbook has exactly one embedded DS.
 *  Anything still ambiguous is dropped — a missing definition_sql is honest, a
 *  mis-attributed one is fabricated lineage. */
function assignCustomSqlToEmbedded(
  embedded: readonly GqlEmbeddedDatasource[],
  workbookSql: readonly GqlCustomSqlNode[],
): Map<GqlEmbeddedDatasource, GqlCustomSqlNode[]> {
  const assigned = new Map<GqlEmbeddedDatasource, GqlCustomSqlNode[]>();
  for (const cs of workbookSql) {
    const csConnId = connectionId(cs.database?.connectionType ?? 'unknown', cs.database);
    let candidates = embedded.filter((d) =>
      (d.upstreamTables ?? []).some(
        (t) => connectionId(t.database?.connectionType ?? 'unknown', t.database) === csConnId,
      ),
    );
    if (candidates.length !== 1) {
      const bare = embedded.filter((d) => (d.upstreamTables ?? []).length === 0);
      candidates = bare.length === 1 ? bare : embedded.length === 1 ? [...embedded] : [];
    }
    if (candidates.length === 1) {
      const list = assigned.get(candidates[0]) ?? [];
      list.push(cs);
      assigned.set(candidates[0], list);
    }
  }
  return assigned;
}

/** One GraphQL workbook node → the doc model both modes share. `site` is supplied by the
 *  caller (config-derived — the Metadata API has no per-workbook site field, the whole
 *  connection is scoped to one site already).
 *
 *  Published datasources (`upstreamDatasources`) join the doc's `datasources` array with
 *  `published: true`, so the mapper gives them their own FQN (decision 2, same as file
 *  mode's `.tds` docs) and sheets referencing them by name resolve without special-casing.
 *  `seenPublishedNames` dedups across workbooks (and pages): a published DS referenced by
 *  several workbooks materializes exactly ONE doc — on the first-seen workbook — and later
 *  references resolve by name through the mapper's existing ref-name fallback. */
export function buildWorkbookDoc(
  site: string,
  node: GqlWorkbookNode,
  seenPublishedNames: Set<string> = new Set(),
  customSql: readonly GqlCustomSqlNode[] = [],
): TableauWorkbookDoc {
  const sheets = (node.sheets ?? []).map((s) => {
    const datasourceRefs: string[] = [];
    const fieldRefs: { ds: string; field: string }[] = [];
    for (const uf of s.upstreamFields ?? []) {
      const ds = uf.datasource?.name ?? '';
      if (!datasourceRefs.includes(ds)) datasourceRefs.push(ds);
      fieldRefs.push({ ds, field: uf.name });
    }
    const sheet: TableauSheetDoc = { name: s.name, datasourceRefs, fieldRefs };
    if (s.luid != null) sheet.luid = s.luid;
    return sheet;
  });
  const dashboards = (node.dashboards ?? []).map((d) => {
    const dash: TableauDashboardDoc = { name: d.name, sheetNames: (d.sheets ?? []).map((s) => s.name) };
    if (d.luid != null) dash.luid = d.luid;
    return dash;
  });
  // Custom SQL owned by a published DS attaches there (exact lineage: the schema's
  // `downstreamDatasources` is published-only); the rest that lists this workbook
  // downstream belongs to one of its embedded datasources — inferred, unambiguous-only.
  const workbookSql = customSql.filter(
    (cs) =>
      (cs.downstreamDatasources ?? []).length === 0 &&
      ownedBy(cs.downstreamWorkbooks, node.luid, node.name),
  );
  const embedded = node.embeddedDatasources ?? [];
  const embeddedSql = assignCustomSqlToEmbedded(embedded, workbookSql);
  const datasources = embedded.map((d) => buildDatasourceDoc(d, false, embeddedSql.get(d) ?? []));
  for (const pub of node.upstreamDatasources ?? []) {
    if (seenPublishedNames.has(pub.name)) continue;
    seenPublishedNames.add(pub.name);
    const pubSql = customSql.filter((cs) => ownedBy(cs.downstreamDatasources, pub.luid, pub.name));
    datasources.push(buildDatasourceDoc(pub, true, pubSql));
  }
  const doc: TableauWorkbookDoc = {
    site,
    project: node.projectName ?? '',
    name: node.name,
    datasources,
    sheets,
    dashboards,
  };
  if (node.luid != null) doc.luid = node.luid;
  return doc;
}

/**
 * Live-mode `ApiDocSource` strategy (decision 10): signs in once, pages the top-level
 * `customSQLTablesConnection` to completion (custom SQL is only reachable there — the
 * datasource types carry no such field), then pages `workbooksConnection`, yielding one
 * `TableauWorkbookDoc` per node with the site's custom SQL associated back to its owners.
 */
export function tableauLiveStrategy(cfg: { site_content_url?: string }) {
  return async function* (fetch: BiApiFetch): AsyncGenerator<TableauWorkbookDoc> {
    await fetch(signinRequest(), 'signin');
    const site =
      cfg.site_content_url && cfg.site_content_url.trim() !== '' ? cfg.site_content_url : 'default';

    const customSql: GqlCustomSqlNode[] = [];
    let csCursor: string | null = null;
    let csPage = 0;
    for (;;) {
      const resp = (await fetch(
        customSqlRequest(csCursor),
        `customsql:${csPage}`,
      )) as CustomSqlConnectionResponse;
      const conn = resp.data.customSQLTablesConnection;
      customSql.push(...conn.nodes);
      if (!conn.pageInfo.hasNextPage) break;
      csCursor = conn.pageInfo.endCursor;
      csPage += 1;
    }

    // Shared across every page/workbook so a published DS referenced repeatedly
    // materializes exactly once (decision 2: one asset on its own FQN).
    const seenPublishedNames = new Set<string>();
    let cursor: string | null = null;
    let page = 0;
    for (;;) {
      const resp = (await fetch(workbooksRequest(cursor), `workbooks:${page}`)) as WorkbooksConnectionResponse;
      const conn = resp.data.workbooksConnection;
      for (const node of conn.nodes) yield buildWorkbookDoc(site, node, seenPublishedNames, customSql);
      if (!conn.pageInfo.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
      page += 1;
    }
  };
}
