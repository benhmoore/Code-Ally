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

/** Tool exchanges whose results use the real harness envelope shape. */
function envelopeTurn(pairCount: number, resultWords: number, pathPrefix = '/repo/src/file'): Message[] {
  const messages: Message[] = [{
    id: 'request',
    role: 'user',
    content: 'Build the complete feature autonomously and verify it.',
    timestamp: 1,
  }];
  for (let index = 0; index < pairCount; index++) {
    const callId = `call-${index}`;
    const filePath = `${pathPrefix}-${index}.ts`;
    const filler = Array.from({ length: resultWords }, (_, word) => `w${word}`).join(' ');
    messages.push({
      id: `assistant-${pathPrefix}-${index}`,
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: callId,
        type: 'function',
        function: { name: 'write', arguments: JSON.stringify({ file_path: filePath }) },
      }],
      timestamp: index * 2 + 2,
    }, {
      id: `tool-${pathPrefix}-${index}`,
      role: 'tool',
      name: 'write',
      tool_call_id: callId,
      content: `[Tool Call ID: ${callId}]\n${JSON.stringify({
        success: true,
        error: '',
        content: `Created new file ${filePath} (${filler})`,
      }, null, 2)}`,
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
    const tokens = new TokenManager(4096);
    const client = chatClient();
    const compactor = new ConversationCompactor(
      client, manager, tokens, new ActivityStream(), vi.fn().mockResolvedValue(true),
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
    expect(checkpoint?.portability).toBe('extractive');
    expect(client.send).not.toHaveBeenCalled();
    expect(checkpoint?.source.messageIds).toContain('request');
    // 15% of a 4096-token window must remain between the compacted result and
    // the automatic trigger, preventing another compaction after a few small messages.
    expect(compactor.budget(context()).triggerBudget - tokens.getCurrentTokenCount()).toBeGreaterThanOrEqual(614);
  });

  it('bounds a stalled manual reducer and falls back without aborting the owner', async () => {
    vi.useFakeTimers();
    try {
      const owner = new AbortController();
      const client = chatClient();
      client.send.mockImplementation((_messages: Message[], options: { signal: AbortSignal }) =>
        new Promise(resolve => options.signal.addEventListener('abort', () => resolve({
          role: 'assistant',
          content: '',
          interrupted: true,
        }), { once: true }))
      );
      const manager = new ConversationManager({ initialMessages: history() });
      const compactor = new ConversationCompactor(
        client, manager, new TokenManager(4096), new ActivityStream(), vi.fn().mockResolvedValue(true),
      );

      const resultPromise = compactor.compactAndApply({ ...context(), signal: owner.signal });
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;

      expect(owner.signal.aborted).toBe(false);
      expect(result.checkpoint.portability).toBe('extractive');
      expect(result.checkpoint.degradedReason).toMatch(/deadline/i);
      expect(compactor.getDebugState()).toMatchObject({
        active: false,
        stage: 'complete',
      });
    } finally {
      vi.useRealTimers();
    }
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

  it('keeps successful tool envelopes out of blockers and bounds checkpoint entries', async () => {
    const messages = envelopeTurn(6, 400);
    const manager = new ConversationManager({ initialMessages: messages });
    const compactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(4096), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    const compacted = await compactor.checkAndPerformAutoCompaction({ ...context(), phase: 'mid-turn' });
    const checkpoint = manager.getCheckpoint();

    expect(compacted).toBe(true);
    // Every result carried `"error":""` — none of them is a blocker.
    expect(checkpoint?.semanticState.blockers).toHaveLength(0);
    expect(checkpoint?.semanticState.completedWork.length).toBeGreaterThan(0);
    // Summaries, not raw payload blobs.
    for (const entry of checkpoint!.semanticState.completedWork) {
      expect(entry.text.length).toBeLessThanOrEqual(450);
    }
  });

  it('carries the artifact inventory and completed work forward across generations', async () => {
    const manager = new ConversationManager({ initialMessages: envelopeTurn(4, 300, '/repo/src/alpha') });
    const compactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(4096), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    const first = await compactor.compactAndApply({ ...context(), phase: 'mid-turn' }, {
      trigger: 'automatic', phase: 'mid-turn', forceExtractive: true,
    });
    expect(first.checkpoint.semanticState.artifacts.some(a => a.path === '/repo/src/alpha-0.ts')).toBe(true);

    manager.addMessages(envelopeTurn(4, 300, '/repo/src/beta').slice(1));
    const second = await compactor.compactAndApply({ ...context(), phase: 'mid-turn' }, {
      trigger: 'automatic', phase: 'mid-turn', forceExtractive: true,
    });

    expect(second.checkpoint.generation).toBe(2);
    const paths = second.checkpoint.semanticState.artifacts.map(artifact => artifact.path);
    // Generation-1 work stays recoverable in generation 2 via the artifact
    // inventory: this is what lets a long task remain lucid across many
    // compactions. (completedWork intentionally keeps only recent summaries,
    // and the newest exchanges live raw in the retained tail, not the
    // checkpoint.)
    expect(paths).toContain('/repo/src/alpha-0.ts');
    expect(paths).toContain('/repo/src/beta-0.ts');
  });

  it('remains lucid with stable runway across many generations of a long task', async () => {
    // Regression for the compaction death-spiral: on a small window, fixed
    // overhead plus a growing low-signal checkpoint made every generation
    // reclaim less than the last until the agent had no working room at all.
    const manager = new ConversationManager({ initialMessages: [{
      id: 'objective',
      role: 'user',
      content: 'Build a complete voxel game. Keep modules separate. Test in the browser.',
      timestamp: 1,
    }] });
    const tokens = new TokenManager(16_384);
    const compactor = new ConversationCompactor(
      chatClient(), manager, tokens, new ActivityStream(), vi.fn().mockResolvedValue(true),
    );
    const runContext = { ...context(), modelMaxOutput: 2_048, phase: 'mid-turn' as const };

    let generations = 0;
    for (let iteration = 0; iteration < 200 && generations < 12; iteration++) {
      // Realistic work shape: whole-file reads (the payload-heavy spiral
      // trigger) interleaved with writes, all in real envelope form.
      const filler = Array.from({ length: 500 }, (_, w) => `it${iteration}w${w}`).join(' ');
      const callId = `call-${iteration}`;
      const filePath = `/repo/src/gen-${iteration}.ts`;
      const toolName = iteration % 2 === 0 ? 'write' : 'read';
      manager.addMessages([{
        id: `assistant-${iteration}`,
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: callId,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify({ file_path: filePath }) },
        }],
        timestamp: iteration * 2 + 10,
      }, {
        id: `tool-${iteration}`,
        role: 'tool',
        name: toolName,
        tool_call_id: callId,
        content: `[Tool Call ID: ${callId}]\n${JSON.stringify({
          success: true,
          error: '',
          content: toolName === 'write'
            ? `Created new file ${filePath} (${filler})`
            : `=== ${filePath} ===\n[500 lines]\n${filler}`,
        }, null, 2)}`,
        timestamp: iteration * 2 + 11,
      }]);

      const budget = compactor.budget(runContext);
      if (!budget.shouldCompact) continue;
      const compacted = await compactor.checkAndPerformAutoCompaction(runContext);
      expect(compacted).toBe(true);
      generations++;

      const after = compactor.budget(runContext);
      // Every generation must restore real working room. This is the invariant
      // whose violation produced the shrinking-runway spiral.
      expect(after.triggerBudget - after.estimatedInput)
        .toBeGreaterThanOrEqual(Math.floor(after.usableBudget * 0.3));

      const checkpoint = manager.getCheckpoint()!;
      // Lucidity invariants, at every generation:
      expect(checkpoint.semanticState.objective?.text).toContain('voxel game');
      expect(checkpoint.semanticState.blockers).toHaveLength(0);
      // The recent artifact inventory survives so work stays re-findable.
      expect(checkpoint.semanticState.artifacts.length).toBeGreaterThanOrEqual(6);
    }

    expect(generations).toBe(12);
    // The inventory accumulates across generations instead of resetting: late
    // context windows still know about work from many generations earlier.
    expect(manager.getCheckpoint()!.semanticState.artifacts.length).toBeGreaterThanOrEqual(20);
  });

  it('rejects with configuration guidance when overhead leaves no usable context', async () => {
    const manager = new ConversationManager({ initialMessages: history() });
    const compactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(1024), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    await expect(compactor.compactAndApply(context()))
      .rejects.toThrow(/cannot sustain this configuration/i);
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
