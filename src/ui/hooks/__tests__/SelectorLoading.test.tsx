import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@agent/Agent.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ActivityEventType as E } from '@shared/index.js';
import { ActivityProvider } from '../../contexts/ActivityContext.js';
import type { AppActions, AppState } from '../../contexts/AppContext.js';
import { useModalState, type ModalState } from '../useModalState.js';
import { useActivityRequestScope } from '../activity/useActivityRequestScope.js';
import { useHistoryActivity } from '../activity/useHistoryActivity.js';
import { useLibraryActivity } from '../activity/useLibraryActivity.js';
class Output extends EventEmitter {
  columns = 80;
  rows = 24;
  write = () => true;
}
const mounted: Array<{ unmount(): void }> = [];
afterEach(() => {
  mounted.splice(0).forEach(instance => instance.unmount());
  for (const key of ['session_manager', 'prompt_library_manager'])
    ServiceRegistry.getInstance()['_services'].delete(key);
});

function setup(kind: 'session' | 'library', list: () => Promise<never[]>) {
  ServiceRegistry.getInstance().registerInstance(
    kind === 'session' ? 'session_manager' : 'prompt_library_manager',
    (kind === 'session' ? { getSessionsInfoByDirectory: list } : { getPrompts: list }) as never
  );
  const agent = {} as Agent;
  const stream = new ActivityStream();
  let modal!: ModalState;
  function Harness() {
    modal = useModalState();
    const lifetime = useActivityRequestScope(agent, modal.activeModal);
    const context = {
      state: {} as AppState,
      actions: {} as AppActions,
      agent,
      activityStream: stream,
      modal,
      lifetime,
    };
    useHistoryActivity(context);
    useLibraryActivity(context);
    return null;
  }
  mounted.push(
    render(
      <ActivityProvider activityStream={stream}>
        <Harness />
      </ActivityProvider>,
      { stdout: new Output(), debug: true, patchConsole: false, exitOnCtrlC: false }
    )
  );
  const emit = (requestId: string) =>
    stream.emit({
      id: requestId,
      type: kind === 'session' ? E.SESSION_SELECT_REQUEST : E.LIBRARY_SELECT_REQUEST,
      timestamp: 1,
      data: { requestId },
    });
  const request = () => (kind === 'session' ? modal.sessionSelectRequest : modal.librarySelectRequest);
  const close = () =>
    stream.emit({
      id: 'close',
      timestamp: 2,
      type: kind === 'session' ? E.SESSION_SELECT_RESPONSE : E.LIBRARY_SELECT_RESPONSE,
      data: { cancelled: true },
    });
  return { request, emit, close };
}

describe.each(['session', 'library'] as const)('%s picker loading', kind => {
  it('shows progress, keeps recoverable errors, and accepts an immediate retry without self-invalidation', async () => {
    let fail!: (error: Error) => void;
    const list = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            fail = reject;
          })
      )
      .mockResolvedValueOnce([]);
    const { request, emit } = setup(kind, list);
    emit('first');
    await vi.waitFor(() => expect(request()?.loadState?.kind).toBe('loading'));
    fail(new Error('disk unavailable'));
    await vi.waitFor(() => expect(request()?.loadState).toEqual({ kind: 'error', message: 'disk unavailable' }));
    emit('retry');
    await vi.waitFor(() => expect(request()?.requestId).toBe('retry'));
    await vi.waitFor(() => expect(request()?.loadState).toBeUndefined());
    expect(list).toHaveBeenCalledTimes(2);
  });
  it('keeps a cancelled loading request closed when the read completes late', async () => {
    let finish!: (value: never[]) => void;
    const list = vi.fn(
      () =>
        new Promise<never[]>(resolve => {
          finish = resolve;
        })
    );
    const { request, emit, close } = setup(kind, list);
    emit('cancel-me');
    await vi.waitFor(() => expect(request()?.loadState?.kind).toBe('loading'));
    close();
    await vi.waitFor(() => expect(request()).toBeUndefined());
    finish([]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(request()).toBeUndefined();
  });
});
