import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAKEVIEW_WIDGET_TYPES,
  isPinnedLakeviewSpec,
  isPinnedLakeviewParameter,
  lakeviewParameterForm,
  LAKEVIEW_PARAMETER_FILTER_WIDGETS,
} from '../../src/lakeview/format.js';

/**
 * Pinned Lakeview `widgetType` + `spec.version` + encoding-channel table (Task 0 — the
 * ground-truth harness). The corpus is real Databricks-authored `.lvdash.json` exports —
 * see server/test/fixtures/lakeview/README.md for provenance. This is the format-drift
 * tripwire: every `(widgetType, spec.version)` pair any golden-corpus fixture actually
 * uses must be pinned in LAKEVIEW_WIDGET_TYPES, or this test fails.
 */

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'fixtures', 'lakeview',
);

interface RawLvdash {
  pages?: Array<{ layout?: Array<{ widget?: { spec?: { widgetType?: string; version?: number } } }> }>;
}

/** Every `(widgetType, specVersion)` pair actually present across the golden corpus, plus
 *  which fixture file(s) used it (for a legible failure message). */
async function corpusPairs(): Promise<Map<string, { widgetType: string; specVersion: number; files: string[] }>> {
  const files = (await fs.readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.lvdash.json'));
  const pairs = new Map<string, { widgetType: string; specVersion: number; files: string[] }>();
  for (const file of files) {
    const doc = JSON.parse(await fs.readFile(path.join(FIXTURES_DIR, file), 'utf8')) as RawLvdash;
    for (const page of doc.pages ?? []) {
      for (const entry of page.layout ?? []) {
        const spec = entry.widget?.spec;
        if (!spec?.widgetType || spec.version === undefined) continue; // text widgets: no spec at all
        const key = `${spec.widgetType}@${spec.version}`;
        const existing = pairs.get(key);
        if (existing) existing.files.push(file);
        else pairs.set(key, { widgetType: spec.widgetType, specVersion: spec.version, files: [file] });
      }
    }
  }
  return pairs;
}

describe('LAKEVIEW_WIDGET_TYPES — format-drift tripwire over the golden corpus', () => {
  let pairs: Map<string, { widgetType: string; specVersion: number; files: string[] }>;

  beforeAll(async () => {
    pairs = await corpusPairs();
  });

  it('the corpus is non-empty (a passing tripwire test must mean something)', () => {
    expect(pairs.size).toBeGreaterThan(0);
  });

  it('every (widgetType, spec.version) pair any fixture uses is pinned', () => {
    const unpinned: string[] = [];
    for (const [key, { widgetType, specVersion, files }] of pairs) {
      if (!isPinnedLakeviewSpec(widgetType, specVersion)) {
        unpinned.push(`${key} (in ${files.join(', ')})`);
      }
    }
    expect(unpinned, `unpinned (widgetType, spec.version) pairs found in fixtures: ${unpinned.join('; ')}`).toEqual([]);
  });

  it('every pinned entry the corpus actually exercises is marked verified: true', () => {
    const wronglyUnverified: string[] = [];
    for (const [key, { widgetType }] of pairs) {
      if (LAKEVIEW_WIDGET_TYPES[widgetType]?.verified !== true) wronglyUnverified.push(key);
    }
    expect(wronglyUnverified).toEqual([]);
  });
});

describe('LAKEVIEW_WIDGET_TYPES — pinned values', () => {
  it('pins the core chart/table/counter/pivot types observed in the corpus', () => {
    expect(LAKEVIEW_WIDGET_TYPES.bar).toEqual({ specVersion: 3, encodings: ['color', 'extra', 'label', 'x', 'y'], verified: true });
    expect(LAKEVIEW_WIDGET_TYPES.table).toEqual({ specVersion: 1, encodings: ['columns'], verified: true });
    expect(LAKEVIEW_WIDGET_TYPES.counter).toEqual({ specVersion: 2, encodings: ['target', 'value'], verified: true });
    expect(LAKEVIEW_WIDGET_TYPES.pivot).toEqual({ specVersion: 3, encodings: ['cell', 'columns', 'rows'], verified: true });
  });

  it('pins all 5 observed filter-* types plus the unprefixed range-slider filter', () => {
    for (const type of [
      'filter-date-picker',
      'filter-date-range-picker',
      'filter-multi-select',
      'filter-single-select',
      'range-slider',
    ]) {
      expect(LAKEVIEW_WIDGET_TYPES[type]?.verified, `${type} should be verified`).toBe(true);
      expect(LAKEVIEW_WIDGET_TYPES[type]?.encodings).toContain('fields');
    }
  });

  it('text has no captured spec.version (sentinel 0) — no spec wrapper exists on the wire', () => {
    expect(LAKEVIEW_WIDGET_TYPES.text).toEqual({ specVersion: 0, encodings: [], verified: true });
  });

  it('lists the target widget types the brief calls out that the corpus never observed, flagged unverified', () => {
    for (const type of ['image', 'histogram', 'funnel', 'waterfall', 'sankey', 'gantt', 'box', 'bubble', 'choropleth-map', 'point-map', 'cohort', 'custom']) {
      expect(LAKEVIEW_WIDGET_TYPES[type], `expected a placeholder entry for ${type}`).toBeDefined();
      expect(LAKEVIEW_WIDGET_TYPES[type]?.verified).toBe(false);
    }
  });

  it('isPinnedLakeviewSpec is false for an unknown widgetType or a mismatched version (never invents a pin)', () => {
    expect(isPinnedLakeviewSpec('bar', 3)).toBe(true);
    expect(isPinnedLakeviewSpec('bar', 99)).toBe(false);
    expect(isPinnedLakeviewSpec('totally-unknown-widget', 1)).toBe(false);
  });
});

/* ------------------------------------------------------- dataset parameters */

interface RawLvdashParams {
  datasets?: Array<{
    name?: string;
    parameters?: Array<{
      keyword?: string;
      dataType?: string;
      complexType?: string;
      defaultSelection?: { values?: { dataType?: string; values?: Array<{ value?: unknown }> }; range?: { dataType?: string; min?: { value?: unknown }; max?: { value?: unknown } } };
    }>;
  }>;
  pages?: Array<{
    layout?: Array<{
      widget?: {
        queries?: Array<{ name?: string; query?: { datasetName?: string; parameters?: Array<{ keyword?: string }> } }>;
        spec?: { widgetType?: string; encodings?: { fields?: Array<{ parameterName?: string; queryName?: string }> } };
      };
    }>;
  }>;
}

describe('LAKEVIEW_PARAMETER_* — format-drift tripwire over the golden corpus', () => {
  let docs: Array<{ file: string; doc: RawLvdashParams }>;

  beforeAll(async () => {
    const files = (await fs.readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.lvdash.json'));
    docs = [];
    for (const file of files) {
      docs.push({ file, doc: JSON.parse(await fs.readFile(path.join(FIXTURES_DIR, file), 'utf8')) as RawLvdashParams });
    }
  });

  it('the corpus carries dataset parameters (a passing tripwire must mean something)', () => {
    const count = docs.flatMap((d) => d.doc.datasets ?? []).flatMap((ds) => ds.parameters ?? []).length;
    expect(count).toBeGreaterThan(0);
  });

  it('every dataset parameter form (dataType, complexType) any fixture uses is pinned', () => {
    const unpinned: string[] = [];
    for (const { file, doc } of docs) {
      for (const ds of doc.datasets ?? []) {
        for (const p of ds.parameters ?? []) {
          if (!p.dataType || !isPinnedLakeviewParameter(p.dataType, p.complexType)) {
            unpinned.push(`${lakeviewParameterForm(p.dataType ?? '?', p.complexType)} (${file})`);
          }
        }
      }
    }
    expect(unpinned).toEqual([]);
  });

  it('every defaultSelection is the `values` shape, or the `range` shape for RANGE parameters', () => {
    const bad: string[] = [];
    for (const { file, doc } of docs) {
      for (const ds of doc.datasets ?? []) {
        for (const p of ds.parameters ?? []) {
          const sel = p.defaultSelection;
          const ok =
            p.complexType === 'RANGE'
              ? sel?.range !== undefined && sel.range.dataType === p.dataType && sel.range.min?.value !== undefined && sel.range.max?.value !== undefined
              : sel?.values !== undefined && sel.values.dataType === p.dataType && Array.isArray(sel.values.values);
          if (!ok) bad.push(`${p.keyword} in ${file}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('every parameter-bound filter widget uses the widget type pinned for that parameter form', () => {
    const unpinned: string[] = [];
    for (const { file, doc } of docs) {
      const form = new Map<string, string>();
      for (const ds of doc.datasets ?? []) {
        for (const p of ds.parameters ?? []) {
          if (ds.name && p.keyword && p.dataType) form.set(`${ds.name}|${p.keyword}`, lakeviewParameterForm(p.dataType, p.complexType));
        }
      }
      for (const page of doc.pages ?? []) {
        for (const entry of page.layout ?? []) {
          const w = entry.widget;
          const widgetType = w?.spec?.widgetType;
          const queries = new Map((w?.queries ?? []).map((q) => [q.name, q.query]));
          for (const f of w?.spec?.encodings?.fields ?? []) {
            if (!f.parameterName || !f.queryName) continue;
            const q = queries.get(f.queryName);
            for (const p of q?.parameters ?? []) {
              const key = `${q?.datasetName}|${p.keyword}`;
              const pf = form.get(key);
              if (!pf) continue;
              if (LAKEVIEW_PARAMETER_FILTER_WIDGETS[pf] !== widgetType) unpinned.push(`${widgetType} bound to ${pf} (${file})`);
            }
          }
        }
      }
    }
    expect(unpinned).toEqual([]);
  });
});
