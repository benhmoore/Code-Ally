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

    const compacted = await compactor.compactConversation(messages, {
      preserveLastUserMessage: true,
    }, new AbortController().signal);

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

    await compactor.compactConversation(messages, { preserveLastUserMessage: true }, new AbortController().signal);

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

    const compacted = await compactor.compactConversation(messages, {
      preserveLastUserMessage: true,
    }, new AbortController().signal);
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
      preserveLastUserMessage: false,
      verification: 'reduced',
    });

    expect(result.newTokenCount).toBeLessThan(result.oldTokenCount);
    expect(conversationManager.getMessages()).toHaveLength(2);
    expect(conversationManager.getMessages()[1]?.metadata?.isConversationSummary).toBe(true);
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
      preserveLastUserMessage: false,
      verification: 'reduced',
    })).rejects.toThrow('Compaction did not reduce token usage');

    expect(conversationManager.getMessages().map(msg => msg.content)).toEqual(before);
    expect(events.map(event => event.type)).toEqual([
      ActivityEventType.COMPACTION_START,
      ActivityEventType.COMPACTION_COMPLETE,
    ]);
    expect(events.at(-1)?.data?.error).toBe(true);
  });
});
