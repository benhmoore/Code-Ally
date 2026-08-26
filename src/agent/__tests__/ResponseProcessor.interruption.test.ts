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
