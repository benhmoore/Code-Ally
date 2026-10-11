import React, { useEffect } from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { useServiceInitialization } from '../useServiceInitialization.js';
import type { Agent } from '../../../agent/Agent.js';
import type { AppActions } from '../../contexts/AppContext.js';

vi.mock('@services/CommandHistory.js', () => ({ CommandHistory: class { async load() {} } }));
vi.mock('@services/CompletionProvider.js', () => ({ CompletionProvider: class {} }));
vi.mock('@agent/CommandHandler.js', () => ({ CommandHandler: class {} }));
vi.mock('@services/ServiceRegistry.js', () => ({ ServiceRegistry: { getInstance: () => ({
  get: (name: string) => name === 'config_manager' ? { getValue: () => true } : undefined,
}) } }));
class Stdout extends EventEmitter { columns = 80; rows = 24; write = () => true; }

describe('input service readiness', () => {
  it('publishes command handling with completion readiness without another unrelated render', async () => {
    const ready = vi.fn();
    const actions = {} as AppActions;
    const agent = {} as Agent;
    function Harness() {
      const services = useServiceInitialization(agent, actions);
      useEffect(() => {
        if (services.completionProvider) ready(services.commandHandler, services.commandHistory);
      }, [services.completionProvider, services.commandHandler, services.commandHistory]);
      return null;
    }
    const instance = render(<Harness/>, { stdout: new Stdout() as unknown as NodeJS.WriteStream,
      debug: true, exitOnCtrlC: false, patchConsole: false });
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(ready).toHaveBeenCalledOnce();
      expect(ready).toHaveBeenCalledWith(expect.any(Object), expect.any(Object));
    } finally { instance.unmount(); }
  });
});
