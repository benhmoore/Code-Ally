/**
 * BackgroundTaskRegistry unit tests
 *
 * Verifies the unified view over agents + shells + watchers, watched-flag
 * tracking, waitFor (status-poll join with timeout), and watcher poll loops.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackgroundTaskRegistry, MissingBackgroundTasksError } from '../BackgroundTaskRegistry.js';
import { BashProcessManager, CircularBuffer } from '../BashProcessManager.js';

function fakeAgentManager(tasks: any[] = []) {
  return {
    listTasks: () => tasks,
    acknowledgeCompletedResults: vi.fn(),
    drainCompletedResults: vi.fn(() => tasks.filter((task) => task.status !== 'running' && !task.consumed)),
  } as any;
}
function fakeBashManager(processes: any[] = []) {
  return { listProcesses: () => processes, acknowledgeCompletedResults: vi.fn() } as any;
}
function fakeStream() {
  return { emit: vi.fn() } as any;
}

describe('BackgroundTaskRegistry', () => {
  it('delivers shell output before releasing its dependency retention', async () => {
    const manager = new BashProcessManager(1);
    const outputBuffer = new CircularBuffer();
    outputBuffer.append('verification passed');
    manager.addProcess({ id: 'verification', status: 'exited', exitCode: 0, exitSignal: null, startTime: 1, exitTime: 2, blocksCompletion: true, outputBuffer } as any);
    const registry = new BackgroundTaskRegistry(fakeAgentManager(), manager, fakeStream());
    expect(registry.get('verification')?.result).toBeNull();
    const results = await registry.waitFor(['verification'], { timeoutMs: 1000 });
    expect(results[0].result).toBe('verification passed');
    expect(registry.getResult('verification')?.result).toBe('verification passed');
    expect(() => manager.addProcess({ id: 'next', status: 'running' } as any)).toThrow();
    registry.acknowledgeResults(results);
    manager.addProcess({ id: 'next', status: 'running' } as any);
    expect(manager.getProcess('verification')).toBeUndefined();
  });
  it('acknowledges only settled shell results with their process owner', () => {
    const manager = fakeBashManager();
    const reg = new BackgroundTaskRegistry(fakeAgentManager(), manager, fakeStream());
    reg.acknowledgeResults([
      { id: 'done', kind: 'shell', status: 'done' },
      { id: 'running', kind: 'shell', status: 'running' },
    ] as any);
    expect(manager.acknowledgeCompletedResults).toHaveBeenCalledWith(['done']);
  });
  it('rejects partially missing dependencies instead of reporting the surviving task as complete', async () => {
    const reg = new BackgroundTaskRegistry(fakeAgentManager([
      { id: 'done', agentType: 'x', status: 'done', startTime: 1, endTime: 2, result: 'ok', error: null },
    ]), fakeBashManager(), fakeStream());
    await expect(reg.waitFor(['done', 'missing'], { timeoutMs: 1000 })).rejects.toMatchObject({ taskIds: ['missing'] });
  });

  it.each([false, true])('does not turn a disappearing dependency into success (all=%s)', async all => {
    const tasks = [{ id: 'pending', agentType: 'x', status: 'running', startTime: 1, endTime: null, result: null, error: null }];
    const reg = new BackgroundTaskRegistry(fakeAgentManager(tasks), fakeBashManager(), fakeStream());
    const controller = new AbortController();
    const waiting = reg.waitFor(all ? 'all' : ['pending'], { timeoutMs: 10000, signal: controller.signal });
    const checked = expect(waiting).rejects.toBeInstanceOf(MissingBackgroundTasksError);
    tasks.splice(0);
    controller.abort();
    await checked;
  });
  it('presents a unified view across agents and shells', () => {
    const agents = [{ id: 'agent-1', agentType: 'explore', status: 'running', startTime: 1, endTime: null, result: null, error: null }];
    const shells = [{ id: 'shell-1', command: 'npm run dev', status: 'running', exitCode: null, exitSignal: null, terminationSignal: null, blocksCompletion: false, startTime: 2, exitTime: null }];
    const reg = new BackgroundTaskRegistry(fakeAgentManager(agents), fakeBashManager(shells), fakeStream());

    const list = reg.list();
    expect(list).toHaveLength(2);
    expect(list.find((t) => t.id === 'agent-1')?.kind).toBe('agent');
    expect(list.find((t) => t.id === 'shell-1')?.kind).toBe('shell');
  });

  it('maps shell exit codes to status', () => {
    const reg = new BackgroundTaskRegistry(
      fakeAgentManager(),
      fakeBashManager([
        { id: 's-run', command: 'x', status: 'running', exitCode: null, exitSignal: null, terminationSignal: null, blocksCompletion: false, startTime: 1, exitTime: null },
        { id: 's-ok', command: 'y', status: 'exited', exitCode: 0, exitSignal: null, terminationSignal: null, blocksCompletion: false, startTime: 1, exitTime: 5 },
        { id: 's-fail', command: 'z', status: 'exited', exitCode: 1, exitSignal: null, terminationSignal: null, blocksCompletion: false, startTime: 1, exitTime: 5 },
        { id: 's-killed', command: 'q', status: 'exited', exitCode: null, exitSignal: 'SIGKILL', terminationSignal: 'SIGKILL', blocksCompletion: false, startTime: 1, exitTime: 5 },
      ]),
      fakeStream(),
    );
    const byId = Object.fromEntries(reg.list().map((t) => [t.id, t.status]));
    expect(byId['s-run']).toBe('running');
    expect(byId['s-ok']).toBe('done');
    expect(byId['s-fail']).toBe('error');
    expect(byId['s-killed']).toBe('cancelled');
  });

  it('tracks the watched set', () => {
    const reg = new BackgroundTaskRegistry(fakeAgentManager([{ id: 'a1', agentType: 'x', status: 'running', startTime: 1, endTime: null, result: null, error: null }]), fakeBashManager(), fakeStream());
    expect(reg.isWatched('a1')).toBe(false);
    reg.markWatched('a1');
    expect(reg.isWatched('a1')).toBe(true);
    expect(reg.get('a1')?.watched).toBe(true);
    reg.clearWatched('a1');
    expect(reg.isWatched('a1')).toBe(false);
  });

  it('waitFor returns immediately when targets are already settled', async () => {
    const reg = new BackgroundTaskRegistry(
      fakeAgentManager([{ id: 'a1', agentType: 'x', status: 'done', startTime: 1, endTime: 2, result: 'ok', error: null }]),
      fakeBashManager(),
      fakeStream(),
    );
    const out = await reg.waitFor(['a1'], { timeoutMs: 1000, pollMs: 10 });
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('done');
  });

  it('acknowledges settled agent results and clears their watched state', () => {
    const manager = fakeAgentManager();
    const reg = new BackgroundTaskRegistry(manager, fakeBashManager(), fakeStream());
    reg.markWatched('a1');

    reg.acknowledgeResults([{
      id: 'a1', kind: 'agent', label: 'audit', status: 'done', startTime: 1,
      endTime: 2, result: 'complete', error: null, watched: true, blocksCompletion: true,
    }]);

    expect(manager.acknowledgeCompletedResults).toHaveBeenCalledWith(['a1']);
    expect(reg.isWatched('a1')).toBe(false);
  });

  it('atomically clears watched state when completed agent results are drained', () => {
    const task = {
      id: 'a1', agentType: 'audit', mode: 'background', status: 'done',
      startTime: 1, endTime: 2, result: 'findings', error: null, consumed: false,
    };
    const manager = fakeAgentManager([task]);
    const reg = new BackgroundTaskRegistry(manager, fakeBashManager(), fakeStream());
    reg.markWatched('a1');

    expect(reg.drainCompletedAgentResults()).toEqual([task]);
    expect(reg.isWatched('a1')).toBe(false);
  });

  it('waitFor resolves when a running task settles', async () => {
    const agent = { id: 'a1', agentType: 'x', status: 'running', startTime: 1, endTime: null, result: null, error: null };
    const reg = new BackgroundTaskRegistry(fakeAgentManager([agent]), fakeBashManager(), fakeStream());
    setTimeout(() => { agent.status = 'done'; agent.result = 'finished'; agent.endTime = 9; }, 30);
    const out = await reg.waitFor(['a1'], { timeoutMs: 2000, pollMs: 10 });
    expect(out[0].status).toBe('done');
    expect(out[0].result).toBe('finished');
  });

  it('waitFor honors the timeout and returns partial state', async () => {
    const reg = new BackgroundTaskRegistry(
      fakeAgentManager([{ id: 'a1', agentType: 'x', status: 'running', startTime: 1, endTime: null, result: null, error: null }]),
      fakeBashManager(),
      fakeStream(),
    );
    const out = await reg.waitFor(['a1'], { timeoutMs: 40, pollMs: 10 });
    expect(out[0].status).toBe('running');
  });

  it('waitFor yields immediately when its caller is interrupted', async () => {
    const reg = new BackgroundTaskRegistry(
      fakeAgentManager([{ id: 'a1', agentType: 'x', status: 'running', startTime: 1, endTime: null, result: null, error: null }]),
      fakeBashManager(),
      fakeStream(),
    );
    const controller = new AbortController();
    const waiting = reg.waitFor(['a1'], {
      timeoutMs: 60_000,
      pollMs: 30_000,
      signal: controller.signal,
    });

    controller.abort();

    const out = await waiting;
    expect(out[0].status).toBe('running');
  });

  it('createWatcher resolves done when the predicate is satisfied and emits completion', async () => {
    const stream = fakeStream();
    const reg = new BackgroundTaskRegistry(fakeAgentManager(), fakeBashManager(), stream);
    let ready = false;
    setTimeout(() => { ready = true; }, 30);
    const task = reg.createWatcher({
      description: 'test condition',
      intervalMs: 10,
      timeoutMs: 1000,
      watched: true,
      check: async () => ready,
    });
    expect(task.kind).toBe('watcher');
    expect(task.status).toBe('running');

    const out = await reg.waitFor([task.id], { timeoutMs: 2000, pollMs: 10 });
    expect(out[0].status).toBe('done');
    expect(stream.emit).toHaveBeenCalled();
  });

  it('createWatcher times out to error', async () => {
    const reg = new BackgroundTaskRegistry(fakeAgentManager(), fakeBashManager(), fakeStream());
    const task = reg.createWatcher({
      description: 'never', intervalMs: 10, timeoutMs: 30, watched: false,
      check: async () => false,
    });
    const out = await reg.waitFor([task.id], { timeoutMs: 1000, pollMs: 10 });
    expect(out[0].status).toBe('error');
  });

  it('shutdown aborts a hung predicate and awaits watcher settlement', async () => {
    const reg = new BackgroundTaskRegistry(fakeAgentManager(), fakeBashManager(), fakeStream());
    const task = reg.createWatcher({
      description: 'hung', intervalMs: 10_000, timeoutMs: 60_000, watched: false,
      check: (signal) => new Promise<boolean>((resolve) => {
        signal.addEventListener('abort', () => resolve(false), { once: true });
      }),
    });
    await reg.shutdown();
    expect(reg.get(task.id)).toBeUndefined();
  });
});
