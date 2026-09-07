import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAKEVIEW_WIDGET_TYPES,
  LAKEVIEW_PARAMETER_COMPLEX_TYPES,
  LAKEVIEW_PARAMETER_DATA_TYPES,
  LAKEVIEW_PARAMETER_FILTER_WIDGETS,
} from '../../src/lakeview/format.js';

/**
 * Cross-language lockstep gate (plan 2026-08-10 Phase 5): forge's Python compiler and
 * validator read the pinned Lakeview widget table from a JSON mirror, because the
 * canonical table is TypeScript (`server/src/convert/lakeview-format.ts`) and
 * Python cannot import it. Two copies of a format pin drift silently — this test is the
 * mechanism that stops it: it reads the JSON file from forge's own package path and
 * deep-equals it against the TypeScript source of truth.
 *
 * If this fails, the TS table changed and the JSON mirror was not regenerated (or vice
 * versa). Fix the MIRROR, never this test's expectation: the TS table is authoritative
 * (its `verified: true` entries are derived from the golden corpus under
 * server/test/fixtures/lakeview/).
 */

const SPEC_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'forge',
  'tableauforge',
  'spec',
);
const MIRROR_PATH = path.join(SPEC_DIR, 'lakeview_widget_types.json');
/** The second mirror: the dataset-parameter pins forge's compiler/validator read
 *  (plan 2026-09-03 Phase D4 — parameters in the AI-authored lane). */
const PARAMETER_MIRROR_PATH = path.join(SPEC_DIR, 'lakeview_parameter_types.json');

describe('forge lakeview_widget_types.json ↔ LAKEVIEW_WIDGET_TYPES', () => {
  it('the JSON mirror exists at forge/tableauforge/spec/', () => {
    expect(fs.existsSync(MIRROR_PATH), `missing mirror: ${MIRROR_PATH}`).toBe(true);
  });

  it('deep-equals the canonical TypeScript table', () => {
    const mirror = JSON.parse(fs.readFileSync(MIRROR_PATH, 'utf8'));
    expect(mirror).toEqual(LAKEVIEW_WIDGET_TYPES);
  });

  it('pins every widget type the Python compiler maps chart types onto', () => {
    // The compiler map in forge/tableauforge/compiler/lakeview.py — an entry missing
    // from the pinned table would make the compiler invent a spec.version.
    const compiled = [
      'bar',
      'line',
      'area',
      'scatter',
      'table',
      'combo',
      'counter',
      'pie',
      'heatmap',
      'pivot',
    ];
    const mirror = JSON.parse(fs.readFileSync(MIRROR_PATH, 'utf8')) as Record<string, unknown>;
    for (const widgetType of compiled) {
      expect(Object.keys(mirror), `unpinned widget type: ${widgetType}`).toContain(widgetType);
    }
  });
});

describe('forge lakeview_parameter_types.json ↔ the parameter pins', () => {
  it('the JSON mirror exists at forge/tableauforge/spec/', () => {
    expect(
      fs.existsSync(PARAMETER_MIRROR_PATH),
      `missing mirror: ${PARAMETER_MIRROR_PATH}`,
    ).toBe(true);
  });

  it('deep-equals the canonical TypeScript parameter pins', () => {
    const mirror = JSON.parse(fs.readFileSync(PARAMETER_MIRROR_PATH, 'utf8'));
    expect(mirror).toEqual({
      dataTypes: LAKEVIEW_PARAMETER_DATA_TYPES,
      complexTypes: LAKEVIEW_PARAMETER_COMPLEX_TYPES,
      filterWidgets: LAKEVIEW_PARAMETER_FILTER_WIDGETS,
    });
  });

  it('every pinned filter widget is itself a pinned widget type', () => {
    const mirror = JSON.parse(fs.readFileSync(PARAMETER_MIRROR_PATH, 'utf8')) as {
      filterWidgets: Record<string, string>;
    };
    const widgets = JSON.parse(fs.readFileSync(MIRROR_PATH, 'utf8')) as Record<string, unknown>;
    for (const [form, widgetType] of Object.entries(mirror.filterWidgets)) {
      expect(Object.keys(widgets), `unpinned widget for form ${form}`).toContain(widgetType);
    }
  });
});
