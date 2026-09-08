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

/** A run that already holds its deterministic pack, as every AI-lane run does by the
 *  time it is enqueued. */
function newRunWithPack() {
  const run = newRun();
  const file = path.join(dir, 'packs', run.id, 'wb', 'dashboards', 'Main.lvdash.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}');
  store.addArtifact(run.id, file, 'lvdash', 2);
  return run;
}

const transportError = (code = 'ECONNREFUSED') =>
  Object.assign(new TypeError('fetch failed'), { cause: { code } });

const until = async (pred: () => boolean, ms = 2_000): Promise<void> => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};

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
  it('marks a run that holds no pack failed with the forge error message', async () => {
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

  /**
   * The deterministic pack is written before the forge is ever asked (spec: "a forge
   * that never answers still leaves a working conversion"). A run that already holds it
   * has converted; the AI lane not improving on it is a warning a person should read,
   * not a failed conversion with the pack hidden behind a red badge.
   */
  it('falls back to the deterministic pack when authoring fails, and says so as a warning', async () => {
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        throw new ForgeError(422, 'generation failed — worksheet x: unknown field');
      }),
    });
    const run = newRunWithPack();
    store.updateRun(run.id, { warnings: ['info: baseline note'] });
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    const after = store.getRun(run.id)!;
    expect(after.status).toBe('succeeded');
    expect(after.lane).toBe('deterministic');
    expect(after.error).toBeNull();
    const warnings = JSON.parse(after.warnings!) as string[];
    expect(warnings).toContain('info: baseline note');
    expect(warnings.some((w) => /AI-authored lane failed.*unknown field.*deterministic pack/.test(w))).toBe(true);
    expect(runNeedsReview(after)).toBe(true);
  });

  it('persists the validation report from a 422 so a fallen-back run still explains itself', async () => {
    const report = { passed: false, layers: [{ layer: 2, name: 'lakeview', passed: false, errors: ['bad'] }] };
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        throw new ForgeError(422, 'generation failed', { detail: 'generation failed', report });
      }),
    });
    const run = newRunWithPack();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    expect(JSON.parse(store.getRun(run.id)!.validation!)).toEqual(report);
    expect(store.getRun(run.id)!.status).toBe('succeeded');
  });

  it('treats a forge answer with no spec as an authoring failure, never as success', async () => {
    const runner = new Runner({
      store,
      forge: fakeForge(async () => result({ spec: undefined })),
    });
    const run = newRunWithPack();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    const after = store.getRun(run.id)!;
    expect(after.lane).toBe('deterministic');
    expect(after.spec).toBeNull();
    expect(JSON.parse(after.warnings!).join(' ')).toMatch(/no spec/);
  });

  it('retries a transient forge status (503, 502, 429) before giving up on the AI lane', async () => {
    let calls = 0;
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        calls += 1;
        if (calls === 1) throw new ForgeError(503, 'Ollama is not reachable');
        if (calls === 2) throw new ForgeError(502, 'Claude API call failed: overloaded');
        if (calls === 3) throw new ForgeError(429, 'rate limited');
        return result();
      }),
      retryDelaysMs: [0, 0, 0],
    });
    const run = newRunWithPack();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    expect(calls).toBe(4);
    const after = store.getRun(run.id)!;
    expect(after.status).toBe('succeeded');
    expect(after.lane).toBe('llm');
  });

  it('does not retry a rejection the model earned (422) or the build timeout (504)', async () => {
    for (const err of [new ForgeError(422, 'rebuild authoring failed'), new ForgeError(504, 'forge build timed out after 30 min')]) {
      let calls = 0;
      const runner = new Runner({
        store,
        forge: fakeForge(async () => {
          calls += 1;
          throw err;
        }),
        retryDelaysMs: [0, 0],
      });
      const run = newRunWithPack();
      runner.enqueue({ runId: run.id, brief: BRIEF });
      await runner.settled();
      expect(calls).toBe(1);
    }
  });

  it('gives up after the retry budget and falls back, naming the last error', async () => {
    let calls = 0;
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        calls += 1;
        throw new ForgeError(503, 'still loading');
      }),
      retryDelaysMs: [0, 0],
    });
    const run = newRunWithPack();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    expect(calls).toBe(3);
    const after = store.getRun(run.id)!;
    expect(after.status).toBe('succeeded');
    expect(after.lane).toBe('deterministic');
    expect(JSON.parse(after.warnings!).join(' ')).toMatch(/still loading/);
  });

  it('stops retrying when the run is cancelled during the wait', async () => {
    let runner!: Runner;
    let calls = 0;
    const run = newRunWithPack();
    runner = new Runner({
      store,
      forge: fakeForge(async () => {
        calls += 1;
        queueMicrotask(() => runner.cancel(run.id));
        throw new ForgeError(503, 'not yet');
      }),
      retryDelaysMs: [50, 50, 50],
    });
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    expect(calls).toBe(1);
    expect(store.getRun(run.id)!.status).toBe('cancelled');
  });

  it('classifies a connection dropped mid-response as the forge going away, not as a bad run', async () => {
    let calls = 0;
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        calls += 1;
        if (calls === 1) {
          throw Object.assign(new TypeError('terminated'), {
            cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
          });
        }
        return result();
      }),
      resumeDelaysMs: [1],
    });
    const run = newRunWithPack();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();
    expect(store.getRun(run.id)!.status).toBe('queued');

    await until(() => store.getRun(run.id)!.status === 'succeeded');
    expect(calls).toBe(2);
    runner.close();
  });

  it('resumes a parked queue by itself once the forge is back, without a new enqueue', async () => {
    let up = false;
    let calls = 0;
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        calls += 1;
        if (!up) throw transportError();
        return result();
      }),
      resumeDelaysMs: [1, 1, 1],
    });
    const run = newRunWithPack();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();
    expect(store.getRun(run.id)!.status).toBe('queued');

    await until(() => calls >= 3);
    up = true;
    await until(() => store.getRun(run.id)!.status === 'succeeded');
    runner.close();
  });

  it('survives a store that fails while marking the outcome, leaving the run failed rather than compiling', async () => {
    const runner = new Runner({
      store,
      forge: fakeForge(async () => result()),
    });
    const run = newRunWithPack();
    const original = store.updateRun.bind(store);
    let armed = true;
    store.updateRun = ((id, patch) => {
      if (armed && patch.status === 'succeeded') {
        armed = false;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return original(id, patch);
    }) as typeof store.updateRun;
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    const after = store.getRun(run.id)!;
    expect(after.status).not.toBe('compiling');
    expect(['succeeded', 'failed']).toContain(after.status);
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
  it('resumes a run left mid-flight from its persisted brief rather than failing it', async () => {
    const run = newRunWithPack();
    store.updateRun(run.id, { status: 'compiling', brief: BRIEF, instructions: 'keep it flat' });
    let seen: Record<string, unknown> | undefined;
    const runner = new Runner({
      store,
      forge: fakeForge(async (body) => {
        seen = body as Record<string, unknown>;
        return result();
      }),
    });
    runner.reconcile();
    await runner.settled();

    const after = store.getRun(run.id)!;
    expect(after.status).toBe('succeeded');
    expect(after.error).toBeNull();
    expect(seen!.brief).toEqual(BRIEF);
    expect(seen!.instructions).toBe('keep it flat');
    expect(JSON.parse(after.warnings!).join(' ')).toMatch(/restarted/);
  });

  it('resumes a queued run whose brief was persisted by a previous process', async () => {
    const run = newRunWithPack();
    store.updateRun(run.id, { brief: BRIEF });
    const runner = new Runner({ store, forge: fakeForge(async () => result()) });
    runner.reconcile();
    await runner.settled();

    expect(store.getRun(run.id)!.status).toBe('succeeded');
  });

  it('counts restart resumes, not the forge retries a parked queue makes', async () => {
    // Three park-and-retry rounds while the forge is down must not spend the restart
    // budget: a later genuine restart still resumes the run.
    let up = false;
    let calls = 0;
    const runner = new Runner({
      store,
      forge: fakeForge(async () => {
        calls += 1;
        if (!up) throw transportError();
        return result();
      }),
      resumeDelaysMs: [1],
    });
    const run = newRunWithPack();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await until(() => calls >= 4);
    runner.close();
    expect(store.getRun(run.id)!.attempts).toBe(0);

    // A restart finds it mid-flight: resumed, and the resume is what gets counted.
    store.updateRun(run.id, { status: 'compiling' });
    up = true;
    const restarted = new Runner({ store, forge: fakeForge(async () => result()) });
    restarted.reconcile();
    await restarted.settled();
    const after = store.getRun(run.id)!;
    expect(after.status).toBe('succeeded');
    expect(after.attempts).toBe(1);
  });

  it('fails a mid-flight run that has already been resumed too often, and says why', () => {
    const run = newRun();
    store.updateRun(run.id, { status: 'compiling', brief: BRIEF, attempts: 2 });
    new Runner({ store, forge: fakeForge(async () => result()) }).reconcile();

    const after = store.getRun(run.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toMatch(/restarted.*3 times/);
  });

  it('fails a queued run with no brief to resume from, and says why', () => {
    const run = newRun();
    new Runner({ store, forge: fakeForge(async () => result()) }).reconcile();

    const after = store.getRun(run.id)!;
    expect(after.status).toBe('failed');
    expect(after.error).toContain('start it again');
  });

  /**
   * The production sequence: `buildServer` constructs a Runner and reconciles it before
   * any run exists, so the startup drain finds an empty queue. A drain that finishes
   * without ever awaiting must still leave the runner able to start the next one --
   * otherwise every AI-lane run enqueued afterwards sits in 'queued' forever, with no
   * error to explain it.
   */
  it('still drains a run enqueued after a reconcile that found nothing to do', async () => {
    const runner = new Runner({ store, forge: fakeForge(async () => result()) });
    runner.reconcile();

    const run = newRun();
    runner.enqueue({ runId: run.id, brief: BRIEF });
    await runner.settled();

    expect(store.getRun(run.id)!.status).toBe('succeeded');
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
