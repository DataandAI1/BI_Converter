import { describe, it, expect, beforeAll } from 'vitest';
import { parseLiveSource, assembleBriefs, convertDeterministic } from '../../src/convert/pipeline.js';
import { isPinnedLakeviewSpec } from '../../src/lakeview/format.js';
import type { ParsedSource } from '../../src/convert/pipeline.js';

/**
 * Live Tableau Server extraction against recorded responses — no live credentials
 * (spec §9). The point of these tests is the one-normalizer invariant: live mode and file
 * mode share the connector, the doc model and the mapper, so everything downstream of the
 * ingest seam must behave identically. A live pull that produced a different shape would
 * mean two products.
 */

const CREDS = {
  serverUrl: 'https://tableau.example.com',
  site: 'analytics',
  patName: 'converter',
  patSecret: 'secret',
};

let estate: ParsedSource;

beforeAll(async () => {
  estate = await parseLiveSource({ ...CREDS, replayFixture: 'tableau/api/estate.json' });
});

describe('parseLiveSource — the pull', () => {
  it('extracts workbooks, sheets and datasources from the Metadata API', () => {
    const types = new Set(estate.ingest.assets.map((a) => a.asset_type));
    expect(estate.ingest.assets.length).toBeGreaterThan(0);
    expect(types.has('bi_workbook')).toBe(true);
    expect(types.has('bi_datasource')).toBe(true);
  });

  it('pins assets to the site content URL, as the FQN scheme requires', () => {
    for (const a of estate.ingest.assets) {
      expect(a.catalog).toBe('analytics');
      expect(a.fqn.startsWith('analytics.')).toBe(true);
    }
  });

  it('produces the same row shapes file mode does', () => {
    const wb = estate.ingest.assets.find((a) => a.asset_type === 'bi_workbook')!;
    expect(wb).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      platform: 'tableau',
      source_system_id: expect.any(String),
    });
    // Edges resolve to minted ids, exactly as in file mode.
    const ids = new Set(estate.ingest.assets.map((a) => a.id));
    for (const e of estate.ingest.edges) {
      expect(ids.has(e.from_asset_id)).toBe(true);
      expect(ids.has(e.to_asset_id)).toBe(true);
    }
  });

  it('is deterministic across two pulls of the same site', async () => {
    const again = await parseLiveSource({ ...CREDS, replayFixture: 'tableau/api/estate.json' });
    expect(again.ingest.assets).toEqual(estate.ingest.assets);
    expect(again.ingest.edges).toEqual(estate.ingest.edges);
  });

  it('fails loudly when the connection does not come up', async () => {
    await expect(
      parseLiveSource({ ...CREDS, replayFixture: 'tableau/api/does-not-exist.json' }),
    ).rejects.toThrow();
  });

  it('refuses to escape the fixtures directory', async () => {
    await expect(
      parseLiveSource({ ...CREDS, replayFixture: '../../../etc/passwd' }),
    ).rejects.toThrow(/fixtures directory/);
  });
});

describe('parseLiveSource — --workbook', () => {
  it('narrows to one workbook and everything it reaches', async () => {
    const wbName = estate.ingest.assets.find((a) => a.asset_type === 'bi_workbook')!.name;
    const one = await parseLiveSource({
      ...CREDS,
      workbook: wbName,
      replayFixture: 'tableau/api/estate.json',
    });
    expect(one.name).toBe(wbName);
    const kept = one.ingest.assets;
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThanOrEqual(estate.ingest.assets.length);
    expect(kept.some((a) => a.asset_type === 'bi_workbook' && a.name === wbName)).toBe(true);
    // Its sheets came along.
    expect(kept.some((a) => a.name.startsWith(`${wbName}/`))).toBe(true);
  });

  it('keeps the per-asset indexes consistent with the assets it kept', async () => {
    const wbName = estate.ingest.assets.find((a) => a.asset_type === 'bi_workbook')!.name;
    const one = await parseLiveSource({
      ...CREDS,
      workbook: wbName,
      replayFixture: 'tableau/api/estate.json',
    });
    const ids = new Set(one.ingest.assets.map((a) => a.id));
    for (const id of one.ingest.columnsByAsset.keys()) expect(ids.has(id)).toBe(true);
    for (const id of one.ingest.derivationsByAsset.keys()) expect(ids.has(id)).toBe(true);
    for (const id of one.ingest.bindingsByAsset.keys()) expect(ids.has(id)).toBe(true);
    for (const e of one.ingest.edges) {
      expect(ids.has(e.from_asset_id) && ids.has(e.to_asset_id)).toBe(true);
    }
  });

  it('names the workbooks it did find rather than converting an empty estate', async () => {
    await expect(
      parseLiveSource({
        ...CREDS,
        workbook: 'No Such Workbook',
        replayFixture: 'tableau/api/estate.json',
      }),
    ).rejects.toThrow(/no workbook named 'No Such Workbook'.*found:/s);
  });
});

describe('parseLiveSource — screenshots', () => {
  it('captures rendered dashboards when the site allows it', async () => {
    const visual = await parseLiveSource({
      ...CREDS,
      replayFixture: 'tableau/api/visual_estate.json',
    });
    expect(visual.ingest.screenshots.length).toBeGreaterThan(0);
    for (const s of visual.ingest.screenshots) {
      expect(s.contentType).toMatch(/^image\//);
      expect(s.base64.length).toBeGreaterThan(0);
      expect(['bi_dashboard', 'bi_sheet']).toContain(s.assetType);
    }
  });

  it('converts fine when the site captured no screenshots at all', () => {
    // estate.json records no image steps: capture is optional, not required.
    expect(estate.ingest.screenshots).toEqual([]);
    expect(() => convertDeterministic(estate)).not.toThrow();
  });
});

describe('a live pull converts exactly like a file one', () => {
  it('produces a full pack through the deterministic lane', () => {
    const result = convertDeterministic(estate);
    const paths = [...result.files.keys()];
    expect(paths).toContain('deploy_dashboards.py');
    expect(paths).toContain('manifest.json');
    expect(paths.some((p) => p.endsWith('rebuild_checklist.md'))).toBe(true);
    expect(result.manifest.counts.total).toBeGreaterThan(0);
  });

  it('emits only pinned widget types', () => {
    for (const [p, content] of convertDeterministic(estate).files) {
      if (!p.endsWith('.lvdash.json')) continue;
      const doc = JSON.parse(content) as {
        pages: Array<{ layout: Array<{ widget: { spec: { widgetType: string; version: number } } }> }>;
      };
      for (const page of doc.pages) {
        for (const el of page.layout) {
          expect(isPinnedLakeviewSpec(el.widget.spec.widgetType, el.widget.spec.version)).toBe(true);
        }
      }
    }
  });

  it('is byte-identical across two conversions of the same pull', () => {
    const a = convertDeterministic(estate, { generatedAt: '2026-09-07T00:00:00.000Z' });
    const b = convertDeterministic(estate, { generatedAt: '2026-09-07T00:00:00.000Z' });
    expect([...a.files.entries()].sort()).toEqual([...b.files.entries()].sort());
  });

  it('assembles a rebuild brief for the LLM lane', () => {
    const { briefs } = assembleBriefs(estate);
    expect(briefs.length).toBeGreaterThan(0);
    for (const b of briefs) {
      expect(b.brief.report.name).toBeTruthy();
      expect(b.workbookName).toBeTruthy();
    }
  });
});
