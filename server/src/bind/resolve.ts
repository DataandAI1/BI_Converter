import { parse as parseYaml } from 'yaml';
import type { BiBindingRef, BiDescriptor } from '../model/types.js';
import type { BiBindingLite } from '../convert/shared.js';
import type { StagingBiBindingRec } from '../tableau/staging.js';

/**
 * Binding: Tableau references to Unity Catalog names (spec §6).
 *
 * Linetria resolved a Tableau table reference to a physical column by stitching connection
 * descriptors against source systems registered in its catalog. There is no catalog here,
 * so the policy is three steps and no more:
 *
 *   1. Descriptor passthrough (default) — the Tableau connection's own catalog/schema/table
 *      names ARE the Unity Catalog names. Correct whenever the estate was lifted and
 *      shifted with names intact, which is the common case.
 *   2. Mapping file override — explicit entries, matched exact after normalization, never
 *      fuzzy. An entry that matches nothing is a warning, not a silent no-op.
 *   3. Never fabricate — a reference that resolves to neither becomes a needs_review
 *      checklist line and a `-- TODO: unresolved source` comment in the emitted view SQL.
 *
 * Live Unity Catalog introspection (connect, read information_schema, match by name) is a
 * deliberate phase-2 deferral: it would put a Databricks connector and credential handling
 * in the extraction path, which the zero-config demo path must not depend on.
 */

/* ------------------------------------------------------------- the mapping file */

export interface TableauSourceKey {
  /** The Tableau connection's server host or Snowflake account locator. */
  server?: string | null;
  database?: string | null;
  schema?: string | null;
  table?: string | null;
}

export interface DatabricksTarget {
  catalog?: string | null;
  schema?: string | null;
  table?: string | null;
}

export interface SourceMappingEntry {
  tableau: TableauSourceKey;
  databricks: DatabricksTarget;
}

export interface SourceMapping {
  mappings: SourceMappingEntry[];
}

/**
 * Parse a `--mapping` file. Shape errors throw rather than being tolerated: a mapping file
 * the converter silently half-understood would produce confidently wrong Unity Catalog
 * names, which is the one outcome the whole policy exists to prevent.
 */
export function parseMappingFile(text: string): SourceMapping {
  const doc = parseYaml(text) as unknown;
  if (doc == null || typeof doc !== 'object') {
    throw new Error('mapping file must be a YAML mapping with a top-level `mappings:` list');
  }
  const raw = (doc as Record<string, unknown>).mappings;
  if (!Array.isArray(raw)) {
    throw new Error('mapping file must have a top-level `mappings:` list');
  }
  const mappings = raw.map((entry, i) => {
    if (entry == null || typeof entry !== 'object') {
      throw new Error(`mappings[${i}] must be a mapping with \`tableau:\` and \`databricks:\` keys`);
    }
    const e = entry as Record<string, unknown>;
    if (e.tableau == null || typeof e.tableau !== 'object') {
      throw new Error(`mappings[${i}] is missing its \`tableau:\` key`);
    }
    if (e.databricks == null || typeof e.databricks !== 'object') {
      throw new Error(`mappings[${i}] is missing its \`databricks:\` key`);
    }
    const target = e.databricks as DatabricksTarget;
    if (!target.catalog && !target.schema && !target.table) {
      throw new Error(
        `mappings[${i}].databricks names no catalog, schema, or table — an entry that changes ` +
          `nothing is almost certainly a mistake`,
      );
    }
    return { tableau: e.tableau as TableauSourceKey, databricks: target };
  });
  return { mappings };
}

/* --------------------------------------------------------------- normalization */

/** Exact after normalization, never fuzzy — the same discipline as Linetria's descriptor
 *  stitcher. Normalizing means trim, lower-case, and strip Tableau's `[brackets]`; it does
 *  NOT mean stemming, prefix matching, or edit distance. */
function norm(v: string | null | undefined): string {
  if (v == null) return '';
  return v.trim().replace(/^\[|\]$/g, '').toLowerCase();
}

/** Strip scheme and any trailing path from a host so `https://acme.snowflakecomputing.com/`
 *  and `acme.snowflakecomputing.com` are the same server. Ports are kept: a different port
 *  is a different endpoint, and guessing otherwise would be fuzzy matching. */
function normHost(v: string | null | undefined): string {
  if (!v) return '';
  let h = v.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const slash = h.indexOf('/');
  if (slash !== -1) h = h.slice(0, slash);
  return h;
}

/**
 * Every server identity a descriptor presents. A Snowflake connection carries both a host
 * (`xy12345.snowflakecomputing.com`) and an account locator (`xy12345`), and either is a
 * legitimate way for a mapping file to name that server — so both are tried. This is not
 * fuzzy matching: each candidate is still compared by exact equality, and neither is
 * derived from the other by guessing.
 */
function serversOf(d: BiDescriptor): string[] {
  return [normHost(d.host), norm(d.account)].filter((s) => s !== '');
}

function mappingKey(server: string, database: string, schema: string, table: string): string {
  return `${server}|${database}|${schema}|${table}`;
}

/* ------------------------------------------------------------------- resolving */

export interface ResolveOptions {
  mapping?: SourceMapping;
}

export interface ResolveResult {
  bindingsByAsset: Map<string, BiBindingLite[]>;
  /** Mapping entries that matched nothing, and refs that could not be resolved. */
  warnings: string[];
  stats: { refs: number; passthrough: number; mapped: number; unresolved: number };
}

/**
 * Turn the staged bindings into the `BiBindingLite[]` the semantic layer reads, applying
 * the mapping file where it matches. Output is matched-first ordered per asset — the
 * ordering `semantic-layer.ts` already relies on, where `bindings[0].status === 'matched'`
 * means the datasource resolved and no extract-rescue script is needed.
 */
export function resolveBindings(
  staged: ReadonlyMap<string, StagingBiBindingRec[]>,
  opts: ResolveOptions = {},
): ResolveResult {
  const warnings: string[] = [];
  const stats = { refs: 0, passthrough: 0, mapped: 0, unresolved: 0 };

  // Index the mapping file. A key with a blank segment matches only a ref whose
  // corresponding segment is blank — absence is a value, not a wildcard, because a
  // wildcard is exactly the fuzzy behaviour this resolver refuses.
  const byKey = new Map<string, { entry: SourceMappingEntry; used: boolean }>();
  for (const entry of opts.mapping?.mappings ?? []) {
    const key = mappingKey(
      normHost(entry.tableau.server) || norm(entry.tableau.server),
      norm(entry.tableau.database),
      norm(entry.tableau.schema),
      norm(entry.tableau.table),
    );
    if (byKey.has(key)) {
      warnings.push(
        `mapping file has two entries for the same Tableau reference (${key.replace(/\|/g, '.')}) — the first is used`,
      );
      continue;
    }
    byKey.set(key, { entry, used: false });
  }

  const bindingsByAsset = new Map<string, BiBindingLite[]>();

  for (const [assetId, records] of staged) {
    const resolved: BiBindingLite[] = [];

    for (const rec of records) {
      const servers = serversOf(rec.descriptor);
      const database = norm(rec.descriptor.database);
      let anyResolved = false;
      let anyUnresolved = false;

      const refs: BiBindingRef[] = rec.refs.map((ref) => {
        // Only `declared` refs name a physical table. Custom SQL and M queries carry their
        // own text and are handled by the semantic layer's custom-SQL path, which ships the
        // query verbatim under a review note rather than resolving a name.
        if (ref.via !== 'declared') return ref;
        stats.refs += 1;

        const schema = norm(ref.parts.schema);
        const table = norm(ref.parts.object);
        const catalog = norm(ref.parts.catalog) || database;

        // ---- step 2: mapping override, tried before passthrough so an explicit entry
        // always wins over an inherited descriptor name. An entry may name the database
        // as the reference states it or as the connection does — a 2-part Tableau
        // relation states neither, and both spell the same table.
        let hit: { entry: SourceMappingEntry; used: boolean } | undefined;
        for (const server of servers) {
          hit =
            byKey.get(mappingKey(server, catalog, schema, table)) ??
            byKey.get(mappingKey(server, database, schema, table));
          if (hit) break;
        }
        if (hit) {
          hit.used = true;
          stats.mapped += 1;
          anyResolved = true;
          return {
            ...ref,
            parts: {
              catalog: hit.entry.databricks.catalog ?? ref.parts.catalog,
              schema: hit.entry.databricks.schema ?? ref.parts.schema,
              object: hit.entry.databricks.table ?? ref.parts.object,
            },
          };
        }

        // ---- step 1: descriptor passthrough. A full three-part name is a resolution; a
        // partial one is not, and step 3 owns what happens to it. The names carried
        // through keep their ORIGINAL case: normalization exists to compare references,
        // never to rewrite them, and Unity Catalog identifiers are emitted back-quoted.
        if (catalog && schema && table) {
          stats.passthrough += 1;
          anyResolved = true;
          return {
            ...ref,
            parts: {
              catalog: ref.parts.catalog ?? rec.descriptor.database ?? undefined,
              schema: ref.parts.schema,
              object: ref.parts.object,
            },
          };
        }

        // ---- step 3: never fabricate. The ref is returned untouched so the semantic layer
        // emits it with its TODO comment and review note; nothing is guessed in.
        stats.unresolved += 1;
        anyUnresolved = true;
        const missing = [!catalog && 'catalog', !schema && 'schema', !table && 'table']
          .filter((s): s is string => !!s)
          .join(' and ');
        warnings.push(
          `unresolved source for '${refLabel(ref)}' — the Tableau connection names no ${missing}; ` +
            `add a --mapping entry or set it in Unity Catalog before running the pack`,
        );
        return ref;
      });

      // A connection resolves when every declared ref it carries resolved. Partial
      // resolution is not resolution: the extract-rescue script and the checklist line
      // both exist for exactly the case where a human still has to decide something.
      //
      // A connection with NO declared refs — custom SQL only — still resolves as long as
      // the descriptor names a server, because there is no table name here to get wrong;
      // the semantic layer already ships that SQL under its own dialect review note.
      // Treating it as unmatched would attach an extract-rescue script to a datasource
      // that has a perfectly good upstream database.
      const hasDeclared = rec.refs.some((r) => r.via === 'declared');
      const status = hasDeclared
        ? anyResolved && !anyUnresolved
          ? 'matched'
          : 'unmatched'
        : servers.length > 0
          ? 'matched'
          : 'unmatched';
      resolved.push({ asset_id: assetId, descriptor: rec.descriptor, refs, status });
    }

    // Matched first — `semantic-layer.ts` reads bindings[0] as the primary connection.
    resolved.sort((a, b) => (a.status === b.status ? 0 : a.status === 'matched' ? -1 : 1));
    bindingsByAsset.set(assetId, resolved);
  }

  for (const { entry, used } of byKey.values()) {
    if (used) continue;
    const t = entry.tableau;
    warnings.push(
      `mapping entry for ${[t.server, t.database, t.schema, t.table].filter(Boolean).join('.')} ` +
        `matched no Tableau reference in this workbook — check the names against the connection`,
    );
  }

  return { bindingsByAsset, warnings, stats };
}

function refLabel(ref: BiBindingRef): string {
  return [ref.parts.catalog, ref.parts.schema, ref.parts.object].filter(Boolean).join('.');
}
