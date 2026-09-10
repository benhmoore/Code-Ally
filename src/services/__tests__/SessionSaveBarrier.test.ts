import { describe, expect, it, vi } from 'vitest';
import { SessionManager } from '../SessionManager.js';

describe('session autosave barriers', () => {
  it.each(['forceSave', 'cleanup'] as const)('awaits a previously admitted write during %s', async barrier => {
    const manager = new SessionManager();
    manager.setCurrentSession('barrier-test');
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const write = vi.spyOn(manager as any, 'mutateSessionIncremental').mockImplementation(async () => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return true;
    });
    await manager.autoSave([{ role: 'user', content: 'must persist' }]);
    const saving = (manager as any).flushPendingAutoSave();
    await ready;
    let completed = false;
    const stopping = manager[barrier]().then(() => { completed = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(completed).toBe(false);
      release();
      await Promise.all([saving, stopping]);
      expect(completed).toBe(true);
      expect(write).toHaveBeenCalledOnce();
    } finally {
      release();
      await manager.cleanup();
    }
  });

  it('retains a failed write across later persistence and shutdown barriers', async () => {
    const manager = new SessionManager();
    manager.setCurrentSession('failed-barrier-test');
    const failure = new Error('injected storage failure');
    const write = vi.spyOn(manager as any, 'mutateSessionIncremental').mockRejectedValue(failure);
    await manager.autoSave([{ role: 'user', content: 'not persisted' }]);
    await expect((manager as any).flushPendingAutoSave()).rejects.toThrow('Session autosave persistence failed');
    await expect(manager.forceSave()).rejects.toThrow('Session autosave persistence failed');
    await expect(manager.cleanup()).rejects.toThrow('Session autosave persistence failed');
    expect(write).toHaveBeenCalledOnce();
  });

  it('retains failures from writes transferred during a session switch', async () => {
    const manager = new SessionManager();
    const writes = vi.spyOn(manager as any, 'mutateSessionIncremental').mockImplementation(async name => {
      if (name === 'first') throw new Error('first session storage failed');
      return true;
    });
    manager.setCurrentSession('first');
    expect(await manager.autoSave([{ role: 'user', content: 'first snapshot' }])).toBe(true);
    manager.setCurrentSession('second');
    expect(await manager.autoSave([{ role: 'user', content: 'second snapshot' }])).toBe(true);
    await expect(manager.forceSave()).rejects.toThrow('Session autosave persistence failed');
    await expect(manager.cleanup()).rejects.toThrow('Session autosave persistence failed');
    expect(writes.mock.calls.map(args => args[0])).toEqual(['first', 'second']);
  });
});
