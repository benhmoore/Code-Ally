import React, { useEffect } from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '@agent/Agent.js';
import { ConversationManager } from '@agent/ConversationManager.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ConversationInputQueue } from '@services/ConversationInputQueue.js';
import { ConversationViewStore } from '@services/ConversationViewStore.js';
import { SessionRuntime } from '@services/SessionRuntime.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { SessionReplayData } from '@services/SessionRestoreCoordinator.js';
import type { AppActions } from '../../contexts/AppContext.js';
import { useSessionResume } from '../useSessionResume.js';

class Output extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true;
  write = (): boolean => true;
}
const disposals: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  const registry = ServiceRegistry.getInstance();
  for (const name of [
    'session_manager',
    'todo_manager',
    'idle_message_generator',
    'project_context_detector',
    'additional_dirs_manager',
  ] as const)
    registry['_services'].delete(name);
  vi.restoreAllMocks();
});

function setup(target: string | null = 'B') {
  let binding: string | null = 'A';
  const conversation = new ConversationManager({ initialMessages: [{ id: 'a', role: 'user', content: 'A' }] });
  const view = new ConversationViewStore(
    new ActivityStream(),
    () => conversation.getTranscript(),
    () => []
  );
  const resume = vi.fn(state =>
    conversation.loadConversation(
      state.messages,
      state.transcript ?? state.messages,
      state.checkpoint,
      state.providerState,
      state.canonicalMessages
    )
  );
  const runtime = new SessionRuntime({
    view,
    input: new ConversationInputQueue(() => false),
    isProcessing: () => false,
    steer: () => false,
    execute: async () => '',
    cancel: () => {},
    resume,
    close: async () => {},
  });
  const agent = {
    getSession: () => runtime,
    getConversationManager: () => conversation,
    addMessage: vi.fn(),
    removeEphemeralSystemReminders: vi.fn(),
    cleanupStaleReminders: vi.fn(),
    getContextUsagePercentage: () => 0,
  } as unknown as Agent;
  let finish!: (data: SessionReplayData) => void;
  const manager = {
    getCurrentSession: () => binding,
    setCurrentSession: (value: string | null) => {
      binding = value;
    },
    forceSave: vi.fn(async () => true),
    getSessionData: vi.fn(
      () =>
        new Promise<SessionReplayData>(resolve => {
          finish = resolve;
        })
    ),
    getSessionsInfoByDirectory: vi.fn(async () => []),
  };
  ServiceRegistry.getInstance().registerInstance('session_manager', manager as never);
  const messages = vi.fn();
  const picker = vi.fn();
  let ready = false;
  function Harness({ request, repaint }: { request: string | null; repaint: number }) {
    const actions = {
      addMessage: messages,
      repaintConversationSurface: () => repaint,
      setContextUsage: vi.fn(),
    } as unknown as AppActions;
    const result = useSessionResume(request, agent, actions, picker);
    useEffect(() => {
      ready = result.sessionLoaded;
    }, [result.sessionLoaded]);
    return null;
  }
  const instance = render(<Harness request={target} repaint={0} />, {
    stdout: new Output() as unknown as NodeJS.WriteStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  disposals.push(
    () => instance.unmount(),
    async () => {
      await runtime.close();
      view.close();
    }
  );
  return {
    manager,
    resume,
    messages,
    picker,
    ready: () => ready,
    pair: () => `${binding}:${conversation.getMessages()[0]?.content}`,
    finish: (data: SessionReplayData) => finish(data),
    unmount: () => instance.unmount(),
    rerender: (request = target, repaint = 1) => instance.rerender(<Harness request={request} repaint={repaint} />),
  };
}

describe('startup session transaction', () => {
  it('single-flights startup reads across rerenders and publishes readiness after admitted replay', async () => {
    const f = setup();
    await vi.waitFor(() => expect(f.manager.getSessionData).toHaveBeenCalledOnce());
    f.rerender();
    f.rerender('B', 2);
    expect(f.ready()).toBe(false);
    f.finish({ messages: [{ id: 'b', role: 'user', content: 'B' }] });
    await vi.waitFor(() => expect(f.ready()).toBe(true));
    expect(f.manager.getSessionData).toHaveBeenCalledOnce();
    expect(f.resume).toHaveBeenCalledOnce();
    expect(f.pair()).toBe('B:B');
  });

  it('discards a delayed startup read after unmount without changing the original session owner', async () => {
    const f = setup();
    await vi.waitFor(() => expect(f.manager.getSessionData).toHaveBeenCalledOnce());
    f.unmount();
    f.finish({ messages: [{ role: 'user', content: 'B' }] });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.resume).not.toHaveBeenCalled();
    expect(f.pair()).toBe('A:A');
  });

  it('handles failed startup reads and releases readiness with the original binding intact', async () => {
    const f = setup();
    f.manager.getSessionData.mockRejectedValueOnce(new Error('corrupt session'));
    await vi.waitFor(() => expect(f.ready()).toBe(true));
    expect(f.messages).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('corrupt session') })
    );
    expect(f.pair()).toBe('A:A');
  });

  it('does not open a stale interactive startup picker after its target is replaced', async () => {
    const f = setup(null);
    let finish!: (sessions: never[]) => void;
    f.manager.getSessionsInfoByDirectory.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    f.rerender('interactive');
    await vi.waitFor(() => expect(f.manager.getSessionsInfoByDirectory).toHaveBeenCalledOnce());
    f.rerender(null);
    await new Promise<void>(resolve => setImmediate(resolve));
    finish([]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.picker).not.toHaveBeenCalled();
    expect(f.pair()).toBe('A:A');
  });
});
