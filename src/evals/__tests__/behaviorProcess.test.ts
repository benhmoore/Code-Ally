import { spawn, ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { superviseBehaviorWorker } from '../behaviorProcess.js';
import { runTrial } from '../behaviorCampaign.js';
import { parseOptions, schedule } from '../behaviorCampaignSupport.js';

const fixture = fileURLToPath(new URL('../../../scripts/test-fixtures/behaviorHangingWorker.mjs', import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const child of children.splice(0))
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGKILL');
      await exited;
    }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function disposable(mode?: string) {
  const root = await mkdtemp(join(tmpdir(), 'owned-eval-process-'));
  roots.push(root);
  const config = join(root, 'config.json');
  await writeFile(config, JSON.stringify({ output: join(root, 'worker.json'), workspace: root }));
  const child = spawn(process.execPath, [fixture, config, ...(mode ? [mode] : [])], {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  return { child, root };
}
async function stopFixtureDescendant(root: string): Promise<void> {
  const pid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'));
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
const denied = () => {
  throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
};

describe('owned behavior worker termination', () => {
  it('falls back to the owned child handle after group denial and reports descendant uncertainty', async () => {
    const { child } = await disposable();
    const direct = vi.spyOn(child, 'kill');
    const group = vi.fn(denied);
    const started = Date.now();
    const result = await superviseBehaviorWorker(child, {
      timeoutMs: 100,
      signalGroup: group,
      cooperativeGraceMs: 50,
      terminationGraceMs: 500,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(group).toHaveBeenCalledExactlyOnceWith(child.pid);
    expect(direct).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(result).toMatchObject({
      timedOut: true,
      exitObserved: true,
      signal: 'SIGKILL',
      directSignalSent: true,
      cleanupConfirmed: false,
    });
    expect(result.timeoutTriggeredAfterMs).toBeGreaterThanOrEqual(100);
    expect(result.timeoutOvershootMs).toBeGreaterThanOrEqual(0);
    expect(result.errors.join(' ')).toContain('EPERM');
  });
  it('bounds the supervisor even if group and direct termination are both unavailable', async () => {
    const { child } = await disposable();
    vi.spyOn(child, 'kill').mockReturnValue(false);
    const started = Date.now();
    const result = await superviseBehaviorWorker(child, {
      timeoutMs: 50,
      signalGroup: denied,
      cooperativeGraceMs: 30,
      terminationGraceMs: 100,
    });
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result).toMatchObject({
      timedOut: true,
      exitObserved: false,
      directSignalSent: false,
      cleanupConfirmed: false,
    });
    expect(result.errors.join(' ')).toContain('may remain');
    // afterEach restores the real handle method and terminates this disposable process.
  });
  it('never signals a worker after its observed normal exit', async () => {
    const { child } = await disposable('finish');
    const group = vi.fn(denied);
    const direct = vi.spyOn(child, 'kill');
    const result = await superviseBehaviorWorker(child, { timeoutMs: 1000, signalGroup: group });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, cleanupConfirmed: true });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(group).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });
  it('records a natural zero exit after failed termination without treating cleanup as confirmed', async () => {
    const { child } = await disposable('finish-later');
    vi.spyOn(child, 'kill').mockReturnValue(false);
    const result = await superviseBehaviorWorker(child, {
      timeoutMs: 50,
      signalGroup: denied,
      terminationGraceMs: 1000,
    });
    expect(result).toMatchObject({
      timedOut: true,
      exitCode: 0,
      exitObserved: true,
      closeObserved: true,
      cleanupConfirmed: false,
    });
  });
  it('does not confirm cleanup from a close event without an observed exit', async () => {
    const child = new ChildProcess();
    Object.defineProperty(child, 'pid', { value: 123456 });
    const group = vi.fn(denied);
    const result = superviseBehaviorWorker(child, { timeoutMs: 1000, signalGroup: group });
    child.emit('close', 0, null);
    expect(await result).toMatchObject({ exitObserved: false, closeObserved: true, cleanupConfirmed: false });
    expect(group).not.toHaveBeenCalled();
  });
  it('recognizes an already exited owned handle and never signals its old PID', async () => {
    const { child } = await disposable('finish');
    await new Promise<void>(resolve => child.once('close', () => resolve()));
    const group = vi.fn(denied);
    const direct = vi.spyOn(child, 'kill');
    const result = await superviseBehaviorWorker(child, { timeoutMs: 50, signalGroup: group });
    expect(result).toMatchObject({ exitCode: 0, exitObserved: true, cleanupConfirmed: false });
    expect(group).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });
  it('bounds inherited-pipe waits and reports a surviving descendant without signalling an exited group leader', async () => {
    const { child, root } = await disposable('descendant');
    const group = vi.fn(denied);
    try {
      const result = await superviseBehaviorWorker(child, { timeoutMs: 1000, signalGroup: group, closeGraceMs: 100 });
      expect(result).toMatchObject({ exitCode: 0, exitObserved: true, closeObserved: false, cleanupConfirmed: false });
      expect(group).not.toHaveBeenCalled();
      expect(result.errors.join(' ')).toContain('descendant cleanup');
    } finally {
      await stopFixtureDescendant(root);
    }
  });
  it.each(['detached', 'detached-no-cleanup'])(
    'requires an actual cleanup ack for a detached stdio-ignore child: %s',
    async mode => {
      const { child, root } = await disposable(mode);
      let acknowledged = false;
      try {
        const result = await superviseBehaviorWorker(child, {
          timeoutMs: 250,
          cooperativeGraceMs: 150,
          terminationGraceMs: 500,
          signalGroup: denied,
        });
        acknowledged = result.cleanupAcknowledged;
        const pid = Number(await readFile(join(root, 'descendant.pid'), 'utf8'));
        expect(result.ownedProcesses).toEqual([{ id: 'detached-fixture', pid }]);
        expect(result.cleanupConfirmed).toBe(mode === 'detached');
        expect(result.cleanupAcknowledged).toBe(mode === 'detached');
        if (mode === 'detached') expect(() => process.kill(pid, 0)).toThrow();
        else expect(() => process.kill(pid, 0)).not.toThrow();
      } finally {
        // The fixture has already reaped acknowledged children; never signal those PIDs again.
        if (!acknowledged) {
          await stopFixtureDescendant(root);
        }
      }
    }
  );
  it.each([false, true])(
    'canonical worker exits and disconnects IPC after normal/cancelled cleanup (cancel=%s)',
    async cancelled => {
      const preload = fileURLToPath(new URL('../../../scripts/test-fixtures/behaviorProvider.mjs', import.meta.url));

      if (cancelled) vi.stubEnv('ALLY_BEHAVIOR_OFFLINE_HANG', '1');
      const options = parseOptions([
        '--model',
        'offline-scripted',
        '--endpoint',
        'http://offline.behavior.invalid',
        '--runs',
        '1',
        '--cases',
        'config-normalization',
        '--timeout-ms',
        cancelled ? '2000' : '10000',
      ]);
      const result = await runTrial(options, schedule(options)[0]!, { preloadPath: preload });
      if (result.retainedRoot) roots.push(result.retainedRoot);
      expect(result.error, JSON.stringify(result.termination) + result.log).toBeUndefined();
      expect(result.termination).toMatchObject({
        cleanupAcknowledged: true,
        cleanupConfirmed: true,
        exitObserved: true,
        closeObserved: true,
      });
      expect(result.timedOut).toBe(cancelled);
      expect(result.passed).toBe(!cancelled);
      expect(result.exitCode).toBe(cancelled ? 124 : 0);
      if (cancelled) expect(result.termination?.cooperativeStopSent).toBe(true);
    }
  );
  it('never promotes a partial passed artifact after timeout and preserves evidence after uncertain cleanup', async () => {
    const options = parseOptions([
      '--model',
      'offline-fixture',
      '--runs',
      '1',
      '--cases',
      'config-normalization',
      '--timeout-ms',
      '1000',
    ]);
    const trial = schedule(options)[0]!;
    const started = Date.now();
    const result = await runTrial(options, trial, {
      workerPath: fixture,
      signalGroup: denied,
      cooperativeGraceMs: 50,
      terminationGraceMs: 500,
    });
    if (result.retainedRoot) roots.push(result.retainedRoot);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(result.worker?.passed).toBe(true);
    expect(result).toMatchObject({ passed: false, timedOut: true, signal: 'SIGKILL' });
    expect(result.termination).toMatchObject({ exitObserved: true, directSignalSent: true, cleanupConfirmed: false });
    expect(result.retainedRoot).toBeTruthy();
    expect(result.error).toContain('cleanup unconfirmed');
  });
});
