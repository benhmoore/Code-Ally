import { expect, it, vi } from 'vitest';
import { TokenManager } from '../TokenManager.js';
import { ContextBudgetPlanner, requestOutputLimit } from '../context/ContextBudget.js';
import { OllamaClient } from '../../llm/OllamaClient.js';
import { OpenAICompatClient } from '../../llm/OpenAICompatClient.js';
import { OpenAIResponsesClient } from '../../llm/OpenAIResponsesClient.js';
import { ConfigurableModelClient } from '../../llm/ConfigurableModelClient.js';
import { Agent } from '../Agent.js';
import { ToolManager } from '../../tools/ToolManager.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import type { Message } from '../../types/index.js';

const config = { endpoint: 'http://fixture', modelName: 'fixture', contextSize: 32768, maxTokens: 4096 };
const requestOptions = () => ({ signal: new AbortController().signal, stream: false });

it('charges native plaintext reasoning once and does not charge unsent Compat/Responses UI or opaque data', async () => {
  const native = new OllamaClient(config);
  const compat = new OpenAICompatClient(config);
  const responses = new OpenAIResponsesClient(config);
  const message: Message = {
    id: 'thought',
    role: 'assistant',
    content: 'answer',
    thinking: 'reason '.repeat(1000),
    metadata: { tool_context: { call: { thinking: 'duplicated UI trace '.repeat(3000) } } },
    images: ['opaque-image'.repeat(1000)],
  };
  const baseline = new TokenManager(32768).estimateMessageTokens(message);
  for (const client of [native, compat, responses]) {
    const manager = new TokenManager(32768, value => client.getReplayedReasoningText(value));
    expect(manager.estimateMessageTokens(message)).toBe(
      baseline + (client === native ? manager.estimateTokens(message.thinking!) : 0)
    );
  }
  const nativePayload = native.previewRequest([message], requestOptions()).payload.messages as Message[];
  const compatPayload = compat.previewRequest([message], requestOptions()).payload.messages as Message[];
  expect(nativePayload[0]?.thinking).toBe(message.thinking);
  expect(compatPayload[0]).not.toHaveProperty('thinking');
  expect(message.metadata?.tool_context?.call?.thinking).toContain('duplicated UI trace');
  await Promise.all([native.close(), compat.close(), responses.close()]);
});

it('invalidates same-ID cached costs when thinking grows or the active transport replay policy changes', async () => {
  const client = new ConfigurableModelClient('ollama', config, provider =>
    provider === 'ollama' ? new OllamaClient(config) : new OpenAICompatClient(config)
  );
  const manager = new TokenManager(32768, value => client.getReplayedReasoningText(value));
  const message: Message = { id: 'same', role: 'assistant', content: 'answer', thinking: 'initial thought' };
  const first = manager.estimateMessagesTokens([message]);
  message.thinking = 'growing thought '.repeat(1000);
  const grown = manager.estimateMessagesTokens([message]);
  expect(grown).toBeGreaterThan(first);
  client.setProvider('openai-compat');
  expect(manager.estimateMessagesTokens([message])).toBe(new TokenManager(32768).estimateMessageTokens(message));
  client.setProvider('ollama');
  expect(manager.estimateMessagesTokens([message])).toBe(grown);
  await client.close();
});

it('triggers 32k compaction and bounds the next output cap before a long native thought is sent', async () => {
  const client = new OllamaClient(config);
  const manager = new TokenManager(32768, value => client.getReplayedReasoningText(value));
  const message: Message = { role: 'assistant', content: 'working', thinking: 'analysis '.repeat(30000) };
  const baseline = new TokenManager(32768).estimateMessagesTokens([message]);
  const budget = new ContextBudgetPlanner(manager).plan({ messages: [message], modelMaxOutput: 4096 });
  expect(budget.estimatedInput).toBeGreaterThan(25000);
  expect(budget.estimatedInput).toBeLessThan(32768);
  expect(budget.shouldCompact).toBe(true);
  const cap = requestOutputLimit(32768, budget.estimatedInput, 4096);
  expect(cap).toBeLessThan(requestOutputLimit(32768, baseline, 4096));
  expect(budget.estimatedInput + cap).toBeLessThanOrEqual(32768);
  await client.close();
});

it('calibrates on the same reasoning-inclusive basis without learning negative uncertain reasoning as fixed overhead', () => {
  const manager = new TokenManager(32768, message => message.thinking);
  const message: Message = { role: 'assistant', content: 'answer', thinking: 'reason '.repeat(1000) };
  const raw = manager.estimateMessagesTokens([message]);
  manager.calibrate(raw, raw + 100, { containsReplayedReasoning: manager.hasReplayedReasoning([message]) });
  expect(new ContextBudgetPlanner(manager).plan({ messages: [message] }).estimatedInput).toBe(raw + 100);
  manager.calibrate(raw, 100, { containsReplayedReasoning: true });
  expect(manager.getCalibrationOverhead()).toBe(100);
  manager.calibrate(1000, 900);
  expect(manager.getCalibrationOverhead()).toBe(20);
});

it('wires the provider-owned estimator into both root and delegated Agent token managers without changing history', async () => {
  const client = new OllamaClient(config);
  const root = new Agent(client, new ToolManager([]), new ActivityStream(), {
    config: { ...DEFAULT_CONFIG, context_size: 32768 },
  });
  const child = new Agent(client, new ToolManager([]), new ActivityStream(), {
    config: { ...DEFAULT_CONFIG, context_size: 32768 },
    isSpecializedAgent: true,
  });
  const message: Message = { role: 'assistant', content: '', thinking: 'active tool reasoning '.repeat(100) };
  try {
    for (const agent of [root, child]) {
      agent.getConversationManager().addMessage(message);
      expect(agent.getTokenManager().estimateMessageTokens(message)).toBe(
        4 + agent.getTokenManager().estimateTokens(message.thinking!)
      );
      expect(agent.getConversationManager().getMessages().at(-1)?.thinking).toBe(message.thinking);
    }
  } finally {
    await child.cleanup();
    await root.cleanup();
  }
});

it('does not learn old native reasoning as fixed overhead when the transport changes during its response', async () => {
  const native = new OllamaClient(config);
  const client = new ConfigurableModelClient('ollama', config, provider =>
    provider === 'ollama' ? native : new OpenAICompatClient(config)
  );
  vi.spyOn(native, 'send').mockImplementation(async (messages, options) => {
    const count = new TokenManager(32768, message => message.thinking);
    const promptTokens =
      count.estimateMessagesTokens(messages) + count.estimateTokens(JSON.stringify(options.functions ?? [])) + 100;
    client.setProvider('openai-compat');
    return { role: 'assistant', content: 'done', usage: { promptTokens, completionTokens: 1 } };
  });
  const agent = new Agent(client, new ToolManager([]), new ActivityStream(), {
    config: { ...DEFAULT_CONFIG, context_size: 32768 },
  });
  try {
    agent
      .getConversationManager()
      .addMessage({ role: 'assistant', content: 'earlier', thinking: 'replayed native reasoning '.repeat(1000) });
    await agent.sendMessage('Continue.');
    expect(native.send).toHaveBeenCalledOnce();
    expect(agent.getTokenManager().getCalibrationOverhead()).toBe(0);
  } finally {
    await agent.cleanup();
  }
});
