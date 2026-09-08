// HTTP client for the forge service (TableauForge, spec 2026-07-22 §7.2). Unlike the
// parser's 30s calls, a rebuild build legitimately runs for minutes (forge streams
// Claude responses because "requests can run past 10 minutes"), so this client uses a
// dedicated undici dispatcher with the header/body timeouts disabled and bounds every
// call with an explicit AbortSignal budget (BUILD_TIMEOUT_MS, default 30 min) instead.

import { Agent, fetch as undiciFetch } from 'undici';

/** The one output format the forge compiles. Upstream this mirrored a three-platform
 *  registry; BI_Converter converts to Databricks AI/BI only (spec §3.2). */
export const BUILD_TARGET = 'databricks' as const;
export type BuildTarget = typeof BUILD_TARGET;

export interface ForgeDatabaseBlock {
  dialect: 'postgres' | 'mysql' | 'snowflake' | 'sqlserver' | 'databricks';
  host: string;
  port?: number;
  database: string;
  db_schema?: string;
  table: string;
  username?: string;
  warehouse?: string;
  http_path?: string;
}

/** A rendered element screenshot, sent as vision input alongside the brief (spec
 *  2026-07-27 visual-informed-rebuild §5) — capped at 4 images server-side. */
export interface RebuildImage {
  element: string;
  media_type: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
}

export interface DraftRebuildBody {
  brief: Record<string, unknown>;
  workbook_name?: string;
  instructions?: string;
  images?: RebuildImage[];
}

export interface GenerateRebuildBody extends DraftRebuildBody {
  spec_json?: Record<string, unknown>;
  translation?: TranslationEntry[];
  llm_usage?: Record<string, unknown>;
}

export interface TranslationEntry {
  name: string;
  /** The language the ORIGINAL formula was written in. `sql` appears when the
   *  catalogued derivation was already SQL (a database view, a Lakeview dataset
   *  expression) — brief.ts's `languageOf` emits it, so the union must carry it. */
  source_language: 'dax' | 'tableau_calc' | 'm' | 'sql';
  original_formula: string;
  status: 'translated' | 'approximated' | 'needs_review' | 'skipped';
  /** Target formula: tableau_formula for 'tableau' runs, dax_formula for
   *  sql_expression carries the Databricks SQL. Exactly one
   *  is populated per run — build/pack.ts picks it by the run's target. */
  tableau_formula?: string;
  dax_formula?: string;
  sql_expression?: string;
  reason?: string;
}

export interface GenerateRebuildResult {
  artifact_id: string;
  spec: Record<string, unknown>;
  report: { passed: boolean; layers: Array<Record<string, unknown>> };
  translation: TranslationEntry[];
  download_url: string;
  llm_usage: Record<string, unknown> | null;
  polish: Record<string, unknown> | null;
  field_resolutions: Array<Record<string, unknown>>;
  /** Compile-time degradations (forge ≥ the warnings-threading revision; older
   *  forges omit the key). Merged into the run's warnings before needs_review.
   *  Review-worthy ONLY: something the source report had that the artifact does
   *  not. */
  warnings?: string[];
  /** Informational compile-time caveats (forge ≥ the notes-split revision; older
   *  forges omit the key): true, worth keeping, but never a reason to flip a run
   *  to needs-review — the databricks target's "this source is not Databricks"
   *  caveat fires on every migration it exists to serve, and as a warning it made
   *  every single run `complete_with_warnings`. Persisted alongside the warnings
   *  under the `info: ` prefix (see build/types.ts NOTE_PREFIX). */
  notes?: string[];
  /** One entry per emitted document when the target had to split the report
   *  across several (databricks: an AI/BI dashboard holds at most 15 pages).
   *  Absent or empty means one artifact carries the whole report; when present,
   *  the downloaded artifact is a zip of these. */
  parts?: ArtifactPart[];
}

/** One document of a split rebuild — see GenerateRebuildResult.parts. */
export interface ArtifactPart {
  /** Filename inside the artifact zip, e.g. `Sales (2 of 3).lvdash.json`. */
  name: string;
  /** Dashboard name, e.g. `Sales (2 of 3)`. */
  title: string;
  index: number;
  total: number;
  pages: number;
  datasets: number;
}

export interface DraftRebuildResult {
  spec: Record<string, unknown>;
  translation: TranslationEntry[];
  llm_usage: Record<string, unknown> | null;
}

/** One entry of the forge's model catalog — what the Settings picker offers for Claude. */
export interface ForgeModel {
  id: string;
  label: string;
  description: string;
  supports_effort: boolean;
}

/** The forge's provider configuration, as GET /settings reports it. Secrets are masked. */
export interface ForgeSettings {
  provider: 'claude' | 'ollama';
  provider_source: 'runtime' | 'env' | null;
  ollama_base_url: string;
  ollama_model: string;
  ollama_num_ctx: number;
  /** LLM features work: Ollama needs no key; Claude needs one configured. */
  llm_ready: boolean;
  api_key_configured: boolean;
  api_key_masked: string | null;
  api_key_source: 'runtime' | 'env' | null;
  model: string;
  model_source: 'runtime' | 'env' | null;
  available_models: ForgeModel[];
}

export interface SetProviderBody {
  provider: 'claude' | 'ollama';
  ollama_base_url?: string;
  ollama_model?: string;
  ollama_num_ctx?: number;
}

/** Settings calls are config writes, not builds: a 30-min budget is the wrong bound. */
const SETTINGS_TIMEOUT_MS = 15_000;

export class ForgeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ForgeError';
  }
}

const buildTimeoutMs = (): number =>
  Number(process.env.BUILD_TIMEOUT_MS ?? 30 * 60 * 1000);

type FetchLike = typeof undiciFetch;

// One shared dispatcher: undici's default headersTimeout/bodyTimeout is 300s,
// which a multi-minute Claude build would trip while forge is still (correctly)
// working. The AbortSignal budget below is the real per-call bound.
const longRunDispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

export class ForgeClient {
  constructor(
    // 4126, as everywhere else in this repo; 4125 is another project's forge on the
    // machine this was ported on, and a stale default here would talk to it silently.
    private readonly baseUrl: string = process.env.FORGE_URL ?? 'http://127.0.0.1:4126',
    private readonly fetchImpl: FetchLike = undiciFetch,
  ) {}

  async health(): Promise<{ ok: boolean; version?: string }> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) return { ok: false };
      const body = (await res.json()) as { version?: string };
      return { ok: true, version: body.version };
    } catch {
      return { ok: false };
    }
  }

  /* ------------------------------------------------------------ settings */

  getSettings(): Promise<ForgeSettings> {
    return this.request('GET', '/settings', undefined, undefined, SETTINGS_TIMEOUT_MS) as Promise<ForgeSettings>;
  }

  setProvider(body: SetProviderBody): Promise<ForgeSettings> {
    return this.request('POST', '/settings/provider', body, undefined, SETTINGS_TIMEOUT_MS) as Promise<ForgeSettings>;
  }

  setModel(model: string): Promise<ForgeSettings> {
    return this.request('POST', '/settings/model', { model }, undefined, SETTINGS_TIMEOUT_MS) as Promise<ForgeSettings>;
  }

  setApiKey(apiKey: string): Promise<ForgeSettings> {
    return this.request(
      'POST',
      '/settings/api-key',
      { api_key: apiKey },
      undefined,
      SETTINGS_TIMEOUT_MS,
    ) as Promise<ForgeSettings>;
  }

  clearApiKey(): Promise<ForgeSettings> {
    return this.request('DELETE', '/settings/api-key', undefined, undefined, SETTINGS_TIMEOUT_MS) as Promise<ForgeSettings>;
  }

  /* -------------------------------------------------------------- builds */

  async draftRebuildSpec(body: DraftRebuildBody, signal?: AbortSignal): Promise<DraftRebuildResult> {
    return (await this.post('/draft-rebuild-spec', body, signal)) as DraftRebuildResult;
  }

  async generateRebuild(
    body: GenerateRebuildBody,
    signal?: AbortSignal,
  ): Promise<GenerateRebuildResult> {
    return (await this.post('/generate-rebuild', body, signal)) as GenerateRebuildResult;
  }

  /** Raw response for piping an artifact download through the server. */
  async artifactStream(artifactId: string): Promise<Awaited<ReturnType<FetchLike>>> {
    const res = await this.fetchImpl(`${this.baseUrl}/download/${artifactId}`, {
      dispatcher: longRunDispatcher,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new ForgeError(res.status, `forge download responded ${res.status}`);
    }
    return res;
  }

  private post(path: string, body: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown> {
    return this.request('POST', path, body, signal, timeoutMs);
  }

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    signal?: AbortSignal,
    /** Override the build budget for short interactive calls (settings, profiling)
     *  — a 30-min timeout is the right bound for a build, not for a config write. */
    timeoutMs?: number,
  ): Promise<unknown> {
    const budget = AbortSignal.timeout(timeoutMs ?? buildTimeoutMs());
    const combined = signal ? AbortSignal.any([signal, budget]) : budget;
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        dispatcher: longRunDispatcher,
        signal: combined,
      });
    } catch (err) {
      if (budget.aborted) {
        if (timeoutMs != null) {
          // Short interactive calls produce no artifact — say what actually timed out.
          throw new ForgeError(
            504,
            `forge did not answer ${path} within ${Math.round(timeoutMs / 1000)}s`,
          );
        }
        // Forge may still finish and persist the artifact server-side; the
        // message points operators at the forge gallery rather than lying
        // that nothing happened.
        throw new ForgeError(
          504,
          `forge build timed out after ${Math.round(buildTimeoutMs() / 60_000)} min — check forge artifacts before re-queueing`,
        );
      }
      throw err;
    }
    if (!res.ok) {
      let detail: unknown;
      let message = `forge responded ${res.status}`;
      try {
        detail = await res.json();
        const d = detail as { detail?: unknown; errors?: unknown };
        if (typeof d.detail === 'string') message = `forge: ${d.detail}`;
        // FastAPI request-validation 422s carry detail as a LIST of
        // {loc, msg, type} objects — render them instead of a bare status.
        else if (Array.isArray(d.detail)) {
          const parts = d.detail.slice(0, 3).map((e) => {
            const err = e as { loc?: unknown; msg?: unknown };
            const loc = Array.isArray(err.loc) ? err.loc.join('.') : '';
            return `${loc}: ${typeof err.msg === 'string' ? err.msg : JSON.stringify(e).slice(0, 120)}`;
          });
          message = `forge rejected the request (${res.status}): ${parts.join('; ')}`;
        }
        // Compile-validation failures carry the layer report — fold the failed
        // layers' first errors in, or "generation failed" says nothing.
        const report = (detail as { report?: unknown }).report;
        if (report && typeof report === 'object' && Array.isArray((report as { layers?: unknown }).layers)) {
          const failed = ((report as { layers: unknown[] }).layers as Array<Record<string, unknown>>)
            .filter((l) => l && l.passed === false)
            .slice(0, 3)
            .map((l) => {
              const errs = Array.isArray(l.errors)
                ? (l.errors as unknown[]).filter((e): e is string => typeof e === 'string')
                : [];
              return `${String(l.name ?? l.layer ?? 'layer')}: ${errs.slice(0, 2).join('; ').slice(0, 300)}`;
            });
          if (failed.length) message += ` — ${failed.join(' | ')}`;
        }
        // Authoring failures carry the per-attempt validator errors — the only
        // part that tells a user WHY. Fold the first few into the run error.
        if (Array.isArray(d.errors)) {
          const shown = d.errors
            .filter((e): e is string => typeof e === 'string')
            .slice(0, 3)
            .map((e) => (e.length > 300 ? `${e.slice(0, 300)}…` : e));
          if (shown.length) {
            const more = d.errors.length - shown.length;
            message += ` — ${shown.join('; ')}${more > 0 ? ` (+${more} more)` : ''}`;
          }
        }
      } catch {
        /* non-JSON error body; keep the status message */
      }
      throw new ForgeError(res.status, message, detail);
    }
    return res.json();
  }
}
