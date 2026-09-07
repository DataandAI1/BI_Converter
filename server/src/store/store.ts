import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Run and artifact storage (spec §7). One SQLite file, no Docker, no migrations service.
 *
 * LLM authoring takes minutes, so the web UI needs durable job state; the CLI shares the
 * same store, which is what makes `convert` followed by a later `deploy --run <id>` work
 * across invocations. Artifact BYTES live on disk — only metadata is in SQLite.
 */

export type RunStatus =
  | 'queued'
  | 'extracting'
  | 'authoring'
  | 'compiling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type RunLane = 'llm' | 'deterministic';
export type SourceKind = 'file' | 'tableau_server';
export type ArtifactKind = 'pack' | 'lvdash' | 'checklist' | 'semantic_layer';

/** Statuses a run can still leave. Anything else is terminal. */
export const ACTIVE_STATUSES: readonly RunStatus[] = [
  'queued',
  'extracting',
  'authoring',
  'compiling',
];

export interface RunRow {
  id: string;
  created_at: string;
  source_kind: SourceKind;
  workbook_name: string;
  lane: RunLane;
  status: RunStatus;
  brief: string | null;
  spec: string | null;
  translation: string | null;
  validation: string | null;
  warnings: string | null;
  llm_usage: string | null;
  error: string | null;
  /** Set when a caller asked to cancel; the runner checks it between stages. */
  cancel_requested_at: string | null;
}

export interface ArtifactRow {
  id: string;
  run_id: string;
  path: string;
  kind: ArtifactKind;
  bytes: number;
}

export interface CreateRunInput {
  sourceKind: SourceKind;
  workbookName: string;
  lane: RunLane;
  id?: string;
  createdAt?: string;
}

/** The JSON-shaped columns, so callers hand over objects and read objects back. */
export interface RunPatch {
  status?: RunStatus;
  brief?: unknown;
  spec?: unknown;
  translation?: unknown;
  validation?: unknown;
  warnings?: readonly string[];
  llmUsage?: unknown;
  error?: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  source_kind TEXT NOT NULL,        -- 'file' | 'tableau_server'
  workbook_name TEXT NOT NULL,
  lane TEXT NOT NULL,               -- 'llm' | 'deterministic'
  status TEXT NOT NULL,             -- queued|extracting|authoring|compiling|succeeded|failed|cancelled
  brief TEXT, spec TEXT, translation TEXT, validation TEXT,
  warnings TEXT, llm_usage TEXT, error TEXT,
  cancel_requested_at TEXT
);

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  path TEXT NOT NULL,               -- on-disk pack location
  kind TEXT NOT NULL,               -- 'pack' | 'lvdash' | 'checklist' | 'semantic_layer'
  bytes INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS artifact_run_idx ON artifact(run_id);
CREATE INDEX IF NOT EXISTS run_created_idx ON run(created_at DESC);
`;

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/** Parse a JSON column, tolerating a row written by an older or hand-edited copy. */
export function parseJsonColumn<T>(raw: string | null): T | null {
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class RunStore {
  private readonly db: Database.Database;

  /** `dir` holds the SQLite file and the artifact directories beside it. */
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(path.join(dir, 'runs.sqlite'));
    // WAL so the CLI can read a run the server is writing, which is the whole point of
    // the two sharing a store.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /** Where a run's emitted files live. */
  packDir(runId: string): string {
    return path.join(this.dir, 'packs', runId);
  }

  createRun(input: CreateRunInput): RunRow {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO run (id, created_at, source_kind, workbook_name, lane, status)
         VALUES (?, ?, ?, ?, ?, 'queued')`,
      )
      .run(id, createdAt, input.sourceKind, input.workbookName, input.lane);
    return this.getRun(id)!;
  }

  getRun(id: string): RunRow | null {
    const row = this.db.prepare(`SELECT * FROM run WHERE id = ?`).get(id) as RunRow | undefined;
    return row ?? null;
  }

  listRuns(limit = 50): RunRow[] {
    return this.db
      .prepare(`SELECT * FROM run ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(limit) as RunRow[];
  }

  /** Runs the drain loop may still pick up, oldest first. */
  listActiveRuns(): RunRow[] {
    const placeholders = ACTIVE_STATUSES.map(() => '?').join(', ');
    return this.db
      .prepare(`SELECT * FROM run WHERE status IN (${placeholders}) ORDER BY created_at, id`)
      .all(...ACTIVE_STATUSES) as RunRow[];
  }

  /**
   * Patch a run. Only the fields present are written, so a stage that learns the spec
   * does not have to restate the brief it was handed.
   */
  updateRun(id: string, patch: RunPatch): RunRow | null {
    const sets: string[] = [];
    const values: unknown[] = [];
    const put = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      values.push(value);
    };
    if (patch.status !== undefined) put('status', patch.status);
    if (patch.brief !== undefined) put('brief', json(patch.brief));
    if (patch.spec !== undefined) put('spec', json(patch.spec));
    if (patch.translation !== undefined) put('translation', json(patch.translation));
    if (patch.validation !== undefined) put('validation', json(patch.validation));
    if (patch.warnings !== undefined) put('warnings', json(patch.warnings));
    if (patch.llmUsage !== undefined) put('llm_usage', json(patch.llmUsage));
    if (patch.error !== undefined) put('error', patch.error);
    if (sets.length === 0) return this.getRun(id);
    values.push(id);
    this.db.prepare(`UPDATE run SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    return this.getRun(id);
  }

  /**
   * Move a run to `next` only if it is currently in one of `from`. Returns whether the
   * move happened, which is how the runner claims a queued run without a lock: two
   * drains racing for the same run, only one wins the UPDATE.
   */
  transition(id: string, from: readonly RunStatus[], next: RunStatus): boolean {
    const placeholders = from.map(() => '?').join(', ');
    const info = this.db
      .prepare(`UPDATE run SET status = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(next, id, ...from);
    return info.changes > 0;
  }

  /** Ask a run to stop. The runner checks this between stages and at each await point. */
  requestCancel(id: string): boolean {
    const info = this.db
      .prepare(
        `UPDATE run SET cancel_requested_at = ?
         WHERE id = ? AND cancel_requested_at IS NULL AND status NOT IN
           ('succeeded', 'failed', 'cancelled')`,
      )
      .run(new Date().toISOString(), id);
    return info.changes > 0;
  }

  cancelRequested(id: string): boolean {
    const row = this.db.prepare(`SELECT cancel_requested_at FROM run WHERE id = ?`).get(id) as
      | { cancel_requested_at: string | null }
      | undefined;
    return row?.cancel_requested_at != null;
  }

  /**
   * Record an artifact. The id is a hash of (run, path) rather than random, so
   * re-recording the same file after a retry updates the row instead of accumulating
   * duplicates — the same reason ingest mints deterministic asset ids.
   */
  addArtifact(runId: string, filePath: string, kind: ArtifactKind, bytes: number): ArtifactRow {
    const id = createHash('sha256').update(`${runId} ${filePath}`).digest('hex').slice(0, 32);
    this.db
      .prepare(
        `INSERT INTO artifact (id, run_id, path, kind, bytes) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET path = excluded.path, kind = excluded.kind,
                                       bytes = excluded.bytes`,
      )
      .run(id, runId, filePath, kind, bytes);
    return { id, run_id: runId, path: filePath, kind, bytes };
  }

  listArtifacts(runId: string): ArtifactRow[] {
    return this.db
      .prepare(`SELECT * FROM artifact WHERE run_id = ? ORDER BY path`)
      .all(runId) as ArtifactRow[];
  }

  getArtifact(id: string): ArtifactRow | null {
    const row = this.db.prepare(`SELECT * FROM artifact WHERE id = ?`).get(id) as
      | ArtifactRow
      | undefined;
    return row ?? null;
  }
}
