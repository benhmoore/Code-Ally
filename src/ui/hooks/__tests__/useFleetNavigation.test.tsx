import React, { useEffect, useState } from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useFleetNavigation } from '../useFleetNavigation.js';
import { ActivityProvider } from '../../contexts/ActivityContext.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { frozenConversation, EMPTY_CONVERSATION } from '../useConversationSelector.js';
import type { Agent } from '@agent/Agent.js';
import type { BackgroundAgentTask } from '@services/BackgroundAgentManager.js';
import { ActivityEventType } from '@shared/index.js';

class Stdout extends EventEmitter { columns = 100; rows = 30; write = () => true; }
const mounted: Array<{ unmount: () => void }> = [];
afterEach(() => { mounted.splice(0).forEach(item => item.unmount()); vi.restoreAllMocks(); });
function agent(name: string) {
  const source = frozenConversation({ ...EMPTY_CONVERSATION, messages: [{ id: name, role: 'user', content: name }] });
  const controls = { ...source, setToolCallsExpanded: vi.fn(), toggleToolCallExpanded: vi.fn() };
  return { getSession: () => controls, getTokenManager: () => ({ getCurrentTokenCount: () => 10 }) } as unknown as Agent;
}

describe('fleet conversation ownership', () => {
  it('retains frozen completed children across pool reuse and returns to root only after removal', async () => {
    const main = agent('root');
    const child = agent('child');
    const completed = { ...EMPTY_CONVERSATION, messages: [{ id: 'frozen', role: 'user' as const, content: 'frozen child' }] };
    let tasks = [{ id: 'task', subAgent: child, status: 'running' }] as BackgroundAgentTask[];
    const stream = new ActivityStream();
    const manager = { listTasks: () => tasks };
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name => name === 'background_agent_manager' ? manager as any : null);
    let fleet!: ReturnType<typeof useFleetNavigation>;
    function Harness() {
      const [activeAgentId, setActiveAgentId] = useState('main');
      const [foreground, setForeground] = useState({ agent: main, id: 'main' });
      const current = useFleetNavigation({ activeAgentId, primaryAgent: main, foregroundAgent: foreground.agent, foregroundAgentId: foreground.id,
        actions: { setActiveAgentId, repaintConversationSurface: () => {} },
        selectForegroundConversation: (selected, id) => setForeground({ agent: selected, id }),
        returnToPrimaryConversation: () => setForeground({ agent: main, id: 'main' }) });
      useEffect(() => { fleet = current; });
      return null;
    }
    const instance = render(<ActivityProvider activityStream={stream}><Harness/></ActivityProvider>,
      { stdout: new Stdout() as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false });
    mounted.push(instance);
    await vi.waitFor(() => expect(fleet).toBeDefined());
    fleet.handleEnterAgent(1);
    await vi.waitFor(() => expect(fleet.isChildSelected).toBe(true));
    expect(fleet.conversationControls).toBe(child.getSession());
    fleet.conversationControls!.setToolCallsExpanded(true);
    expect(child.getSession().setToolCallsExpanded).toHaveBeenCalledWith(true);
    expect(main.getSession().setToolCallsExpanded).not.toHaveBeenCalled();
    tasks = [{ id: 'task', subAgent: child, status: 'done', completedView: completed, completedTokens: 12 }] as BackgroundAgentTask[];
    stream.emit({ id: 'done', type: ActivityEventType.AGENT_BACKGROUND_COMPLETE, timestamp: Date.now() });
    await vi.waitFor(() => expect(fleet.completedChild).toBe(true));
    expect(fleet.conversationControls).toBeUndefined();
    expect(fleet.conversationSource.getSnapshot()).toBe(completed);
    child.getSession = () => main.getSession(); // Pool reuse must not change the selected history.
    expect(fleet.conversationSource.getSnapshot()).toBe(completed);
    tasks = [];
    stream.emit({ id: 'removed', type: ActivityEventType.AGENT_BACKGROUND_COMPLETE, timestamp: Date.now() });
    await vi.waitFor(() => expect(fleet.isChildSelected).toBe(false));
    expect(fleet.conversationSource).toBe(main.getSession());
  });

  it('never displays the pooled agent or root history when a completed snapshot is unavailable', async () => {
    const main = agent('root');
    const reused = agent('unrelated pooled work');
    const manager = { listTasks: () => [{ id: 'done', status: 'done', subAgent: reused }] };
    vi.spyOn(ServiceRegistry.getInstance(), 'get').mockImplementation(name => name === 'background_agent_manager' ? manager as any : null);
    let current!: ReturnType<typeof useFleetNavigation>;
    function Harness() {
      const fleet = useFleetNavigation({ activeAgentId: 'done', primaryAgent: main, foregroundAgent: reused, foregroundAgentId: 'done',
        actions: { setActiveAgentId: () => {}, repaintConversationSurface: () => {} }, selectForegroundConversation: () => {}, returnToPrimaryConversation: () => {} });
      useEffect(() => { current = fleet; });
      return null;
    }
    mounted.push(render(<ActivityProvider activityStream={new ActivityStream()}><Harness/></ActivityProvider>,
      { stdout: new Stdout() as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false }));
    await vi.waitFor(() => expect(current).toBeDefined());
    expect(current.conversationSource.getSnapshot().messages).toEqual([]);
    expect(current.conversationControls).toBeUndefined();
  });
});
