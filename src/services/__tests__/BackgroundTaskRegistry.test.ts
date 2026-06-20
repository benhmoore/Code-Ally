/**
 * BackgroundTaskRegistry unit tests
 *
 * Verifies the unified view over agents + shells + watchers, watched-flag
 * tracking, waitFor (status-poll join with timeout), and watcher poll loops.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackgroundTaskRegistry } from '../BackgroundTaskRegistry.js';

function fakeAgentManager(tasks: any[] = []) {
  return { listTasks: () => tasks } as any;
}
function fakeBashManager(processes: any[] = []) {
  return { listProcesses: () => processes } as any;
}
function fakeStream() {
  return { emit: vi.fn() } as any;
}

describe('BackgroundTaskRegistry', () => {
  it('presents a unified view across agents and shells', () => {
    const agents = [{ id: 'agent-1', agentType: 'explore', status: 'running', startTime: 1, endTime: null, result: null, error: null }];
    const shells = [{ id: 'shell-1', command: 'npm run dev', exitCode: null, startTime: 2, exitTime: null }];
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
        { id: 's-run', command: 'x', exitCode: null, startTime: 1, exitTime: null },
        { id: 's-ok', command: 'y', exitCode: 0, startTime: 1, exitTime: 5 },
        { id: 's-fail', command: 'z', exitCode: 1, startTime: 1, exitTime: 5 },
      ]),
      fakeStream(),
    );
    const byId = Object.fromEntries(reg.list().map((t) => [t.id, t.status]));
    expect(byId['s-run']).toBe('running');
    expect(byId['s-ok']).toBe('done');
    expect(byId['s-fail']).toBe('error');
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
});
