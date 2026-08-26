/**
 * Gap 4: a response cut off at the output token limit (finishReason 'length')
 * with visible content but no tool calls must not be accepted as a deliberate
 * final answer. The processor records the partial content, reclaims context,
 * injects the truncation reminder, and retries exactly once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResponseProcessor, ResponseContext } from '../ResponseProcessor.js';
import { Message } from '../../types/index.js';

function makeProcessor() {
  const messages: Message[] = [];
  const conversationManager = {
    addMessage: vi.fn((msg: Message) => { messages.push(msg); }),
    getLastMessage: vi.fn(() => messages[messages.length - 1]),
    getMessageCount: vi.fn(() => messages.length),
    getMessagesCopy: vi.fn(() => [...messages]),
    replaceActiveMessages: vi.fn(),
  };
  const messageValidator = {
    validate: vi.fn(() => ({ isValid: true, errors: [] })),
    reset: vi.fn(),
    logAttempt: vi.fn(),
    createValidationRetryMessage: vi.fn(),
  };
  const interruptionManager = {
    isInterrupted: vi.fn(() => false),
    getCause: vi.fn(() => null),
    markRequestAsInterrupted: vi.fn(),
  };
  const requiredToolTracker = {
    hasRequiredTools: vi.fn(() => false),
  };
  const requirementValidator = {
    hasRequirements: vi.fn(() => false),
  };
  const activityStream = { emit: vi.fn() };

  const processor = new ResponseProcessor(
    messageValidator as any,
    activityStream as any,
    interruptionManager as any,
    conversationManager as any,
    requiredToolTracker as any,
    requirementValidator as any
  );

  return { processor, messages, conversationManager };
}

function makeContext(overrides: Partial<ResponseContext> = {}): ResponseContext {
  return {
    instanceId: 'test-agent',
    isSpecializedAgent: false,
    generateId: () => 'id-1',
    autoSaveSession: vi.fn(),
    getLLMResponse: vi.fn(async () => ({ role: 'assistant', content: 'done' })),
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

describe('ResponseProcessor output-limit handling (Gap 4)', () => {
  let setup: ReturnType<typeof makeProcessor>;

  beforeEach(() => {
    setup = makeProcessor();
  });

  it('retries once when a content-only response was cut off at the output limit', async () => {
    const context = makeContext({
      getLLMResponse: vi.fn(async () => ({
        role: 'assistant' as const,
        content: 'continuation succeeded',
      })),
    });

    const result = await setup.processor.processLLMResponse(
      { role: 'assistant', content: 'Now the main loop —', finishReason: 'length' } as any,
      context
    );

    // The truncated content is recorded with truncation metadata.
    const truncatedMsg = setup.messages.find(m => m.metadata?.outputLimited);
    expect(truncatedMsg).toBeDefined();
    expect(truncatedMsg!.content).toBe('Now the main loop —');
    expect(truncatedMsg!.metadata?.finishReason).toBe('length');

    // Context was reclaimed for output runway, the reminder was injected,
    // and the model was called again.
    expect(context.reclaimContext).toHaveBeenCalledTimes(1);
    const reminder = setup.messages.find(
      m => m.role === 'system' && m.content.includes('cut off at the output token limit')
    );
    expect(reminder).toBeDefined();
    expect(context.getLLMResponse).toHaveBeenCalledTimes(1);
    expect(result).toBe('continuation succeeded');
  });

  it('accepts a still-truncated retry instead of looping, marking it truncated', async () => {
    const context = makeContext({
      getLLMResponse: vi.fn(async () => ({
        role: 'assistant' as const,
        content: 'still cut off',
        finishReason: 'length',
      })),
    });

    const result = await setup.processor.processLLMResponse(
      { role: 'assistant', content: 'first attempt', finishReason: 'length' } as any,
      context
    );

    // Exactly one continuation - no infinite retry loop.
    expect(context.getLLMResponse).toHaveBeenCalledTimes(1);
    expect(result).toBe('still cut off');

    // The accepted retry is still flagged as truncated for visibility.
    const accepted = setup.messages.filter(m => m.metadata?.outputLimited);
    expect(accepted).toHaveLength(2);
  });

  it('does not treat a normally-finished text response as truncated', async () => {
    const context = makeContext();

    const result = await setup.processor.processLLMResponse(
      { role: 'assistant', content: 'All done.', finishReason: 'stop' } as any,
      context
    );

    expect(result).toBe('All done.');
    expect(context.getLLMResponse).not.toHaveBeenCalled();
    expect(context.reclaimContext).not.toHaveBeenCalled();
    expect(setup.messages.some(m => m.metadata?.outputLimited)).toBe(false);
  });

  it('falls back to ensureContextRoom when reclamation fails', async () => {
    const context = makeContext({
      reclaimContext: vi.fn(async () => { throw new Error('reclaim failed'); }),
      getLLMResponse: vi.fn(async () => ({
        role: 'assistant' as const,
        content: 'recovered',
      })),
    });

    const result = await setup.processor.processLLMResponse(
      { role: 'assistant', content: 'partial', finishReason: 'length' } as any,
      context
    );

    expect(context.ensureContextRoom).toHaveBeenCalledTimes(1);
    expect(result).toBe('recovered');
  });

  it('leaves output-limited responses WITH tool calls to normal tool processing', async () => {
    const context = makeContext({
      executeToolCalls: vi.fn(async () => [{ success: true }]),
      getLLMResponse: vi.fn(async () => ({
        role: 'assistant' as const,
        content: 'after tools',
      })),
    });

    await setup.processor.processLLMResponse(
      {
        role: 'assistant',
        content: '',
        finishReason: 'length',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'write', arguments: { file_path: '/tmp/x', content: 'y' } },
        }],
      } as any,
      context
    );

    // Complete tool calls that survived truncation still execute.
    expect(context.executeToolCalls).toHaveBeenCalledTimes(1);
  });
});
