import React, { useEffect, useLayoutEffect } from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { logger } from '@services/Logger.js';
import { ActivityEventType as E, type PromptInfo, type Config } from '@shared/index.js';
import type { Agent } from '@agent/Agent.js';
import type { AppActions, AppState } from '../../contexts/AppContext.js';
import { ActivityProvider } from '../../contexts/ActivityContext.js';
import { useModalState, type ModalState } from '../useModalState.js';
import { ConfigCommand } from '@agent/commands/ConfigCommand.js';
import { DEFAULT_CONFIG } from '@config/defaults.js';
import { ModelConfigCoordinator } from '@services/ModelConfigCoordinator.js';
import { useConfigurationActivity } from '../activity/useConfigurationActivity.js';
import { useLibraryActivity } from '../activity/useLibraryActivity.js';
import { useActivityRequestScope } from '../activity/useActivityRequestScope.js';
import { useDomainActivityEvent } from '../activity/useDomainActivityEvent.js';

class Output extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true;
  write = (): boolean => true;
}
const mounted: { unmount(): void }[] = [];
afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
  ServiceRegistry.getInstance()['_services'].delete('prompt_library_manager');
  ServiceRegistry.getInstance()['_services'].delete('config_manager');
  vi.restoreAllMocks();
});

function setup(options: { preview?: (id: number) => Promise<void>; confirm?: () => Promise<void> } = {}) {
  const stream = new ActivityStream();
  const agent = {} as Agent;
  let modal: ModalState | undefined;
  const publications = vi.fn();
  const configUpdates = vi.fn();
  const previewPublications: number[] = [];
  let confirmed = 0;
  function Harness({ activeAgentId, onCommit }: { activeAgentId: string; onCommit?: () => void }) {
    const state = useModalState();
    const lifetime = useActivityRequestScope(agent, state.activeModal, activeAgentId);
    useLayoutEffect(() => {
      onCommit?.();
    }, [activeAgentId, onCommit]);
    const context = {
      state: { activeAgentId } as AppState,
      actions: { addMessage: publications, updateConfig: configUpdates } as unknown as AppActions,
      modal: state,
      agent,
      activityStream: stream,
      lifetime,
    };
    useConfigurationActivity(context);
    useDomainActivityEvent(
      E.UNDO_FILE_SELECTED,
      async (event, isCurrent) => {
        await options.preview?.(event.data.patchNumber);
        if (isCurrent()) previewPublications.push(event.data.patchNumber);
      },
      lifetime
    );
    useLibraryActivity({
      state: {} as AppState,
      actions: { addMessage: publications } as unknown as AppActions,
      modal: state,
      agent,
      activityStream: stream,
      lifetime,
    });
    useDomainActivityEvent(
      E.UNDO_CONFIRM,
      async (_event, isCurrent) => {
        if (!options.confirm) throw new Error('detached rejection');
        await options.confirm();
        if (isCurrent()) confirmed++;
      },
      lifetime
    );
    useEffect(() => {
      modal = state;
    }, [state]);
    return null;
  }
  const instance = render(
    <ActivityProvider activityStream={stream}>
      <Harness activeAgentId="main" />
    </ActivityProvider>,
    {
      stdout: new Output() as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    }
  );
  mounted.push(instance);
  return {
    stream,
    getModal: () => modal!,
    instance,
    configUpdates,
    previewPublications,
    getConfirmed: () => confirmed,
    reroute: (activeAgentId: string, onCommit?: () => void) =>
      instance.rerender(
        <ActivityProvider activityStream={stream}>
          <Harness activeAgentId={activeAgentId} onCommit={onCommit} />
        </ActivityProvider>
      ),
  };
}

describe('asynchronous activity domains', () => {
  it('does not reopen a late library picker after another modal takes the route', async () => {
    let finish!: (prompts: PromptInfo[]) => void;
    const getPrompts = vi.fn(
      () =>
        new Promise<PromptInfo[]>(resolve => {
          finish = resolve;
        })
    );
    ServiceRegistry.getInstance().registerInstance('prompt_library_manager', { getPrompts } as never);
    const { stream, getModal } = setup();
    await vi.waitFor(() => expect(getModal()).toBeDefined());
    stream.emit({ id: 'library', type: E.LIBRARY_SELECT_REQUEST, timestamp: 1, data: {} });
    expect(getPrompts).toHaveBeenCalledOnce();
    getModal().setModelSelectRequest({ requestId: 'new-model', models: [] });
    await vi.waitFor(() => expect(getModal().activeModal?.kind).toBe('model'));
    finish([]);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(getModal().activeModal?.kind).toBe('model');
    expect(getModal().librarySelectRequest).toBeUndefined();
  });

  it('publishes only the latest preview when selections complete out of order', async () => {
    const finish = new Map<number, () => void>();
    const f = setup({
      preview: id =>
        new Promise(resolve => {
          finish.set(id, resolve);
        }),
    });
    await vi.waitFor(() => expect(f.getModal()).toBeDefined());
    for (const patchNumber of [1, 2])
      f.stream.emit({
        id: `preview-${patchNumber}`,
        type: E.UNDO_FILE_SELECTED,
        timestamp: patchNumber,
        data: { patchNumber, filePath: 'file' },
      });
    finish.get(2)!();
    finish.get(1)!();
    await vi.waitFor(() => expect(f.previewPublications).toEqual([2]));
  });

  it('supersedes pending confirmations as explicit admissions', async () => {
    const completions: (() => void)[] = [];
    const f = setup({ confirm: () => new Promise(resolve => completions.push(resolve)) });
    await vi.waitFor(() => expect(f.getModal()).toBeDefined());
    for (const requestId of ['first', 'second'])
      f.stream.emit({ id: requestId, type: E.UNDO_CONFIRM, timestamp: 1, data: { requestId } });
    completions[1]!();
    completions[0]!();
    await vi.waitFor(() => expect(f.getConfirmed()).toBe(1));
  });

  it('discards root prompt prefill immediately when fleet routing renders a child before passive effects', async () => {
    let finish!: (prompt: { content: string }) => void;
    ServiceRegistry.getInstance().registerInstance('prompt_library_manager', {
      getPrompt: () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    } as never);
    const f = setup();
    await vi.waitFor(() => expect(f.getModal()).toBeDefined());
    f.stream.emit({ id: 'prompt', type: E.LIBRARY_SELECT_RESPONSE, timestamp: 1, data: { promptId: 'root-only' } });
    let routeCommitted = false;
    f.reroute('child', () => {
      routeCommitted = true;
      finish({ content: 'root prompt' });
    });
    await vi.waitFor(() => expect(routeCommitted).toBe(true));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.getModal().inputPrefillText).toBeUndefined();
    expect(f.getModal().promptPrefilled).toBe(false);
  });

  it('adopts an admitted model commit after routing changes without closing the new picker', async () => {
    let finish!: (outcome: Awaited<ReturnType<ModelConfigCoordinator['switchModel']>>) => void;
    vi.spyOn(ModelConfigCoordinator.prototype, 'switchModel').mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const authoritative = { model: 'committed-model' } as Config;
    ServiceRegistry.getInstance().registerInstance('config_manager', { getConfig: () => authoritative } as never);
    const f = setup();
    await vi.waitFor(() => expect(f.getModal()).toBeDefined());
    f.getModal().setModelSelectRequest({ requestId: 'old', models: [] });
    await vi.waitFor(() => expect(f.getModal().modelSelectRequest?.requestId).toBe('old'));
    f.stream.emit({
      id: 'response',
      type: E.MODEL_SELECT_RESPONSE,
      timestamp: 1,
      data: { modelName: 'committed-model' },
    });
    await vi.waitFor(() => expect(f.getModal().modelSelectLoading).toBe(true));
    f.getModal().setModelSelectRequest({ requestId: 'new', models: [] });
    f.reroute('child');
    await vi.waitFor(() => expect(f.getModal().modelSelectRequest?.requestId).toBe('new'));
    finish({ status: 'switched', configUpdate: { model: 'committed-model' }, messages: [] });
    await vi.waitFor(() => expect(f.configUpdates).toHaveBeenCalledWith(authoritative));
    expect(f.getModal().modelSelectRequest?.requestId).toBe('new');
    expect(f.getModal().modelSelectLoading).toBe(false);
    ServiceRegistry.getInstance()['_services'].delete('config_manager');
  });

  it('does not clear the newer loading operation when an older admitted selection settles', async () => {
    const completions: ((outcome: Awaited<ReturnType<ModelConfigCoordinator['switchModel']>>) => void)[] = [];
    vi.spyOn(ModelConfigCoordinator.prototype, 'switchModel').mockImplementation(
      () => new Promise(resolve => completions.push(resolve))
    );
    const config = { model: 'old' } as Config;
    ServiceRegistry.getInstance().registerInstance('config_manager', { getConfig: () => config } as never);
    const f = setup();
    await vi.waitFor(() => expect(f.getModal()).toBeDefined());
    f.getModal().setModelSelectRequest({ requestId: 'same-picker', models: [] });
    await vi.waitFor(() => expect(f.getModal().modelSelectRequest?.requestId).toBe('same-picker'));
    for (const modelName of ['old', 'new'])
      f.stream.emit({ id: modelName, type: E.MODEL_SELECT_RESPONSE, timestamp: 1, data: { modelName } });
    await vi.waitFor(() => expect(f.getModal().modelSelectLoading).toBe(true));
    completions[0]!({ status: 'switched', configUpdate: { model: 'old' }, messages: [] });
    await vi.waitFor(() => expect(f.configUpdates).toHaveBeenCalledOnce());
    expect(f.getModal().modelSelectLoading).toBe(true);
    expect(f.getModal().modelSelectRequest?.requestId).toBe('same-picker');
    config.model = 'new';
    completions[1]!({ status: 'switched', configUpdate: { model: 'new' }, messages: [] });
    await vi.waitFor(() => expect(f.getModal().modelSelectRequest).toBeUndefined());
  });

  it('starts model selection on the currently active model', async () => {
    const f = setup();
    await vi.waitFor(() => expect(f.getModal()).toBeDefined());
    f.stream.emit({
      id: 'models',
      type: E.MODEL_SELECT_REQUEST,
      timestamp: 1,
      data: { requestId: 'models', models: [{ name: 'other' }, { name: 'current' }], currentModel: 'current' },
    });
    await vi.waitFor(() => expect(f.getModal().modelSelectedIndex).toBe(1));
  });

  it('applies a command setting once while the frontend adopts its notification', async () => {
    let config = { ...DEFAULT_CONFIG };
    const manager = {
      getConfig: () => ({ ...config }),
      parseKeyValue: () => ({ key: 'temperature', valueString: '0.5' }),
      setFromString: async () => {
        const oldValue = config.temperature;
        config = { ...config, temperature: 0.5 };
        return { key: 'temperature', oldValue, newValue: 0.5 };
      },
    };
    const applied = vi.fn();
    ServiceRegistry.getInstance().registerInstance('config_manager', manager as never);
    ServiceRegistry.getInstance().registerInstance('agent', { applyConfigUpdates: applied } as never);
    const f = setup();
    ServiceRegistry.getInstance().registerInstance('activity_stream', f.stream);
    await vi.waitFor(() => expect(f.getModal()).toBeDefined());
    await new ConfigCommand().execute(['set', 'temperature=0.5'], [], ServiceRegistry.getInstance());
    expect(applied).toHaveBeenCalledExactlyOnceWith({ temperature: 0.5 });
    expect(f.configUpdates).toHaveBeenCalledWith({ temperature: 0.5 });
    ServiceRegistry.getInstance()['_services'].delete('agent');
    ServiceRegistry.getInstance()['_services'].delete('activity_stream');
  });

  it('observes rejected detached handlers instead of leaking an unhandled promise', async () => {
    const failure = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const { stream, getModal } = setup();
    await vi.waitFor(() => expect(getModal()).toBeDefined());
    stream.emit({ id: 'undo', type: E.UNDO_CONFIRM, timestamp: 1, data: { requestId: 'missing' } });
    await vi.waitFor(() =>
      expect(failure).toHaveBeenCalledWith(
        expect.stringContaining('undo_confirm'),
        expect.objectContaining({ message: 'detached rejection' })
      )
    );
  });
});
