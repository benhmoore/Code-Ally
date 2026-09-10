import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../SessionManager.js';

describe('session deletion ordering', () => {
  let dir: string;
  let manager: SessionManager;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ally-session-deletion-'));
    manager = new SessionManager({ sessionsDir: dir });
    await manager.initialize();
    await manager.createSession('owned');
  });
  afterEach(async () => {
    await manager.cleanup();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not resurrect a deleted session from a pending autosave', async () => {
    await manager.autoSave([{ role: 'user', content: 'pending snapshot' }]);
    expect(await manager.deleteSession('owned')).toBe(true);
    await manager.forceSave();
    expect(await manager.sessionExists('owned')).toBe(false);
    expect(await manager.saveSession('owned', [{ role: 'user', content: 'late update' }])).toBe(false);
    expect(await manager.sessionExists('owned')).toBe(false);
  });

  it('waits for an already executing update before deleting the manifest', async () => {
    const original = (manager as any).writeSessionFile.bind(manager);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(manager as any, 'writeSessionFile').mockImplementation(async (...args) => {
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return original(...args);
    });
    const saving = manager.saveSession('owned', [{ role: 'user', content: 'executing update' }]);
    await ready;
    let deleted = false;
    const deletion = manager.deleteSession('owned').then(result => { deleted = result; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(deleted).toBe(false);
      release();
      expect(await saving).toBe(true);
      await deletion;
      expect(deleted).toBe(true);
      expect(await manager.sessionExists('owned')).toBe(false);
    } finally { release(); }
  });
});
