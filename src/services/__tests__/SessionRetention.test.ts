import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../SessionManager.js';

describe('session retention', () => {
  let dir: string;
  const managers: SessionManager[] = [];
  const createManager = (maxSessions: number) => {
    const manager = new SessionManager({ sessionsDir: dir, maxSessions });
    managers.push(manager);
    return manager;
  };
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ally-session-retention-'));
  });
  afterEach(async () => {
    await Promise.all(managers.splice(0).map(manager => manager.cleanup()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('removes cached snapshots and immutable archives together with an expired manifest', async () => {
    const manager = createManager(1);
    await manager.initialize();
    await manager.createSession('expired');
    await manager.saveSession('expired', Array.from({ length: 64 }, (_, index) => ({
      id: String(index), role: 'user' as const, content: `message ${index}`,
    })));
    expect((await fs.readdir(join(dir, 'expired', 'transcript-segments'))).length).toBe(1);
    expect(await manager.loadSession('expired')).not.toBeNull();
    await manager.createSession('retained');
    expect(await manager.loadSession('expired')).toBeNull();
    await expect(fs.stat(join(dir, 'expired'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await manager.listSessions()).toEqual(['retained']);
  });

  it('drains a retained-away session autosave before removing all of its data', async () => {
    const manager = createManager(1);
    await manager.initialize();
    await manager.createSession('expired');
    await manager.autoSave([{ id: 'pending', role: 'user', content: 'pending snapshot' }]);
    await manager.createSession('retained');
    await manager.forceSave();
    expect(await manager.loadSession('expired')).toBeNull();
    await expect(fs.stat(join(dir, 'expired'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await manager.listSessions()).toEqual(['retained']);
  });

  it('retains the full limit when there is no current session', async () => {
    const writer = createManager(100);
    await writer.initialize();
    for (const name of ['old', 'middle', 'new']) await writer.createSession(name);
    await fs.utimes(join(dir, 'old.json'), new Date(1000), new Date(1000));
    await fs.utimes(join(dir, 'middle.json'), new Date(2000), new Date(2000));
    const manager = createManager(2);
    await manager.initialize();
    expect(await manager.saveSession('new', [{ role: 'user', content: 'updated' }])).toBe(true);
    expect(await manager.listSessions()).toEqual(['middle', 'new']);
  });
});
