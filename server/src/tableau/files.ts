import { XMLParser } from 'fast-xml-parser';
import { unzipSync, strFromU8 } from 'fflate';
import type { BiDescriptor } from '../model/types.js';
import type {
  TableauDashboardLayout,
  TableauDashboardZone,
  TableauDatasourceDoc,
  TableauFieldDoc,
  TableauParameterDoc,
  TableauRelationDoc,
  TableauSheetVisual,
  TableauTableParts,
  TableauThumbnailDoc,
  TableauWorkbookDoc,
} from './model.js';

/**
 * Tableau file-mode parsing (BI connectors plan Task 4): `.twb`/`.tds` XML → the doc model
 * both delivery modes share (model.ts), and `.twbx`/`.tdsx` zip unwrapping. Live mode
 * (Task 5) builds the identical doc shape from Metadata API responses; this file never
 * produces staging records directly (mapper.ts owns that, spec §4 one-normalizer
 * invariant).
 */

// jPath-scoped so the document ROOT ('workbook' or 'datasource') never collapses into a
// one-element array — only genuinely repeatable descendants do.
const REPEATABLE_TAGS = new Set([
  'named-connection', 'relation', 'column', 'worksheet', 'dashboard', 'zone',
  'datasource-dependencies', 'pane', 'filter', 'thumbnail', 'sort', 'member',
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
  isArray: (name, jpath) => {
    if (name === 'datasource') return jpath === 'workbook.datasources.datasource';
    return REPEATABLE_TAGS.has(name);
  },
});

type XmlNode = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function attr(node: XmlNode | undefined, name: string): string | undefined {
  const v = node?.[`@_${name}`];
  return v == null ? undefined : String(v);
}

function stripBrackets(raw: string): string {
  return raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw;
}

/** '[none:Category:nk]' / '[sum:Sales:qk]' / '[Measure Names]' → the field name. */
function instanceFieldName(token: string): string {
  const inner = stripBrackets(token);
  const parts = inner.split(':');
  if (parts.length >= 3) return parts.slice(1, -1).join(':');
  return inner;
}

/** Shelf text ('[ds].[inst] / [ds].[inst]') → resolved field names, order kept. */
function shelfFieldNames(shelf: string | undefined): string[] {
  if (!shelf) return [];
  const names: string[] = [];
  // column-instance refs are the SECOND bracket group of each '[ds].[inst]' pair
  const re = /\[[^\]]*\]\.(\[[^\]]*\])/g;
  for (let m = re.exec(shelf); m; m = re.exec(shelf)) names.push(instanceFieldName(m[1]));
  return names;
}

/** `[PUBLIC].[ORDERS]` / `[DB].[SCHEMA].[OBJECT]` / `[OBJECT]` → namespace parts. */
function parseTableRef(raw: string): TableauTableParts {
  const parts = raw
    .split('].[')
    .map((p) => p.replace(/^\[/, '').replace(/\]$/, ''));
  if (parts.length >= 3) return { catalog: parts[0], schema: parts[1], object: parts.slice(2).join('.') };
  if (parts.length === 2) return { schema: parts[0], object: parts[1] };
  return { object: parts[0] };
}

const SNOWFLAKE_HOST_RE = /^([a-z0-9-]+)\.snowflakecomputing\.com$/i;

/** One `<named-connection>` → a `BiDescriptor` (spec §8). The account locator isn't a
 *  distinct XML attribute for Tableau's snowflake driver — it's derivable from the
 *  account-subdomain of the server hostname (real-world Snowflake convention), which
 *  matters because the stitcher's snowflake match key is `account`, not `host`. */
function parseDescriptor(named: XmlNode): BiDescriptor {
  const inner = (named.connection ?? {}) as XmlNode;
  const platformHint = attr(inner, 'class') ?? 'unknown';
  const host = attr(inner, 'server') ?? null;
  const account =
    platformHint === 'snowflake' && host ? (SNOWFLAKE_HOST_RE.exec(host)?.[1] ?? null) : null;
  const extra: Record<string, unknown> = { named_connection: attr(named, 'name') };
  const port = attr(inner, 'port');
  if (port) extra.port = port;

  return {
    platform_hint: platformHint,
    host,
    account,
    database: attr(inner, 'dbname') ?? null,
    warehouse: attr(inner, 'warehouse') ?? null,
    schema: attr(inner, 'schema') ?? null,
    connection_type: platformHint,
    extra,
  };
}

function parseRelation(raw: XmlNode): TableauRelationDoc {
  const type = attr(raw, 'type');
  const connection = attr(raw, 'connection') ?? '';
  if (type === 'text') {
    const sql = typeof raw['#text'] === 'string' ? (raw['#text'] as string).trim() : '';
    return { kind: 'custom_sql', sql, connection };
  }
  const table = attr(raw, 'table');
  return { kind: 'table', table: table ? parseTableRef(table) : undefined, connection };
}

function parseField(raw: XmlNode): TableauFieldDoc {
  const rawName = attr(raw, 'name') ?? '';
  const calc = raw.calculation as XmlNode | undefined;
  const field: TableauFieldDoc = { name: stripBrackets(rawName) };
  const caption = attr(raw, 'caption');
  if (caption !== undefined) field.caption = caption;
  const datatype = attr(raw, 'datatype');
  if (datatype !== undefined) field.datatype = datatype;
  const role = attr(raw, 'role');
  if (role !== undefined) field.role = role;
  const formula = calc ? attr(calc, 'formula') : undefined;
  if (formula !== undefined) field.formula = formula;
  return field;
}

function parseDatasource(raw: XmlNode): TableauDatasourceDoc {
  const name = attr(raw, 'name') ?? '';
  const published = raw['repository-location'] !== undefined;
  const connectionRoot = (raw.connection ?? {}) as XmlNode;
  const namedConnections = asArray(
    (connectionRoot['named-connections'] as XmlNode | undefined)?.['named-connection'] as
      | XmlNode
      | XmlNode[]
      | undefined,
  );
  const connections = namedConnections.map(parseDescriptor);
  const relations = asArray(connectionRoot.relation as XmlNode | XmlNode[] | undefined).map(
    parseRelation,
  );
  const fields = asArray(raw.column as XmlNode | XmlNode[] | undefined).map(parseField);

  return { name, published, connections, relations, fields };
}

/** One `<column>` inside the reserved `<datasource name='Parameters'>` → a
 *  `TableauParameterDoc`. `param-domain-type` ('all' | 'list' | 'range') is a `<column>`
 *  attribute; its domain data is NOT — 'list' values live in a child `<members>/<member
 *  value=…>` list, and 'range' min/max live on a child `<range min= max=>` element, never
 *  as attributes on `<column>` itself (verified against real fixture XML — see the model.ts
 *  TableauParameterDoc doc comment and files.ts test coverage). */
function parseParameter(raw: XmlNode): TableauParameterDoc {
  const name = stripBrackets(attr(raw, 'name') ?? '');
  const param: TableauParameterDoc = { name };
  const caption = attr(raw, 'caption');
  if (caption !== undefined) param.caption = caption;
  const datatype = attr(raw, 'datatype');
  if (datatype !== undefined) param.datatype = datatype;
  const currentValue = attr(raw, 'value');
  if (currentValue !== undefined) param.currentValue = currentValue;

  const kind = attr(raw, 'param-domain-type');
  if (kind === 'all' || kind === 'list' || kind === 'range') {
    const allowable: NonNullable<TableauParameterDoc['allowableValues']> = { kind };
    if (kind === 'list') {
      const members = asArray(
        (raw.members as XmlNode | undefined)?.member as XmlNode | XmlNode[] | undefined,
      );
      const values = members
        .map((m) => attr(m, 'value'))
        .filter((v): v is string => v !== undefined);
      if (values.length > 0) allowable.values = values;
    } else if (kind === 'range') {
      const range = raw.range as XmlNode | undefined;
      const min = attr(range, 'min');
      const max = attr(range, 'max');
      if (min !== undefined) allowable.min = min;
      if (max !== undefined) allowable.max = max;
    }
    param.allowableValues = allowable;
  }
  return param;
}

/** The `Parameters` pseudo-datasource's `<column>` entries → the workbook's parameters,
 *  document order preserved. */
function parseParameters(raw: XmlNode): TableauParameterDoc[] {
  return asArray(raw.column as XmlNode | XmlNode[] | undefined).map(parseParameter);
}

/** Element text via `#text` (attrs present) or a plain string (fast-xml-parser collapses
 *  a text-only, attribute-less element to a bare string). */
function elementText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const t = (v as XmlNode)['#text'];
    if (t !== undefined) return String(t);
  }
  return '';
}

/** '[ds].[inst]' → the second bracket group ('[inst]'), for shelf/filter/encoding column
 *  refs that carry the owning datasource as a prefix. Falls back to the raw ref when it
 *  doesn't match the two-part shape. */
function secondBracketGroup(ref: string): string {
  const m = /\[[^\]]*\]\.(\[[^\]]*\])/.exec(ref);
  return m ? m[1] : ref;
}

/** `<sort>` elements directly under a worksheet's `<view>` (sibling to `<filter>`, not
 *  pane-scoped) → resolved field + raw direction (Task 6 fidelity backfill — named in the
 *  visual-capture spec but never implemented). */
function parseSorts(view: XmlNode): { field: string; direction?: string }[] {
  return asArray(view.sort as XmlNode | XmlNode[] | undefined).map((s) => {
    const field = instanceFieldName(secondBracketGroup(attr(s, 'column') ?? ''));
    const direction = attr(s, 'direction');
    return direction !== undefined ? { field, direction } : { field };
  });
}

/** `ws.table` → the worksheet's mark/shelf/encoding/filter structure (Task A1). Only
 *  built when the table carries `<panes>` (mark info) — a `<table>` with no panes (the
 *  pre-visual-capture fixtures) has nothing worth reporting. */
function parseVisual(table: XmlNode | undefined): TableauSheetVisual | undefined {
  if (!table || table.panes === undefined) return undefined;
  const view = (table.view ?? {}) as XmlNode;
  const rowsRaw = elementText(table.rows);
  const colsRaw = elementText(table.cols);
  const panes = asArray((table.panes as XmlNode).pane as XmlNode | XmlNode[] | undefined);
  const markClasses = panes.map(
    (p) => attr(p.mark as XmlNode | undefined, 'class') ?? 'Automatic',
  );
  const filters = asArray(view.filter as XmlNode | XmlNode[] | undefined).map((f) => {
    const field = instanceFieldName(secondBracketGroup(attr(f, 'column') ?? ''));
    const filterClass = attr(f, 'class');
    return filterClass !== undefined ? { field, filterClass } : { field };
  });
  const encodings: { channel: string; field: string }[] = [];
  const firstPane = panes[0] as XmlNode | undefined;
  const encodingsRoot = (firstPane?.encodings ?? {}) as XmlNode;
  for (const [channel, value] of Object.entries(encodingsRoot)) {
    if (channel === '#text') continue;
    for (const entry of asArray(value as XmlNode | XmlNode[] | undefined)) {
      const column = attr(entry, 'column');
      if (column) encodings.push({ channel, field: instanceFieldName(secondBracketGroup(column)) });
    }
  }
  const sorts = parseSorts(view);
  return {
    markClass: markClasses[0] ?? 'Automatic',
    markClasses,
    rows: shelfFieldNames(rowsRaw),
    cols: shelfFieldNames(colsRaw),
    rowsRaw,
    colsRaw,
    encodings,
    filters,
    ...(sorts.length > 0 ? { sorts } : {}),
  };
}

function parseSheets(root: XmlNode): TableauWorkbookDoc['sheets'] {
  const worksheets = asArray(
    (root.worksheets as XmlNode | undefined)?.worksheet as XmlNode | XmlNode[] | undefined,
  );
  return worksheets.map((ws) => {
    const name = attr(ws, 'name') ?? '';
    const table = ws.table as XmlNode | undefined;
    const view = (table?.view ?? {}) as XmlNode;
    const depBlocks = asArray(
      view['datasource-dependencies'] as XmlNode | XmlNode[] | undefined,
    );
    const datasourceRefs: string[] = [];
    const fieldRefs: { ds: string; field: string }[] = [];
    for (const block of depBlocks) {
      const ds = attr(block, 'datasource') ?? '';
      if (!datasourceRefs.includes(ds)) datasourceRefs.push(ds);
      for (const col of asArray(block.column as XmlNode | XmlNode[] | undefined)) {
        const fieldName = stripBrackets(attr(col, 'name') ?? '');
        fieldRefs.push({ ds, field: fieldName });
      }
    }
    const sheet: TableauWorkbookDoc['sheets'][number] = { name, datasourceRefs, fieldRefs };
    const visual = parseVisual(table);
    if (visual) sheet.visual = visual;
    return sheet;
  });
}

/** 100000-unit zone grid (see `forge/tableauforge/compiler/twb.py`'s `_dashboard_xml`,
 *  which writes this same grid from percentages) → percent, 2-decimal rounded. */
function zonePct(raw: string): number {
  return Math.round((Number(raw) / 1000) * 100) / 100;
}

/** A `<zone>` and every descendant (nested zones ride `zone.zone`), preorder/document
 *  order — used both for the layout's flat zone list and for the legacy `sheetNames`
 *  scan, so both agree on traversal order. */
function flattenZoneNodes(zone: XmlNode): XmlNode[] {
  const nodes = [zone];
  for (const child of asArray(zone.zone as XmlNode | XmlNode[] | undefined)) {
    nodes.push(...flattenZoneNodes(child));
  }
  return nodes;
}

function parseDashboards(root: XmlNode): TableauWorkbookDoc['dashboards'] {
  const dashboards = asArray(
    (root.dashboards as XmlNode | undefined)?.dashboard as XmlNode | XmlNode[] | undefined,
  );
  return dashboards.map((dash) => {
    const name = attr(dash, 'name') ?? '';
    const zoneRoots = asArray(
      (dash.zones as XmlNode | undefined)?.zone as XmlNode | XmlNode[] | undefined,
    );
    const allZoneNodes = zoneRoots.flatMap(flattenZoneNodes);

    // Existing behavior (byte-for-byte): named zones, deduped, in document order. Now
    // recursive so it still finds sheet-bearing zones nested under a layout container.
    const sheetNames = [
      ...new Set(allZoneNodes.map((z) => attr(z, 'name')).filter((n): n is string => !!n)),
    ];

    const zones: TableauDashboardZone[] = [];
    for (const z of allZoneNodes) {
      const x = attr(z, 'x');
      const y = attr(z, 'y');
      const w = attr(z, 'w');
      const h = attr(z, 'h');
      if (x === undefined || y === undefined || w === undefined || h === undefined) continue;
      const sheetName = attr(z, 'name');
      const type = sheetName ? 'worksheet' : (attr(z, 'type-v2') ?? attr(z, 'type') ?? 'blank');
      const zone: TableauDashboardZone = { type, x: zonePct(x), y: zonePct(y), w: zonePct(w), h: zonePct(h) };
      if (sheetName) zone.sheetName = sheetName;
      zones.push(zone);
    }

    const sizeEl = dash.size as XmlNode | undefined;
    let layout: TableauDashboardLayout | undefined;
    if (sizeEl || zones.length > 0) {
      layout = { zones };
      if (sizeEl) {
        const sizing = attr(sizeEl, 'sizing-mode');
        if (sizing !== undefined) layout.sizing = sizing;
        const widthRaw = attr(sizeEl, 'maxwidth') ?? attr(sizeEl, 'minwidth');
        const width = widthRaw !== undefined ? Number(widthRaw) : NaN;
        if (!Number.isNaN(width)) layout.width = width;
        const heightRaw = attr(sizeEl, 'maxheight') ?? attr(sizeEl, 'minheight');
        const height = heightRaw !== undefined ? Number(heightRaw) : NaN;
        if (!Number.isNaN(height)) layout.height = height;
      }
    }

    const dashboard: TableauWorkbookDoc['dashboards'][number] = { name, sheetNames };
    if (layout) dashboard.layout = layout;
    return dashboard;
  });
}

/** Filename → workbook/doc identity: strip any path, then the recognized extension. File
 *  mode has no server-carried workbook name (that lives in `.twb`/`.tds` XML nowhere —
 *  Tableau derives it from the filename too), so the upload filename IS the identity. */
function deriveDocName(fileName: string): string {
  const base = fileName.split(/[/\\]/).pop() ?? fileName;
  return base.replace(/\.(twbx|twb|tdsx|tds)$/i, '');
}

function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

/** `.twb`/`.twbx`/`.tds`/`.tdsx` → one `TableauWorkbookDoc` (a lone `.tds`/`.tdsx` yields a
 *  doc with no sheets/dashboards and its single datasource marked `published: true`). */
export function parseTableauFile(name: string, buf: Buffer): TableauWorkbookDoc[] {
  let xml: string;
  if (isZipBuffer(buf)) {
    const entries = unzipSync(new Uint8Array(buf));
    const innerName = Object.keys(entries).find((k) => /\.(twb|tds)$/i.test(k));
    if (!innerName) {
      throw new Error(`no .twb/.tds entry found inside packaged Tableau file '${name}'`);
    }
    xml = strFromU8(entries[innerName]);
  } else {
    xml = buf.toString('utf-8');
  }

  const parsed = xmlParser.parse(xml) as XmlNode;
  const docName = deriveDocName(name);

  if (parsed.workbook !== undefined) {
    const root = parsed.workbook as XmlNode;
    const dsRoot = asArray(
      (root.datasources as XmlNode | undefined)?.datasource as XmlNode | XmlNode[] | undefined,
    );
    // Tableau stores workbook parameters as calculated fields inside a reserved
    // `<datasource name='Parameters'>` — excluded from `datasources` (it is not a real
    // datasource) and parsed into `parameters` instead (Task 6 fidelity backfill).
    const parametersDs = dsRoot.find((d) => attr(d, 'name') === 'Parameters');
    const regularDs = dsRoot.filter((d) => attr(d, 'name') !== 'Parameters');
    const parameters = parametersDs ? parseParameters(parametersDs) : [];
    const thumbnails: TableauThumbnailDoc[] = asArray(
      (root.thumbnails as XmlNode | undefined)?.thumbnail as XmlNode | XmlNode[] | undefined,
    )
      .map((t) => ({ name: attr(t, 'name'), base64: String(t['#text'] ?? '').replace(/\s+/g, '') }))
      .filter((t): t is TableauThumbnailDoc => !!t.name && !!t.base64);
    const doc: TableauWorkbookDoc = {
      site: 'default',
      project: '',
      name: docName,
      datasources: regularDs.map(parseDatasource),
      sheets: parseSheets(root),
      dashboards: parseDashboards(root),
      visualSource: 'twb_file',
      thumbnails,
    };
    if (parameters.length > 0) doc.parameters = parameters;
    return [doc];
  }

  if (parsed.datasource !== undefined) {
    const ds = parseDatasource(parsed.datasource as XmlNode);
    ds.published = true;
    return [{ site: 'default', project: '', name: docName, datasources: [ds], sheets: [], dashboards: [] }];
  }

  throw new Error(`'${name}' does not contain a <workbook> or <datasource> root element`);
}
