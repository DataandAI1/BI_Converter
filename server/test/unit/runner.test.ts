import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunStore } from '../../src/store/store.js';
import { Runner, runNeedsReview } from '../../src/forge/runner.js';
import { ForgeError } from '../../src/forge/client.js';
import type { ForgeClient } from '../../src/forge/client.js';
import type { RebuildBrief } from '../../src/brief/types.js';

/**
 * Queue semantics (spec §7). The behaviours under test are the ones the rewrite had to
 * preserve from Linetria's Postgres runner: single-flight claiming, the drain loop,
 * cancellation before and during a run, forge-outage parking, and restart reconciliation.
 */

let dir: string;
let store: RunStore;

const BRIEF = { brief_version: '1', report: { name: 'wb' } } as unknown as RebuildBrief;

function result(overrides: Record<string, unknown> = {}) {
  return {
    artifact_id: 'a1',
    spec: { workbook: { name: 'wb' } },
    report: { passed: true, layers: [] },
    translation: [],
    download_url: '/download/a1',
    llm_usage: null,
    warnings: [],
    notes: [],
    parts: [],
    field_resolutions: [],
    ...overrides,
  };
}

/** A ForgeClient stand-in: only `generateRebuild` is reached by the runner. */
function fakeForge(impl: (body: unknown, signal?: AbortSignal) => Promise<unknown>): ForgeClient {
  return { generateRebuild: impl } as unknown as ForgeClient;
}

function newRun(lane: 'llm' | 'deterministic' = 'llm') {
  return store.createRun({ sourceKind: 'file', workbookName: 'wb', lane });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bi-converter-runner-'));
  store = new RunStore(dir);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Runner — the happy path', () => {
  it('drains a queued run to succeeded and persists what the forge returned', async () => {
    const runner = new Runner({
      store,
      forge: fakeForge(async () =>
        result({ translation: [{ name: 'c', status: 'translated' }], warnings: ['w'] }),
      ),
    });
    const run = newRun();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    const after = store.getRun(run.id)!;
    expect(after.status).toBe('succeeded');
    expect(JSON.parse(after.spec!)).toEqual({ workbook: { name: 'wb' } });
    expect(JSON.parse(after.validation!)).toEqual({ passed: true, layers: [] });
    expect(JSON.parse(after.warnings!)).toContain('w');
    expect(after.error).toBeNull();
  });

  it('sends the enqueued brief and the run workbook name to the forge', async () => {
    let seen: Record<string, unknown> | undefined;
    const runner = new Runner({
      store,
      forge: fakeForge(async (body) => {
        seen = body as Record<string, unknown>;
        return result();
      }),
    });
    const run = newRun();
    runner.enqueue({ runId: run.id, brief: BRIEF, instructions: 'keep it flat' });
    await runner.settled();

    expect(seen!.brief).toEqual(BRIEF);
    expect(seen!.workbook_name).toBe('wb');
    expect(seen!.instructions).toBe('keep it flat');
  });

  it('persists the brief at enqueue, before the forge is called', async () => {
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        // The brief must already be durable by the time the forge sees the run.
        expect(store.getRun(run.id)!.brief).not.toBeNull();
        return result();
      }),
    });
    const run = newRun();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();
    expect(JSON.parse(store.getRun(run.id)!.brief!)).toEqual(BRIEF);
  });

  it('runs queued runs one at a time, in order', async () => {
    const order: string[] = [];
    let inFlight = 0;
    const runner = new Runner({
      store,
      forge: fakeForge(async (body) => {
        inFlight += 1;
        expect(inFlight, 'two runs were in flight at once').toBe(1);
        await new Promise((r) => setTimeout(r, 5));
        order.push((body as { workbook_name: string }).workbook_name);
        inFlight -= 1;
        return result();
      }),
    });
    const a = store.createRun({ sourceKind: 'file', workbookName: 'first', lane: 'llm' });
    const b = store.createRun({ sourceKind: 'file', workbookName: 'second', lane: 'llm' });
    runner.enqueue({ runId: a.id, brief: BRIEF });
    runner.enqueue({ runId: b.id, brief: BRIEF });
    await runner.settled();

    expect(order).toEqual(['first', 'second']);
  });
});

describe('Runner — failure', () => {
  it('marks a run failed with the forge error message', async () => {
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        throw new ForgeError(422, 'generation failed');
      }),
    });
    const run = newRun();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    const after = store.getRun(run.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toBe('generation failed');
  });

  it('persists the validation report from a 422 so a failed run still explains itself', async () => {
    const report = { passed: false, layers: [{ layer: 2, name: 'lakeview', passed: false, errors: ['bad'] }] };
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        throw new ForgeError(422, 'generation failed', { detail: 'generation failed', report });
      }),
    });
    const run = newRun();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    expect(JSON.parse(store.getRun(run.id)!.validation!)).toEqual(report);
  });

  it('does not fail the run when the forge is unreachable — it reverts to queued', async () => {
    const transport = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        throw transport;
      }),
    });
    const run = newRun();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    // A forge that is not running is a setup problem, not a bad workbook.
    const after = store.getRun(run.id)!;
    expect(after.status).toBe('queued');
    expect(after.error).toBeNull();
  });

  it('resumes a parked run once the forge comes back', async () => {
    let up = false;
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        if (!up) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
        return result();
      }),
    });
    const run = newRun();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();
    expect(store.getRun(run.id)!.status).toBe('queued');

    up = true;
    runner.kick();
    await runner.settled();
    expect(store.getRun(run.id)!.status).toBe('succeeded');
  });
});

describe('Runner — cancellation', () => {
  it('cancels a queued run outright, without calling the forge', async () => {
    let called = false;
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        called = true;
        return result();
      }),
    });
    const run = newRun();
    store.updateRun(run.id, { brief: BRIEF });
    // Cancel before anything is enqueued, so the drain never claims it.
    expect(runner.cancel(run.id)).toBe('cancelled');
    runner.kick();
    await runner.settled();

    expect(store.getRun(run.id)!.status).toBe('cancelled');
    expect(called).toBe(false);
  });

  it('aborts an in-flight run and marks it cancelled', async () => {
    let runner!: Runner;
    const run = (() => {
      const r = newRun();
      return r;
    })();
    runner = new Runner({
      store,
      forge: fakeForge(
        (_body, signal) =>
          new Promise((_resolve, reject) => {
            // Cancel once the call is genuinely in flight.
            queueMicrotask(() => runner.cancel(run.id));
            signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      ),
    });
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    expect(store.getRun(run.id)!.status).toBe('cancelled');
  });

  it('reports a run that already finished as finished, not cancelled', async () => {
    const runner = new Runner({ store, forge: fakeForge(async () => result()) });
    const run = newRun();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();
    expect(runner.cancel(run.id)).toBe('finished');
    expect(store.getRun(run.id)!.status).toBe('succeeded');
  });

  it('reports an unknown run as not_found', () => {
    const runner = new Runner({ store, forge: fakeForge(async () => result()) });
    expect(runner.cancel('nope')).toBe('not_found');
  });
});

describe('Runner — reconciliation after a restart', () => {
  it('fails a run left mid-flight rather than leaving it looking active', () => {
    const run = newRun();
    store.updateRun(run.id, { status: 'compiling' });
    new Runner({ store, forge: fakeForge(async () => result()) }).reconcile();

    const after = store.getRun(run.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toContain('restarted');
  });

  it('fails a queued run whose brief this process never saw, and says why', () => {
    const run = newRun();
    new Runner({ store, forge: fakeForge(async () => result()) }).reconcile();

    const after = store.getRun(run.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toContain('start it again');
  });

  it('leaves terminal runs alone', () => {
    const run = newRun();
    store.updateRun(run.id, { status: 'succeeded' });
    new Runner({ store, forge: fakeForge(async () => result()) }).reconcile();
    expect(store.getRun(run.id)!.status).toBe('succeeded');
  });
});

describe('runNeedsReview', () => {
  it('is true for a warning a person should act on', () => {
    const run = newRun();
    store.updateRun(run.id, { warnings: ['unresolved source for x'] });
    expect(runNeedsReview(store.getRun(run.id)!)).toBe(true);
  });

  it('is false for an info note', () => {
    const run = newRun();
    store.updateRun(run.id, { warnings: ['info: this source is not Databricks'] });
    expect(runNeedsReview(store.getRun(run.id)!)).toBe(false);
  });

  it('is true when a calculation was only approximated', () => {
    const run = newRun();
    store.updateRun(run.id, {
      warnings: [],
      translation: [{ name: 'c', status: 'approximated' }],
    });
    expect(runNeedsReview(store.getRun(run.id)!)).toBe(true);
  });

  it('is false for a clean run', () => {
    const run = newRun();
    store.updateRun(run.id, { warnings: [], translation: [{ name: 'c', status: 'translated' }] });
    expect(runNeedsReview(store.getRun(run.id)!)).toBe(false);
  });
});
