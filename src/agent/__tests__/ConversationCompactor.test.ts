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

function toolTurn(pairCount: number, resultWords: number): Message[] {
  const messages: Message[] = [{
    id: 'request',
    role: 'user',
    content: 'Build the complete feature autonomously and verify it.',
    timestamp: 1,
  }];
  for (let index = 0; index < pairCount; index++) {
    const callId = `call-${index}`;
    messages.push({
      id: `assistant-${index}`,
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: callId,
        type: 'function',
        function: { name: 'write', arguments: JSON.stringify({ path: `src/file-${index}.ts` }) },
      }],
      timestamp: index * 2 + 2,
    }, {
      id: `tool-${index}`,
      role: 'tool',
      name: 'write',
      tool_call_id: callId,
      content: `Wrote src/file-${index}.ts successfully. ${'result '.repeat(resultWords)}`,
      timestamp: index * 2 + 3,
    });
  }
  return messages;
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
    const commit = vi.fn().mockResolvedValue(false);
    const compactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(4096), new ActivityStream(), commit,
    );

    await expect(compactor.compactAndApply(context())).rejects.toThrow(/persistence failed/i);
    expect(commit).toHaveBeenCalledTimes(3);
    expect(manager.getMessages().map(message => message.id)).toEqual(messages.map(message => message.id));
    expect(manager.getCheckpoint()).toBeNull();

    commit.mockResolvedValue(true);
    const retried = await compactor.compactAndApply(context());
    expect(retried.checkpoint.generation).toBe(1);
  });

  it('retries a transient durable commit without rebuilding or mutating early', async () => {
    const manager = new ConversationManager({ initialMessages: history() });
    const commit = vi.fn()
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error('temporary filesystem failure'))
      .mockResolvedValueOnce(true);
    const client = chatClient();
    const compactor = new ConversationCompactor(
      client, manager, new TokenManager(4096), new ActivityStream(), commit,
    );

    const result = await compactor.compactAndApply(context());

    expect(result.checkpoint.generation).toBe(1);
    expect(commit).toHaveBeenCalledTimes(3);
    expect(client.send).toHaveBeenCalledOnce();
  });

  it('compacts completed work inside a long unattended user turn at a safe tool boundary', async () => {
    const messages = toolTurn(8, 520);
    const manager = new ConversationManager({ initialMessages: messages });
    const compactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(4096), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    const compacted = await compactor.checkAndPerformAutoCompaction({ ...context(), phase: 'mid-turn' });
    const active = manager.getMessages();
    const retained = active.filter(message => !message.metadata?.isConversationCheckpoint);
    const checkpoint = manager.getCheckpoint();

    expect(compacted).toBe(true);
    expect(manager.getTranscript().map(message => message.id)).toEqual(messages.map(message => message.id));
    expect(active.length).toBeLessThan(messages.length);
    expect(retained.length).toBeGreaterThan(0);
    expect(retained[0]?.role).toBe('assistant');
    expect(retained[0]?.tool_calls?.length).toBeGreaterThan(0);
    expect(checkpoint?.trigger).toBe('automatic');
    expect(checkpoint?.phase).toBe('mid-turn');
    expect(checkpoint?.source.messageIds).toContain('request');
  });

  it('checkpoints an oversized completed tool exchange with no raw tail', async () => {
    const messages = toolTurn(1, 5_000);
    const manager = new ConversationManager({ initialMessages: messages });
    const compactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(4096), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    const result = await compactor.compactAndApply({ ...context(), phase: 'mid-turn' }, { phase: 'mid-turn' });

    expect(manager.getMessages()).toHaveLength(1);
    expect(manager.getMessages()[0]?.metadata?.isConversationCheckpoint).toBe(true);
    expect(result.checkpoint.retainedMessageIds).toEqual([]);
    expect(result.checkpoint.portability).toBe('extractive');
    expect(result.checkpoint.semanticState.completedWork.some(fact =>
      fact.text.includes('Wrote src/file-0.ts successfully'))).toBe(true);
  });

  it('preserves the latest user message verbatim at a true pre-turn boundary', async () => {
    const latest: Message = {
      id: 'latest-request',
      role: 'user',
      content: 'Now implement the final integration.',
      timestamp: 20,
    };
    const manager = new ConversationManager({ initialMessages: [...history(), latest] });
    const compactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(4096), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    const result = await compactor.compactAndApply({ ...context(), phase: 'pre-turn' }, { phase: 'pre-turn' });

    expect(manager.getMessages().at(-1)).toMatchObject(latest);
    expect(result.checkpoint.retainedMessageIds).toEqual(['latest-request']);
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
