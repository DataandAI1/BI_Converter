/**
 * Pack-level deploy artifacts for a Databricks AI/BI rebuild — shared by the deterministic
 * rebuild pack (`rebuild.ts`) and the forge build pack (`build/pack.ts`), so both lanes
 * ship the same secret-free `deploy_dashboards.py` + `databricks.yml`.
 */

export const DEPLOY_PY = `
"""Deploy the Linetria Databricks AI/BI rebuild pack's dashboards.

Creates (or updates) one AI/BI dashboard per '*.lvdash.json' file under this pack's
'*/dashboards/' folders, optionally publishing each one afterwards.

Secret-free: no credentials are embedded in this file, and no workspace host or SQL
warehouse id is baked in — both are arguments. Authenticate the Databricks SDK from the
environment before running, e.g.:

  Personal access token:
    export DATABRICKS_HOST=https://<workspace>.cloud.databricks.com
    export DATABRICKS_TOKEN=<token>

  OAuth machine-to-machine (recommended for automation):
    export DATABRICKS_HOST=https://<workspace>.cloud.databricks.com
    export DATABRICKS_CLIENT_ID=<service principal application id>
    export DATABRICKS_CLIENT_SECRET=<service principal oauth secret>

See https://docs.databricks.com/aws/en/dev-tools/auth/ for the full precedence chain.
The service principal needs CAN MANAGE on the dashboards, CAN USE on the warehouse, and
SELECT on the underlying Unity Catalog objects.

Usage:
  python deploy_dashboards.py --host <workspace-url> --warehouse-id <id> [--parent-path /Workspace/...] [--publish]

Requires: databricks-sdk
"""
import argparse
import json
import os
import sys


def find_dashboards(root: str) -> list:
    found = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in sorted(filenames):
            if name.endswith('.lvdash.json'):
                found.append(os.path.join(dirpath, name))
    return sorted(found)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--host', required=True, help='workspace URL, e.g. https://adb-123.4.azuredatabricks.net')
    parser.add_argument('--warehouse-id', required=True, help='SQL warehouse id the dashboards run on')
    parser.add_argument('--parent-path', default=None, help='workspace folder to create the dashboards in')
    parser.add_argument('--publish', action='store_true', help='publish each dashboard after creating/updating it')
    parser.add_argument('--pack-root', default=os.path.dirname(os.path.abspath(__file__)), help='pack folder to scan')
    args = parser.parse_args()

    from databricks.sdk import WorkspaceClient  # local import: keep --help usable without the SDK

    # Credentials come from the environment only (see the module docstring) — the host is
    # the one connection detail this script accepts, and it is not a secret.
    if not any(os.environ.get(name) for name in ('DATABRICKS_TOKEN', 'DATABRICKS_CLIENT_ID')):
        print(
            'warning: neither DATABRICKS_TOKEN nor DATABRICKS_CLIENT_ID is set — the SDK will '
            'fall back to its other auth sources (CLI profile, metadata service, ...)',
            file=sys.stderr,
        )
    w = WorkspaceClient(host=args.host)

    files = find_dashboards(args.pack_root)
    if not files:
        print(f'no .lvdash.json files found under {args.pack_root}', file=sys.stderr)
        return 1

    # Idempotent-ish: match an existing dashboard by display_name and update it in place
    # rather than creating a duplicate on every run. 'known' starts from the workspace's
    # current dashboards and is kept in sync with every create/update below, so a
    # dashboard created earlier in *this* run is visible to a later file that resolves to
    # the same display name — a one-time snapshot from w.lakeview.list() would miss it.
    known = {}
    for d in w.lakeview.list():
        if d.display_name:
            known[d.display_name] = d

    # Resolve every file's display name up front, before creating or updating anything.
    # Prefer the dashboard JSON's own page title (nicer than the file's slugified
    # basename, and what the AI/BI UI already shows) and fall back to the basename only
    # if a dashboard somehow has no page. Two workbook groups can legitimately produce the
    # same page title (e.g. both call their dashboard 'Overview') — resolving names up
    # front lets that collision be detected and every colliding name qualified with its
    # pack folder, instead of two unrelated dashboards racing for one display_name.
    docs = {}
    base_names = {}
    for path in files:
        with open(path, 'r', encoding='utf-8') as fh:
            doc = json.load(fh)
        docs[path] = doc
        pages = doc.get('pages') or []
        base = pages[0].get('displayName') if pages and isinstance(pages[0], dict) else None
        base_names[path] = base or os.path.basename(path)[: -len('.lvdash.json')]

    name_counts = {}
    for base in base_names.values():
        name_counts[base] = name_counts.get(base, 0) + 1

    for path in files:
        doc = docs[path]
        base = base_names[path]
        if name_counts[base] > 1:
            group_dir = os.path.dirname(os.path.dirname(path))
            if os.path.abspath(group_dir) == os.path.abspath(args.pack_root):
                # Flat layout (a forge build pack's workbooks/<file>): there is no pack
                # folder to qualify with, so the unique file stem disambiguates instead.
                group = os.path.basename(path)[: -len('.lvdash.json')]
            else:
                group = os.path.basename(group_dir)
            display_name = f'{base} ({group})'
        else:
            display_name = base
        serialized = json.dumps(doc)

        current = known.get(display_name)
        if current is not None:
            dashboard = w.lakeview.update(
                dashboard_id=current.dashboard_id,
                display_name=display_name,
                warehouse_id=args.warehouse_id,
                serialized_dashboard=serialized,
            )
            print(f'updated {display_name} ({dashboard.dashboard_id})')
        else:
            kwargs = {
                'display_name': display_name,
                'warehouse_id': args.warehouse_id,
                'serialized_dashboard': serialized,
            }
            if args.parent_path:
                kwargs['parent_path'] = args.parent_path
            dashboard = w.lakeview.create(**kwargs)
            print(f'created {display_name} ({dashboard.dashboard_id})')
        known[display_name] = dashboard

        if args.publish:
            w.lakeview.publish(dashboard_id=dashboard.dashboard_id, warehouse_id=args.warehouse_id)
            print(f'published {display_name}')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
`;

/** Minimal Asset Bundle skeleton registering each emitted dashboard. Host and warehouse
 *  stay variables — no workspace identity is baked into the pack. Scans the pack's files
 *  for `*.lvdash.json` and names each dashboard exactly the way `deploy_dashboards.py`
 *  does — the first page's title, qualified with the pack folder only on collision — so
 *  the two deploy paths can never create two differently-named copies of one dashboard. */
export function bundleYaml(files: ReadonlyMap<string, string>): string {
  const paths = [...files.keys()].filter((p) => p.endsWith('.lvdash.json')).sort();
  const baseNames = new Map<string, string>();
  for (const path of paths) {
    const basename = path.split('/').pop()!.replace(/\.lvdash\.json$/, '');
    let title: string | null = null;
    try {
      const doc = JSON.parse(files.get(path)!) as { pages?: Array<{ displayName?: unknown }> };
      const first = doc.pages?.[0]?.displayName;
      if (typeof first === 'string' && first.length > 0) title = first;
    } catch {
      title = null;
    }
    baseNames.set(path, title ?? basename);
  }
  const counts = new Map<string, number>();
  for (const base of baseNames.values()) counts.set(base, (counts.get(base) ?? 0) + 1);
  const displayNameOf = (path: string): string => {
    const base = baseNames.get(path)!;
    if ((counts.get(base) ?? 0) <= 1) return base;
    // <slug>/dashboards/<file> — the pack folder is two levels up, as in DEPLOY_PY. A
    // flat layout (the forge build pack's workbooks/<file>) has no such folder, so the
    // already-unique file stem disambiguates instead.
    const parts = path.split('/');
    const stem = parts[parts.length - 1].replace(/\.lvdash\.json$/, '');
    const group = parts.length >= 3 ? parts[parts.length - 3] : stem;
    return `${base} (${group})`;
  };

  const lines = [
    '# Generated by Linetria — Databricks AI/BI rebuild pack (Tableau → Databricks).',
    '# Minimal Databricks Asset Bundle skeleton. Fill in the variables (or pass them with',
    '# `databricks bundle deploy --var=...`) and run `databricks bundle validate`.',
    '# Secret-free: no host, token or warehouse id is baked in.',
    'bundle:',
    '  name: linetria_aibi_rebuild',
    '',
    'variables:',
    '  warehouse_id:',
    '    description: SQL warehouse the dashboards run on',
    '  workspace_host:',
    '    description: workspace URL, e.g. https://adb-123.4.azuredatabricks.net',
    '',
    'targets:',
    '  dev:',
    '    default: true',
    '    workspace:',
    '      host: ${var.workspace_host}',
    '',
    'resources:',
    '  dashboards:',
  ];
  for (const [i, path] of paths.entries()) {
    lines.push(`    dashboard_${i + 1}:`);
    lines.push(`      display_name: ${JSON.stringify(displayNameOf(path))}`);
    lines.push(`      file_path: ${JSON.stringify(`./${path}`)}`);
    lines.push('      warehouse_id: ${var.warehouse_id}');
  }
  if (paths.length === 0) lines.push('    {}');
  lines.push('');
  return lines.join('\n');
}

