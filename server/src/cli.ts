#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseTableauFile } from './tableau/files.js';
import { mapTableauDocs } from './tableau/mapper.js';
import { sniffBiFileKind } from './tableau/uploads.js';
import { ingestStagingBatches } from './ingest/adapter.js';
import { parseMappingFile, type SourceMapping } from './bind/resolve.js';
import { convertToLakeviewPack, zipPack } from './convert/convert.js';

/**
 * `bi-converter` (spec §8.1). Three commands: convert a workbook into a pack, deploy a
 * pack to a workspace, and serve the web UI.
 *
 * `convert --no-llm` is the whole deterministic lane: no API key, no running forge, no
 * database, no network. That is deliberate — it is both the fallback when the forge is
 * down and the golden-file baseline the LLM lane is diffed against.
 */

const USAGE = `bi-converter — Tableau to Databricks AI/BI

  bi-converter convert <file.twb|.twbx|.tds|.tdsx> --out <dir> [options]
  bi-converter convert --tableau-server <url> --site <site> --workbook <name> [options]
  bi-converter deploy <pack-dir> --host <url> --warehouse-id <id> [options]
  bi-converter serve [--port 4123]

convert options
  --out <dir>          write the pack here (default: ./pack)
  --zip                also write <out>.zip
  --no-llm             deterministic lane only; no forge, no API key
  --mapping <file>     YAML mapping of Tableau references to Unity Catalog names
  --name <name>        pack name (default: the source filename)

deploy options
  --host <url>         workspace URL, or DATABRICKS_HOST
  --warehouse-id <id>  SQL warehouse backing the dashboards' datasets
  --parent-path <p>    workspace folder for the dashboards
  --publish            publish each dashboard after creating its draft

Auth for deploy comes from the environment: DATABRICKS_TOKEN, or the OAuth M2M pair
DATABRICKS_CLIENT_ID / DATABRICKS_CLIENT_SECRET. No credential is ever written into a pack.
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

async function cmdConvert(args: Args): Promise<number> {
  const source = args.positional[0];
  if (str(args.flags, 'tableau-server')) {
    // Phase 7. Failing loudly beats half-doing it: a silent fall-through to file mode
    // would look like a conversion that found nothing.
    throw new UsageError(
      'live Tableau Server extraction is not wired up yet — convert a downloaded ' +
        '.twb/.twbx/.tds/.tdsx file instead',
    );
  }
  if (!source) throw new UsageError('convert needs a Tableau file, or --tableau-server');
  if (args.flags.get('no-llm') !== true) {
    throw new UsageError(
      'the LLM lane is not wired up yet — pass --no-llm to run the deterministic lane',
    );
  }

  const outDir = str(args.flags, 'out') ?? 'pack';
  const mapping = await loadMapping(str(args.flags, 'mapping'));
  const data = await fs.readFile(source);
  const base = path.basename(source);
  const name = str(args.flags, 'name') ?? base.replace(/\.[^.]+$/, '');

  const kind = sniffBiFileKind(base, data);
  if (kind === 'unknown') {
    throw new UsageError(`'${source}' is not a Tableau workbook or datasource file`);
  }

  const docs = parseTableauFile(base, data);
  const ingest = ingestStagingBatches(mapTableauDocs(docs, 'file'), { systemName: name });
  const result = convertToLakeviewPack(ingest, { sourceName: name, mapping });

  await writePack(outDir, result.files);
  if (args.flags.get('zip') === true) {
    await fs.writeFile(`${outDir}.zip`, zipPack(result.files));
  }

  const { counts } = result.manifest;
  process.stdout.write(
    `Converted ${name}: ${counts.total} objects (${counts.ready} ready, ` +
      `${counts.needs_review} need review, ${counts.skipped} skipped), ` +
      `${result.files.size} files -> ${outDir}\n`,
  );
  for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
  // Needing review is the honest outcome, not a failure — the checklist is a deliverable.
  return 0;
}

async function writePack(outDir: string, files: ReadonlyMap<string, string>): Promise<void> {
  for (const [rel, content] of files) {
    const target = path.join(outDir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
}

/* -------------------------------------------------------------------- deploy */

async function cmdDeploy(_args: Args): Promise<number> {
  throw new UsageError(
    'deploy is not wired up yet — run the pack\'s own deploy_dashboards.py in the meantime',
  );
}

async function cmdServe(_args: Args): Promise<number> {
  throw new UsageError('serve is not wired up yet');
}

/* ---------------------------------------------------------------------- main */

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  try {
    switch (args.command) {
      case 'convert':
        return await cmdConvert(args);
      case 'deploy':
        return await cmdDeploy(args);
      case 'serve':
        return await cmdServe(args);
      case 'help':
      case undefined:
        process.stdout.write(USAGE);
        return args.command === undefined ? 1 : 0;
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
