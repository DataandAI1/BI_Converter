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

export interface Health {
  ok: boolean;
  forge: { ok: boolean; version?: string; url: string };
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

export const api = {
  health: () => fetch('/api/health').then(json<Health>),

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
  }) =>
    fetch('/api/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<Run>),

  runs: () => fetch('/api/runs').then(json<{ runs: Run[] }>),
  run: (id: string) => fetch(`/api/runs/${id}`).then(json<Run>),
  cancel: (id: string) =>
    fetch(`/api/runs/${id}/cancel`, { method: 'POST' }).then(json<{ outcome: string }>),
  artifacts: (id: string) =>
    fetch(`/api/runs/${id}/artifacts`).then(json<{ artifacts: Artifact[] }>),
  artifactUrl: (id: string) => `/api/artifacts/${id}`,
  packUrl: (runId: string) => `/api/runs/${runId}/pack.zip`,

  deploy: (
    id: string,
    body: { host?: string; warehouseId: string; parentPath?: string; publish?: boolean },
  ) =>
    fetch(`/api/runs/${id}/deploy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(
      json<{
        host: string;
        deployed: Array<{ displayName: string; dashboardId: string; action: string; published: boolean }>;
      }>,
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
