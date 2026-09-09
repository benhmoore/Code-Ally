import { describe, expect, it, vi } from 'vitest';
import { ResponseProcessor, type ResponseContext } from '../ResponseProcessor.js';

function context(overrides: Partial<ResponseContext> = {}): ResponseContext {
  return {
    instanceId: 'test-agent',
    isSpecializedAgent: false,
    generateId: () => 'id-1',
    autoSaveSession: vi.fn(),
    getLLMResponse: vi.fn(async () => ({ role: 'assistant', content: 'unexpected retry' })),
    executeToolCalls: vi.fn(async () => []),
    detectCycles: vi.fn(() => new Map()),
    detectRecordedFailures: vi.fn(() => new Map()),
    recordToolCalls: vi.fn(),
    interruptForToolLoop: vi.fn(),
    clearCurrentTurn: vi.fn(),
    startToolExecution: vi.fn(),
    cleanupEphemeralMessages: vi.fn(),
    ensureContextRoom: vi.fn(async () => {}),
    reclaimContext: vi.fn(async () => {}),
    ...overrides,
  } as ResponseContext;
}

describe('ResponseProcessor interruption handoff', () => {
  it.each(['answer already emitted', ''])('ends a terminal tool batch without another model call (content: %j)', async (content) => {
    const addMessage = vi.fn();
    const emit = vi.fn();
    const processor = new ResponseProcessor(
      { reset: vi.fn() } as any,
      { emit } as any,
      { isInterrupted: () => false } as any,
      { addMessage, getMessageCount: () => addMessage.mock.calls.length } as any,
      { hasRequiredTools: () => false } as any,
      { hasRequirements: () => false } as any,
    );
    const ctx = context({ getTerminalResponse: () => 'accepted summary' });
    const result = await processor.processToolResponse(
      { role: 'assistant', content },
      [{ id: 'terminal-call', type: 'function', function: { name: 'tool', arguments: {} } }],
      ctx,
    );
    expect(result).toBe(content || 'accepted summary');
    expect(ctx.getLLMResponse).not.toHaveBeenCalled();
    expect(ctx.recordToolCalls).toHaveBeenCalledOnce();
    expect(ctx.cleanupEphemeralMessages).toHaveBeenCalledOnce();
    const visible = emit.mock.calls.filter(([event]) => event.type === 'assistant_message_complete');
    expect(visible).toHaveLength(1);
    expect(visible[0]![0].data.content).toBe(result);
  });

  it('does not turn a concurrent interjection into an empty-response repair', async () => {
    const addMessage = vi.fn();
    const getLLMResponse = vi.fn(async () => ({ role: 'assistant' as const, content: 'unexpected retry' }));
    const processor = new ResponseProcessor(
      { validate: vi.fn(), reset: vi.fn(), logAttempt: vi.fn(), createValidationRetryMessage: vi.fn() } as any,
      { emit: vi.fn() } as any,
      {
        isInterrupted: vi.fn(() => true),
        getCause: vi.fn(() => ({ kind: 'user_interjection' })),
        markRequestAsInterrupted: vi.fn(),
      } as any,
      { addMessage } as any,
      { hasRequiredTools: vi.fn(() => false) } as any,
      { hasRequirements: vi.fn(() => false) } as any,
    );

    const result = await processor.processLLMResponse(
      { role: 'assistant', content: '' },
      context({ getLLMResponse }),
    );

    expect(result).toBe('');
    expect(addMessage).not.toHaveBeenCalled();
    expect(getLLMResponse).not.toHaveBeenCalled();
  });

  it('marks a concurrent user cancellation without mutating history', async () => {
    const addMessage = vi.fn();
    const markRequestAsInterrupted = vi.fn();
    const processor = new ResponseProcessor(
      { validate: vi.fn() } as any,
      { emit: vi.fn() } as any,
      {
        isInterrupted: vi.fn(() => true),
        getCause: vi.fn(() => ({ kind: 'user_cancel' })),
        markRequestAsInterrupted,
      } as any,
      { addMessage } as any,
      { hasRequiredTools: vi.fn(() => false) } as any,
      { hasRequirements: vi.fn(() => false) } as any,
    );

    const result = await processor.processLLMResponse(
      { role: 'assistant', content: 'partial' },
      context(),
    );

    expect(result.toLowerCase()).toContain('interrupt');
    expect(markRequestAsInterrupted).toHaveBeenCalledOnce();
    expect(addMessage).not.toHaveBeenCalled();
  });
});
