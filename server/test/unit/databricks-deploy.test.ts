import { describe, it, expect } from 'vitest';
import { DEPLOY_PY, bundleYaml } from '../../src/deploy/databricks-deploy.js';

const doc = (title: string) => JSON.stringify({ datasets: [], pages: [{ name: 'p1', displayName: title, pageType: 'PAGE_TYPE_CANVAS', layout: [] }] });

function packFiles(): Map<string, string> {
  return new Map([
    ['sales-wb/dashboards/Exec_Dashboard.lvdash.json', doc('Exec Dashboard')],
    ['sales-wb/rebuild_checklist.md', '# checklist'],
  ]);
}

describe('databricks deploy artifacts are secret-free', () => {
  it('deploy_dashboards.py takes host/warehouse as arguments and authenticates from the environment', () => {
    const py = DEPLOY_PY;
    expect(py).toContain('--host');
    expect(py).toContain('--warehouse-id');
    expect(py).toContain('--parent-path');
    expect(py).toContain('--publish');
    expect(py).toContain('DATABRICKS_TOKEN');
    expect(py).toContain('lakeview.create');
    expect(py).toContain('lakeview.publish');
    expect(py).toMatch(/token\s*=\s*None|os\.environ/);
    expect(py).not.toMatch(/(token|password)\s*=\s*['"][A-Za-z0-9]/);
  });

  it('deploy_dashboards.py keys each dashboard by its page title, not the file basename', () => {
    const py = DEPLOY_PY;
    expect(py).toContain("pages[0].get('displayName')");
    // basename only survives as the fallback for a dashboard with no page
    expect(py).toContain("os.path.basename(path)[: -len('.lvdash.json')]");
  });

  it('deploy_dashboards.py qualifies colliding display names with their pack folder, and only on collision', () => {
    const py = DEPLOY_PY;
    expect(py).toContain('name_counts[base] > 1');
    expect(py).toContain("f'{base} ({group})'");
    expect(py).toContain('os.path.basename(group_dir)');
  });

  it('deploy_dashboards.py keeps a running dict of created/updated dashboards so a mid-run creation is visible to a later file', () => {
    const py = DEPLOY_PY;
    expect(py).toContain('known[display_name] = dashboard');
    expect(py.indexOf('known = {}')).toBeLessThan(py.indexOf('for path in files'));
  });

  it('databricks.yml registers each dashboard file with placeholder variables only', () => {
    const yml = bundleYaml(packFiles());
    expect(yml).toContain('resources:');
    expect(yml).toContain('dashboards:');
    expect(yml).toContain('file_path:');
    expect(yml).toContain('${var.warehouse_id}');
    expect(yml).toContain('sales-wb/dashboards/Exec_Dashboard.lvdash.json');
  });

  it('databricks.yml names each dashboard by its first page title, like deploy_dashboards.py', () => {
    const yml = bundleYaml(packFiles());
    expect(yml).toContain('display_name: "Exec Dashboard"');
    expect(yml).not.toContain('Exec_Dashboard"');
  });

  it('databricks.yml falls back to the file basename for a dashboard with no page title', () => {
    const yml = bundleYaml(new Map([['wb/dashboards/Loose_Sheets.lvdash.json', JSON.stringify({ datasets: [], pages: [] })]]));
    expect(yml).toContain('display_name: "Loose_Sheets"');
  });

  it('databricks.yml qualifies colliding titles with their pack folder, and only on collision', () => {
    const yml = bundleYaml(
      new Map([
        ['sales-wb/dashboards/Overview.lvdash.json', doc('Overview')],
        ['hr-wb/dashboards/Overview.lvdash.json', doc('Overview')],
        ['hr-wb/dashboards/Detail.lvdash.json', doc('Detail')],
      ]),
    );
    expect(yml).toContain('display_name: "Overview (sales-wb)"');
    expect(yml).toContain('display_name: "Overview (hr-wb)"');
    expect(yml).toContain('display_name: "Detail"');
  });

  it('databricks.yml with no dashboards still validates as a bundle skeleton', () => {
    const yml = bundleYaml(new Map());
    expect(yml).toContain('  dashboards:\n    {}');
  });
});

describe('deploy naming in a flat (forge build pack) layout', () => {
  it('databricks.yml qualifies colliding titles with the file stem when there is no pack folder', () => {
    const yml = bundleYaml(
      new Map([
        ['workbooks/sales-overview.lvdash.json', doc('Overview')],
        ['workbooks/hr-overview.lvdash.json', doc('Overview')],
      ]),
    );
    expect(yml).toContain('display_name: "Overview (sales-overview)"');
    expect(yml).toContain('display_name: "Overview (hr-overview)"');
    expect(yml).not.toContain('(workbooks)');
  });

  it('deploy_dashboards.py falls back to the file stem when the group folder is the pack root', () => {
    expect(DEPLOY_PY).toContain('os.path.abspath(group_dir) == os.path.abspath(args.pack_root)');
  });
});
