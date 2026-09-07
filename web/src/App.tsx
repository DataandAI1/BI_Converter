import { useCallback, useEffect, useState } from 'react';
import { api, fileToBase64, type Artifact, type Health, type Run } from './api';

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

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

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
        </nav>
      </header>

      {screen.name === 'convert' && (
        <ConvertScreen health={health} onStarted={(id) => setScreen({ name: 'run', id })} />
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
  onStarted,
}: {
  health: Health | null;
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
  // Never offer a lane that cannot run: a submit that fails on a server the user was told
  // nothing about is worse than a disabled control that says why.
  useEffect(() => {
    if (forgeDown && lane === 'llm') setLane('deterministic');
  }, [forgeDown, lane]);

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
            disabled={forgeDown}
            onClick={() => setLane('llm')}
          >
            <strong>AI-authored</strong>
            <em>
              {forgeDown
                ? 'Needs the forge running.'
                : 'Higher layout fidelity. Takes minutes; the deterministic pack is written first either way.'}
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
    fetch(api.artifactUrl(selected.id))
      .then((r) => r.text())
      .then(setContent)
      .catch(() => setContent('(could not read that file)'));
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
