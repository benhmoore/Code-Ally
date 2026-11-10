import { resolveBehaviorFactors, type CampaignVariant } from '../behaviorFactors.js';
import { spawn } from 'node:child_process';
import { superviseBehaviorWorker } from '../behaviorProcess.js';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const worker = fileURLToPath(new URL('../behaviorWorker.ts', import.meta.url));
const preload = fileURLToPath(new URL('../../../scripts/test-fixtures/behaviorProvider.mjs', import.meta.url));
const tsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url));
describe('offline production behavior worker integration', () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });
  async function run(
    caseId: string,
    variant: CampaignVariant = 'outcome',
    variants: CampaignVariant[] = ['baseline', variant].filter(
      (value, index, array) => array.indexOf(value) === index
    ) as CampaignVariant[]
  ) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ally-worker-integration-')));
    roots.push(root);
    const workspace = join(root, 'workspace');
    const data = join(root, 'data');
    await Promise.all([mkdir(workspace), mkdir(data)]);
    const output = join(root, 'result.json');
    const config = join(root, 'worker.json');
    await writeFile(
      config,
      JSON.stringify({
        caseId,
        variant,
        ...resolveBehaviorFactors(variants)[variant],
        model: 'offline-scripted',
        endpoint: 'http://offline.behavior.invalid',
        contextSize: 32768,
        maxTokens: 2048,
        temperature: 0,
        reasoningEffort: 'low',
        seed: 17,
        workspace,
        output,
      })
    );
    const child = spawn(
      process.execPath,
      ['--import', preload, '--import', import.meta.resolve('tsx'), worker, config],
      {
        cwd: workspace,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, ALLY_DATA_DIR: data, TSX_TSCONFIG_PATH: tsconfig },
      }
    );
    let log = '';
    child.stdout?.on('data', chunk => {
      log = (log + chunk.toString()).slice(-200000);
    });
    child.stderr?.on('data', chunk => {
      log = (log + chunk.toString()).slice(-200000);
    });
    const completion = await superviseBehaviorWorker(child, { timeoutMs: 45000 });
    expect(completion.errors, log).toEqual([]);
    expect(completion).toMatchObject({
      exitCode: 0,
      cleanupAcknowledged: true,
      cleanupConfirmed: true,
      timedOut: false,
    });
    return JSON.parse(await readFile(output, 'utf8'));
  }
  function verifyWire(result: any) {
    expect(result.error).toBeUndefined();
    expect(result.passed, JSON.stringify(result.verification)).toBe(true);
    const taskRequests = result.requests.filter((request: any) => request.owner === 'main');
    expect(taskRequests.length).toBeGreaterThan(0);
    for (const request of taskRequests) expect(request.variantApplied).toBe(result.promptVariant === 'outcome');
    for (const request of result.requests) {
      expect(request.httpStatus).toBe(200);
      expect(request.payload.options.num_predict).toBeGreaterThan(0);
      expect(request.payload.options.num_predict).toBeLessThanOrEqual(2048);
    }
  }
  it('executes real read, patch, and test tools and enforces the configured wire output cap', async () => {
    const result = await run('config-normalization');
    verifyWire(result);
    const successes = result.toolEvents.filter((event: any) => event.data?.result?.success);
    for (const tool of ['read', 'apply-patch', 'bash'])
      expect(successes.some((event: any) => event.data.toolName === tool)).toBe(true);
  }, 50000);
  it('runs the explicit exact candidate interface through the worker permission and mutation flow', async () => {
    const result = await run('config-normalization', 'exact-edit');
    verifyWire(result);
    const edits = result.toolEvents.filter(
      (event: any) => event.data?.toolName === 'apply-patch' && event.data?.result?.success
    );
    expect(edits).toHaveLength(2);
    for (const event of edits) {
      expect(event.data.arguments).toHaveProperty('old_text');
      expect(event.data.arguments).toHaveProperty('new_text');
      expect(event.data.arguments).not.toHaveProperty('patch');
    }
    for (const request of result.requests.filter((item: any) => item.owner === 'main')) {
      const schema = request.payload.tools.find((item: any) => item.function.name === 'apply-patch').function
        .parameters;
      expect(schema.required).toEqual(['file_path', 'old_text', 'new_text']);
    }
  }, 50000);
  it('uses unified production for both single and paired baselines', async () => {
    const production = await run('config-normalization', 'baseline', ['baseline']);
    const historical = await run('config-normalization', 'baseline', ['baseline', 'exact-edit']);
    verifyWire(production);
    verifyWire(historical);
    expect(production.editSurface).toBe('unified');
    expect(historical.editSurface).toBe('unified');
    expect(production.promptVariant).toBe('baseline');
    expect(historical.promptVariant).toBe('baseline');
    for (const result of [production, historical]) {
      const schema = result.requests[0].payload.tools.find((tool: any) => tool.function.name === 'apply-patch').function
        .parameters;
      expect(schema.required).toEqual(
        result.editSurface === 'exact' ? ['file_path', 'old_text', 'new_text'] : ['file_path', 'patch']
      );
    }
  }, 50000);
  it('persists and restores a real checkpoint before continuing with refreshed file state', async () => {
    const result = await run('checkpoint-continuation');
    verifyWire(result);
    for (const name of [
      'checkpoint-committed',
      'original-direction-archived',
      'checkpoint-restored-from-disk',
      'original-directions-and-current-facts',
    ]) {
      expect(result.verification.assertions.find((assertion: any) => assertion.name === name)?.passed, name).toBe(true);
    }
    expect(result.checkpoint.id).toBeTruthy();
    expect(result.requests.some((request: any) => request.owner === 'compaction')).toBe(true);
    expect(
      result.toolEvents.some((event: any) => event.data?.toolName === 'write' && event.data?.result?.success)
    ).toBe(true);
  }, 50000);
  it('runs an actual child agent and joins its result before synthesizing output', async () => {
    const result = await run('delegated-synthesis');
    verifyWire(result);
    expect(result.fleet).toHaveLength(1);
    expect(result.fleet[0].status).toBe('done');
    expect(result.fleet[0].messages.length).toBeGreaterThan(0);
    expect(result.requests.some((request: any) => request.owner === 'delegate')).toBe(true);
    expect(
      result.toolEvents.some(
        (event: any) => event.owner === 'delegate' && event.data?.toolName === 'read' && event.data?.result?.success
      )
    ).toBe(true);
    expect(
      result.verification.assertions.find((assertion: any) => assertion.name === 'parent-respected-work-division')
        ?.passed
    ).toBe(true);
  }, 50000);
});
