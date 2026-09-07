import fs from 'node:fs/promises';
import path from 'node:path';
import { LakeviewClient, type LakeviewDashboard } from './lakeview-client.js';

/**
 * Deploy a pack's dashboards (spec §8.3, direct path).
 *
 * The naming and idempotency rules here mirror the pack's own `deploy_dashboards.py`
 * exactly — display name from the first page's title, collisions qualified with the pack
 * folder, and an update-in-place when the workspace already holds that name. Two paths
 * that disagreed on what counts as "the same dashboard" would let one create duplicates
 * the other updates, which is worse than having only one path.
 */

export interface DeployOptions {
  warehouseId: string;
  parentPath?: string;
  publish?: boolean;
  /** Report progress as it happens; a deploy of many dashboards is slow. */
  onProgress?: (line: string) => void;
}

export interface DeployedDashboard {
  file: string;
  displayName: string;
  dashboardId: string;
  action: 'created' | 'updated';
  published: boolean;
}

const SUFFIX = '.lvdash.json';

/** Every `*.lvdash.json` under `root`, sorted, so a deploy's order is stable. */
export async function findDashboards(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(SUFFIX)) out.push(full);
    }
  }
  await walk(root);
  return out.sort();
}

/**
 * Resolve every file's display name BEFORE creating anything. Two workbook groups can
 * legitimately produce the same page title (both call their dashboard 'Overview'), and
 * resolving up front lets that collision be detected and every colliding name qualified
 * with its pack folder — rather than two unrelated dashboards racing for one name.
 */
export async function resolveDisplayNames(
  packRoot: string,
  files: readonly string[],
): Promise<Map<string, { displayName: string; serialized: string }>> {
  const bases = new Map<string, string>();
  const serialized = new Map<string, string>();
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    serialized.set(file, text);
    const doc = JSON.parse(text) as { pages?: Array<{ displayName?: string }> };
    const first = doc.pages?.[0];
    bases.set(file, first?.displayName || path.basename(file).slice(0, -SUFFIX.length));
  }

  const counts = new Map<string, number>();
  for (const base of bases.values()) counts.set(base, (counts.get(base) ?? 0) + 1);

  const qualified = new Map<string, string>();
  for (const file of files) {
    const base = bases.get(file)!;
    if ((counts.get(base) ?? 0) <= 1) {
      qualified.set(file, base);
      continue;
    }
    const groupDir = path.dirname(path.dirname(file));
    const group =
      path.resolve(groupDir) === path.resolve(packRoot)
        ? // Flat layout: there is no pack folder to qualify with, so the unique file stem
          // disambiguates instead.
          path.basename(file).slice(0, -SUFFIX.length)
        : path.basename(groupDir);
    qualified.set(file, `${base} (${group})`);
  }

  // Qualifying by folder is not always enough: two dashboards in the SAME workbook folder
  // that share a page title ('Overview' twice in one workbook) qualify to the same name
  // and would still race for it — the second silently overwriting the first. The file
  // stem is unique by construction, so anything still colliding falls back to it.
  const afterCounts = new Map<string, number>();
  for (const name of qualified.values()) afterCounts.set(name, (afterCounts.get(name) ?? 0) + 1);

  const out = new Map<string, { displayName: string; serialized: string }>();
  for (const file of files) {
    let displayName = qualified.get(file)!;
    if ((afterCounts.get(displayName) ?? 0) > 1) {
      displayName = `${bases.get(file)!} (${path.basename(file).slice(0, -SUFFIX.length)})`;
    }
    out.set(file, { displayName, serialized: serialized.get(file)! });
  }
  return out;
}

export async function deployPack(
  client: LakeviewClient,
  packRoot: string,
  opts: DeployOptions,
): Promise<DeployedDashboard[]> {
  const files = await findDashboards(packRoot);
  if (files.length === 0) {
    throw new Error(`no ${SUFFIX} files under '${packRoot}' — is this a converted pack?`);
  }
  const resolved = await resolveDisplayNames(packRoot, files);
  const log = opts.onProgress ?? (() => {});

  // `known` starts from the workspace's current dashboards and is kept in sync with every
  // create below, so a dashboard created earlier in THIS run is visible to a later file
  // that resolves to the same name — a one-time snapshot would miss it.
  const known = new Map<string, LakeviewDashboard>();
  for (const d of await client.list()) {
    if (d.display_name) known.set(d.display_name, d);
  }

  const out: DeployedDashboard[] = [];
  for (const file of files) {
    const { displayName, serialized } = resolved.get(file)!;
    const current = known.get(displayName);

    let dashboard: LakeviewDashboard;
    let action: 'created' | 'updated';
    if (current) {
      dashboard = await client.update({
        dashboardId: current.dashboard_id,
        displayName,
        warehouseId: opts.warehouseId,
        serializedDashboard: serialized,
        etag: current.etag,
      });
      action = 'updated';
    } else {
      dashboard = await client.create({
        displayName,
        warehouseId: opts.warehouseId,
        serializedDashboard: serialized,
        parentPath: opts.parentPath,
      });
      action = 'created';
    }
    known.set(displayName, dashboard);
    log(`${action} ${displayName} (${dashboard.dashboard_id})`);

    let published = false;
    if (opts.publish) {
      await client.publish({ dashboardId: dashboard.dashboard_id, warehouseId: opts.warehouseId });
      published = true;
      log(`published ${displayName}`);
    }
    out.push({ file, displayName, dashboardId: dashboard.dashboard_id, action, published });
  }
  return out;
}
