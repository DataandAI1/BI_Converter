import { describe, expect, it } from 'vitest';
import { mergeVisualStructure, collectVisuals } from '../../src/tableau/visuals.js';
import { ReplayExecutor } from '../../src/tableau/executor.js';
import type { TableauWorkbookDoc } from '../../src/tableau/model.js';

const base = (): TableauWorkbookDoc => ({
  site: 'default', project: 'Ops', name: 'wb', luid: 'wb-1', datasources: [],
  sheets: [{ name: 'S1', luid: 'v-s1', datasourceRefs: [], fieldRefs: [] }],
  dashboards: [{ name: 'D1', luid: 'v-d1', sheetNames: ['S1'] }],
});

const VISUAL = {
  markClass: 'Bar', markClasses: ['Bar'], rows: ['A'], cols: ['B'],
  rowsRaw: '', colsRaw: '', encodings: [], filters: [],
};

describe('mergeVisualStructure', () => {
  it('copies visual/layout/thumbnails onto name-matched docs and flags the source', () => {
    const target = base();
    const parsed: TableauWorkbookDoc = {
      ...base(), visualSource: 'twb_file',
      sheets: [{ name: 's1', datasourceRefs: [], fieldRefs: [], visual: VISUAL }],
      dashboards: [{ name: 'D1', sheetNames: ['S1'], layout: { zones: [] } }],
      thumbnails: [{ name: 'D1', base64: 'AAAA' }],
    };
    const warnings: string[] = [];
    mergeVisualStructure(target, parsed, warnings);
    expect(target.visualSource).toBe('twb_content');
    expect(target.sheets[0].visual).toEqual(VISUAL);       // case-insensitive name match
    expect(target.dashboards[0].layout).toEqual({ zones: [] });
    expect(target.thumbnails).toEqual([{ name: 'D1', base64: 'AAAA' }]);
    expect(warnings).toEqual([]);
  });

  it('warns about parsed sheets with no Metadata API counterpart', () => {
    const target = base();
    const parsed: TableauWorkbookDoc = {
      ...base(),
      sheets: [{ name: 'Ghost', datasourceRefs: [], fieldRefs: [], visual: VISUAL }],
      dashboards: [],
    };
    const warnings: string[] = [];
    mergeVisualStructure(target, parsed, warnings);
    expect(warnings[0]).toMatch(/1 sheet\(s\).*no Metadata API counterpart/);
  });
});

describe('collectVisuals', () => {
  const PNG64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

  it('captures dashboard + standalone-sheet images and skips unrecorded steps silently', async () => {
    const doc = base();
    doc.sheets.push({ name: 'Solo', luid: 'v-solo', datasourceRefs: [], fieldRefs: [] });
    const ex = new ReplayExecutor({ steps: {
      'image:v-d1': [{ base64: PNG64, contentType: 'image/png' }],
      'image:v-solo': [{ base64: PNG64, contentType: 'image/png' }],
      // no 'content:wb-1' step recorded — must be skipped without a warning
    } });
    const { screenshots, warnings } = await collectVisuals(ex, [doc]);
    expect(warnings).toEqual([]);
    expect(screenshots.map((s) => [s.name, s.assetType, s.source])).toEqual([
      ['wb/D1', 'bi_dashboard', 'rest_image'],
      ['wb/Solo', 'bi_sheet', 'rest_image'],   // S1 is inside D1 → not captured
    ]);
    expect(screenshots[0].catalog).toBe('default');
    expect(screenshots[0].schemaName).toBe('Ops');
  });

  it('honors the screenshot cap with a counting warning and the off switch', async () => {
    process.env.LINETRIA_TABLEAU_MAX_SCREENSHOTS = '1';
    const ex = new ReplayExecutor({ steps: {
      'image:v-d1': [{ base64: PNG64, contentType: 'image/png' }],
    } });
    const doc = base();
    doc.sheets.push({ name: 'Solo', luid: 'v-solo', datasourceRefs: [], fieldRefs: [] });
    const { screenshots, warnings } = await collectVisuals(ex, [doc]);
    expect(screenshots).toHaveLength(1);
    expect(warnings[0]).toMatch(/screenshot cap reached .*1 view image\(s\) not captured/);
    delete process.env.LINETRIA_TABLEAU_MAX_SCREENSHOTS;

    process.env.LINETRIA_BI_SCREENSHOTS = 'off';
    const off = await collectVisuals(ex, [base()]);
    expect(off.screenshots).toEqual([]);
    delete process.env.LINETRIA_BI_SCREENSHOTS;
  });

  it('falls back to the 200 default when LINETRIA_TABLEAU_MAX_SCREENSHOTS is malformed', async () => {
    // A typo'd/non-numeric override must NOT silently become `targets.slice(0, NaN)`,
    // which drops ALL screenshots without so much as a warning — the guard must fall
    // back to the 200 default instead.
    process.env.LINETRIA_TABLEAU_MAX_SCREENSHOTS = 'abc';
    try {
      const doc = base();
      const ex = new ReplayExecutor({ steps: {
        'image:v-d1': [{ base64: PNG64, contentType: 'image/png' }],
      } });
      const { screenshots, warnings } = await collectVisuals(ex, [doc]);
      expect(screenshots).toHaveLength(1);
      expect(warnings).toEqual([]);
    } finally {
      delete process.env.LINETRIA_TABLEAU_MAX_SCREENSHOTS;
    }
  });

  it('turns image failures into warnings, never throws', async () => {
    const ex = { // executor whose image step fails hard
      execute: async (_r: string, id: string) => { throw new Error(`HTTP 403 for ${id}`); },
      close: async () => {},
    };
    const { screenshots, warnings } = await collectVisuals(ex, [base()]);
    expect(screenshots).toEqual([]);
    expect(warnings.some((w) => w.includes('wb/D1'))).toBe(true);
  });
});
