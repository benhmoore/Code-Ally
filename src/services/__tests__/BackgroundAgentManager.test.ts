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
    acceptingMessages: true,
    status: 'running',
    result: null,
    error: null,
    finalizationError: null,
    startTime: 1_000,
    endTime: null,
    consumed: false,
    promise: Promise.resolve(),
    subAgent: fakeAgent(),
    pooledAgent: null,
    callId: `call-${id}`,
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

  it('acknowledges results delivered by an explicit join', () => {
    manager.addTask(makeTask('t1', { status: 'done', endTime: Date.now(), result: 'done output' }));
    manager.addTask(makeTask('t2', { status: 'done', endTime: Date.now(), result: 'other output' }));

    manager.acknowledgeCompletedResults(['t1']);

    expect(manager.drainCompletedResults().map((task) => task.id)).toEqual(['t2']);
    expect(manager.getStatusReminders().some((line) => line.includes('t1'))).toBe(false);
  });

  it('produces running and recently-completed status reminders', () => {
    manager.addTask(makeTask('t1'));
    manager.addTask(makeTask('t2', { status: 'done', endTime: Date.now() }));
    const reminders = manager.getStatusReminders();
    expect(reminders.some((r) => r.includes('[running]'))).toBe(true);
    expect(reminders.some((r) => r.includes('[done]'))).toBe(true);
  });

  it('cancel signals the sub-agent but leaves it running until unwind completes', () => {
    const t = makeTask('t1');
    manager.addTask(t);
    expect(manager.cancelTask('t1')).toBe(true);
    expect(t.subAgent.interrupt).toHaveBeenCalledWith({ kind: 'user_cancel' });
    // The detached run owns the terminal state transition. Keeping the task
    // running prevents it from being drained or evicted while cleanup is active.
    expect(t.status).toBe('running');
    expect(manager.drainCompletedResults()).toHaveLength(0);
    // Cancellation only signals; the detached run owns pooled-agent release.
    expect(t.pooledAgent).toBeNull();
  });

  it('cancel returns false for unknown ids', () => {
    expect(manager.cancelTask('nope')).toBe(false);
  });

  it('creates asynchronous tasks with a message admission barrier', () => {
    const task = manager.createTask({ agentType: 'explore', taskPrompt: 'x', description: 'Map handlers', subAgent: fakeAgent(), pooledAgent: null, callId: 'c1' });
    expect(task.description).toBe('Map handlers');
    expect(task.acceptingMessages).toBe(true);
    expect(task).not.toHaveProperty('mode');
    expect(task).not.toHaveProperty('detach');
  });

  it('delivers only the requesting owner results and acknowledges each once', () => {
    manager.addTask(makeTask('root-task', { ownerId: 'root', status: 'done' }));
    manager.addTask(makeTask('child-task', { ownerId: 'child', status: 'done' }));
    expect(manager.drainCompletedResults('root').map(task => task.id)).toEqual(['root-task']);
    expect(manager.getTask('child-task')?.consumed).toBe(false);
    expect(manager.drainCompletedResults('child').map(task => task.id)).toEqual(['child-task']);
    expect(manager.drainCompletedResults('root')).toEqual([]);
  });

  it('scopes model reminders to the owning parent without leaking sibling tasks', () => {
    manager.addTask(makeTask('root-child', { ownerId: 'root' }));
    manager.addTask(makeTask('nested-child', { ownerId: 'child' }));
    expect(manager.getStatusReminders('root').join(' ')).toContain('root-child');
    expect(manager.getStatusReminders('root').join(' ')).not.toContain('nested-child');
    expect(manager.getStatusReminders('child').join(' ')).not.toContain('root-child');
    expect(manager.getStatusReminders()).toHaveLength(2);
  });

  it('shutdown interrupts running agents and clears tracking', async () => {
    const t1 = makeTask('t1');
    const t2 = makeTask('t2', { status: 'done', endTime: 2_000 });
    manager.addTask(t1);
    manager.addTask(t2);
    await manager.shutdown();
    expect(t1.subAgent.interrupt).toHaveBeenCalledWith({ kind: 'user_cancel' });
    expect(manager.getCount()).toBe(0);
  });
});
