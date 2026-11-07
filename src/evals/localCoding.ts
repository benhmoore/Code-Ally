/** Launch a real local-model coding turn in a disposable, isolated process. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodingFixture, verifyCodingFixture } from './localCodingFixture.js';

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    process.stdout.write('Usage: npm run eval:coding -- --model NAME [--endpoint URL] [--output PATH] [--timeout-ms 240000] [--context-size 32768] [--max-tokens 2048]\n');
    return;
  }
  const values = new Map<string, string>();
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith('--') || !args[index + 1]) throw new Error(`Invalid option ${args[index]}`);
    values.set(args[index]!, args[index + 1]!);
  }
  const model = values.get('--model');
  if (!model) throw new Error('Pass --model NAME');
  const endpoint = values.get('--endpoint') ?? 'http://localhost:11434';
  const output = resolve(values.get('--output') ?? 'model-eval-results/local-coding.json');
  const timeoutMs = Number(values.get('--timeout-ms') ?? 240_000);
  const contextSize = Number(values.get('--context-size') ?? 32_768);
  const maxTokens = Number(values.get('--max-tokens') ?? 2_048);
  if (![timeoutMs, contextSize, maxTokens].every(value => Number.isInteger(value) && value > 0)) throw new Error('Timeout and token limits must be positive integers');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ally-coding-')));
  const workspace = join(root, 'workspace');
  const data = join(root, 'data');
  const workerOutput = join(root, 'worker.json');
  const started = Date.now();
  try {
    await Promise.all([mkdir(workspace), mkdir(data)]);
    await createCodingFixture(workspace);
    const worker = fileURLToPath(new URL('./localCodingRunner.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), worker, model, endpoint, workerOutput, String(contextSize), String(maxTokens)], {
      cwd: workspace,
      env: {
        ...process.env,
        ALLY_DATA_DIR: data,
        ALLY_CODING_WORKSPACE: workspace,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
      },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    const append = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-200_000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    let timedOut = false;
    const kill = () => {
      if (!child.pid) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const exitCode = await new Promise<number | null>((accept, reject) => {
      child.once('error', reject);
      child.once('close', code => accept(code));
    }).finally(() => { clearTimeout(timer); kill(); });
    let workerResult: Record<string, unknown> = {};
    try { workerResult = JSON.parse(await readFile(workerOutput, 'utf8')) as Record<string, unknown>; }
    catch { /* A killed or failed worker has no final transcript. */ }
    const verification = await verifyCodingFixture(workspace);
    const score = Number(verification.sourceChanged) + Number(verification.testsUnchanged)
      + Number(verification.independentTestsPassed) + Number(workerResult.successfulTestRun === true);
    const result = {
      suite: { id: 'code-ally-local-coding', version: 1 },
      model, endpoint, contextSize, maxTokens, timeoutMs,
      elapsedMs: Date.now() - started,
      exitCode, timedOut, score, maxScore: 4,
      passed: exitCode === 0 && !timedOut && score === 4,
      verification, worker: workerResult, log,
    };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`Coding smoke: ${score}/4; passed=${result.passed}; result=${output}\n`);
    if (!result.passed) process.exitCode = 1;
  } finally { await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
