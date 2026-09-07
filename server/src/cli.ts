#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseMappingFile, type SourceMapping } from './bind/resolve.js';
import {
  assembleBriefs,
  convertDeterministic,
  parseLiveSource,
  parseSource,
} from './convert/pipeline.js';
import { zipPack } from './convert/convert.js';
import { ForgeClient } from './forge/client.js';
import { Runner, runNeedsReview } from './forge/runner.js';
import { RunStore, type ArtifactKind } from './store/store.js';
import { authFromEnv, LakeviewClient } from './deploy/lakeview-client.js';
import { deployPack } from './deploy/deploy.js';
import { buildServer } from './api/app.js';

/**
 * `bi-converter` (spec §8.1). Three commands: convert a workbook into a pack, deploy a
 * pack to a workspace, and serve the web UI.
 *
 * `--no-llm` selects the deterministic lane: no API key, no running forge, no database,
 * no network. That is deliberate — it is both the fallback when the forge is down and the
 * golden-file baseline the LLM lane is diffed against.
 */

const USAGE = `bi-converter — Tableau to Databricks AI/BI

  bi-converter convert <file.twb|.twbx|.tds|.tdsx> [options]
  bi-converter convert --tableau-server <url> [--site <site>] [--workbook <name>] [options]
  bi-converter deploy <pack-dir> --host <url> --warehouse-id <id> [options]
  bi-converter runs [--limit 20]
  bi-converter serve [--port 4123]

convert options
  --out <dir>          write the pack here (default: ./pack)
  --no-llm             force the deterministic lane; no forge, no API key
  --llm                force the AI-authored lane; fails if the forge is down
                       (with neither, the lane follows what is available)
  --mapping <file>     YAML mapping of Tableau references to Unity Catalog names
  --name <name>        pack name (default: the source filename)
  --zip                also write <out>.zip
  --forge <url>        forge base URL (default: $FORGE_URL or http://127.0.0.1:4126)
  --instructions <s>   extra authoring guidance for the LLM lane

live extraction (--tableau-server)
  --site <site>        site content URL; omit for the default site
  --workbook <name>    convert one workbook; omit to convert every one visible
  --pat-name <name>    token name, or $TABLEAU_PAT_NAME
  --screenshots        capture rendered dashboards as authoring context
  The token SECRET is read from $TABLEAU_PAT_SECRET only — never from an argument,
  which would land in shell history and in every process listing on the machine.

deploy options
  --host <url>         workspace URL, or DATABRICKS_HOST
  --warehouse-id <id>  SQL warehouse backing the dashboards' datasets
  --parent-path <p>    workspace folder for the dashboards
  --publish            publish each dashboard after creating its draft
  --run <id>           deploy the pack a previous run produced, instead of a directory

Auth for deploy comes from the environment: DATABRICKS_TOKEN, or the OAuth M2M pair
DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET. No credential is ever written into a pack.

State lives in $BI_CONVERTER_HOME (default: ~/.bi-converter).
`;

interface Args {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      flags.set(name, next);
      i += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { command: positional[0], positional: positional.slice(1), flags };
}

function str(flags: Args['flags'], name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

class UsageError extends Error {}

function stateDir(): string {
  return process.env.BI_CONVERTER_HOME ?? path.join(os.homedir(), '.bi-converter');
}

function forgeUrl(args: Args): string {
  return str(args.flags, 'forge') ?? process.env.FORGE_URL ?? 'http://127.0.0.1:4126';
}

/* ------------------------------------------------------------------- convert */

async function loadMapping(file: string | undefined): Promise<SourceMapping | undefined> {
  if (!file) return undefined;
  const text = await fs.readFile(file, 'utf8');
  try {
    return parseMappingFile(text);
  } catch (err) {
    throw new UsageError(`--mapping ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function writePack(outDir: string, files: ReadonlyMap<string, string>): Promise<void> {
  for (const [rel, content] of files) {
    const target = path.join(outDir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
}

/** What kind of artifact a pack file is, for the store's artifact rows. */
function artifactKind(rel: string): ArtifactKind {
  if (rel.endsWith('.lvdash.json')) return 'lvdash';
  if (rel.endsWith('rebuild_checklist.md')) return 'checklist';
  if (rel.includes('/views/') || rel.includes('/metric_views/') || rel.startsWith('semantic_layer/')) {
    return 'semantic_layer';
  }
  return 'pack';
}

async function cmdConvert(args: Args): Promise<number> {
  const serverUrl = str(args.flags, 'tableau-server');
  const source = args.positional[0];
  if (!serverUrl && !source) {
    throw new UsageError('convert needs a Tableau file, or --tableau-server');
  }

  const outDir = str(args.flags, 'out') ?? 'pack';
  const mapping = await loadMapping(str(args.flags, 'mapping'));
  // Lane selection (spec §8.1 + success criterion 1). `--no-llm` forces the deterministic
  // lane and `--llm` forces the AI-authored one; with neither, the lane follows what is
  // actually available. That is what makes the bare `convert` command work with no
  // credentials and no network — and the run always says which lane produced the pack, so
  // the convenience never costs the user knowing what they got.
  const forcedDeterministic = args.flags.get('no-llm') === true;
  const forcedLlm = args.flags.get('llm') === true;
  if (forcedDeterministic && forcedLlm) {
    throw new UsageError('--llm and --no-llm contradict each other');
  }

  let parsed;
  let name: string;
  let sourceKind: 'file' | 'tableau_server';
  try {
    if (serverUrl) {
      // The PAT secret comes from the environment, never the command line — an argument
      // lands in shell history and in every process listing on the machine.
      const patName = str(args.flags, 'pat-name') ?? process.env.TABLEAU_PAT_NAME;
      const patSecret = process.env.TABLEAU_PAT_SECRET;
      if (!patName || !patSecret) {
        throw new UsageError(
          'live extraction needs a personal access token: set TABLEAU_PAT_NAME and ' +
            'TABLEAU_PAT_SECRET (the secret is read from the environment only, never from ' +
            'an argument)',
        );
      }
      parsed = await parseLiveSource({
        serverUrl,
        site: str(args.flags, 'site'),
        patName,
        patSecret,
        workbook: str(args.flags, 'workbook'),
        screenshots: args.flags.get('screenshots') === true,
        replayFixture: str(args.flags, 'replay-fixture'),
      });
      name = str(args.flags, 'name') ?? parsed.name;
      sourceKind = 'tableau_server';
    } else {
      const data = await fs.readFile(source);
      name = str(args.flags, 'name') ?? path.basename(source).replace(/\.[^.]+$/, '');
      parsed = parseSource(source, data, name);
      sourceKind = 'file';
    }
  } catch (err) {
    if (err instanceof UsageError) throw err;
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  let deterministic = forcedDeterministic;
  let fellBack = false;
  if (!forcedDeterministic) {
    const reachable = (await new ForgeClient(forgeUrl(args)).health()).ok;
    if (!reachable) {
      if (forcedLlm) {
        throw new UsageError(
          `--llm needs the forge, and it is not reachable at ${forgeUrl(args)} — start it ` +
            'with `npm run dev:forge`, or drop --llm to convert deterministically',
        );
      }
      deterministic = true;
      fellBack = true;
    }
  }

  const store = new RunStore(stateDir());
  try {
    const run = store.createRun({
      sourceKind,
      workbookName: name,
      lane: deterministic ? 'deterministic' : 'llm',
    });

    if (deterministic) {
      store.updateRun(run.id, { status: 'compiling' });
      const result = convertDeterministic(parsed, { mapping });
      await writePack(outDir, result.files);
      for (const [rel, content] of result.files) {
        store.addArtifact(
          run.id,
          path.join(outDir, rel),
          artifactKind(rel),
          Buffer.byteLength(content, 'utf8'),
        );
      }
      if (args.flags.get('zip') === true) await fs.writeFile(`${outDir}.zip`, zipPack(result.files));
      store.updateRun(run.id, { status: 'succeeded', warnings: result.warnings });

      const { counts } = result.manifest;
      if (fellBack) {
        process.stdout.write(
          `The forge is not running at ${forgeUrl(args)}, so this ran the deterministic ` +
            `lane. Pass --no-llm to make that explicit, or start the forge for AI-authored ` +
            `layout.
`,
        );
      }
      process.stdout.write(
        `Converted ${name} (run ${run.id}): ${counts.total} objects ` +
          `(${counts.ready} ready, ${counts.needs_review} need review, ${counts.skipped} skipped), ` +
          `${result.files.size} files -> ${outDir}\n`,
      );
      for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
      // Needing review is the honest outcome, not a failure — the checklist is a deliverable.
      return 0;
    }

    // ---- LLM lane. The deterministic pack is written FIRST and always: it costs nothing,
    // it is the diff baseline for what the model returns, and it means a forge that never
    // answers still leaves the user with a working conversion rather than an empty
    // directory.
    const baseline = convertDeterministic(parsed, { mapping });
    await writePack(outDir, baseline.files);

    const { briefs, warnings } = assembleBriefs(parsed, { mapping });
    if (briefs.length === 0) {
      throw new UsageError(`no Tableau report container found in '${source}'`);
    }
    store.updateRun(run.id, { warnings });

    const forge = new ForgeClient(forgeUrl(args));
    const health = await forge.health();
    if (!health.ok) {
      process.stderr.write(
        `error: the forge is not reachable at ${forgeUrl(args)} — start it with ` +
          `\`npm run dev:forge\`, or re-run with --no-llm.\n` +
          `The deterministic pack was written to ${outDir} regardless.\n`,
      );
      store.updateRun(run.id, { status: 'failed', error: 'forge unreachable' });
      return 3;
    }

    const runner = new Runner({ store, forge });
    // One brief per container; the first is the workbook the run is named for.
    runner.enqueue({
      runId: run.id,
      brief: briefs[0].brief,
      instructions: str(args.flags, 'instructions'),
    });
    await runner.settled();

    const finished = store.getRun(run.id)!;
    if (finished.status !== 'succeeded') {
      process.stderr.write(`error: run ${run.id} ${finished.status}: ${finished.error ?? ''}\n`);
      process.stderr.write(`The deterministic pack is still in ${outDir}.\n`);
      return 1;
    }

    // The authored dashboard replaces the deterministic one; everything else in the pack —
    // the semantic layer, the checklist, the deploy artifacts — is deterministic either way.
    const artifactDir = path.join(outDir, 'authored');
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(
      path.join(artifactDir, 'spec.json'),
      `${JSON.stringify(JSON.parse(finished.spec ?? 'null'), null, 2)}\n`,
      'utf8',
    );
    if (finished.translation) {
      await fs.writeFile(
        path.join(artifactDir, 'translation.json'),
        `${JSON.stringify(JSON.parse(finished.translation), null, 2)}\n`,
        'utf8',
      );
    }

    process.stdout.write(
      `Converted ${name} through the LLM lane (run ${run.id}) -> ${outDir}\n` +
        `Authored spec and translation report in ${artifactDir}; ` +
        `deterministic baseline alongside it.\n`,
    );
    if (runNeedsReview(finished)) {
      process.stdout.write('This run needs review — see the checklist and the warnings below.\n');
    }
    for (const w of JSON.parse(finished.warnings ?? '[]') as string[]) {
      process.stderr.write(`warning: ${w}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

/* ---------------------------------------------------------------------- runs */

function cmdRuns(args: Args): number {
  const store = new RunStore(stateDir());
  try {
    const limit = Number(str(args.flags, 'limit') ?? 20);
    const rows = store.listRuns(Number.isFinite(limit) ? limit : 20);
    if (rows.length === 0) {
      process.stdout.write('No runs yet.\n');
      return 0;
    }
    for (const r of rows) {
      const review = runNeedsReview(r) ? ' needs-review' : '';
      process.stdout.write(
        `${r.id}  ${r.created_at}  ${r.lane.padEnd(13)} ${r.status.padEnd(10)} ` +
          `${r.workbook_name}${review}\n`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

/* -------------------------------------------------------------------- deploy */

async function cmdDeploy(args: Args): Promise<number> {
  const warehouseId = str(args.flags, 'warehouse-id');
  if (!warehouseId) throw new UsageError('deploy needs --warehouse-id');

  // A pack directory, or the pack a previous run produced.
  let packRoot = args.positional[0];
  const runId = str(args.flags, 'run');
  if (runId) {
    const store = new RunStore(stateDir());
    try {
      const run = store.getRun(runId);
      if (!run) throw new UsageError(`no run '${runId}' — list them with \`bi-converter runs\``);
      const artifacts = store.listArtifacts(runId);
      if (artifacts.length === 0) throw new UsageError(`run '${runId}' produced no artifacts`);
      // Every artifact path is inside the pack; the shallowest common directory is it.
      packRoot = artifacts
        .map((a) => path.dirname(a.path))
        .reduce((a, b) => (a.split(path.sep).length <= b.split(path.sep).length ? a : b));
    } finally {
      store.close();
    }
  }
  if (!packRoot) throw new UsageError('deploy needs a pack directory, or --run <id>');

  let auth;
  try {
    auth = authFromEnv({ host: str(args.flags, 'host') });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  const deployed = await deployPack(new LakeviewClient(auth), packRoot, {
    warehouseId,
    parentPath: str(args.flags, 'parent-path'),
    publish: args.flags.get('publish') === true,
    onProgress: (line) => process.stdout.write(`${line}
`),
  });

  const created = deployed.filter((d) => d.action === 'created').length;
  process.stdout.write(
    `Deployed ${deployed.length} dashboard(s) to ${auth.host}: ` +
      `${created} created, ${deployed.length - created} updated` +
      `${deployed.some((d) => d.published) ? ', all published' : ''}.
`,
  );
  return 0;
}

async function cmdServe(args: Args): Promise<number> {
  const port = Number(str(args.flags, 'port') ?? 4123);
  if (!Number.isFinite(port)) throw new UsageError('--port must be a number');

  const store = new RunStore(stateDir());
  const app = buildServer({ store, forgeUrl: forgeUrl(args) });
  await app.listen({ port, host: '127.0.0.1' });
  process.stdout.write(
    `bi-converter listening on http://127.0.0.1:${port}
` +
      `State: ${stateDir()}
Forge: ${forgeUrl(args)}
`,
  );
  // Serve until interrupted; the store closes with the process.
  await new Promise<void>((resolve) => {
    const stop = () => {
      void app.close().then(() => {
        store.close();
        resolve();
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

/* ---------------------------------------------------------------------- main */

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    switch (args.command) {
      case 'convert':
        return await cmdConvert(args);
      case 'runs':
        return cmdRuns(args);
      case 'deploy':
        return await cmdDeploy(args);
      case 'serve':
        return await cmdServe(args);
      case 'help':
        process.stdout.write(USAGE);
        return 0;
      case undefined:
        process.stdout.write(USAGE);
        return 1;
      default:
        process.stderr.write(`unknown command '${args.command}'\n\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// Only run when invoked as a program, so the tests can import `main` directly.
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
