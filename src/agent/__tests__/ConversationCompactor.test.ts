import { describe, expect, it, vi } from 'vitest';
import { ConversationCompactor } from '../ConversationCompactor.js';
import { ConversationManager } from '../ConversationManager.js';
import { TokenManager } from '../TokenManager.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { checkpointSourceDigest } from '../compaction/CheckpointReducer.js';
import { ActivityEventType, type Message } from '../../types/index.js';

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

function structuredClient() {
  return {
    providerId: 'chat',
    capabilities: { nativeCompaction: false, exactInputTokens: false, opaqueReasoningReplay: false },
    modelName: 'test-model',
    endpoint: 'test',
    send: vi.fn().mockImplementation(async (messages: Message[]) => {
      const request = JSON.parse(messages[1]!.content);
      const transcript = String(request.transcriptJsonLines)
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
      const firstId = transcript[0].id;
      const lastId = transcript.at(-1).id;
      return {
        role: 'assistant',
        content: JSON.stringify({
          schemaVersion: 1,
          objective: { text: 'Complete the durable objective.', sourceMessageIds: [firstId] },
          currentRequest: { text: 'Continue from the latest evidence.', sourceMessageIds: [lastId] },
          userConstraints: [],
          decisions: [],
          completedWork: [],
          activeWork: [{ text: 'Continue the active implementation.', sourceMessageIds: [lastId] }],
          blockers: [],
          nextActions: [{ text: 'Execute the next verified step.', sourceMessageIds: [lastId] }],
          unresolvedQuestions: [],
          durableFacts: [],
          artifacts: [],
        }),
      };
    }),
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

  it('continues checkpoint generations after late session restoration', async () => {
    const manager = new ConversationManager({ initialMessages: history() });
    // Agents construct their compactor before the UI asynchronously loads a
    // resumed conversation, so this instance initially observes generation 0.
    const resumedCompactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(4096), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );
    const originalCompactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(4096), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    const first = await originalCompactor.compactAndApply(context());
    expect(first.checkpoint.generation).toBe(1);

    resumedCompactor.synchronizeCheckpointState();
    manager.addMessage({ id: 'after-resume', role: 'user', content: 'Continue.', timestamp: 99 });
    const next = await resumedCompactor.compactAndApply(context());

    expect(next.checkpoint.generation).toBe(2);
    expect(next.checkpoint.parentId).toBe(first.checkpoint.id);
  });

  it('continues auto-compacting after the bounded transcript tail reaches capacity', async () => {
    const messages: Message[] = Array.from({ length: 500 }, (_, index) => ({
      id: `initial-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `initial ${index} ${'context '.repeat(20)}`,
      timestamp: index + 1,
    }));
    const manager = new ConversationManager({ initialMessages: messages });
    const tokens = new TokenManager(16_384);
    const compactor = new ConversationCompactor(
      chatClient(), manager, tokens, new ActivityStream(), vi.fn().mockResolvedValue(true),
    );
    const runContext = { ...context(), phase: 'mid-turn' as const };

    const first = await compactor.compactAndApply(runContext, { forceExtractive: true });
    expect(first.checkpoint.generation).toBe(1);
    expect(manager.getTranscript()).toHaveLength(500);

    for (let index = 0; index < 120; index++) {
      manager.addMessage({
        id: `later-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `later ${index} ${'new work '.repeat(35)}`,
        timestamp: 1_000 + index,
      });
    }
    tokens.resetContextTracking(manager.getMessages());

    expect(manager.getTranscript()).toHaveLength(500);
    expect(compactor.budget(runContext).shouldCompact).toBe(true);

    const compacted = await compactor.checkAndPerformAutoCompaction(runContext);

    expect(compacted).toBe(true);
    expect(manager.getCheckpoint()?.generation).toBe(2);
  });

  it('digests canonical transcript content after active-window eviction', async () => {
    const messages = history();
    const manager = new ConversationManager({ initialMessages: messages });
    manager.replaceActiveMessages(manager.getMessages().map(message => ({
      ...message,
      content: `[active-window stub for ${message.id}]`,
      metadata: { ...message.metadata, contentEvicted: true },
    })));
    const compactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(4096), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    const result = await compactor.compactAndApply(context(), {
      forceExtractive: true,
      forceNoRetainedTail: true,
    });
    const transcriptById = new Map(manager.getTranscript().map(message => [message.id, message]));
    const canonicalSource = result.checkpoint.source.messageIds.map(id => transcriptById.get(id)!);

    expect(canonicalSource.every(message => !message.content.includes('active-window stub'))).toBe(true);
    expect(result.checkpoint.source.digest).toBe(checkpointSourceDigest(canonicalSource));
  });

  it('does not depend on the bounded presentation transcript for canonical sources', async () => {
    const messages: Message[] = Array.from({ length: 520 }, (_, index) => ({
      id: `long-lived-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `canonical message ${index}`,
      timestamp: index + 1,
    }));
    const manager = new ConversationManager({ initialMessages: messages });
    manager.replaceActiveMessages(manager.getMessages().map(message => ({
      ...message,
      content: `[evicted ${message.id}]`,
      metadata: { ...message.metadata, contentEvicted: true },
    })));
    expect(manager.getTranscript()).toHaveLength(500);

    const compactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(16_384), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );
    const result = await compactor.compactAndApply(context(), {
      forceExtractive: true,
      forceNoRetainedTail: true,
    });

    expect(result.checkpoint.source.messageIds).toHaveLength(520);
    expect(result.checkpoint.source.digest).toBe(checkpointSourceDigest(messages));
  });

  it('retains the observed objective when a structured reducer returns null', async () => {
    const manager = new ConversationManager({ initialMessages: history() });
    const client = structuredClient();
    client.send = vi.fn().mockImplementation(async (request: Message[]) => {
      const input = JSON.parse(request[1]!.content);
      const transcript = String(input.transcriptJsonLines).trim().split('\n').map(line => JSON.parse(line));
      expect(transcript.length).toBeGreaterThan(0);
      return {
        role: 'assistant',
        content: JSON.stringify({
          schemaVersion: 1,
          objective: null,
          currentRequest: null,
          userConstraints: [], decisions: [], completedWork: [], activeWork: [], blockers: [],
          nextActions: [], unresolvedQuestions: [], durableFacts: [], artifacts: [],
        }),
      };
    });
    const compactor = new ConversationCompactor(
      client, manager, new TokenManager(4096), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    const result = await compactor.compactAndApply(context(), { forceNoRetainedTail: true });

    expect(result.checkpoint.semanticState.objective?.text).toContain('0: context');
    expect(result.checkpoint.semanticState.currentRequest?.text).toContain('10: context');
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
    // Many small (non-evictable) results, so this exercises the checkpoint
    // path rather than first-line eviction.
    const messages = toolTurn(30, 150);
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
    // Automatic checkpoints first ask the model for a semantic handoff. This
    // fixture returns invalid JSON, so the bounded extractive fallback commits.
    expect(client.send).toHaveBeenCalledOnce();
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
      await vi.advanceTimersByTimeAsync(180_000);
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

  it('treats owner cancellation as control flow without extraction or commit', async () => {
    const owner = new AbortController();
    const client = chatClient();
    client.send.mockImplementation((_messages: Message[], options: { signal: AbortSignal }) =>
      new Promise(resolve => options.signal.addEventListener('abort', () => resolve({
        role: 'assistant',
        content: '',
        interrupted: true,
      }), { once: true }))
    );
    const messages = history();
    const manager = new ConversationManager({ initialMessages: messages });
    const stream = new ActivityStream();
    const events: any[] = [];
    stream.subscribe(ActivityEventType.COMPACTION_COMPLETE, event => events.push(event));
    const commit = vi.fn().mockResolvedValue(true);
    const compactor = new ConversationCompactor(
      client, manager, new TokenManager(4096), stream, commit,
    );

    const compacting = compactor.compactAndApply({ ...context(), signal: owner.signal });
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledOnce());
    owner.abort();

    await expect(compacting).rejects.toThrow(/interrupted/i);
    expect(commit).not.toHaveBeenCalled();
    expect(manager.getMessages()).toEqual(messages);
    expect(manager.getCheckpoint()).toBeNull();
    expect(compactor.getDebugState()).toMatchObject({ active: false, stage: 'interrupted' });
    expect(events.at(-1)?.data).toMatchObject({ interrupted: true });
    expect(events.at(-1)?.data.error).toBeUndefined();
  });

  it('preserves structured semantics when fitting and tail removal are required', async () => {
    const manager = new ConversationManager({ initialMessages: history() });
    const client = structuredClient();
    const compactor = new ConversationCompactor(
      client, manager, new TokenManager(4096), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );
    const actualCount = (compactor as any).countCandidate.bind(compactor);
    (compactor as any).countCandidate = vi.fn()
      // Force both checkpoint fitting and the no-raw-tail rebuild paths.
      .mockResolvedValueOnce(Number.MAX_SAFE_INTEGER)
      .mockResolvedValueOnce(Number.MAX_SAFE_INTEGER)
      .mockImplementation(actualCount);

    const result = await compactor.compactAndApply(context());

    // The complete-domain rebuild may itself be chunked; critically, every
    // reduction remains structured instead of switching to extraction.
    expect(client.send.mock.calls.length).toBeGreaterThan(1);
    expect(result.checkpoint.portability).toBe('model-validated');
    expect(result.checkpoint.strategy).toBe('local-structured');
    expect(result.checkpoint.retainedMessageIds).toEqual([]);
    expect(result.checkpoint.semanticState.activeWork[0]?.text)
      .toContain('active implementation');
  });

  it('asks the reducer to preserve evidence-backed identifiers and signatures exactly', async () => {
    const manager = new ConversationManager({ initialMessages: history() });
    const client = structuredClient();
    const compactor = new ConversationCompactor(
      client, manager, new TokenManager(16_384), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    await compactor.compactAndApply(context());

    const reducerMessages = client.send.mock.calls[0]![0] as Message[];
    expect(reducerMessages[0]!.content).toContain(
      'Preserve exact identifiers, paths, commands, error text, and compact public declarations/signatures'
    );
    expect(reducerMessages[0]!.content).toContain('never rename or infer them');
    expect(reducerMessages[0]!.content).toContain(
      'exported/public symbols, call signatures, important data shapes, and invariants'
    );
    expect(reducerMessages[0]!.content).toContain(
      'Reconcile plans against the newest successful tool evidence'
    );
    expect(reducerMessages[0]!.content).toContain('Do not repeat unchanged entries');
    expect(reducerMessages[0]!.content).toContain('complete current operational frontier');
    const reducerOptions = client.send.mock.calls[0]![1];
    expect(reducerOptions.responseSchema.schema.properties.artifacts.maxItems).toBe(32);
    expect(reducerOptions.responseSchema.schema.$defs.fact.properties.text.maxLength).toBe(800);
  });

  it('uses the reducer request headroom for accumulated structured output', async () => {
    const manager = new ConversationManager({ initialMessages: history() });
    const client = structuredClient();
    const compactor = new ConversationCompactor(
      client, manager, new TokenManager(16_384), new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    await compactor.compactAndApply(context());

    expect(client.send).toHaveBeenCalled();
    expect(client.send.mock.calls[0][1].dynamicMaxTokens).toBe(4_096);
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

    const result = await compactor.compactAndApply({ ...context(), phase: 'mid-turn' }, {
      trigger: 'automatic', phase: 'mid-turn', forceExtractive: true,
    });
    const checkpoint = result.checkpoint;

    // Every result carried `"error":""` — none of them is a blocker.
    expect(checkpoint.semanticState.blockers).toHaveLength(0);
    expect(checkpoint.semanticState.completedWork.length).toBeGreaterThan(0);
    // Summaries, not raw payload blobs.
    for (const entry of checkpoint.semanticState.completedWork) {
      expect(entry.text.length).toBeLessThanOrEqual(450);
    }
  });

  it('evicts stale tool outputs in place instead of spending a checkpoint generation', async () => {
    const messages = envelopeTurn(6, 400);
    const manager = new ConversationManager({ initialMessages: messages });
    const tokens = new TokenManager(4096);
    const compactor = new ConversationCompactor(
      chatClient(), manager, tokens, new ActivityStream(), vi.fn().mockResolvedValue(true),
    );

    const compacted = await compactor.checkAndPerformAutoCompaction({ ...context(), phase: 'mid-turn' });

    expect(compacted).toBe(true);
    // Eviction alone cleared the trigger: no checkpoint generation was spent
    // and the conversation keeps its complete structure.
    expect(manager.getCheckpoint()).toBeNull();
    const active = manager.getMessages();
    expect(active.map(message => message.id)).toEqual(messages.map(message => message.id));
    // Old payloads became stubs; the newest results (the working set) survive.
    const results = active.filter(message => message.role === 'tool');
    expect(results.slice(0, -2).every(message => message.metadata?.contentEvicted)).toBe(true);
    expect(results.slice(0, -2).every(message => message.content.includes('evicted to reclaim context'))).toBe(true);
    expect(results.slice(-2).every(message => !message.metadata?.contentEvicted)).toBe(true);
    expect(results.slice(-2).every(message => message.content.includes('Created new file'))).toBe(true);
    // The transcript still holds the original payloads for the user.
    const transcriptResults = manager.getTranscript().filter(message => message.role === 'tool');
    expect(transcriptResults.every(message => message.content.includes('Created new file'))).toBe(true);
    // Real context was reclaimed.
    expect(compactor.budget(context()).shouldCompact).toBe(false);
  });

  it('carries the artifact inventory and completed work forward across generations', async () => {
    // 8k window: the smallest realistic deployment target. (At the 4k stress
    // size the checkpoint budget is too small to guarantee full inventory
    // survival — that regime is covered by the fit-floor tests instead.)
    const manager = new ConversationManager({ initialMessages: envelopeTurn(4, 300, '/repo/src/alpha') });
    const compactor = new ConversationCompactor(
      chatClient(), manager, new TokenManager(8192), new ActivityStream(), vi.fn().mockResolvedValue(true),
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

  it('remains lucid with stable runway across many reclaim cycles of a long task', async () => {
    // Regression for the compaction death-spiral: on a small window, tool
    // payloads plus a growing low-signal checkpoint made every reclaim free
    // less than the last until the agent looped on re-reading its own files.
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

    let reclaimRounds = 0;
    let evictionRounds = 0;
    let lastGeneration = 0;
    for (let iteration = 0; iteration < 200 && reclaimRounds < 16; iteration++) {
      // Realistic work shape: substantive assistant prose (non-evictable, so
      // checkpoints stay in play) plus payload-heavy reads and writes in real
      // envelope form (evictable — the observed spiral trigger).
      const prose = Array.from({ length: 100 }, (_, w) => `p${iteration}w${w}`).join(' ');
      const filler = Array.from({ length: 500 }, (_, w) => `it${iteration}w${w}`).join(' ');
      const callId = `call-${iteration}`;
      const filePath = `/repo/src/gen-${iteration}.ts`;
      const toolName = iteration % 2 === 0 ? 'write' : 'read';
      manager.addMessages([{
        id: `assistant-${iteration}`,
        role: 'assistant',
        content: `Analysis of step ${iteration}: ${prose}`,
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
      reclaimRounds++;

      const after = compactor.budget(runContext);
      // Every reclaim round — eviction or checkpoint — must restore real
      // working room. This is the invariant whose violation produced the
      // shrinking-runway spiral.
      expect(after.triggerBudget - after.estimatedInput)
        .toBeGreaterThanOrEqual(Math.floor(after.usableBudget * 0.2));

      // The newest tool result is the working set; reclaim never eats it.
      const newestResult = manager.getMessages().filter(m => m.role === 'tool').at(-1);
      expect(newestResult?.metadata?.contentEvicted).not.toBe(true);

      const checkpoint = manager.getCheckpoint();
      if (checkpoint && checkpoint.generation > lastGeneration) {
        lastGeneration = checkpoint.generation;
        // Lucidity invariants at every checkpoint generation:
        expect(checkpoint.semanticState.objective?.text).toContain('voxel game');
        expect(checkpoint.semanticState.blockers).toHaveLength(0);
        // Early generations compact few exchanges (the adaptive tail keeps the
        // recent ones raw); the floor is small but must never be zero.
        expect(checkpoint.semanticState.artifacts.length).toBeGreaterThanOrEqual(3);
        // Continuity: the next window knows what the assistant was doing.
        expect(checkpoint.semanticState.activeWork.some(entry =>
          entry.text.includes('Analysis of step'))).toBe(true);
      } else {
        evictionRounds++;
      }
    }

    expect(reclaimRounds).toBe(16);
    // Cheap in-place eviction carries most of the load; checkpoint generations
    // are rare but still functioning.
    expect(evictionRounds).toBeGreaterThanOrEqual(8);
    expect(lastGeneration).toBeGreaterThanOrEqual(1);
    // The inventory accumulates across generations instead of resetting: late
    // context windows still know about work from many generations earlier.
    expect(manager.getCheckpoint()!.semanticState.artifacts.length).toBeGreaterThanOrEqual(8);
  });

  it('retains a maximum-permitted tool result through compaction', async () => {
    // The load-bearing invariant: the largest result the harness allows a tool
    // to return must survive the next reclaim. If it cannot, the model loses
    // its work every time and loops re-fetching the same content — the exact
    // failure observed on a live 16k run.
    const tokens = new TokenManager(16_384);
    const system: Message = { id: 'sys', role: 'system', content: `prompt ${'word '.repeat(1_500)}` };
    const functions = [{
      type: 'function' as const,
      function: { name: 'tools', description: 'x'.repeat(6_000), parameters: {} },
    }];
    const manager = new ConversationManager({ initialMessages: [system, ...envelopeTurn(6, 300)] });
    const compactor = new ConversationCompactor(
      chatClient(), manager, tokens, new ActivityStream(), vi.fn().mockResolvedValue(true),
    );
    const runContext = { ...context(), functions, phase: 'mid-turn' as const };
    const budget = compactor.budget(runContext);

    // A result just under the permitted ceiling, as a tool would return it.
    const callId = 'call-max';
    let filler = '';
    while (tokens.estimateTokens(filler) < budget.maxToolResultTokens * 0.85) {
      filler += ` line ${filler.length} of source code;`;
    }
    manager.addMessages([{
      id: 'assistant-max',
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: callId,
        type: 'function',
        function: { name: 'read', arguments: JSON.stringify({ file_path: '/repo/src/big.ts' }) },
      }],
      timestamp: 900,
    }, {
      id: 'tool-max',
      role: 'tool',
      name: 'read',
      tool_call_id: callId,
      content: `[Tool Call ID: ${callId}]\n${JSON.stringify({
        success: true, error: '', content: `=== /repo/src/big.ts ===\n${filler}`,
      })}`,
      timestamp: 901,
    }]);
    const resultTokens = tokens.estimateMessageTokens(manager.getMessages().at(-1)!);
    expect(resultTokens).toBeLessThanOrEqual(budget.maxToolResultTokens);

    await compactor.compactAndApply(runContext, {
      trigger: 'automatic', phase: 'mid-turn', forceExtractive: true,
    });

    const active = manager.getMessages();
    expect(active.some(message => message.id === 'tool-max')).toBe(true);
    // And the checkpoint still fits alongside it.
    expect(manager.getCheckpoint()!.retainedMessageIds).toContain('tool-max');
  });

  it('retains a parallel tool-call group of maximum-permitted results', async () => {
    // Observed live: an assistant turn issuing two reads produced two results
    // that had to be retained together with their assistant message. Sizing a
    // single result to the whole tail made that group overflow, so the tail was
    // dropped and the model re-read the same files on the next window.
    const tokens = new TokenManager(16_384);
    const system: Message = { id: 'sys', role: 'system', content: `prompt ${'word '.repeat(1_500)}` };
    const functions = [{
      type: 'function' as const,
      function: { name: 'tools', description: 'x'.repeat(6_000), parameters: {} },
    }];
    const manager = new ConversationManager({ initialMessages: [system, ...envelopeTurn(6, 300)] });
    const compactor = new ConversationCompactor(
      chatClient(), manager, tokens, new ActivityStream(), vi.fn().mockResolvedValue(true),
    );
    const runContext = { ...context(), functions, phase: 'mid-turn' as const };
    const budget = compactor.budget(runContext);

    let filler = '';
    while (tokens.estimateTokens(filler) < budget.maxToolResultTokens * 0.85) {
      filler += ` line ${filler.length} of source code;`;
    }
    const result = (id: string) => ({
      id: `tool-${id}`,
      role: 'tool' as const,
      name: 'read',
      tool_call_id: `call-${id}`,
      content: `[Tool Call ID: call-${id}]\n${JSON.stringify({
        success: true, error: '', content: `=== /repo/src/${id}.ts ===\n${filler}`,
      })}`,
      timestamp: 900,
    });
    manager.addMessages([{
      id: 'assistant-parallel',
      role: 'assistant',
      content: '',
      tool_calls: ['a', 'b'].map(id => ({
        id: `call-${id}`,
        type: 'function' as const,
        function: { name: 'read', arguments: JSON.stringify({ file_path: `/repo/src/${id}.ts` }) },
      })),
      timestamp: 899,
    }, result('a'), result('b')]);

    await compactor.compactAndApply(runContext, {
      trigger: 'automatic', phase: 'mid-turn', forceExtractive: true,
    });

    const retained = manager.getCheckpoint()!.retainedMessageIds;
    expect(retained).toContain('assistant-parallel');
    expect(retained).toContain('tool-a');
    expect(retained).toContain('tool-b');
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
