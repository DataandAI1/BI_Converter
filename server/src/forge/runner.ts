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
  // undici's own codes for a socket that closed under a request or its response body.
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

function isTransportError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ForgeError) return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code && TRANSPORT_CODES.has(cause.code)) return true;
  // 'fetch failed' is the request never getting out; 'terminated' is the response body
  // being cut off — the forge (or a proxy in front of it) went away mid-build. Both mean
  // the forge is not there to answer, not that this run was bad.
  return err.name === 'TypeError' && /fetch failed|terminated/i.test(err.message);
}

/**
 * Forge statuses worth another try before the AI lane gives up: the model provider
 * throttling or overloaded (429, and the 502 the forge wraps a provider error in), or
 * Ollama still loading a model (503). A 422 is the model's own work being rejected, and
 * the client's 504 is a build that already ran the whole timeout — neither improves by
 * asking again.
 */
const RETRYABLE_FORGE_STATUSES = new Set([429, 502, 503]);

/** Waits between retries of one forge call. The last entry is also the retry count. */
const DEFAULT_RETRY_DELAYS_MS = [3_000, 10_000, 30_000];

/** Waits before re-kicking a drain parked on an unreachable forge; the last entry
 *  repeats until the forge answers. */
const DEFAULT_RESUME_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000];

/** How many times a restart may resume a run it found mid-flight before failing it. */
const MAX_RESUMES = 2;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface RunnerDeps {
  store: RunStore;
  forge: ForgeClient;
  /** Screenshots to send as vision input, keyed by brief element name. */
  imagesFor?: (run: RunRow) => RebuildImage[];
  /** Waits between retries of a transient forge failure. Tests pass zeros. */
  retryDelaysMs?: readonly number[];
  /** Waits before a parked drain tries the forge again. Tests pass milliseconds. */
  resumeDelaysMs?: readonly number[];
}

/** What one run needs beyond its row: the brief the shell assembled for it. */
export interface QueuedRun {
  runId: string;
  brief: RebuildBrief;
  instructions?: string;
  images?: RebuildImage[];
}

export type CancelOutcome = 'cancelled' | 'requested' | 'not_found' | 'finished';

/** The brief persisted at enqueue, or null when the row predates that column or holds
 *  something that is not a brief. */
function parseBrief(row: RunRow): RebuildBrief | null {
  if (row.brief == null) return null;
  try {
    const parsed = JSON.parse(row.brief);
    return parsed && typeof parsed === 'object' ? (parsed as RebuildBrief) : null;
  } catch {
    return null;
  }
}

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
  /** The in-flight drain, for `settled()` to await. NOT the single-flight guard: see
   *  `draining` — this field is assigned only after the drain body has already begun. */
  private drain: Promise<void> | null = null;
  /**
   * The single-flight guard. It has to be a flag set *before* the drain body starts
   * rather than a null-check on `drain`, because an async function body runs
   * synchronously until its first `await` — and the empty-queue path has none. Guarding
   * on `drain` meant the body's `finally` cleared the field before the assignment that
   * set it, leaving a resolved promise parked there forever, so every later `kick()`
   * saw "a drain is already running" and returned. The startup `reconcile()` on a store
   * with nothing active hit that path every time, which left every AI-lane run
   * afterwards sitting in 'queued' with no error to explain it.
   */
  private draining = false;
  private pendingKick = false;
  private readonly aborters = new Map<string, AbortController>();
  /** Briefs for queued runs, held until the drain picks them up. The store persists the
   *  brief too (so a restart can resume from it), but the in-flight queue reads from here. */
  private readonly queued = new Map<string, QueuedRun>();
  /** The pending re-kick of a parked drain, so `close()` can cancel it and a second park
   *  does not schedule a second timer. */
  private resumeTimer: ReturnType<typeof setTimeout> | null = null;
  /** How many resumes in a row found the forge still down; indexes the backoff table. */
  private parkedRounds = 0;
  private closed = false;

  constructor(private readonly deps: RunnerDeps) {}

  /** Enqueue an already-created run. The brief and instructions are persisted so the run
   *  detail can show what the forge was asked to author from, and so a restart can resume
   *  the run rather than fail it. */
  enqueue(item: QueuedRun): void {
    const { store } = this.deps;
    store.updateRun(item.runId, {
      brief: item.brief,
      instructions: item.instructions ?? null,
      status: 'queued',
    });
    this.queued.set(item.runId, item);
    this.kick();
  }

  /** Stop any pending resume timer. Tests call this; a server exiting does not need to,
   *  the timer is unref'd. */
  close(): void {
    this.closed = true;
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = null;
    }
  }

  /** Resolves when the current drain has settled. Tests await this; production does not. */
  async settled(): Promise<void> {
    await this.drain;
  }

  /** Fire-and-forget: start (or join) the serial drain. */
  kick(): void {
    if (this.draining) {
      this.pendingKick = true;
      return;
    }
    this.draining = true;
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
          // Parked: runs stay 'queued'. The drain tries again by itself, backing off,
          // until the forge answers — so a forge restarted a minute later picks the
          // queue up without anyone re-submitting or restarting this server.
          this.scheduleResume();
        } else {
          console.error('bi-converter: the run drain stopped unexpectedly', err);
        }
      } finally {
        this.draining = false;
        this.pendingKick = false;
      }
    })();
  }

  private scheduleResume(): void {
    if (this.closed || this.resumeTimer) return;
    const delays = this.deps.resumeDelaysMs ?? DEFAULT_RESUME_DELAYS_MS;
    const delay = delays[Math.min(this.parkedRounds, delays.length - 1)] ?? 0;
    this.parkedRounds += 1;
    if (this.parkedRounds === 1) {
      console.warn(
        'bi-converter: the run drain parked — the forge is unreachable. Start it with ' +
          '`npm run dev:forge`, or convert with --no-llm; queued runs resume by themselves ' +
          'once it answers.',
      );
    }
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      if (!this.closed) this.kick();
    }, delay);
    // A CLI process must not be kept alive by a queue it has already reported on.
    this.resumeTimer.unref?.();
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

    /**
     * The AI lane did not produce a dashboard. If the run already holds its deterministic
     * pack — every AI-lane run does by the time it is enqueued — the conversion has still
     * happened: the run succeeds on that pack, says so in a warning a person should read
     * (so it shows as needing review), and records which lane produced what it holds.
     * Only a run with nothing to fall back on is failed outright.
     *
     * Every store write here is guarded: this is the recovery path, and a store that is
     * briefly locked must leave the run failed rather than 'compiling' forever.
     */
    const giveUp = (message: string, extra: { validation?: unknown } = {}): void => {
      try {
        const hasPack = store.listArtifacts(row.id).length > 0;
        if (!hasPack) {
          store.updateRun(row.id, { status: 'failed', error: message, ...extra });
          return;
        }
        const current = store.getRun(row.id);
        store.updateRun(row.id, {
          status: 'succeeded',
          lane: 'deterministic',
          error: null,
          warnings: [
            ...(current ? parseWarnings(current) ?? [] : []),
            `AI-authored lane failed: ${message} — this run holds the deterministic pack ` +
              'instead; fix the cause and convert again for an AI-authored layout',
          ],
          ...extra,
        });
      } catch (storeErr) {
        console.error(`bi-converter: could not record the outcome of run ${row.id}`, storeErr);
        try {
          store.updateRun(row.id, { status: 'failed', error: message });
        } catch {
          /* the store is gone; reconcile() on the next start will find the run */
        }
      }
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
      const body = {
        brief: item.brief as unknown as Record<string, unknown>,
        workbook_name: row.workbook_name,
        ...(item.instructions ? { instructions: item.instructions } : {}),
        ...(images.length > 0 ? { images } : {}),
      };
      const delays = this.deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
      let result: Awaited<ReturnType<ForgeClient['generateRebuild']>>;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await forge.generateRebuild(body, aborter.signal);
          break;
        } catch (err) {
          const transient =
            err instanceof ForgeError &&
            RETRYABLE_FORGE_STATUSES.has(err.status) &&
            attempt < delays.length;
          if (!transient) throw err;
          console.warn(
            `bi-converter: run ${row.id}: forge answered ${err.status} (${err.message}); ` +
              `retrying in ${Math.round(delays[attempt] / 1000)}s (${attempt + 1}/${delays.length})`,
          );
          await sleep(delays[attempt], aborter.signal);
          if (aborter.signal.aborted || store.cancelRequested(row.id)) throw err;
        }
      }

      // A 200 with no spec in it is a forge bug, and recording it as success would hand
      // the CLI a null to write and the UI a run that "converted" to nothing.
      if (!result.spec || typeof result.spec !== 'object') {
        throw new ForgeError(502, 'the forge answered with no spec in it (no dashboard was authored)');
      }

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
      this.parkedRounds = 0;
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
        // Persist the {passed, layers} report itself when present, so a fallen-back run
        // still shows which validation layer rejected it (the raw 422 envelope is
        // {detail, report}); authoring failures ({errors}) keep the envelope.
        const validation =
          detail && typeof detail === 'object' ? { validation: detail.report ?? detail } : {};
        giveUp(err.message, validation);
        return;
      }
      if (isTransportError(err)) {
        // The forge is down (or went away mid-build), not this run. Revert to queued and
        // park the drain; it resumes by itself.
        store.transition(row.id, ['authoring', 'compiling'], 'queued');
        throw new ForgeUnreachableError();
      }
      giveUp(err instanceof Error ? err.message : String(err));
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
   * Startup reconciliation. The brief and instructions are persisted at enqueue, so a run
   * the previous process left queued or mid-flight is resumed from the store rather than
   * failed: the forge call is restartable, and a server restart is not the workbook's
   * fault. A mid-flight run is re-queued at most MAX_RESUMES times — one that keeps
   * dying with the process is failed with a message that says so — and a run with no
   * brief to resume from (written by a build older than the brief column) is failed with
   * a message that says to run it again, since silently leaving it queued would be a run
   * that never completes and never explains why.
   */
  reconcile(): void {
    const { store } = this.deps;
    for (const row of store.listActiveRuns()) {
      if (this.queued.has(row.id)) continue;
      const brief = parseBrief(row);
      if (row.status === 'authoring' || row.status === 'compiling' || row.status === 'extracting') {
        // `attempts` counts restart resumes only — never in-process forge retries, which
        // park and re-claim the run without anything having died.
        const resumes = row.attempts ?? 0;
        if (!brief || resumes >= MAX_RESUMES) {
          store.updateRun(row.id, {
            status: 'failed',
            error: !brief
              ? 'interrupted: the server restarted while this run was executing'
              : `interrupted: the server restarted while this run was executing, ${resumes + 1} times ` +
                'in a row — it is not resumed again; convert with --no-llm or check the forge log',
          });
          continue;
        }
        store.updateRun(row.id, {
          status: 'queued',
          attempts: resumes + 1,
          warnings: [
            ...(parseWarnings(row) ?? []),
            `${NOTE_PREFIX}the server restarted while this run was executing; it was resumed from its brief`,
          ],
        });
        this.queued.set(row.id, { runId: row.id, brief, instructions: row.instructions ?? undefined });
        continue;
      }
      if (row.status === 'queued') {
        if (!brief) {
          store.updateRun(row.id, {
            status: 'failed',
            error:
              'interrupted: the server restarted while this run was queued — start it again',
          });
          continue;
        }
        this.queued.set(row.id, { runId: row.id, brief, instructions: row.instructions ?? undefined });
      }
    }
    this.kick();
  }
}
