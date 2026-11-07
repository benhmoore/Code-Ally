import React, { useEffect } from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAgentDiagnostics } from '../useAgentDiagnostics.js';
import { logger, LogLevel } from '@services/Logger.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { FocusManager } from '@services/FocusManager.js';
import type { Agent } from '@agent/Agent.js';

class Stdout extends EventEmitter { columns = 100; rows = 30; write = () => true; }
const mounted: Array<{ unmount: () => void }> = [];
const originalLevel = logger.getLevel();
afterEach(() => { mounted.splice(0).forEach(item => item.unmount()); logger.setLevel(originalLevel); vi.restoreAllMocks(); vi.useRealTimers(); });
function agent(tokens: number): Agent {
  return { getScopedRegistry: () => undefined, getTokenManager: () => ({ getCurrentTokenCount: () => tokens, getContextSize: () => 8192 }) } as unknown as Agent;
}

describe('selected agent diagnostics lifecycle', () => {
  it('reacts to debug toggles without polling the logger and stops sampling when disabled or unmounted', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    logger.setLevel(LogLevel.ERROR);
    const memory = vi.spyOn(process, 'memoryUsage');
    const selected = agent(42);
    let current!: ReturnType<typeof useAgentDiagnostics>;
    function Harness() { const value = useAgentDiagnostics(selected); useEffect(() => { current = value; }); return null; }
    const instance = render(<Harness/>, { stdout: new Stdout() as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false });
    mounted.push(instance);
    await vi.waitFor(() => expect(current?.isDebugMode).toBe(false));
    expect(memory).not.toHaveBeenCalled();
    logger.setLevel(LogLevel.DEBUG);
    await vi.waitFor(() => expect(current?.debugStats.tokensUsed).toBe(42));
    expect(current.isDebugMode).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    const activeSamples = memory.mock.calls.length;
    logger.setLevel(LogLevel.ERROR);
    await vi.waitFor(() => expect(current.isDebugMode).toBe(false));
    await vi.advanceTimersByTimeAsync(3000);
    expect(memory).toHaveBeenCalledTimes(activeSamples);
    instance.unmount();
    logger.setLevel(LogLevel.DEBUG);
    await vi.advanceTimersByTimeAsync(3000);
    expect(memory).toHaveBeenCalledTimes(activeSamples);
  });

  it('uses completed token snapshots and subscribes to focus changes without reading a recycled agent', async () => {
    logger.setLevel(LogLevel.DEBUG);
    const focus = new FocusManager();
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name => name === 'focus_manager' ? focus as any : null);
    let current!: ReturnType<typeof useAgentDiagnostics>;
    function Harness({ selected, completed }: { selected?: Agent; completed?: number }) {
      const value = useAgentDiagnostics(selected, completed); useEffect(() => { current = value; }); return null;
    }
    const selected = agent(9);
    const instance = render(<Harness selected={selected}/>, { stdout: new Stdout() as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false });
    mounted.push(instance);
    await vi.waitFor(() => expect(current?.debugStats.tokensUsed).toBe(9));
    await focus.setFocus('/tmp');
    await vi.waitFor(() => expect(current.currentFocus).not.toBeNull());
    focus.clearFocus();
    await vi.waitFor(() => expect(current.currentFocus).toBeNull());
    instance.rerender(<Harness completed={123}/>);
    await vi.waitFor(() => expect(current.debugStats.tokensUsed).toBe(123));
    expect(current.debugStats.tokensTotal).toBe(0);
  });
});
