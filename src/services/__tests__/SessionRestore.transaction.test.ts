import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../SessionManager.js';
import { describe, expect, it, vi } from 'vitest';
import { ActivityStream } from '../ActivityStream.js';
import { ConversationInputQueue } from '../ConversationInputQueue.js';
import { ConversationViewStore } from '../ConversationViewStore.js';
import { SessionRuntime, type SessionResumeState } from '../SessionRuntime.js';
import {
  SessionRestoreCoordinator,
  type SessionReplayData,
  type SessionRestoreOptions,
} from '../SessionRestoreCoordinator.js';

function fixture() {
  let selected: string | null = 'A';
  let owner = 'A';
  let busy = false;
  const input = new ConversationInputQueue(() => busy);
  const view = new ConversationViewStore(
    new ActivityStream(),
    () => [],
    () => []
  );
  const executed: string[] = [];
  const runtime = new SessionRuntime({
    view,
    input,
    isProcessing: () => busy,
    steer: () => false,
    execute: async () => {
      executed.push(`${selected}:${owner}`);
      return 'done';
    },
    cancel: () => {},
    resume: state => {
      owner = state.messages[0]!.content;
    },
    close: async () => {},
  });
  const manager = {
    getCurrentSession: () => selected,
    forceSave: vi.fn(async () => true),
    setCurrentSession: (id: string | null) => {
      selected = id;
    },
    getSessionsInfoByDirectory: async () => [],
    getSessionData: vi.fn(async (): Promise<SessionReplayData> => ({ messages: [{ role: 'user', content: 'B' }] })),
  };
  const patch = { onSessionChange: vi.fn(async () => {}) };
  const coordinator = new SessionRestoreCoordinator({ getSessionManager: () => manager, getPatchManager: () => patch });
  const options: SessionRestoreOptions = {
    runExclusive: operation => runtime.withIdleMutation(operation),
    captureRollback: () => {
      const previous: SessionResumeState = { messages: [{ role: 'user', content: owner }] };
      return async resume => {
        resume!(previous);
      };
    },
    onRollbackFailure: () => {
      void runtime.close();
    },
  };
  const load = vi.fn(async (data: SessionReplayData, resume?: (state: SessionResumeState) => void) => {
    resume!(data);
  });
  return {
    input,
    view,
    runtime,
    manager,
    patch,
    coordinator,
    options,
    load,
    executed,
    pair: () => `${selected}:${owner}`,
    setBusy: (value: boolean) => {
      busy = value;
    },
  };
}

describe('session restore transaction', () => {
  it('flushes pending autosave before reselecting the current saved conversation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ally-reselect-'));
    const manager = new SessionManager({ sessionsDir: directory });
    await manager.initialize();
    const name = await manager.createSession('current');
    manager.setCurrentSession(name);
    const old = { id: 'old', role: 'user' as const, content: 'old' };
    const latest = { id: 'new', role: 'assistant' as const, content: 'latest pending reply' };
    await manager.autoSave([old]);
    await manager.forceSave();
    await manager.autoSave([old, latest]);
    const coordinator = new SessionRestoreCoordinator({
      getSessionManager: () => manager,
      getPatchManager: () => null,
    });
    const load = vi.fn(async (_data: SessionReplayData) => {});
    try {
      expect(await coordinator.restoreSession(name, load)).toEqual({ status: 'ok' });
      expect(load.mock.calls[0]![0].messages.map(message => message.id)).toEqual(['old', 'new']);
    } finally {
      await manager.cleanup();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('does not switch the saved owner after navigation supersedes a delayed read', async () => {
    const f = fixture();
    let finish!: (data: SessionReplayData) => void;
    let foreground = 'main';
    f.manager.getSessionData.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const restore = f.coordinator.restoreSession('B', f.load, {
      ...f.options,
      ownsRequest: () => foreground === 'main',
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    foreground = 'child';
    finish({ messages: [{ role: 'user', content: 'B' }] });
    expect(await restore).toEqual({ status: 'superseded' });
    expect(f.pair()).toBe('A:A');
    expect(f.load).not.toHaveBeenCalled();
    await f.runtime.close();
    f.view.close();
  });

  it('holds new submissions through patch rebind and replays an admitted restore despite navigation', async () => {
    const f = fixture();
    let finish!: () => void;
    let foreground = true;
    f.patch.onSessionChange.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const restore = f.coordinator.restoreSession('B', f.load, { ...f.options, ownsRequest: () => foreground });
    await vi.waitFor(() => expect(finish).toBeDefined());
    const submission = f.runtime.submit('next');
    foreground = false;
    expect(f.executed).toEqual([]);
    expect(f.runtime.getSnapshot().pendingInputs).toHaveLength(1);
    finish();
    expect(await restore).toEqual({ status: 'ok' });
    await submission;
    expect(f.pair()).toBe('B:B');
    expect(f.executed).toEqual(['B:B']);
    await f.runtime.close();
    f.view.close();
  });

  it.each(['active', 'queued'])('rejects restore before binding or replay when work is %s', async mode => {
    const f = fixture();
    f.setBusy(true);
    const queued = mode === 'queued' ? f.input.enqueue('pending', async () => {}) : undefined;
    if (mode === 'queued') f.setBusy(false);
    const outcome = await f.coordinator.restoreSession('B', f.load, f.options);
    expect(outcome.status).toBe('error');
    expect(f.pair()).toBe('A:A');
    expect(f.load).not.toHaveBeenCalled();
    await f.runtime.close();
    await queued;
    f.view.close();
  });

  it('rolls binding and owner back together after replay failure', async () => {
    const f = fixture();
    const outcome = await f.coordinator.restoreSession(
      'B',
      async (data, resume) => {
        resume!(data);
        throw new Error('replay failed');
      },
      f.options
    );
    expect(outcome).toMatchObject({ status: 'error', sessionSwitched: false });
    expect(f.pair()).toBe('A:A');
    await f.runtime.close();
    f.view.close();
  });

  it('closes admission and drops queued work when rollback cannot establish a consistent owner', async () => {
    const f = fixture();
    let finish!: () => void;
    f.patch.onSessionChange.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const restore = f.coordinator.restoreSession(
      'B',
      async (data, resume) => {
        resume!(data);
        throw new Error('replay failed');
      },
      {
        ...f.options,
        captureRollback: () => async () => {
          throw new Error('rollback failed');
        },
      }
    );
    await vi.waitFor(() => expect(finish).toBeDefined());
    const pending = f.runtime.submit('must not execute');
    finish();
    expect(await restore).toMatchObject({ status: 'error', sessionSwitched: true });
    expect(await pending).toEqual({ kind: 'not_sent' });
    await expect(f.runtime.submit('late')).rejects.toThrow('closed');
    expect(f.executed).toEqual([]);
    await f.runtime.close();
    f.view.close();
  });
});
