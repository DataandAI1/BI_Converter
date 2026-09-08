import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { main } from '../../src/cli.js';
import { RunStore } from '../../src/store/store.js';

/**
 * The CLI's LLM lane against a canned forge. What matters is the run record it leaves
 * behind, because `deploy --run <id>` and the web UI read that record, not the terminal.
 */

const FIXTURES = fileURLToPath(new URL('../fixtures/tableau/files/', import.meta.url));

let dir: string;
let stateDir: string;
let forge: FastifyInstance;
let forgeUrl: string;
let savedHome: string | undefined;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-converter-cli-'));
  stateDir = path.join(dir, 'state');
  savedHome = process.env.BI_CONVERTER_HOME;
  process.env.BI_CONVERTER_HOME = stateDir;

  forge = Fastify();
  forge.get('/healthz', async () => ({ status: 'ok', version: 'test' }));
  forge.post('/generate-rebuild', async () => ({
    artifact_id: 'a1',
    spec: { workbook: { name: 'sample' } },
    report: { passed: true, layers: [] },
    translation: [{ name: 'Profit Ratio', source_language: 'tableau_calc', original_formula: 'x', status: 'translated', sql_expression: 'x' }],
    download_url: '/download/a1',
    llm_usage: null,
    warnings: [],
    notes: [],
    parts: [],
    field_resolutions: [],
  }));
  forgeUrl = await forge.listen({ port: 0, host: '127.0.0.1' });
});

afterEach(async () => {
  await forge.close();
  if (savedHome == null) delete process.env.BI_CONVERTER_HOME;
  else process.env.BI_CONVERTER_HOME = savedHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

function runs() {
  const store = new RunStore(stateDir);
  try {
    const rows = store.listRuns(10);
    const artifacts = new Map(rows.map((r) => [r.id, store.listArtifacts(r.id)]));
    return { rows, artifacts: (id: string) => artifacts.get(id) ?? [] };
  } finally {
    store.close();
  }
}

describe('bi-converter convert --llm', () => {
  it('records every file of the pack, by absolute path, with the baseline warnings kept', async () => {
    // A cwd-relative --out, as a user would type it: the store must not remember it that
    // way, or a later `deploy --run` from another directory looks in the wrong place.
    const relOut = path.relative(process.cwd(), path.join(dir, 'pack'));
    const code = await main([
      'convert',
      path.join(FIXTURES, 'sample.twb'),
      '--llm',
      '--forge',
      forgeUrl,
      '--out',
      relOut,
    ]);
    expect(code).toBe(0);

    const { rows, artifacts } = runs();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lane: 'llm', status: 'succeeded' });

    const files = artifacts(rows[0].id);
    expect(files.length).toBeGreaterThan(0);
    for (const a of files) expect(path.isAbsolute(a.path)).toBe(true);
    expect(files.some((a) => a.kind === 'lvdash')).toBe(true);
    expect(files.some((a) => a.path.endsWith(path.join('authored', 'spec.json')))).toBe(true);
    expect(files.some((a) => a.path.endsWith(path.join('authored', 'translation.json')))).toBe(true);
    for (const a of files) expect(fs.existsSync(a.path)).toBe(true);

    // The deterministic baseline's own review summary must survive into the run.
    const warnings = JSON.parse(rows[0].warnings ?? '[]') as string[];
    expect(warnings.some((w) => /need review/.test(w))).toBe(true);
  });
});
