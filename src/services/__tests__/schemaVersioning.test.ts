/**
 * Cross-store schema versioning tests.
 *
 * Two guarantees are exercised for every persisted store:
 *  1. A pre-versioning (unversioned) file on disk loads as v0 and migrates
 *     forward with no data loss. Every existing install has such files.
 *  2. A file written by a NEWER build is refused with SchemaTooNewError and is
 *     left byte-identical on disk - never emptied, quarantined or overwritten.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionManager } from '../SessionManager.js';
import { ScheduledTaskManager } from '../ScheduledTaskManager.js';
import { PromptLibraryManager } from '../PromptLibraryManager.js';
import { ConfigManager } from '../ConfigManager.js';
import { SchemaTooNewError, SCHEMA_VERSION_KEY } from '../../utils/versionedStore.js';
import { CONFIG_SCHEMA, SESSION_SCHEMA } from '../../config/schemas.js';

vi.mock('@config/paths.js', async () => {
  const actual = await vi.importActual('@config/paths.js');
  return {
    ...actual,
    getBaseConfigFile: () => '/nonexistent/base/config.json',
  };
});

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ally-schema-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/** Read a file's exact bytes so a later comparison proves it was untouched. */
async function snapshot(file: string): Promise<string> {
  return fs.readFile(file, 'utf-8');
}

describe('SessionManager schema versioning', () => {
  const legacySession = {
    id: 'legacy',
    name: 'legacy',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    working_dir: '/tmp/project',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ],
    metadata: { model: 'legacy-model' },
  };

  it('loads an unversioned legacy session as v0 without data loss', async () => {
    const manager = new SessionManager({ sessionsDir: dir });
    await manager.initialize();
    await fs.writeFile(join(dir, 'legacy.json'), JSON.stringify(legacySession, null, 2));

    const session = await manager.loadSession('legacy');

    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(2);
    expect(session!.messages[0]!.content).toBe('hello');
    expect(session!.metadata).toEqual({ model: 'legacy-model' });
    expect(session!.working_dir).toBe('/tmp/project');
    expect(session!.schema_version).toBe(SESSION_SCHEMA.current);
    // Reading must not rewrite or quarantine the file.
    expect(JSON.parse(await snapshot(join(dir, 'legacy.json')))).toEqual(legacySession);
  });

  it('refuses a session from a newer build and leaves the file byte-identical', async () => {
    const manager = new SessionManager({ sessionsDir: dir });
    await manager.initialize();
    const file = join(dir, 'future.json');
    const raw = JSON.stringify({ ...legacySession, id: 'future', name: 'future', [SCHEMA_VERSION_KEY]: 99 }, null, 2);
    await fs.writeFile(file, raw);

    await expect(manager.loadSession('future')).rejects.toBeInstanceOf(SchemaTooNewError);

    expect(await snapshot(file)).toBe(raw);
    // Not quarantined either: the file is still exactly where it was.
    expect(await fs.readdir(join(dir, '.quarantine'))).toEqual([]);
  });

  it('round-trips a saved session with the version stamped', async () => {
    const manager = new SessionManager({ sessionsDir: dir });
    await manager.initialize();
    const name = await manager.createSession('roundtrip');
    await manager.saveSession(name, [{ role: 'user', content: 'ping' }] as never);

    const onDisk = JSON.parse(await snapshot(join(dir, 'roundtrip.json')));
    expect(onDisk[SCHEMA_VERSION_KEY]).toBe(SESSION_SCHEMA.current);

    const reloaded = new SessionManager({ sessionsDir: dir });
    const session = await reloaded.loadSession('roundtrip');
    expect(session!.messages).toHaveLength(1);
    expect(session!.messages[0]!.content).toBe('ping');
    expect(session!.schema_version).toBe(SESSION_SCHEMA.current);
  });

  it('skips a too-new session when listing rather than failing the whole listing', async () => {
    const manager = new SessionManager({ sessionsDir: dir });
    await manager.initialize();
    await manager.createSession('ok');
    const futureRaw = JSON.stringify({ ...legacySession, [SCHEMA_VERSION_KEY]: 99 }, null, 2);
    await fs.writeFile(join(dir, 'future.json'), futureRaw);

    const infos = await manager.getSessionsInfo();

    expect(infos.map(info => info.session_id)).toEqual(['ok']);
    expect(await snapshot(join(dir, 'future.json'))).toBe(futureRaw);
  });
});

describe('ScheduledTaskManager schema versioning', () => {
  const task = {
    id: 'sched-legacy',
    title: 'Nightly build',
    enabled: true,
    project_dir: '/tmp/project',
    profile: 'default',
    schedule: { type: 'daily', time: '05:00', timezone: 'UTC', grace_minutes: 10 },
    run_prompt: 'build it',
    policy_preset: 'none',
    next_run_at: '2030-01-01T05:00:00.000Z',
    last_status: 'never_run',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    history: [],
  };

  function makeManager() {
    return new ScheduledTaskManager(undefined, {
      storeFile: join(dir, 'scheduled_tasks.json'),
      indexFile: join(dir, 'scheduled_tasks_index.json'),
      lockFile: join(dir, 'scheduler.lock'),
    });
  }

  it('REGRESSION: a store whose version no longer matches is preserved, not emptied', async () => {
    // Before schema versioning, any version mismatch made loadStore() return an
    // empty store and the next saveStore() wipe the user's tasks. The legacy
    // `version: 1` field is now migrated to schema_version with tasks intact.
    const manager = makeManager();
    await manager.initialize();
    const storeFile = join(dir, 'scheduled_tasks.json');
    await fs.writeFile(
      storeFile,
      JSON.stringify({ version: 1, tasks: [task, { ...task, id: 'sched-legacy-2' }] }, null, 2)
    );

    const tasks = await manager.listCurrentProject({ projectDir: '/tmp/project', allProfiles: true });
    expect(tasks).toHaveLength(2);
    expect(tasks.map(t => t.id)).toContain('sched-legacy');

    // A write after the read keeps both tasks and converts the version field.
    await manager.update('sched-legacy', { title: 'Renamed' }, '/tmp/project');

    const persisted = JSON.parse(await snapshot(storeFile));
    expect(persisted.tasks).toHaveLength(2);
    expect(persisted[SCHEMA_VERSION_KEY]).toBe(1);
    expect(persisted.version).toBeUndefined();
    expect(await makeManager().listCurrentProject({ projectDir: '/tmp/project', allProfiles: true }))
      .toHaveLength(2);
  });

  it('loads a fully unversioned store as v0 without data loss', async () => {
    const manager = makeManager();
    await manager.initialize();
    await fs.writeFile(join(dir, 'scheduled_tasks.json'), JSON.stringify({ tasks: [task] }, null, 2));

    const loaded = await manager.getTask('sched-legacy', '/tmp/project');

    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('Nightly build');
    expect(loaded!.run_prompt).toBe('build it');
  });

  it('refuses a too-new store and leaves the file byte-identical', async () => {
    const manager = makeManager();
    await manager.initialize();
    const storeFile = join(dir, 'scheduled_tasks.json');
    const raw = JSON.stringify({ [SCHEMA_VERSION_KEY]: 42, tasks: [task] }, null, 2);
    await fs.writeFile(storeFile, raw);

    await expect(
      manager.listCurrentProject({ projectDir: '/tmp/project', allProfiles: true })
    ).rejects.toBeInstanceOf(SchemaTooNewError);
    expect(await snapshot(storeFile)).toBe(raw);

    // A failed create must not overwrite the store either.
    await expect(
      manager.create({
        title: 'New',
        run_prompt: 'go',
        schedule: { type: 'daily', time: '06:00', timezone: 'UTC' },
        project_dir: '/tmp/project',
      })
    ).rejects.toBeInstanceOf(SchemaTooNewError);
    expect(await snapshot(storeFile)).toBe(raw);
  });

  it('round-trips a created task with the version stamped', async () => {
    const manager = makeManager();
    await manager.initialize();
    const created = await manager.create({
      title: 'Round trip',
      run_prompt: 'go',
      schedule: { type: 'daily', time: '06:00', timezone: 'UTC' },
      project_dir: '/tmp/project',
    });

    const persisted = JSON.parse(await snapshot(join(dir, 'scheduled_tasks.json')));
    expect(persisted[SCHEMA_VERSION_KEY]).toBe(1);
    expect(persisted.tasks).toHaveLength(1);

    const reloaded = await makeManager().getTask(created.id, '/tmp/project');
    expect(reloaded).toEqual(created);

    const index = JSON.parse(await snapshot(join(dir, 'scheduled_tasks_index.json')));
    expect(index[SCHEMA_VERSION_KEY]).toBe(1);
    expect(index.tasks).toHaveLength(1);
  });
});

describe('PromptLibraryManager schema versioning', () => {
  const legacyLibrary = {
    version: '1.0',
    prompts: [
      { id: 'p1', title: 'One', content: 'first', createdAt: 2 },
      { id: 'p2', title: 'Two', content: 'second', createdAt: 1, tags: ['x'] },
    ],
  };

  it('loads an unversioned legacy library as v0 without data loss', async () => {
    const manager = new PromptLibraryManager(dir);
    await manager.initialize();
    await fs.writeFile(join(dir, 'library.json'), JSON.stringify(legacyLibrary, null, 2));

    const prompts = await manager.getPrompts();

    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.title).toBe('One');
    expect(prompts[1]!.tags).toEqual(['x']);
  });

  it('refuses a too-new library and leaves the file byte-identical', async () => {
    const manager = new PromptLibraryManager(dir);
    await manager.initialize();
    const file = join(dir, 'library.json');
    const raw = JSON.stringify({ ...legacyLibrary, [SCHEMA_VERSION_KEY]: 5 }, null, 2);
    await fs.writeFile(file, raw);

    await expect(manager.getPrompts()).rejects.toBeInstanceOf(SchemaTooNewError);
    await expect(manager.addPrompt('New', 'body')).rejects.toBeInstanceOf(SchemaTooNewError);
    expect(await snapshot(file)).toBe(raw);
  });

  it('round-trips added prompts with the version stamped', async () => {
    const manager = new PromptLibraryManager(dir);
    await manager.initialize();
    const added = await manager.addPrompt('Title', 'Body', ['tag']);

    const persisted = JSON.parse(await snapshot(join(dir, 'library.json')));
    expect(persisted[SCHEMA_VERSION_KEY]).toBe(1);

    const reloaded = await new PromptLibraryManager(dir).getPrompt(added.id);
    expect(reloaded).toEqual(added);
  });

  it('preserves existing prompts when an unversioned library is written back', async () => {
    const manager = new PromptLibraryManager(dir);
    await manager.initialize();
    await fs.writeFile(join(dir, 'library.json'), JSON.stringify(legacyLibrary, null, 2));

    await manager.addPrompt('Three', 'third');

    const persisted = JSON.parse(await snapshot(join(dir, 'library.json')));
    expect(persisted.prompts).toHaveLength(3);
    expect(persisted[SCHEMA_VERSION_KEY]).toBe(1);
  });
});

describe('ConfigManager schema versioning', () => {
  it('loads an unversioned legacy config as v0 without data loss', async () => {
    const configPath = join(dir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify({ temperature: 0.42, model: 'legacy-model' }, null, 2));

    const manager = new ConfigManager(configPath);
    await manager.initialize();

    expect(manager.getValue('temperature')).toBe(0.42);
    expect(manager.getValue('model')).toBe('legacy-model');
  });

  it('refuses a too-new config and leaves the file byte-identical', async () => {
    const configPath = join(dir, 'config.json');
    const raw = JSON.stringify({ temperature: 0.42, [SCHEMA_VERSION_KEY]: 77 }, null, 2);
    await fs.writeFile(configPath, raw);

    const manager = new ConfigManager(configPath);
    await expect(manager.initialize()).rejects.toBeInstanceOf(SchemaTooNewError);

    expect(await snapshot(configPath)).toBe(raw);
  });

  it('preserves an unknown key across a load/save cycle', async () => {
    const configPath = join(dir, 'config.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({ temperature: 0.42, a_key_from_the_future: { nested: true } }, null, 2)
    );

    const manager = new ConfigManager(configPath);
    await manager.initialize();
    await manager.setValue('temperature', 0.9);

    const persisted = JSON.parse(await snapshot(configPath));
    expect(persisted.temperature).toBe(0.9);
    expect(persisted.a_key_from_the_future).toEqual({ nested: true });
    expect(persisted[SCHEMA_VERSION_KEY]).toBe(CONFIG_SCHEMA.current);

    // And it is still there after another full load/save cycle.
    const reloaded = new ConfigManager(configPath);
    await reloaded.initialize();
    await reloaded.setValue('temperature', 0.3);
    expect(JSON.parse(await snapshot(configPath)).a_key_from_the_future).toEqual({ nested: true });
  });
});
