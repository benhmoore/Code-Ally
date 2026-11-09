/** Sequential, process-isolated behavioral campaign. Never unloads provider models. */
import { spawn, execFileSync } from 'node:child_process';
import { readdir, readFile, mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { arch, cpus, platform, release, totalmem, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicJson,
  identity,
  parseOptions,
  schedule,
  summarize,
  type CampaignOptions,
  type Trial,
  type TrialResult,
} from './behaviorCampaignSupport.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
async function sourceIdentity(): Promise<string> {
  const files: string[] = [];
  async function walk(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push(`${relative(repository, child)}\0${await readFile(child, 'utf8')}`);
    }
  }
  await walk(join(repository, 'src'));
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json'])
    files.push(`${name}\0${await readFile(join(repository, name), 'utf8')}`);
  return identity(files);
}
async function api(options: CampaignOptions, route: string, body?: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${options.endpoint}${route}`, {
    method: body ? 'POST' : 'GET',
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}
async function assertIdle(options: CampaignOptions): Promise<Record<string, unknown>> {
  const state = await api(options, '/api/ps');
  if (!Array.isArray(state.models)) throw new Error('Provider /api/ps omitted models');
  // A resident model cannot be distinguished from active user work: conservatively refuse foreign models.
  const foreign = state.models.filter(
    (model: { name?: string; model?: string }) =>
      ![options.model, `${options.model}:latest`].includes(model.name ?? model.model ?? '')
  );
  if (foreign.length)
    throw new Error(`Provider has other loaded models; leaving them untouched: ${JSON.stringify(foreign)}`);
  return state;
}
export async function runTrial(options: CampaignOptions, trial: Trial): Promise<TrialResult> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ally-behavior-')));
  const workspace = join(root, 'workspace');
  const output = join(root, 'worker.json');
  const started = Date.now();
  let log = '';
  let timedOut = false;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let error: string | undefined;
  let kill: (() => void) | undefined;
  try {
    await Promise.all([mkdir(workspace), mkdir(join(root, 'data'))]);
    const config = join(root, 'config.json');
    await atomicJson(config, {
      ...trial,
      model: options.model,
      endpoint: options.endpoint,
      contextSize: options.contextSize,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      reasoningEffort: options.reasoningEffort,
      output,
      workspace,
    });
    const child = spawn(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('./behaviorWorker.ts', import.meta.url)), config],
      {
        cwd: workspace,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ALLY_DATA_DIR: join(root, 'data'),
          TSX_TSCONFIG_PATH: join(repository, 'tsconfig.json'),
        },
      }
    );
    kill = () => {
      if (child.pid) {
        try {
          process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL');
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') error = String(failure);
        }
      }
    };
    const interrupt = () => {
      error = 'Campaign interrupted';
      kill?.();
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const append = (chunk: Buffer) => {
      log = (log + chunk.toString()).slice(-200000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      kill?.();
    }, options.timeoutMs);
    try {
      await new Promise<void>(resolve => {
        child.once('error', failure => {
          error = failure.message;
          resolve();
        });
        child.once('close', (code, exitSignal) => {
          exitCode = code;
          signal = exitSignal;
          resolve();
        });
      });
    } finally {
      clearTimeout(timer);
      kill();
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
    let worker: Record<string, unknown> | undefined;
    try {
      worker = JSON.parse(await readFile(output, 'utf8')) as Record<string, unknown>;
    } catch (failure) {
      error = `${error ?? ''} Worker artifact unavailable: ${String(failure)}`.trim();
    }
    return {
      ...trial,
      passed: !error && !timedOut && exitCode === 0 && signal === null && worker?.passed === true,
      elapsedMs: Date.now() - started,
      exitCode,
      signal,
      timedOut,
      log,
      worker,
      ...(error ? { error } : {}),
    };
  } finally {
    kill?.();
    await rm(root, { recursive: true, force: true });
  }
}
interface Checkpoint {
  schemaVersion: number;
  identity: string;
  metadata: Record<string, unknown>;
  results: TrialResult[];
  summary: ReturnType<typeof summarize>;
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(
      'Usage: npm run eval:behavior -- --model NAME [--endpoint URL] [--runs 3] [--cases IDS] [--variants baseline,outcome,exact-edit] [--context-size 32768] [--max-tokens 4096] [--temperature 0] [--reasoning-effort low] [--timeout-ms 240000] [--output PATH] [--resume]\nDefault endpoint: http://100.68.102.73:11434; default variant: baseline. Runs are sequential.\n'
    );
    return;
  }
  const options = parseOptions(args);
  const [sourceHash, version, show, tags] = await Promise.all([
    sourceIdentity(),
    api(options, '/api/version'),
    api(options, '/api/show', { model: options.model }),
    api(options, '/api/tags'),
  ]);
  if (!Array.isArray(tags.models)) throw new Error('Provider /api/tags omitted models');
  const model = tags.models.find((entry: { name?: string; model?: string }) =>
    [options.model, `${options.model}:latest`].includes(entry.name ?? entry.model ?? '')
  ) as { digest?: string } | undefined;
  if (!model?.digest) throw new Error('Cannot establish requested model digest');
  const git = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
  const { resume: _resume, output: _output, ...settings } = options;
  const metadata = {
    options: settings,
    sourceHash,
    git,
    version,
    modelDigest: model.digest,
    model: show,
    environment: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      memoryBytes: totalmem(),
    },
  };
  const fingerprint = identity(metadata);
  let results: TrialResult[] = [];
  if (options.resume) {
    const previous = JSON.parse(await readFile(options.output, 'utf8')) as Checkpoint;
    if (previous.schemaVersion !== 1 || previous.identity !== fingerprint || !Array.isArray(previous.results))
      throw new Error('Resume rejected: options, source, git or model metadata changed');
    if (
      previous.results.some(
        row =>
          !row ||
          typeof row.passed !== 'boolean' ||
          !Number.isFinite(row.elapsedMs) ||
          !Number.isSafeInteger(row.repetition) ||
          !['baseline', 'outcome', 'exact-edit'].includes(row.variant) ||
          typeof row.timedOut !== 'boolean' ||
          (row.passed && (row.exitCode !== 0 || row.signal !== null || row.timedOut || row.worker?.passed !== true))
      )
    )
      throw new Error('Resume rejected: malformed trial results');
    results = previous.results;
  }
  const trials = schedule(options);
  for (let index = 0; index < results.length; index++) {
    const trial = trials[index];
    if (
      !trial ||
      identity(trial) !==
        identity({
          caseId: results[index]!.caseId,
          variant: results[index]!.variant,
          repetition: results[index]!.repetition,
          seed: results[index]!.seed,
        })
    )
      throw new Error('Resume rejected: invalid trial order');
  }
  const checkpoint = () =>
    atomicJson(options.output, {
      schemaVersion: 1,
      identity: fingerprint,
      metadata,
      results,
      summary: summarize(results, options.cases, options.variants),
    } satisfies Checkpoint);
  await checkpoint();
  for (const trial of trials.slice(results.length)) {
    await assertIdle(options);
    process.stdout.write(`${trial.caseId} ${trial.variant} repetition ${trial.repetition + 1}\n`);
    const result = await runTrial(options, trial);
    results.push(result);
    await checkpoint();
    process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'} (${result.elapsedMs}ms)\n`);
    if (result.error === 'Campaign interrupted') {
      process.exitCode = 130;
      break;
    }
  }
  if (results.some(result => !result.passed) && !process.exitCode) process.exitCode = 1;
  process.stdout.write(`Saved ${results.length} trials to ${options.output}\n`);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
