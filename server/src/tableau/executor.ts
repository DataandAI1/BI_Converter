import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The seam between connector logic and the wire (spec §16). Connectors express their
 * extraction as ordered query steps against this interface; live executors wrap the
 * platform driver, while ReplayExecutor serves recorded responses so Snowflake and
 * Databricks connectors are tested end-to-end with only the network substituted.
 */
export interface QueryExecutor {
  /**
   * Run one statement. stepId is the stable identity of the query step (e.g. 'tables',
   * 'show_imported_keys:FIXTURE_ESTATE') — live executors ignore it; the replay
   * executor keys recorded responses by it.
   */
  execute(sql: string, stepId: string): Promise<Array<Record<string, unknown>>>;
  close(): Promise<void>;
}

const FIXTURES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'test',
  'fixtures',
);

export interface ReplayFixture {
  /** Recorded rows per step id. */
  steps: Record<string, Array<Record<string, unknown>>>;
}

/** A replay fixture has no recording for a step. Optional capture passes (Tableau
 *  content/image, spec 2026-07-27) catch this to skip silently — a fixture that
 *  never recorded capture steps is not a degraded live run. */
export class ReplayStepMissingError extends Error {}

/** Recorded-response test double (spec §16). */
export class ReplayExecutor implements QueryExecutor {
  constructor(private readonly fixture: ReplayFixture) {}

  static async fromFile(relativePath: string): Promise<ReplayExecutor> {
    // The path comes from connection_config; never let it escape fixtures/.
    const resolved = path.resolve(FIXTURES_DIR, relativePath);
    if (!resolved.startsWith(path.resolve(FIXTURES_DIR) + path.sep)) {
      throw new Error('replay fixture path must live inside the fixtures directory');
    }
    const raw = await fs.readFile(resolved, 'utf8');
    return new ReplayExecutor(JSON.parse(raw) as ReplayFixture);
  }

  async execute(_sql: string, stepId: string): Promise<Array<Record<string, unknown>>> {
    const rows = this.fixture.steps[stepId];
    if (rows === undefined) {
      throw new ReplayStepMissingError(`replay fixture has no recorded response for step '${stepId}'`);
    }
    return rows;
  }

  async close(): Promise<void> {}
}
