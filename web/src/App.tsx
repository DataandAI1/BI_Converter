import { useCallback, useEffect, useState } from 'react';
import {
  api,
  fileToBase64,
  type Artifact,
  type Health,
  type OllamaModel,
  type Provider,
  type Run,
  type SettingsResponse,
} from './api';

/**
 * Three screens (spec §8.2): Convert, Run, Artifacts.
 *
 * The one thing the UI must never do is make a conversion look cleaner than it is, so
 * needs-review state is as prominent as success, and the translation report shows every
 * calculation the converter could not carry across faithfully.
 */

type Screen = { name: 'convert' } | { name: 'run'; id: string } | { name: 'artifacts'; id: string };

const ACTIVE = new Set(['queued', 'extracting', 'authoring', 'compiling']);

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: 'convert' });
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // The one check every screen depends on. A server that cannot be reached is said so
  // at the top of the page, once, rather than discovered one failed click at a time.
  const refreshHealth = useCallback(() => {
    api
      .health()
      .then((h) => {
        setHealth(h);
        setHealthError(null);
      })
      .catch((err) => {
        setHealth(null);
        setHealthError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    refreshHealth();
  }, [refreshHealth]);

  return (
    <div className="app">
      <header className="top">
        <h1>
          BI_Converter <span>· Tableau to Databricks AI/BI</span>
        </h1>
        <nav>
          <button
            aria-current={screen.name === 'convert'}
            onClick={() => setScreen({ name: 'convert' })}
          >
            Convert
          </button>
          <button
            aria-current={screen.name === 'run'}
            onClick={() => setScreen({ name: 'run', id: '' })}
          >
            Runs
          </button>
          <button
            className="icon"
            aria-label="Settings"
            title="LLM provider settings"
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen(true)}
          >
            <GearIcon />
          </button>
        </nav>
      </header>

      {healthError && <div className="error">{healthError}</div>}

      {settingsOpen && (
        <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={refreshHealth} />
      )}

      {screen.name === 'convert' && (
        <ConvertScreen
          health={health}
          onOpenSettings={() => setSettingsOpen(true)}
          onStarted={(id) => setScreen({ name: 'run', id })}
        />
      )}
      {screen.name === 'run' && (
        <RunScreen
          id={screen.id}
          onOpen={(id) => setScreen({ name: 'run', id })}
          onArtifacts={(id) => setScreen({ name: 'artifacts', id })}
        />
      )}
      {screen.name === 'artifacts' && (
        <ArtifactsScreen id={screen.id} onBack={(id) => setScreen({ name: 'run', id })} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- convert */

function ConvertScreen({
  health,
  onOpenSettings,
  onStarted,
}: {
  health: Health | null;
  onOpenSettings: () => void;
  onStarted: (id: string) => void;
}) {
  const [sourceKind, setSourceKind] = useState<'file' | 'server'>('file');
  const [file, setFile] = useState<File | null>(null);
  const [live, setLive] = useState({ server: '', site: '', patName: '', patSecret: '', workbook: '' });
  const [lane, setLane] = useState<'llm' | 'deterministic'>('deterministic');
  const [mapping, setMapping] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const forgeDown = health != null && !health.forge.ok;
  // The forge is up but has no provider it can call: same outcome, different remedy.
  const llmUnconfigured = health != null && health.forge.ok && !health.llm.ready;
  const llmUnavailable = forgeDown || llmUnconfigured;
  // Never offer a lane that cannot run: a submit that fails on a server the user was told
  // nothing about is worse than a disabled control that says why.
  useEffect(() => {
    if (llmUnavailable && lane === 'llm') setLane('deterministic');
  }, [llmUnavailable, lane]);

  const ready =
    sourceKind === 'file' ? file != null : live.server.trim() !== '' && live.patName.trim() !== '';

  async function submit() {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const source =
        sourceKind === 'file'
          ? { fileName: file!.name, data: await fileToBase64(file!) }
          : {
              tableauServer: live.server.trim(),
              site: live.site.trim() || undefined,
              patName: live.patName.trim(),
              // Blank sends nothing, so the server falls back to its own environment
              // rather than the browser holding a token it does not need to.
              patSecret: live.patSecret.trim() || undefined,
              workbook: live.workbook.trim() || undefined,
            };
      const run = await api.convert({
        ...source,
        lane,
        mapping: mapping.trim() || undefined,
        instructions: instructions.trim() || undefined,
      });
      onStarted(run.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2>Convert a Tableau workbook</h2>
      <p className="hint">
        A workbook — uploaded, or pulled straight from a Tableau site — becomes a Lakeview
        dashboard per Tableau dashboard, the Unity Catalog views and metric views it reads
        from, and a checklist of what a human still has to decide.
      </p>

      {error && <div className="error">{error}</div>}
      {forgeDown && (
        <div className="notice">
          The forge is not running at <span className="mono">{health?.forge.url}</span>, so the
          AI-authored lane is unavailable. Start it with{' '}
          <span className="mono">npm run dev:forge</span>. The deterministic lane needs no forge
          and no API key.
        </div>
      )}
      {llmUnconfigured && (
        <div className="notice">
          The forge is running but has no LLM provider to call, so the AI-authored lane is
          unavailable.{' '}
          <button type="button" className="link" onClick={onOpenSettings}>
            Open Settings
          </button>{' '}
          to add an Anthropic API key or point it at an Ollama server.
        </div>
      )}

      <div className="field" role="radiogroup" aria-label="Source">
        <span className="field-label">Source</span>
        <div className="lanes">
          <button
            type="button"
            className="lane"
            role="radio"
            aria-checked={sourceKind === 'file'}
            onClick={() => setSourceKind('file')}
          >
            <strong>A workbook file</strong>
            <em>.twb, .twbx, .tds or .tdsx. No credentials, no network.</em>
          </button>
          <button
            type="button"
            className="lane"
            role="radio"
            aria-checked={sourceKind === 'server'}
            onClick={() => setSourceKind('server')}
          >
            <strong>Tableau Server or Cloud</strong>
            <em>Pull straight from a site with a personal access token.</em>
          </button>
        </div>
      </div>

      {sourceKind === 'file' ? (
        <label className="field">
          <span>Workbook file</span>
          <input
            type="file"
            accept=".twb,.twbx,.tds,.tdsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
      ) : (
        <>
          <label className="field">
            <span>Server URL</span>
            <input
              type="text"
              value={live.server}
              placeholder="https://10ax.online.tableau.com"
              onChange={(e) => setLive({ ...live, server: e.target.value })}
            />
          </label>
          <label className="field">
            <span>
              Site <span className="muted">(blank for the default site)</span>
            </span>
            <input
              type="text"
              value={live.site}
              onChange={(e) => setLive({ ...live, site: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Personal access token name</span>
            <input
              type="text"
              value={live.patName}
              onChange={(e) => setLive({ ...live, patName: e.target.value })}
            />
          </label>
          <label className="field">
            <span>
              Token secret{' '}
              <span className="muted">
                (blank uses the server's TABLEAU_PAT_SECRET — it is used for this request
                only and never stored)
              </span>
            </span>
            <input
              type="password"
              value={live.patSecret}
              onChange={(e) => setLive({ ...live, patSecret: e.target.value })}
            />
          </label>
          <label className="field">
            <span>
              Workbook <span className="muted">(blank converts every workbook the token can see)</span>
            </span>
            <input
              type="text"
              value={live.workbook}
              onChange={(e) => setLive({ ...live, workbook: e.target.value })}
            />
          </label>
        </>
      )}

      <div className="field" role="radiogroup" aria-label="Conversion lane">
        <span className="field-label">Lane</span>
        <div className="lanes">
          <button
            type="button"
            className="lane"
            role="radio"
            aria-checked={lane === 'deterministic'}
            aria-pressed={lane === 'deterministic'}
            onClick={() => setLane('deterministic')}
          >
            <strong>Deterministic</strong>
            <em>By rule. No forge, no API key. Byte-identical every run.</em>
          </button>
          <button
            type="button"
            className="lane"
            role="radio"
            aria-checked={lane === 'llm'}
            aria-pressed={lane === 'llm'}
            disabled={llmUnavailable}
            onClick={() => setLane('llm')}
          >
            <strong>AI-authored</strong>
            <em>
              {forgeDown
                ? 'Needs the forge running.'
                : llmUnconfigured
                  ? 'Needs an LLM provider — see Settings.'
                  : `Higher layout fidelity. Takes minutes; the deterministic pack is written first either way.${
                      health?.llm.model
                        ? ` Uses ${health.llm.model} via ${health.llm.provider === 'ollama' ? 'Ollama' : 'Anthropic'}.`
                        : ''
                    }`}
            </em>
          </button>
        </div>
      </div>

      <label className="field">
        <span>
          Source mapping <span className="muted">(optional YAML — Tableau names to Unity Catalog names)</span>
        </span>
        <textarea
          value={mapping}
          placeholder={'mappings:\n  - tableau:    { server: sf-prod, database: ANALYTICS, schema: PUBLIC, table: ORDERS }\n    databricks: { catalog: main, schema: sales, table: orders }'}
          onChange={(e) => setMapping(e.target.value)}
        />
      </label>

      {lane === 'llm' && (
        <label className="field">
          <span>
            Authoring notes <span className="muted">(optional)</span>
          </span>
          <input
            type="text"
            value={instructions}
            placeholder="e.g. keep every KPI on one row"
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>
      )}

      <button className="primary" disabled={!ready || busy} onClick={submit}>
        {busy ? 'Converting…' : 'Convert'}
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------------- run */

function RunScreen({
  id,
  onOpen,
  onArtifacts,
}: {
  id: string;
  onOpen: (id: string) => void;
  onArtifacts: (id: string) => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      if (id) setRun(await api.run(id));
      else setRuns((await api.runs()).runs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Authoring takes minutes, so an active run polls. A settled one stops — no reason to
  // keep asking a question that cannot change.
  useEffect(() => {
    if (!id || !run || !ACTIVE.has(run.status)) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [id, run, refresh]);

  if (error) return <div className="panel"><div className="error">{error}</div></div>;

  if (!id) {
    return (
      <div className="panel">
        <h2>Runs</h2>
        <p className="hint">Every conversion, from this browser or the command line.</p>
        {runs.length === 0 ? (
          <p className="muted">No runs yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Workbook</th>
                <th>Lane</th>
                <th>Status</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => onOpen(r.id)}>
                  <td>{r.workbookName}</td>
                  <td className="muted">{r.lane === 'llm' ? 'AI-authored' : 'deterministic'}</td>
                  <td>
                    <StatusBadge run={r} />
                  </td>
                  <td className="muted mono">{new Date(r.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  if (!run) return <div className="panel"><p className="muted">Loading…</p></div>;

  const reviewWarnings = run.warnings.filter((w) => !w.startsWith('info: '));
  const notes = run.warnings.filter((w) => w.startsWith('info: '));

  return (
    <>
      <div className="panel">
        <div className="row">
          <h2 style={{ marginRight: 'auto' }}>{run.workbookName}</h2>
          <StatusBadge run={run} />
          {ACTIVE.has(run.status) && (
            <button className="ghost" onClick={() => void api.cancel(run.id).then(refresh)}>
              Cancel
            </button>
          )}
          {run.artifacts > 0 && (
            <button className="ghost" onClick={() => onArtifacts(run.id)}>
              Artifacts ({run.artifacts})
            </button>
          )}
        </div>
        <p className="hint mono">{run.id}</p>
        {run.error && <div className="error">{run.error}</div>}
      </div>

      {run.translation.length > 0 && (
        <div className="panel">
          <h2>Calculations</h2>
          <p className="hint">
            What survived translation, and what did not. Anything below{' '}
            <strong>translated</strong> needs a person.
          </p>
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Status</th>
                <th>Databricks SQL, or why not</th>
              </tr>
            </thead>
            <tbody>
              {run.translation.map((t, i) => (
                <tr key={`${t.name}-${i}`}>
                  <td>{t.name}</td>
                  <td>
                    <span
                      className={`badge ${
                        t.status === 'translated' ? 'ok' : t.status === 'skipped' ? 'bad' : 'review'
                      }`}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td className="mono">{t.sql_expression || t.reason || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(reviewWarnings.length > 0 || notes.length > 0) && (
        <div className="panel">
          <h2>Warnings</h2>
          <p className="hint">
            {reviewWarnings.length} to act on
            {notes.length > 0 ? `, ${notes.length} informational` : ''}.
          </p>
          <ul className="warnings">
            {reviewWarnings.map((w, i) => (
              <li key={`w${i}`}>{w}</li>
            ))}
            {notes.map((w, i) => (
              <li className="info" key={`n${i}`}>
                {w.slice('info: '.length)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function StatusBadge({ run }: { run: Run }) {
  if (ACTIVE.has(run.status)) return <span className="badge busy">{run.status}</span>;
  if (run.status === 'failed') return <span className="badge bad">failed</span>;
  if (run.status === 'cancelled') return <span className="badge">cancelled</span>;
  // Needing review is not failure — but it is not silence either.
  return run.needsReview ? (
    <span className="badge review">needs review</span>
  ) : (
    <span className="badge ok">converted</span>
  );
}

/* ----------------------------------------------------------------- artifacts */

function ArtifactsScreen({ id, onBack }: { id: string; onBack: (id: string) => void }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selected, setSelected] = useState<Artifact | null>(null);
  const [content, setContent] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [deploy, setDeploy] = useState({ host: '', warehouseId: '', parentPath: '', publish: false });
  const [deploying, setDeploying] = useState(false);
  const [deployed, setDeployed] = useState<string | null>(null);

  useEffect(() => {
    api
      .artifacts(id)
      .then((r) => {
        setArtifacts(r.artifacts);
        setSelected(r.artifacts.find((a) => a.kind === 'checklist') ?? r.artifacts[0] ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [id]);

  useEffect(() => {
    if (!selected) return;
    // A slower earlier request must not land after a faster later one and show file A's
    // text under file B's highlighted row.
    let stale = false;
    fetch(api.artifactUrl(selected.id))
      .then((r) => r.text())
      .then((text) => {
        if (!stale) setContent(text);
      })
      .catch(() => {
        if (!stale) setContent('(could not read that file)');
      });
    return () => {
      stale = true;
    };
  }, [selected]);

  async function runDeploy() {
    setDeploying(true);
    setError(null);
    setDeployed(null);
    try {
      const res = await api.deploy(id, {
        host: deploy.host.trim() || undefined,
        warehouseId: deploy.warehouseId.trim(),
        parentPath: deploy.parentPath.trim() || undefined,
        publish: deploy.publish,
      });
      setDeployed(
        `${res.deployed.length} dashboard(s) to ${res.host}: ` +
          res.deployed.map((d) => `${d.displayName} (${d.action})`).join(', '),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeploying(false);
    }
  }

  return (
    <>
      <div className="panel">
        <div className="row">
          <h2 style={{ marginRight: 'auto' }}>Artifacts</h2>
          <a className="ghost" href={api.packUrl(id)} style={{ textDecoration: 'none', padding: '7px 14px' }}>
            Download pack
          </a>
          <button className="ghost" onClick={() => onBack(id)}>
            Back to run
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="split">
          <div>
            <table>
              <tbody>
                {artifacts.map((a) => (
                  <tr
                    key={a.id}
                    className="clickable"
                    onClick={() => setSelected(a)}
                    style={selected?.id === a.id ? { background: 'var(--accent-soft)' } : undefined}
                  >
                    <td className="mono" style={{ wordBreak: 'break-all' }}>
                      {a.path}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <pre className="viewer">{content}</pre>
        </div>
      </div>

      <div className="panel">
        <h2>Deploy to a workspace</h2>
        <p className="hint">
          Creates a draft dashboard per <span className="mono">.lvdash.json</span>, updating one
          that already exists rather than duplicating it. Credentials come from the server's
          environment — <span className="mono">DATABRICKS_TOKEN</span>, or the OAuth M2M pair —
          and are never written into a pack.
        </p>
        {deployed && <div className="notice">Deployed {deployed}</div>}
        <label className="field">
          <span>
            Workspace host <span className="muted">(blank uses DATABRICKS_HOST)</span>
          </span>
          <input
            type="text"
            value={deploy.host}
            placeholder="https://ws.cloud.databricks.com"
            onChange={(e) => setDeploy({ ...deploy, host: e.target.value })}
          />
        </label>
        <label className="field">
          <span>SQL warehouse id</span>
          <input
            type="text"
            value={deploy.warehouseId}
            onChange={(e) => setDeploy({ ...deploy, warehouseId: e.target.value })}
          />
        </label>
        <label className="field">
          <span>
            Parent path <span className="muted">(optional)</span>
          </span>
          <input
            type="text"
            value={deploy.parentPath}
            placeholder="/Workspace/Shared/Converted"
            onChange={(e) => setDeploy({ ...deploy, parentPath: e.target.value })}
          />
        </label>
        <label className="row" style={{ marginBottom: 16 }}>
          <input
            type="checkbox"
            checked={deploy.publish}
            onChange={(e) => setDeploy({ ...deploy, publish: e.target.checked })}
            style={{ width: 'auto' }}
          />
          <span>Publish after creating the draft</span>
        </label>
        <button className="primary" disabled={!deploy.warehouseId.trim() || deploying} onClick={runDeploy}>
          {deploying ? 'Deploying…' : 'Deploy'}
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ settings */

function GearIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/**
 * LLM provider settings: Anthropic (an API key and a model from the forge's catalog) or a
 * local Ollama server (a URL and a model it has pulled). The forge owns and persists the
 * configuration; this dialog is the way to it from the browser. A key typed here goes to
 * the forge once and is only ever shown back masked.
 */
function SettingsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [loaded, setLoaded] = useState<SettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState<Provider>('claude');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState(DEFAULT_OLLAMA_URL);
  const [ollamaModel, setOllamaModel] = useState('');
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([]);
  const [ollamaStatus, setOllamaStatus] = useState<
    { kind: 'idle' | 'loading' | 'ok' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .settings()
      .then((r) => {
        setLoaded(r);
        if (r.settings) {
          setProvider(r.settings.provider);
          setModel(r.settings.model);
          setOllamaBaseUrl(r.settings.ollama_base_url || DEFAULT_OLLAMA_URL);
          setOllamaModel(r.settings.ollama_model);
        }
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const loadOllamaModels = useCallback(async (baseUrl: string) => {
    setOllamaStatus({ kind: 'loading' });
    try {
      const r = await api.ollamaModels(baseUrl);
      setOllamaModels(r.models);
      setOllamaStatus({ kind: 'ok' });
      // Nothing chosen yet: the first pulled model is a better default than a blank.
      setOllamaModel((current) => current || r.models[0]?.name || '');
    } catch (err) {
      setOllamaModels([]);
      setOllamaStatus({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  // List what the Ollama server has as soon as it is the chosen provider. Edits to the
  // URL do not refetch on every keystroke — the Refresh button does that on purpose.
  const settings = loaded?.settings ?? null;
  useEffect(() => {
    if (settings && provider === 'ollama') {
      void loadOllamaModels(settings.ollama_base_url || DEFAULT_OLLAMA_URL);
    }
  }, [settings, provider, loadOllamaModels]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await api.saveSettings(
        provider === 'claude'
          ? { provider, apiKey: apiKey.trim() || undefined, model: model || undefined }
          : { provider, ollamaBaseUrl: ollamaBaseUrl.trim(), ollamaModel: ollamaModel || undefined },
      );
      setLoaded(res);
      setApiKey('');
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function clearKey() {
    setError(null);
    try {
      setLoaded(await api.clearApiKey());
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const keyConfigured = settings?.api_key_configured ?? false;
  const ollamaOptions = ollamaModels.map((m) => m.name);
  // The configured model may not be on the server the dialog just asked (a different
  // host, or not pulled yet). Keep it selectable rather than silently switching.
  const ollamaMissing = ollamaModel !== '' && !ollamaOptions.includes(ollamaModel);

  return (
    <div className="backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="row" style={{ marginBottom: 4 }}>
          <h2 id="settings-title" style={{ marginRight: 'auto' }}>
            LLM provider
          </h2>
          <button type="button" className="ghost" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="hint">
          The AI-authored lane sends each rebuild brief to this provider. The forge stores
          these settings next to its artifacts, so they survive restarts. A key is shown back
          masked, never in full.
        </p>

        {loadError && <div className="error">{loadError}</div>}
        {!loadError && !loaded && <p className="muted">Loading…</p>}
        {loaded && !loaded.forge.ok && (
          <div className="notice">
            The forge is not running at <span className="mono">{loaded.forge.url}</span>, so
            there is nothing to configure yet. Start it with{' '}
            <span className="mono">npm run dev:forge</span> and reopen Settings.
          </div>
        )}

        {settings && (
          <>
            <div className="field" role="radiogroup" aria-label="Provider">
              <span className="field-label">Provider</span>
              <div className="lanes">
                <button
                  type="button"
                  className="lane"
                  role="radio"
                  aria-checked={provider === 'claude'}
                  aria-pressed={provider === 'claude'}
                  onClick={() => setProvider('claude')}
                >
                  <strong>Anthropic</strong>
                  <em>Claude via the Anthropic API. Needs an API key.</em>
                </button>
                <button
                  type="button"
                  className="lane"
                  role="radio"
                  aria-checked={provider === 'ollama'}
                  aria-pressed={provider === 'ollama'}
                  onClick={() => setProvider('ollama')}
                >
                  <strong>Ollama</strong>
                  <em>A local model server. No key; nothing leaves the machine.</em>
                </button>
              </div>
            </div>

            {provider === 'claude' ? (
              <>
                <label className="field">
                  <span>
                    Anthropic API key{' '}
                    {keyConfigured ? (
                      <span className="muted">
                        (currently <span className="mono">{settings.api_key_masked}</span>
                        {settings.api_key_source === 'env' ? ', from the forge environment' : ''}
                        {' — leave blank to keep it)'}
                      </span>
                    ) : (
                      <span className="muted">(none configured)</span>
                    )}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    placeholder={keyConfigured ? 'leave blank to keep the current key' : 'sk-ant-…'}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </label>
                {settings.api_key_source === 'runtime' && (
                  <p className="hint">
                    <button type="button" className="link" onClick={() => void clearKey()}>
                      Clear the saved key
                    </button>
                  </p>
                )}
                <label className="field">
                  <span>Model</span>
                  <select value={model} onChange={(e) => setModel(e.target.value)}>
                    {settings.available_models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} — {m.description}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            ) : (
              <>
                <label className="field">
                  <span>Ollama server URL</span>
                  <div className="row">
                    <input
                      type="text"
                      value={ollamaBaseUrl}
                      placeholder={DEFAULT_OLLAMA_URL}
                      onChange={(e) => setOllamaBaseUrl(e.target.value)}
                    />
                    <button
                      type="button"
                      className="ghost"
                      disabled={ollamaStatus.kind === 'loading'}
                      onClick={() => void loadOllamaModels(ollamaBaseUrl.trim() || DEFAULT_OLLAMA_URL)}
                    >
                      {ollamaStatus.kind === 'loading' ? 'Checking…' : 'Refresh models'}
                    </button>
                  </div>
                </label>
                {ollamaStatus.kind === 'error' && <div className="notice">{ollamaStatus.message}</div>}
                <label className="field">
                  <span>
                    Model{' '}
                    <span className="muted">
                      {ollamaStatus.kind === 'ok'
                        ? ollamaModels.length === 0
                          ? '(that server has no models — run ollama pull <model>)'
                          : `(${ollamaModels.length} pulled on that server)`
                        : ''}
                    </span>
                  </span>
                  <select
                    value={ollamaModel}
                    disabled={ollamaOptions.length === 0 && !ollamaMissing}
                    onChange={(e) => setOllamaModel(e.target.value)}
                  >
                    {ollamaMissing && (
                      <option value={ollamaModel}>{ollamaModel} — not pulled on that server</option>
                    )}
                    {ollamaModels.map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                        {m.parameterSize ? ` — ${m.parameterSize}` : ''}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            {error && <div className="error">{error}</div>}
            <div className="row">
              <button type="button" className="primary" disabled={saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button type="button" className="ghost" onClick={onClose}>
                Cancel
              </button>
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>
                {settings.llm_ready
                  ? `Ready: ${settings.provider === 'ollama' ? settings.ollama_model : settings.model}`
                  : 'Not ready — Anthropic needs an API key'}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
