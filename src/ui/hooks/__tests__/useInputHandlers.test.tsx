import React, { useEffect } from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { AppActions, AppState } from '../../contexts/AppContext.js';
import { useInputHandlers } from '../useInputHandlers.js';

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 30;
  isTTY = true;
  write = (): boolean => true;
}

const mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.unmount();
  const registry = ServiceRegistry.getInstance() as any;
  registry._services.clear();
  registry._descriptors.clear();
});

describe('useInputHandlers interjection routing', () => {
  it('routes to the selected main agent even while an injectable delegate is active', async () => {
    const addUserInterjection = vi.fn();
    const interrupt = vi.fn();
    const injectUserMessage = vi.fn();
    const registry = ServiceRegistry.getInstance();
    registry.registerInstance('agent', { addUserInterjection, interrupt } as any);
    registry.registerInstance('tool_manager', {
      getActiveInjectableTool: () => ({
        name: 'agent',
        callId: 'child-call',
        tool: { injectUserMessage },
      }),
    } as any);

    const activityStream = new ActivityStream();
    const emitted: any[] = [];
    activityStream.subscribe('*', (event) => emitted.push(event));
    let completion: Promise<void> | undefined;

    const Harness = () => {
      const { handleInterjection } = useInputHandlers(
        null,
        activityStream,
        { activeAgentId: 'main', currentAgent: 'ally' } as AppState,
        { addMessage: vi.fn() } as unknown as AppActions,
      );
      useEffect(() => {
        completion = handleInterjection('keep this with main');
      }, [handleInterjection]);
      return null;
    };

    const instance = render(<Harness />, {
      stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
      debug: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    mounted.push(instance);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await completion;

    expect(addUserInterjection).toHaveBeenCalledWith('keep this with main');
    expect(interrupt).toHaveBeenCalledWith({ kind: 'user_interjection' });
    expect(injectUserMessage).not.toHaveBeenCalled();
    expect(emitted.at(-1)).toMatchObject({
      type: 'user_interjection',
      parentId: 'root',
      data: { targetAgent: 'main' },
    });
  });
});
