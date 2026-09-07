import { ForgeClient, ForgeError, type RebuildImage } from './client.js';
import { NOTE_PREFIX, isReviewWarning, type RebuildBrief } from '../brief/types.js';
import type { RunRow, RunStore } from '../store/store.js';

/**
 * The run queue (spec §7). Linetria's `build/runner.ts` is Postgres-coupled throughout —
 * `queueBuilds`, `kickDrain`, `cancelBuildRun` and `reconcileBuildRuns` all take a
 * `pg.Pool` — so this is a rewrite of the same semantics against the SQLite store, not a
 * port of the code:
 *
 *   - single-flight: one drain per store, claiming runs with a conditional UPDATE, so two
 *     kicks racing the same queued run cannot both process it;
 *   - a drain loop that keeps pulling until the queue is empty, with a pending-kick
 *     sentinel so a kick that races an empty SELECT is not lost;
 *   - cancellation, both before a run is claimed and mid-flight via an AbortController;
 *   - reconciliation of runs orphaned by a restart.
 *
 * The one behaviour worth calling out is what happens when the forge is DOWN: the run
 * reverts to `queued` and the drain parks, rather than the queue failing every run in it.
 * A forge that is not running is a setup problem, not a bad workbook, and the spec's own
 * risk table asks for queued runs to wait rather than fail.
 */

/** Thrown by processRun when the forge is transport-unreachable: the run reverts to
 *  'queued' and the drain parks instead of insta-failing the queue. */
class ForgeUnreachableError extends Error {
  constructor() {
    super('forge service unreachable');
    this.name = 'ForgeUnreachableError';
  }
}

/** undici's fetch rejects transport failures as TypeError('fetch failed') with the socket
 *  error attached as cause. Anything else — an authoring failure, a validation 422 — is
 *  NOT a forge outage, and must not park the queue. */
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ECONNRESET',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
]);

function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ForgeError) return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code && TRANSPORT_CODES.has(cause.code)) return true;
  return err.name === 'TypeError' && /fetch failed/i.test(err.message);
}

export interface RunnerDeps {
  store: RunStore;
  forge: ForgeClient;
  /** Screenshots to send as vision input, keyed by brief element name. */
  imagesFor?: (run: RunRow) => RebuildImage[];
}

/** What one run needs beyond its row: the brief the shell assembled for it. */
export interface QueuedRun {
  runId: string;
  brief: RebuildBrief;
  instructions?: string;
  images?: RebuildImage[];
}

export type CancelOutcome = 'cancelled' | 'requested' | 'not_found' | 'finished';

/** Warnings persisted on a run before the forge ran (from ingest and binding). */
function parseWarnings(row: RunRow): string[] | null {
  if (row.warnings == null) return null;
  try {
    const parsed = JSON.parse(row.warnings);
    return Array.isArray(parsed) ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * Does a human need to look at this run? One rule, so the CLI and the web UI cannot
 * disagree: any warning that is not an `info:` note, or any calculation the translator
 * could not carry across faithfully.
 */
export function runNeedsReview(row: RunRow): boolean {
  if ((parseWarnings(row) ?? []).some(isReviewWarning)) return true;
  try {
    const translation = row.translation == null ? [] : JSON.parse(row.translation);
    return (
      Array.isArray(translation) &&
      translation.some(
        (t: { status?: string }) => t.status === 'needs_review' || t.status === 'approximated',
      )
    );
  } catch {
    return false;
  }
}

/**
 * One drain and one abort registry per Runner instance. Upstream these were module-level
 * maps keyed by project id; here the store IS the scope, so a Runner owns them — which
 * also means tests get a fresh queue per instance instead of sharing module state.
 */
export class Runner {
  private drain: Promise<void> | null = null;
  private pendingKick = false;
  private readonly aborters = new Map<string, AbortController>();
  /** Briefs for queued runs, held until the drain picks them up. The store persists the
   *  brief too (so a restart can show it), but the in-flight queue reads from here. */
  private readonly queued = new Map<string, QueuedRun>();

  constructor(private readonly deps: RunnerDeps) {}

  /** Enqueue an already-created run. The brief is persisted so the run detail can show
   *  what the forge was asked to author from, even if the process dies mid-flight. */
  enqueue(item: QueuedRun): void {
    const { store } = this.deps;
    store.updateRun(item.runId, { brief: item.brief, status: 'queued' });
    this.queued.set(item.runId, item);
    this.kick();
  }

  /** Resolves when the current drain has settled. Tests await this; production does not. */
  async settled(): Promise<void> {
    await this.drain;
  }

  /** Fire-and-forget: start (or join) the serial drain. */
  kick(): void {
    if (this.drain) {
      this.pendingKick = true;
      return;
    }
    this.drain = (async () => {
      try {
        for (;;) {
          const next = this.deps.store
            .listActiveRuns()
            .find((r) => r.status === 'queued' && this.queued.has(r.id));
          if (!next) {
            // A kick may have raced our empty scan; consume it and look again.
            if (this.pendingKick) {
              this.pendingKick = false;
              continue;
            }
            return;
          }
          await this.processRun(next);
        }
      } catch (err) {
        if (err instanceof ForgeUnreachableError) {
          // Parked: runs stay 'queued'; the next enqueue or a restart re-kicks once the
          // forge is back.
          console.warn(
            'bi-converter: the run drain parked — the forge is unreachable. Start it with ' +
              '`npm run dev:forge`, or convert with --no-llm; queued runs resume on the ' +
              'next enqueue or restart.',
          );
        } else {
          console.error('bi-converter: the run drain stopped unexpectedly', err);
        }
      } finally {
        this.drain = null;
        this.pendingKick = false;
      }
    })();
  }

  private async processRun(row: RunRow): Promise<void> {
    const { store, forge } = this.deps;
    const item = this.queued.get(row.id);
    if (!item) return;

    // queued -> authoring. A run cancelled while queued loses this race by design: the
    // cancel path flips it to 'cancelled' first, and the transition then finds nothing.
    if (store.cancelRequested(row.id)) {
      store.transition(row.id, ['queued'], 'cancelled');
      this.queued.delete(row.id);
      return;
    }
    if (!store.transition(row.id, ['queued'], 'authoring')) {
      this.queued.delete(row.id);
      return;
    }

    const fail = (message: string): void => {
      store.updateRun(row.id, { status: 'failed', error: message });
    };

    const aborter = new AbortController();
    this.aborters.set(row.id, aborter);
    try {
      const images = item.images ?? this.deps.imagesFor?.(row) ?? [];

      if (store.cancelRequested(row.id)) {
        store.transition(row.id, ['authoring'], 'cancelled');
        return;
      }

      store.updateRun(row.id, { status: 'compiling' });
      const result = await forge.generateRebuild(
        {
          brief: item.brief as unknown as Record<string, unknown>,
          workbook_name: row.workbook_name,
          ...(item.instructions ? { instructions: item.instructions } : {}),
          ...(images.length > 0 ? { images } : {}),
        },
        aborter.signal,
      );

      // The forge's compile-time warnings join the shell's: both degrade this run, so both
      // must count toward needs_review. Its `notes` are the other half of that channel —
      // true, worth printing, but not a reason to make a person re-check the build — so
      // they ride the same list behind NOTE_PREFIX and are filtered out of needs_review.
      const allWarnings = [
        ...(parseWarnings(row) ?? []),
        ...(result.warnings ?? []),
        ...(result.notes ?? []).map((n) => `${NOTE_PREFIX}${n}`),
      ];

      // needs_review is NOT a run status: an honest checklist is a deliverable, not a
      // failure. Everything a caller needs to compute it is persisted here, and
      // `runNeedsReview` below is the one place that decides what counts.
      store.updateRun(row.id, {
        status: 'succeeded',
        spec: result.spec,
        translation: result.translation,
        validation: result.report,
        warnings: allWarnings,
        llmUsage: result.llm_usage ?? null,
      });
    } catch (err) {
      // The cancel check must never throw here: if the store is unavailable, marking the
      // run failed is the recovery path, not an exception out of the catch.
      let cancelled = aborter.signal.aborted;
      if (!cancelled) {
        try {
          cancelled = store.cancelRequested(row.id);
        } catch {
          /* store unreachable — treat as not cancelled */
        }
      }
      if (cancelled) {
        store.transition(row.id, ['queued', 'authoring', 'compiling'], 'cancelled');
        return;
      }
      if (err instanceof ForgeError) {
        const detail = err.detail as { report?: unknown; errors?: unknown } | undefined;
        if (detail && typeof detail === 'object') {
          // Persist the {passed, layers} report itself when present, so a failed run
          // still shows which validation layer rejected it (the raw 422 envelope is
          // {detail, report}); authoring failures ({errors}) keep the envelope.
          store.updateRun(row.id, { validation: detail.report ?? detail });
        }
        fail(err.message);
        return;
      }
      if (isTransportError(err)) {
        // fetch rejected before the forge answered: the forge is down, not this run.
        // Revert to queued and park the drain.
        store.transition(row.id, ['authoring', 'compiling'], 'queued');
        throw new ForgeUnreachableError();
      }
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.aborters.delete(row.id);
      if (['succeeded', 'failed', 'cancelled'].includes(this.deps.store.getRun(row.id)?.status ?? '')) {
        this.queued.delete(row.id);
      }
    }
  }

  /**
   * Cancel a run. A queued run cancels outright; a running one gets a cancel request plus
   * an abort of the in-flight forge call. Race-safe against the drain's claim: the request
   * flag is set FIRST (the claim checks it), then the queued flip is attempted, then the
   * running path handles whatever the run actually became.
   */
  cancel(runId: string): CancelOutcome {
    const { store } = this.deps;
    const row = store.getRun(runId);
    if (!row) return 'not_found';
    if (!store.requestCancel(runId)) {
      // Either already terminal, or a cancel was already requested.
      const current = store.getRun(runId);
      if (current && ['succeeded', 'failed', 'cancelled'].includes(current.status)) {
        return 'finished';
      }
    }
    if (store.transition(runId, ['queued'], 'cancelled')) {
      this.queued.delete(runId);
      return 'cancelled';
    }
    // The drain claimed it (or it was already running): abort the in-flight call.
    // processRun's own cancel checks pick up the request either way.
    this.aborters.get(runId)?.abort();
    return 'requested';
  }

  /**
   * Startup reconciliation: a run left mid-flight by a restart is failed rather than left
   * to look active forever, and any run still queued is re-kicked. A queued run whose
   * brief this process never saw cannot be resumed in memory, so it is failed with a
   * message that says to re-run it — silently leaving it queued would be a run that never
   * completes and never explains why.
   */
  reconcile(): void {
    const { store } = this.deps;
    for (const row of store.listActiveRuns()) {
      if (row.status === 'authoring' || row.status === 'compiling' || row.status === 'extracting') {
        store.updateRun(row.id, {
          status: 'failed',
          error: 'interrupted: the server restarted while this run was executing',
        });
        continue;
      }
      if (row.status === 'queued' && !this.queued.has(row.id)) {
        store.updateRun(row.id, {
          status: 'failed',
          error:
            'interrupted: the server restarted while this run was queued — start it again',
        });
      }
    }
    this.kick();
  }
}
