import React, { useEffect } from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { AppActions } from '../../contexts/AppContext.js';
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
    const mainAgent = { getSession: () => ({ submit: async (text: string) => { addUserInterjection(text); interrupt({ kind: 'user_interjection' }); return { kind: 'steered' }; } }) } as any;
    registry.registerInstance('agent', mainAgent);
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
        { id: 'main', kind: 'primary', agent: mainAgent, activityStream, isAvailable: () => true },
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

  it('keeps child interjections out of the primary UI projection', async () => {
    const addUserInterjection = vi.fn();
    const interrupt = vi.fn();
    const childStream = new ActivityStream('child-call');
    const childAgent = { getSession: () => ({ submit: async (text: string) => { addUserInterjection(text); interrupt({ kind: 'user_interjection' }); return { kind: 'steered' }; } }) } as any;
    const addMessage = vi.fn();
    let completion: Promise<void> | undefined;

    const Harness = () => {
      const { handleInterjection } = useInputHandlers(
        null,
        { id: 'child-call', kind: 'child', agent: childAgent, activityStream: childStream, isAvailable: () => true },
        { addMessage } as unknown as AppActions,
      );
      useEffect(() => { completion = handleInterjection('change the child task'); }, [handleInterjection]);
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

    expect(addUserInterjection).toHaveBeenCalledWith('change the child task');
    expect(interrupt).toHaveBeenCalledWith({ kind: 'user_interjection' });
    expect(addMessage).not.toHaveBeenCalled();
  });

  it('reports a child-completion race instead of dropping or misrouting input', async () => {
    const addUserInterjection = vi.fn();
    const addMessage = vi.fn();
    let completion: Promise<void> | undefined;

    const Harness = () => {
      const { handleInterjection } = useInputHandlers(
        null,
        {
          id: 'finished-child',
          kind: 'child',
          agent: { addUserInterjection, interrupt: vi.fn() } as any,
          activityStream: new ActivityStream('finished-child'),
          isAvailable: () => false,
        },
        { addMessage } as unknown as AppActions,
      );
      useEffect(() => { completion = handleInterjection('late follow-up'); }, [handleInterjection]);
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

    expect(addUserInterjection).not.toHaveBeenCalled();
    expect(addMessage).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('already finished'),
      metadata: { isError: true },
    }));
  });
});

describe('command background and prompt submission', () => {
  it('detaches only selected conversation commands before normal session admission', async () => {
    const order: string[] = [];
    const backgroundForeground = vi.fn((owner: string) => {order.push(owner); return 1;});
    const submit = vi.fn(async (text: string) => {order.push(text); return {kind:'completed'};});
    const childAgent = {getInstanceId:()=> 'selected-child-owner', getSession:()=>({submit})} as any;
    ServiceRegistry.getInstance().registerInstance('bash_process_manager',{backgroundForeground} as any);
    let handlers!: ReturnType<typeof useInputHandlers>;
    function Harness() {
      handlers=useInputHandlers(null,{id:'child',kind:'child',agent:childAgent,activityStream:new ActivityStream('child'),isAvailable:()=>true},{addMessage:vi.fn()} as any);
      return null;
    }
    mounted.push(render(<Harness/>,{stdout:new FakeStdout() as unknown as NodeJS.WriteStream,debug:true,exitOnCtrlC:false,patchConsole:false}));
    await vi.waitFor(()=>expect(handlers).toBeDefined());
    await handlers.handleBackgroundAndSubmit('next instruction');
    expect(order).toEqual(['selected-child-owner','next instruction']);
    expect(submit).toHaveBeenCalledWith('next instruction',expect.objectContaining({mode:'follow_up',execute:expect.any(Function)}));
  });
});


it('executes credential assignments unchanged while redacting the submitted command echo', async () => {
  const input = '/config set api_key=UX-FAKE-CANARY=tail';
  const agent = { getInstanceId: () => 'main', getMessages: () => [] } as any;
  const stream = new ActivityStream(); const addMessage = vi.fn();
  const handleCommand = vi.fn(async () => ({ handled: true, response: `Saved securely: ${input}` }));
  let completion: Promise<void> | undefined;
  const actions = { addMessage } as unknown as AppActions;
  function Harness() {
    const { handleInput } = useInputHandlers({ handleCommand } as any,
      { id: 'main', kind: 'primary', agent, activityStream: stream, isAvailable: () => true }, actions);
    useEffect(() => { completion = handleInput(input); }, [handleInput]);
    return null;
  }
  mounted.push(render(<Harness />, { stdout: new FakeStdout() as unknown as NodeJS.WriteStream,
    debug: true, exitOnCtrlC: false, patchConsole: false }));
  await new Promise(resolve => setTimeout(resolve, 0)); await completion;
  expect(handleCommand).toHaveBeenCalledWith(input, [], expect.anything());
  expect(addMessage).toHaveBeenCalledWith({ role: 'user', content: '/config set api_key=[REDACTED]' });
  expect(JSON.stringify(addMessage.mock.calls)).not.toContain('UX-FAKE-CANARY');
});
