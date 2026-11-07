import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent/Agent.js';
import { ToolManager } from '../../tools/ToolManager.js';
import { ActivityStream } from '../ActivityStream.js';
import { ServiceRegistry } from '../ServiceRegistry.js';
import { switchAgent } from '../AgentSwitcher.js';
import { shutdownApplication } from '../shutdownApplication.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import type { ModelClient } from '../../llm/ModelClient.js';
import { ActivityEventType } from '../../types/index.js';

afterEach(() => vi.restoreAllMocks());

describe('primary agent replacement resource ownership', () => {
  it('drains the old turn, preserves shared resources and subscribers, then closes resources once at shutdown', async () => {
    const registry = ServiceRegistry.getInstance();
    await registry.shutdown();
    const close = vi.fn().mockResolvedValue(undefined);
    const client = { modelName: 'fixture', endpoint: 'fixture', close, send: vi.fn() } as unknown as ModelClient;
    const stream = new ActivityStream();
    const cleanupStream = vi.spyOn(stream, 'cleanup');
    const observer = vi.fn();
    stream.subscribe(ActivityEventType.STATUS_MESSAGE, observer);
    const tools = new ToolManager([]);
    const config = { ...DEFAULT_CONFIG, model: 'fixture' };
    const first = new Agent(client, tools, stream, { config });
    registry.registerInstance('agent', first);
    registry.registerInstance('model_client', client);
    registry.registerInstance('service_model_client', client);
    registry.registerInstance('activity_stream', stream);
    registry.registerInstance('tool_manager', tools);
    registry.registerInstance('config_manager', { getConfig: () => config, getValue: (key: keyof typeof config) => config[key] } as any);
    let finish!: () => void;
    vi.spyOn(first as any, 'executeMessageTurn').mockImplementation(() => new Promise<string>(resolve => {
      finish = () => { first.addMessage({ id: 'last', role: 'assistant', content: 'Final admitted turn message' }); resolve('done'); };
    }));
    const turn = first.sendMessage('admitted request');
    let replaced = false;
    const switching = switchAgent('ally', registry).then(agent => { replaced = true; return agent; });
    await Promise.resolve();
    expect(replaced).toBe(false);
    finish();
    await turn;
    const second = await switching;
    expect(second.getMessages().some(message => message.content === 'Final admitted turn message')).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(cleanupStream).not.toHaveBeenCalled();
    stream.emit({ id: 'still-live', type: ActivityEventType.STATUS_MESSAGE, timestamp: Date.now(), data: { message: 'live' } });
    expect(observer).toHaveBeenCalledOnce();
    await expect(first.sendMessage('late request')).rejects.toThrow();
    expect(await shutdownApplication(registry)).toEqual([]);
    expect(close).toHaveBeenCalledOnce();
    expect(cleanupStream).toHaveBeenCalledOnce();
  });
});
