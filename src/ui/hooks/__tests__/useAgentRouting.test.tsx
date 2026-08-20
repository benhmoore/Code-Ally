import React, { useEffect } from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it } from 'vitest';
import type { Agent } from '@agent/Agent.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ActivityEventType } from '@shared/index.js';
import { AgentRouting, useAgentRouting } from '../useAgentRouting.js';

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

function fakeAgent(id: string): Agent {
  return {
    getInstanceId: () => id,
    getAgentName: () => id,
    getModelClient: () => ({ modelName: `${id}-model` }),
  } as Agent;
}

describe('useAgentRouting', () => {
  it('changes only the foreground route when entering and exiting a child', async () => {
    const main = fakeAgent('main-instance');
    const child = fakeAgent('child-instance');
    const registry = ServiceRegistry.getInstance();
    const activityStream = new ActivityStream();
    const observed: AgentRouting[] = [];
    const primaryAnnouncements: string[] = [];

    activityStream.subscribe(ActivityEventType.AGENT_SWITCHED, (event) => {
      primaryAnnouncements.push(event.data?.agentId);
    });

    registry.registerInstance('agent', main);

    const Harness = () => {
      const current = useAgentRouting(main, activityStream);
      useEffect(() => { observed.push(current); }, [current]);
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
    expect(primaryAnnouncements).toEqual(['main-instance']);

    registry.registerInstance('agent', child);
    activityStream.emit({
      id: 'foreground-child',
      type: ActivityEventType.FOREGROUND_AGENT_CHANGED,
      timestamp: Date.now(),
      data: { agentId: 'task-id', agentName: 'task', isMain: false },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed.at(-1)).toEqual({ primaryAgent: main, foregroundAgent: child, foregroundAgentId: 'task-id' });
    expect(primaryAnnouncements).toEqual(['main-instance']);

    registry.registerInstance('agent', main);
    activityStream.emit({
      id: 'foreground-main',
      type: ActivityEventType.FOREGROUND_AGENT_CHANGED,
      timestamp: Date.now(),
      data: { agentId: 'main', agentName: 'ally', isMain: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed.at(-1)).toEqual({ primaryAgent: main, foregroundAgent: main, foregroundAgentId: 'main' });
    expect(primaryAnnouncements).toEqual(['main-instance']);
  });

  it('replaces both routes when the primary conversation changes agent', async () => {
    const first = fakeAgent('first');
    const second = fakeAgent('second');
    const registry = ServiceRegistry.getInstance();
    const activityStream = new ActivityStream();
    let observed: AgentRouting | undefined;

    registry.registerInstance('agent', first);
    const Harness = () => {
      const current = useAgentRouting(first, activityStream);
      useEffect(() => { observed = current; }, [current]);
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

    registry.registerInstance('agent', second);
    activityStream.emit({
      id: 'agent-switch',
      type: ActivityEventType.AGENT_SWITCHED,
      timestamp: Date.now(),
      data: { agentId: 'second', agentName: 'review' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed).toEqual({ primaryAgent: second, foregroundAgent: second, foregroundAgentId: 'main' });
  });
});
