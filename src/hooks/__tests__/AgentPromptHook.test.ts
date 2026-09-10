/**
 * The UserPromptSubmit hook runs inside the turn claim. A hook can hold its
 * await open for its whole timeout, and an unclaimed agent would admit a
 * second turn into that window and corrupt the state both share.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../../agent/Agent.js';
import { ToolManager } from '@tools/ToolManager.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import type { Config } from '@shared/index.js';
import type { ModelClient } from '@llm/ModelClient.js';
import type { HookEvent, HookVerdict } from '../types.js';

const config = {
  model: 'test-model',
  endpoint: 'http://localhost:11434',
  context_size: 8192,
  temperature: 0.7,
  max_tokens: 2048,
  bash_timeout: 120000,
  auto_confirm: true,
  parallel_tools: false,
  theme: 'default',
  stream_responses: false,
  setup_completed: true,
} as unknown as Config;

function buildAgent(): { agent: Agent; send: ReturnType<typeof vi.fn> } {
  const activityStream = new ActivityStream();
  const send = vi.fn(async () => ({ role: 'assistant', content: 'done', tool_calls: [] }) as any);
  const agent = new Agent(
    { send, close: vi.fn(), cancel: vi.fn(), setModelName: vi.fn() } as unknown as ModelClient,
    new ToolManager([]),
    activityStream,
    { config, isSpecializedAgent: false },
  );
  return { agent, send };
}

describe('UserPromptSubmit around the turn claim', () => {
  let release!: (verdict: HookVerdict) => void;

  beforeEach(() => {
    ServiceRegistry.getInstance().registerInstance('hook_runner', {
      hasHooks: (event: HookEvent) => event === 'UserPromptSubmit',
      run: () => new Promise<HookVerdict>(resolve => { release = resolve; }),
    } as any);
  });

  afterEach(() => {
    const registry = ServiceRegistry.getInstance() as any;
    registry._services.delete('hook_runner');
    vi.restoreAllMocks();
  });

  it('holds the claim while the hook runs and releases it when the hook blocks', async () => {
    const { agent, send } = buildAgent();

    const turn = agent.sendMessage('do the thing');
    await vi.waitFor(() => expect(release).toBeDefined());

    expect(agent.isProcessing()).toBe(true);
    await expect(agent.sendMessage('and another')).rejects.toThrow('already processing a turn');

    release({ kind: 'block', reason: 'prompts are reviewed first', source: 'settings' });
    expect(await turn).toBe('prompts are reviewed first');
    expect(send).not.toHaveBeenCalled();
    expect(agent.isProcessing()).toBe(false);
  });
});
