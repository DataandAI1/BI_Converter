import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * One broken workbook must not take the pack down with it. The emitter is mocked to fail
 * for one group, and the assertion is that every other group still emits and the broken
 * one is reported in the manifest, the checklist warnings and the README rather than
 * thrown out of the conversion.
 */

vi.mock('../../src/convert/rebuild-databricks.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/convert/rebuild-databricks.js')>();
  return {
    ...actual,
    emitTableauGroupAsLakeview: vi.fn((ctx, top, own, slug) => {
      if (top.name === 'regional') throw new TypeError("Cannot read properties of undefined (reading 'x')");
      return actual.emitTableauGroupAsLakeview(ctx, top, own, slug);
    }),
  };
});

import { parseTableauFile } from '../../src/tableau/files.js';
import { mapTableauDocs } from '../../src/tableau/mapper.js';
import { ingestStagingBatches } from '../../src/ingest/adapter.js';
import { convertToLakeviewPack } from '../../src/convert/convert.js';

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'fixtures', 'tableau', 'files',
);

async function twoWorkbooks() {
  const docs = [];
  for (const file of ['sample.twb', 'regional.twb']) {
    docs.push(...parseTableauFile(file, await fs.readFile(path.join(FIXTURES_DIR, file))));
  }
  return ingestStagingBatches(mapTableauDocs(docs, 'file'), { systemName: 'estate' });
}

describe('deterministic lane — a workbook that fails to emit does not fail the pack', () => {
  it('still emits the other workbook and reports the broken one as skipped', async () => {
    const result = convertToLakeviewPack(await twoWorkbooks(), {
      sourceName: 'estate',
      generatedAt: '2026-09-07T00:00:00.000Z',
    });

    const paths = [...result.files.keys()];
    expect(paths).toContain('sample/dashboards/Executive_Dashboard.lvdash.json');
    expect(paths.some((p) => p.startsWith('regional/'))).toBe(false);

    const skipped = result.manifest.objects.filter((o) => o.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.every((o) => o.fqn.includes('regional'))).toBe(true);
    expect(skipped[0].notes[0]).toMatch(/could not be converted.*Cannot read properties/);

    expect(result.warnings.some((w) => /regional.*could not be converted/.test(w))).toBe(true);
    expect(result.files.get('README.md')).toMatch(/could not be converted/);
    expect(result.manifest.counts.skipped).toBe(skipped.length);
  });
});
