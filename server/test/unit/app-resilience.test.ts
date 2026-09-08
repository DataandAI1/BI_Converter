import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

/**
 * A conversion that breaks AFTER its run row exists must leave a run that says so, not a
 * row parked in 'queued' behind an opaque 500 that the UI polls forever. The pipeline is
 * mocked so one workbook name blows up inside the deterministic lane.
 */

vi.mock('../../src/convert/pipeline.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/convert/pipeline.js')>();
  return {
    ...actual,
    convertDeterministic: vi.fn((source, opts) => {
      if (source.name === 'explodes') throw new RangeError('Maximum call stack size exceeded');
      return actual.convertDeterministic(source, opts);
    }),
  };
});

import { buildServer } from '../../src/api/app.js';
import { RunStore } from '../../src/store/store.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/tableau/files/', import.meta.url));
const upload = (file: string, as = file) => ({
  fileName: as,
  data: fs.readFileSync(path.join(FIXTURES, file)).toString('base64'),
});

let dir: string;
let store: RunStore;
let app: FastifyInstance | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-converter-app-res-'));
  store = new RunStore(path.join(dir, 'state'));
  app = buildServer({ store, forgeUrl: 'http://127.0.0.1:1', webRoot: path.join(dir, 'nowhere') });
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/convert — a conversion that breaks after the run exists', () => {
  it('marks the run failed with the reason and answers with that reason, never a stuck queued row', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/convert',
      payload: { ...upload('sample.twb'), name: 'explodes' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/conversion failed.*Maximum call stack/);

    const runs = store.listRuns(10);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
    expect(runs[0].error).toMatch(/Maximum call stack/);
  });

  it('says an empty upload is empty rather than that no file was given', async () => {
    const res = await app!.inject({
      method: 'POST',
      url: '/api/convert',
      payload: { fileName: 'blank.twb', data: '' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/'blank\.twb' is empty/);
    expect(store.listRuns(10)).toEqual([]);
  });

  it('names the file and the problem for a truncated workbook, and creates no run', async () => {
    const buf = fs.readFileSync(path.join(FIXTURES, 'sample.twb'));
    const res = await app!.inject({
      method: 'POST',
      url: '/api/convert',
      payload: { fileName: 'cut.twb', data: buf.subarray(0, buf.length / 2).toString('base64') },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/'cut\.twb'/);
    expect(store.listRuns(10)).toEqual([]);
  });
});

describe('GET /api/runs/:id/pack.zip', () => {
  it('serves a pack whose workbook name carries quotes and non-ASCII characters', async () => {
    const created = await app!.inject({
      method: 'POST',
      url: '/api/convert',
      payload: { ...upload('sample.twb'), name: 'Ventas "Región" 2026\r\nX' },
    });
    expect(created.statusCode).toBe(200);
    const res = await app!.inject({ method: 'GET', url: `/api/runs/${created.json().id}/pack.zip` });
    expect(res.statusCode).toBe(200);
    const disposition = res.headers['content-disposition'] as string;
    expect(disposition).toMatch(/^attachment; filename="[\x20-\x7e]*"/);
    expect(disposition).not.toMatch(/["\r\n]{2}/);
    expect(disposition).toMatch(/filename\*=UTF-8''.*Regi/);
  });
});
