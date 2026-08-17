import { describe, expect, it, vi } from 'vitest';
import { ConversationCompactor } from '../ConversationCompactor.js';
import { ConversationManager } from '../ConversationManager.js';
import { TokenManager } from '../TokenManager.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import type { Message } from '../../types/index.js';

const signal = new AbortController().signal;

function history(): Message[] {
  return Array.from({ length: 12 }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `${index}: ${'context '.repeat(300)}`,
    timestamp: index + 1,
  }));
}

function context() {
  let id = 0;
  return {
    instanceId: 'test',
    isSpecializedAgent: false,
    generateId: () => `id-${++id}`,
    signal,
    modelMaxOutput: 256,
    phase: 'manual' as const,
  };
}

function chatClient() {
  return {
    providerId: 'chat',
    capabilities: { nativeCompaction: false, exactInputTokens: false, opaqueReasoningReplay: false },
    modelName: 'test-model',
    endpoint: 'test',
    // Force the bounded deterministic reducer path.
    send: vi.fn().mockResolvedValue({ role: 'assistant', content: 'not-json' }),
  } as any;
}

describe('ConversationCompactor', () => {
  it('commits atomically while preserving the complete visible transcript', async () => {
    const messages = history();
    const manager = new ConversationManager({ initialMessages: messages });
    const commit = vi.fn().mockResolvedValue(true);
    const compactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(4096), new ActivityStream(), commit,
    );

    const result = await compactor.compactAndApply(context());

    expect(commit).toHaveBeenCalledOnce();
    expect(manager.getTranscript().map(message => message.id)).toEqual(messages.map(message => message.id));
    expect(manager.getMessages().length).toBeLessThan(messages.length);
    expect(manager.getMessages().some(message => message.metadata?.isConversationCheckpoint)).toBe(true);
    expect(manager.getTranscript().some(message => message.metadata?.isConversationCheckpoint)).toBe(false);
    expect(result.checkpoint.generation).toBe(1);
  });

  it('does not mutate memory or consume a generation when durable commit fails', async () => {
    const messages = history();
    const manager = new ConversationManager({ initialMessages: messages });
    const commit = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const compactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(4096), new ActivityStream(), commit,
    );

    await expect(compactor.compactAndApply(context())).rejects.toThrow(/persistence failed/i);
    expect(manager.getMessages().map(message => message.id)).toEqual(messages.map(message => message.id));
    expect(manager.getCheckpoint()).toBeNull();

    const retried = await compactor.compactAndApply(context());
    expect(retried.checkpoint.generation).toBe(1);
  });

  it('uses provider-native compaction as canonical replay state and exact post-counting', async () => {
    const manager = new ConversationManager({ initialMessages: history() });
    const nativeState = {
      kind: 'openai-responses' as const,
      items: [{ type: 'compaction', encrypted_content: 'opaque' }],
      coveredMessageIds: history().map(message => message.id!),
    };
    const client = {
      providerId: 'openai-responses',
      capabilities: { nativeCompaction: true, exactInputTokens: true, opaqueReasoningReplay: true },
      modelName: 'gpt-test',
      endpoint: 'https://api.openai.com',
      send: vi.fn().mockResolvedValue({ role: 'assistant', content: 'not-json' }),
      compactProviderState: vi.fn().mockResolvedValue(nativeState),
      countInput: vi.fn().mockImplementation((_messages: Message[], options: any) =>
        options.providerState?.kind === 'openai-responses' ? 1000 : 3900),
    } as any;
    const compactor = new ConversationCompactor(
      client, manager, new TokenManager(4096), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    const result = await compactor.compactAndApply(context());

    expect(result.checkpoint.strategy).toBe('openai-native');
    expect(result.checkpoint.providerState).toEqual(nativeState);
    expect(result.checkpoint.budget.exactBefore).toBe(3900);
    expect(result.checkpoint.budget.after).toBe(1000);
    expect(client.compactProviderState).toHaveBeenCalledOnce();
  });
});
