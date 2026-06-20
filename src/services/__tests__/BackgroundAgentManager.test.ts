/**
 * BackgroundAgentManager unit tests
 *
 * Verifies registration, the concurrency cap, drain-once result delivery,
 * status reminders, cancellation (signal-only), and shutdown.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BackgroundAgentManager, BackgroundAgentTask } from '../BackgroundAgentManager.js';
import type { Agent } from '../../agent/Agent.js';

/** Minimal fake sub-agent: only the bits the manager touches. */
function fakeAgent(tokens = 0) {
  return {
    interrupt: vi.fn(),
    getTokenManager: () => ({ getCurrentTokenCount: () => tokens }),
  } as unknown as Agent;
}

function makeTask(id: string, overrides: Partial<BackgroundAgentTask> = {}): BackgroundAgentTask {
  return {
    id,
    agentType: 'explore',
    taskPrompt: 'map the repo',
    mode: 'background',
    status: 'running',
    result: null,
    error: null,
    startTime: 1_000,
    endTime: null,
    consumed: false,
    promise: Promise.resolve(),
    subAgent: fakeAgent(),
    pooledAgent: null,
    callId: `call-${id}`,
    detachPromise: Promise.resolve(),
    detach: () => {},
    ...overrides,
  };
}

describe('BackgroundAgentManager', () => {
  let manager: BackgroundAgentManager;

  beforeEach(() => {
    manager = new BackgroundAgentManager(3); // small cap for testing
  });

  it('generates unique ids with the agent- prefix', () => {
    const a = manager.generateId();
    const b = manager.generateId();
    expect(a).toMatch(/^agent-\d+-[a-z0-9]+$/);
    expect(a).not.toBe(b);
  });

  it('adds, gets, and lists tasks', () => {
    const t = makeTask('t1');
    manager.addTask(t);
    expect(manager.getTask('t1')).toBe(t);
    expect(manager.listTasks()).toHaveLength(1);
    expect(manager.getRunningCount()).toBe(1);
  });

  it('throws when the running cap is reached', () => {
    manager.addTask(makeTask('t1'));
    manager.addTask(makeTask('t2'));
    manager.addTask(makeTask('t3'));
    expect(() => manager.addTask(makeTask('t4'))).toThrow(/limit reached/i);
  });

  it('allows a new task once a slot frees up (completed task evicted)', () => {
    manager.addTask(makeTask('t1', { status: 'done', endTime: 2_000 }));
    manager.addTask(makeTask('t2'));
    manager.addTask(makeTask('t3'));
    // 2 running + 1 done; running cap is 3, so this is allowed.
    expect(() => manager.addTask(makeTask('t4'))).not.toThrow();
  });

  it('drains completed results exactly once', () => {
    manager.addTask(makeTask('t1', { status: 'done', endTime: 2_000, result: 'done output' }));
    manager.addTask(makeTask('t2')); // still running — not drained

    const first = manager.drainCompletedResults();
    expect(first.map((t) => t.id)).toEqual(['t1']);

    // Second drain returns nothing (already consumed).
    expect(manager.drainCompletedResults()).toHaveLength(0);
  });

  it('produces running and recently-completed status reminders', () => {
    manager.addTask(makeTask('t1'));
    manager.addTask(makeTask('t2', { status: 'done', endTime: Date.now() }));
    const reminders = manager.getStatusReminders();
    expect(reminders.some((r) => r.includes('[running]'))).toBe(true);
    expect(reminders.some((r) => r.includes('[done]'))).toBe(true);
  });

  it('cancel signals the sub-agent and marks it cancelled (no release)', () => {
    const t = makeTask('t1');
    manager.addTask(t);
    expect(manager.cancelTask('t1')).toBe(true);
    expect(t.subAgent.interrupt).toHaveBeenCalledWith('cancel');
    expect(t.status).toBe('cancelled');
    // Cancellation only signals; the detached run owns pooled-agent release.
    expect(t.pooledAgent).toBeNull();
  });

  it('cancel returns false for unknown ids', () => {
    expect(manager.cancelTask('nope')).toBe(false);
  });

  it('createTask wires a detach that flips foreground → background', () => {
    const task = manager.createTask({
      agentType: 'explore', taskPrompt: 'x', mode: 'foreground',
      subAgent: fakeAgent(), pooledAgent: null, callId: 'c1',
    });
    expect(task.mode).toBe('foreground');
    task.detach();
    expect(task.mode).toBe('background');
  });

  it('foreground runs do not count against the background cap', () => {
    manager.addTask(makeTask('f1', { mode: 'foreground' }));
    manager.addTask(makeTask('f2', { mode: 'foreground' }));
    manager.addTask(makeTask('f3', { mode: 'foreground' }));
    manager.addTask(makeTask('f4', { mode: 'foreground' }));
    // 4 foreground + 1 background still allowed (cap is on background only).
    expect(() => manager.addTask(makeTask('b1', { mode: 'background' }))).not.toThrow();
    expect(manager.getBackgroundRunningCount()).toBe(1);
  });

  it('requestDetachAll backgrounds running foreground runs only', () => {
    const fg = manager.createTask({ agentType: 'explore', taskPrompt: 'x', mode: 'foreground', subAgent: fakeAgent(), pooledAgent: null, callId: 'c1' });
    manager.addTask(fg);
    manager.addTask(makeTask('b1', { mode: 'background' }));
    const n = manager.requestDetachAll();
    expect(n).toBe(1);
    expect(fg.mode).toBe('background');
  });

  it('does not drain foreground results (only background)', () => {
    manager.addTask(makeTask('f1', { mode: 'foreground', status: 'done', endTime: 2_000, result: 'fg' }));
    expect(manager.drainCompletedResults()).toHaveLength(0);
  });

  it('shutdown interrupts running agents and clears tracking', async () => {
    const t1 = makeTask('t1');
    const t2 = makeTask('t2', { status: 'done', endTime: 2_000 });
    manager.addTask(t1);
    manager.addTask(t2);
    await manager.shutdown();
    expect(t1.subAgent.interrupt).toHaveBeenCalledWith('cancel');
    expect(manager.getCount()).toBe(0);
  });
});
