/** The server's HTTP surface, as the three screens see it. */

export type RunStatus =
  | 'queued'
  | 'extracting'
  | 'authoring'
  | 'compiling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface TranslationEntry {
  name: string;
  status: 'translated' | 'approximated' | 'needs_review' | 'skipped';
  original_formula?: string;
  sql_expression?: string;
  reason?: string;
}

export interface Run {
  id: string;
  createdAt: string;
  sourceKind: 'file' | 'tableau_server';
  workbookName: string;
  lane: 'llm' | 'deterministic';
  status: RunStatus;
  needsReview: boolean;
  warnings: string[];
  translation: TranslationEntry[];
  validation: unknown;
  llmUsage: unknown;
  error: string | null;
  artifacts: number;
}

export interface Artifact {
  id: string;
  path: string;
  kind: 'pack' | 'lvdash' | 'checklist' | 'semantic_layer';
  bytes: number;
}

export type Provider = 'claude' | 'ollama';

export interface Health {
  ok: boolean;
  forge: { ok: boolean; version?: string; url: string };
  /** Whether the forge has a provider that can author right now, and which. */
  llm: { ready: boolean; provider: Provider | null; model: string | null };
}

export interface ForgeModel {
  id: string;
  label: string;
  description: string;
  supports_effort: boolean;
}

/** The forge's provider configuration. Secrets come back masked, never in full. */
export interface Settings {
  provider: Provider;
  provider_source: 'runtime' | 'env' | null;
  ollama_base_url: string;
  ollama_model: string;
  ollama_num_ctx: number;
  llm_ready: boolean;
  api_key_configured: boolean;
  api_key_masked: string | null;
  api_key_source: 'runtime' | 'env' | null;
  model: string;
  model_source: 'runtime' | 'env' | null;
  available_models: ForgeModel[];
}

export interface SettingsResponse {
  forge: { ok: boolean; version?: string; url: string };
  /** null when the forge is not running — there is nothing to configure yet. */
  settings: Settings | null;
}

export interface OllamaModel {
  name: string;
  parameterSize: string | null;
  bytes: number;
}

/** The server that served this page did not answer at all. */
export class ServerUnreachableError extends Error {
  constructor() {
    super(
      `Cannot reach the BI_Converter server at ${window.location.origin} — it is not running, ` +
        'or it stopped after this page loaded. Start it with `npx bi-converter serve` ' +
        '(or `npm run serve -w server`) and reload.',
    );
    this.name = 'ServerUnreachableError';
  }
}

/**
 * fetch rejects — the browser's bare "Failed to fetch" — only when no HTTP response came
 * back at all. Every such case here means the same thing, so say it, rather than hand a
 * user five words that name nothing.
 */
async function request(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new ServerUnreachableError();
  }
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* not JSON — the body is the best message available */
    }
    throw new Error(message || `HTTP ${res.status}`);
  }
  return JSON.parse(text) as T;
}

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  health: () => request('/api/health').then(json<Health>),

  convert: (body: {
    fileName?: string;
    data?: string;
    tableauServer?: string;
    site?: string;
    patName?: string;
    patSecret?: string;
    workbook?: string;
    lane: 'llm' | 'deterministic';
    mapping?: string;
    instructions?: string;
  }) => request('/api/convert', jsonBody('POST', body)).then(json<Run>),

  runs: () => request('/api/runs').then(json<{ runs: Run[] }>),
  run: (id: string) => request(`/api/runs/${id}`).then(json<Run>),
  cancel: (id: string) =>
    request(`/api/runs/${id}/cancel`, { method: 'POST' }).then(json<{ outcome: string }>),
  artifacts: (id: string) =>
    request(`/api/runs/${id}/artifacts`).then(json<{ artifacts: Artifact[] }>),
  artifactUrl: (id: string) => `/api/artifacts/${id}`,
  packUrl: (runId: string) => `/api/runs/${runId}/pack.zip`,

  deploy: (
    id: string,
    body: { host?: string; warehouseId: string; parentPath?: string; publish?: boolean },
  ) =>
    request(`/api/runs/${id}/deploy`, jsonBody('POST', body)).then(
      json<{
        host: string;
        deployed: Array<{ displayName: string; dashboardId: string; action: string; published: boolean }>;
      }>,
    ),

  settings: () => request('/api/settings').then(json<SettingsResponse>),
  saveSettings: (body: {
    provider: Provider;
    /** Blank keeps the key the forge already has. */
    apiKey?: string;
    model?: string;
    ollamaBaseUrl?: string;
    ollamaModel?: string;
  }) => request('/api/settings', jsonBody('PUT', body)).then(json<SettingsResponse>),
  clearApiKey: () =>
    request('/api/settings/api-key', { method: 'DELETE' }).then(json<SettingsResponse>),
  ollamaModels: (baseUrl: string) =>
    request(`/api/settings/ollama-models?baseUrl=${encodeURIComponent(baseUrl)}`).then(
      json<{ models: OllamaModel[] }>,
    ),
};

/** Read a File as base64, without the data: prefix. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('could not read that file'));
    reader.readAsDataURL(file);
  });
}
