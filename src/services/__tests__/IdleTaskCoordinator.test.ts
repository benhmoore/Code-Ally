import { describe, expect, it, vi } from 'vitest';
import { IdleTaskCoordinator } from '../IdleTaskCoordinator.js';
import type { IdleMessageGenerator } from '../IdleMessageGenerator.js';
import type { SessionManager } from '../SessionManager.js';
import type { SessionTitleGenerator } from '../SessionTitleGenerator.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function idleGenerator() {
  return { isActive: false, getQueueSize: () => 0, cancel: vi.fn(), generateMessageBackground: vi.fn() };
}

describe('IdleTaskCoordinator admission ownership', () => {
  it('uses the live replacement and stops using disabled idle generators', async () => {
    const first = idleGenerator();
    const second = idleGenerator();
    const coordinator = new IdleTaskCoordinator(null, first as unknown as IdleMessageGenerator, null, {} as SessionManager);
    coordinator.setIdleMessageGenerator(second as unknown as IdleMessageGenerator);
    await coordinator.checkAndRunIdleTasks([]);
    expect(first.cancel).toHaveBeenCalledOnce();
    expect(first.generateMessageBackground).not.toHaveBeenCalled();
    expect(second.generateMessageBackground).toHaveBeenCalledOnce();
    coordinator.setIdleMessageGenerator(null);
    await coordinator.checkAndRunIdleTasks([]);
    expect(second.generateMessageBackground).toHaveBeenCalledOnce();
    await coordinator.cleanup();
  });

  it('invalidates an idle admission suspended in session I/O when foreground starts', async () => {
    const read = deferred<null>();
    const title = { isActive: false, cancel: vi.fn(), regenerateTitleBackground: vi.fn() };
    const idle = idleGenerator();
    const session = { getCurrentSession: () => 'test', loadSession: () => read.promise };
    const coordinator = new IdleTaskCoordinator(title as unknown as SessionTitleGenerator, idle as unknown as IdleMessageGenerator, null, session as unknown as SessionManager);
    coordinator.notifyUserMessage();
    const pending = coordinator.checkAndRunIdleTasks([]);
    coordinator.cancel();
    coordinator.setOllamaActive(true);
    read.resolve(null);
    await pending;
    expect(title.regenerateTitleBackground).not.toHaveBeenCalled();
    expect(idle.generateMessageBackground).not.toHaveBeenCalled();
    await coordinator.cleanup();
  });

  it('retains and reports title preparation failures through the owning promise', async () => {
    const title = { isActive: false, cancel: vi.fn(), regenerateTitleBackground: vi.fn() };
    const failure = new Error('Unreadable session manifest');
    const session = { getCurrentSession: () => 'test', loadSession: vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(failure) };
    const coordinator = new IdleTaskCoordinator(title as unknown as SessionTitleGenerator, null, null, session as unknown as SessionManager);
    coordinator.notifyUserMessage();
    await expect(coordinator.checkAndRunIdleTasks([{ role: 'user', content: 'Build' }, { role: 'assistant', content: 'Done' }])).rejects.toBe(failure);
    expect(title.regenerateTitleBackground).not.toHaveBeenCalled();
    await coordinator.cleanup();
  });

  it('shutdown waits for suspended admission and prevents all later work', async () => {
    const read = deferred<null>();
    const title = { isActive: false, cancel: vi.fn(), regenerateTitleBackground: vi.fn() };
    const coordinator = new IdleTaskCoordinator(title as unknown as SessionTitleGenerator, null, null,
      { getCurrentSession: () => 'test', loadSession: () => read.promise } as unknown as SessionManager);
    const admission = coordinator.checkAndRunIdleTasks([]);
    let settled = false;
    const closing = coordinator.cleanup().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    read.resolve(null);
    await Promise.all([admission, closing]);
    await coordinator.checkAndRunIdleTasks([]);
    expect(title.regenerateTitleBackground).not.toHaveBeenCalled();
  });
});
