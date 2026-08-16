import { describe, expect, it } from 'vitest';
import path from 'path';
import { AgentCompactor } from '../AgentCompactor.js';
import { ConversationManager } from '../ConversationManager.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ActivityEventType, Message } from '../../types/index.js';
import { ModelClient, LLMResponse, SendOptions } from '../../llm/ModelClient.js';
import type { TokenManager } from '../TokenManager.js';

class MockModelClient extends ModelClient {
  readonly requests: readonly Message[][] = [];

  constructor(private responseContent = 'GOAL: summarized') {
    super();
  }

  async send(messages: readonly Message[], _options?: SendOptions): Promise<LLMResponse> {
    (this.requests as Message[][]).push([...messages]);
    return {
      role: 'assistant',
      content: this.responseContent,
    };
  }

  get modelName(): string {
    return 'mock-model';
  }

  get endpoint(): string {
    return 'mock-endpoint';
  }
}

class FakeTokenManager {
  private currentTokenCount = 0;

  constructor(private contextSize = 8000) {}

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  estimateMessageTokens(message: Message): number {
    let tokens = 4 + this.estimateTokens(message.content || '');
    if (message.name) tokens += this.estimateTokens(message.name);
    if (message.tool_call_id) tokens += this.estimateTokens(message.tool_call_id);
    if (message.tool_calls) tokens += this.estimateTokens(JSON.stringify(message.tool_calls));
    return tokens;
  }

  updateTokenCount(messages: readonly Message[]): void {
    this.currentTokenCount = messages.reduce((sum, msg) => sum + this.estimateMessageTokens(msg), 0);
  }

  getCurrentTokenCount(): number {
    return this.currentTokenCount;
  }

  getContextUsagePercentage(): number {
    return Math.min(100, Math.floor((this.currentTokenCount / this.contextSize) * 100));
  }

  getContextSize(): number {
    return this.contextSize;
  }
}

function createCompactor(
  messages: Message[],
  modelClient = new MockModelClient(),
  tokenManager = new FakeTokenManager()
): { compactor: AgentCompactor; conversationManager: ConversationManager; activityStream: ActivityStream; modelClient: MockModelClient; tokenManager: FakeTokenManager } {
  const conversationManager = new ConversationManager({ instanceId: 'test', initialMessages: messages });
  tokenManager.updateTokenCount(conversationManager.getMessages());
  const activityStream = new ActivityStream();
  const compactor = new AgentCompactor(
    modelClient,
    conversationManager,
    tokenManager as unknown as TokenManager,
    activityStream
  );

  return { compactor, conversationManager, activityStream, modelClient, tokenManager };
}

/**
 * Assert the tool_call/tool_result invariant: every tool result has an earlier
 * assistant message that requested it, and every retained assistant call is
 * answered.
 */
function expectToolPairingIntact(messages: readonly Message[]): void {
  const calledIds = new Set<string>();
  const answeredIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) calledIds.add(tc.id);
    }
    if (msg.role === 'tool') {
      expect(msg.tool_call_id).toBeTruthy();
      // Parent must already have been seen — never a leading orphan.
      expect(calledIds.has(msg.tool_call_id!)).toBe(true);
      answeredIds.add(msg.tool_call_id!);
    }
  }

  for (const id of calledIds) {
    expect(answeredIds.has(id)).toBe(true);
  }
}

/** A conversation whose newest turn is still in flight (tool calls + results). */
function midTurnMessages(): Message[] {
  return [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'Original goal' },
    { role: 'assistant', content: `Older reply ${'X'.repeat(2000)}` },
    { role: 'user', content: 'CURRENT REQUEST' },
    {
      role: 'assistant',
      content: 'Calling first tool',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'grep', arguments: { pattern: 'alpha' } },
      }],
    },
    { role: 'tool', name: 'grep', tool_call_id: 'call-1', content: `TOOL RESULT ALPHA ${'y'.repeat(3000)}` },
    {
      role: 'assistant',
      content: 'Calling second tool',
      tool_calls: [{
        id: 'call-2',
        type: 'function',
        function: { name: 'read', arguments: { file_paths: ['src/b.ts'] } },
      }],
    },
    { role: 'tool', name: 'read', tool_call_id: 'call-2', content: `TOOL RESULT BETA ${'z'.repeat(3000)}` },
  ];
}

describe('AgentCompactor', () => {
  it('keeps a bounded excerpt of an oversized newest summarized message', async () => {
    const hugeAssistantMessage = `RECENT HUGE RESULT\n${'x'.repeat(40000)}\nIMPORTANT TAIL`;
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Initial goal' },
      { role: 'assistant', content: hugeAssistantMessage },
      { role: 'user', content: 'Continue from here' },
    ];
    const { compactor, modelClient } = createCompactor(messages);

    const compacted = await compactor.compactConversation(messages, {}, new AbortController().signal);

    const request = modelClient.requests[0]!;
    expect(request).toHaveLength(2);
    expect(request.some(msg => msg.role === 'tool' || msg.tool_calls)).toBe(false);
    expect(request[1]!.content).toContain('RECENT HUGE RESULT');
    expect(request[1]!.content).toContain('omitted middle content');
    expect(request[1]!.content).toContain('IMPORTANT TAIL');
    expect(compacted.at(-1)?.content).toBe('Continue from here');
  });

  it('flattens tool protocol messages into a plain transcript for summarization', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Inspect the file' },
      {
        role: 'assistant',
        content: 'Reading now',
        tool_calls: [{
          id: 'call-read',
          type: 'function',
          function: { name: 'read', arguments: { file_paths: ['src/a.ts'] } },
        }],
      },
      { role: 'tool', name: 'read', tool_call_id: 'call-read', content: 'file contents' },
      { role: 'assistant', content: 'The file exports A.' },
      { role: 'user', content: 'Summarize progress' },
    ];
    const { compactor, modelClient } = createCompactor(messages);

    await compactor.compactConversation(messages, {}, new AbortController().signal);

    const request = modelClient.requests[0]!;
    expect(request.map(msg => msg.role)).toEqual(['system', 'user']);
    expect(request.some(msg => msg.tool_calls)).toBe(false);
    expect(request[1]!.content).toContain('Tool calls:');
    expect(request[1]!.content).toContain('call-read: read {"file_paths":["src/a.ts"]}');
    expect(request[1]!.content).toContain('TOOL | read | tool_call_id=call-read');
    expect(request[1]!.content).toContain('file contents');
  });

  it('extracts normalized file references from parsed and serialized tool arguments', async () => {
    const editedPath = path.resolve(process.cwd(), 'src/app.ts');
    const readPath = path.resolve(process.cwd(), 'README.md');
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Change files' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-write',
            type: 'function',
            function: { name: 'write', arguments: { file_path: 'src/app.ts', content: 'old' } },
          },
          {
            id: 'call-edit',
            type: 'function',
            function: { name: 'edit', arguments: { file_path: 'src/app.ts', edits: [] } },
          },
          {
            id: 'call-read',
            type: 'function',
            function: { name: 'read', arguments: '{"file_paths":["README.md"]}' as any },
          },
        ],
      },
      { role: 'assistant', content: 'Done' },
      { role: 'user', content: 'Continue' },
    ];
    const { compactor } = createCompactor(messages);

    const compacted = await compactor.compactConversation(messages, {}, new AbortController().signal);
    const summary = compacted.find(msg => msg.metadata?.isConversationSummary);

    expect(summary?.metadata?.contextFileReferences).toEqual([editedPath, readPath]);
    expect(summary?.metadata?.contextFileSources?.edited).toContain(editedPath);
    expect(summary?.metadata?.contextFileSources?.written).not.toContain(editedPath);
    expect(summary?.metadata?.contextFileSources?.read).toContain(readPath);
  });

  it('applies verified compaction through the shared mutation path', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Goal' },
      { role: 'assistant', content: 'A'.repeat(2000) },
      { role: 'user', content: 'Next' },
      { role: 'assistant', content: 'B'.repeat(2000) },
    ];
    const { compactor, conversationManager, activityStream } = createCompactor(messages);
    const events: any[] = [];
    activityStream.subscribe('*', event => events.push(event));

    const result = await compactor.compactAndApply({
      instanceId: 'test-agent',
      isSpecializedAgent: false,
      compactThreshold: 95,
      generateId: () => `evt-${events.length}`,
      signal: new AbortController().signal,
    }, {
      verification: 'reduced',
    });

    expect(result.newTokenCount).toBeLessThan(result.oldTokenCount);
    // system + summary + retained tail starting at the last user message
    expect(conversationManager.getMessages().map(msg => msg.role)).toEqual([
      'system', 'system', 'user', 'assistant',
    ]);
    expect(conversationManager.getMessages()[1]?.metadata?.isConversationSummary).toBe(true);
    expect(conversationManager.getMessages()[2]?.content).toBe('Next');
    expect(events.map(event => event.type)).toEqual([
      ActivityEventType.COMPACTION_START,
      ActivityEventType.COMPACTION_COMPLETE,
    ]);
  });

  it('leaves conversation untouched when verification fails', async () => {
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Goal' },
      { role: 'assistant', content: 'Short answer' },
      { role: 'user', content: 'Next' },
    ];
    const modelClient = new MockModelClient('GOAL: ' + 'summary '.repeat(4000));
    const { compactor, conversationManager, activityStream } = createCompactor(messages, modelClient);
    const before = conversationManager.getMessages().map(msg => msg.content);
    const events: any[] = [];
    activityStream.subscribe('*', event => events.push(event));

    await expect(compactor.compactAndApply({
      instanceId: 'test-agent',
      isSpecializedAgent: false,
      compactThreshold: 95,
      generateId: () => `evt-${events.length}`,
      signal: new AbortController().signal,
    }, {
      verification: 'reduced',
    })).rejects.toThrow('Compaction did not reduce token usage');

    expect(conversationManager.getMessages().map(msg => msg.content)).toEqual(before);
    expect(events.map(event => event.type)).toEqual([
      ActivityEventType.COMPACTION_START,
      ActivityEventType.COMPACTION_COMPLETE,
    ]);
    expect(events.at(-1)?.data?.error).toBe(true);
  });

  it('retains the in-flight turn verbatim when compaction fires mid-turn', async () => {
    const messages = midTurnMessages();
    const { compactor } = createCompactor(messages);

    const compacted = await compactor.compactConversation(messages, {}, new AbortController().signal);

    // The whole in-flight turn survives: user request, both calls, both results.
    expect(compacted.map(msg => msg.role)).toEqual([
      'system', 'system', 'user', 'assistant', 'tool', 'assistant', 'tool',
    ]);
    expect(compacted[2]!.content).toBe('CURRENT REQUEST');
    expect(compacted.some(msg => msg.content?.includes('TOOL RESULT ALPHA'))).toBe(true);
    expect(compacted.some(msg => msg.content?.includes('TOOL RESULT BETA'))).toBe(true);
    expectToolPairingIntact(compacted);
  });

  it('summarizes rather than drops the in-flight turn when the retained tail exceeds budget', async () => {
    const messages = midTurnMessages();
    // Context small enough that the tail from the last user message overruns the
    // post-compaction retention budget, forcing the split forward.
    const { compactor, modelClient } = createCompactor(messages, new MockModelClient(), new FakeTokenManager(2000));

    const compacted = await compactor.compactConversation(messages, {}, new AbortController().signal);

    // Split advanced to the next safe boundary: the second call + its result.
    expect(compacted.map(msg => msg.role)).toEqual(['system', 'system', 'assistant', 'tool']);
    expect(compacted[2]!.tool_calls?.[0]?.id).toBe('call-2');
    expect(compacted[3]!.tool_call_id).toBe('call-2');
    expectToolPairingIntact(compacted);

    // Everything pushed out of the tail was SENT TO THE SUMMARIZER, not dropped.
    const transcript = modelClient.requests[0]![1]!.content;
    expect(transcript).toContain('CURRENT REQUEST');
    expect(transcript).toContain('call-1: grep');
    expect(transcript).toContain('TOOL RESULT ALPHA');
  });

  it('never splits an assistant tool_calls message away from its results', async () => {
    const messages = midTurnMessages();

    for (const contextSize of [8000, 4000, 2000, 1200]) {
      const { compactor } = createCompactor(
        messages,
        new MockModelClient(),
        new FakeTokenManager(contextSize)
      );

      const summarized = await compactor.compactConversation(messages, {}, new AbortController().signal);
      expectToolPairingIntact(summarized);

      const truncated: Message[] = (compactor as any).performEmergencyTruncation(messages);
      expectToolPairingIntact(truncated);
    }
  });

  it('emergency truncation never begins with a parentless tool result', () => {
    // Budget fits the small tool result but not the huge assistant call that
    // produced it — the pre-fix backwards keep-loop emitted a leading orphan.
    const messages: Message[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'Goal' },
      {
        role: 'assistant',
        content: 'A'.repeat(3000),
        tool_calls: [{
          id: 'call-huge',
          type: 'function',
          function: { name: 'grep', arguments: { pattern: 'x' } },
        }],
      },
      { role: 'tool', name: 'grep', tool_call_id: 'call-huge', content: 'tiny result' },
    ];
    const { compactor } = createCompactor(messages, new MockModelClient(), new FakeTokenManager(400));

    const truncated: Message[] = (compactor as any).performEmergencyTruncation(messages);

    const firstNonSystem = truncated.find(msg => msg.role !== 'system');
    expect(firstNonSystem?.role).not.toBe('tool');
    expect(firstNonSystem?.tool_calls?.[0]?.id).toBe('call-huge');
    expectToolPairingIntact(truncated);
  });
});
