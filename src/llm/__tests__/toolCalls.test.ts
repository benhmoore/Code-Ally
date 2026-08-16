/**
 * Tests for the shared tool-call repair/validation lifted out of OllamaClient
 * so both provider clients use one implementation.
 */

import { describe, it, expect } from 'vitest';
import { normalizeToolCallsInMessage, repairSingleToolCall, validateToolCalls } from '../toolCalls.js';
import type { LLMResponse } from '../ModelClient.js';

describe('repairSingleToolCall', () => {
  it('parses JSON-string arguments into an object', () => {
    const result = repairSingleToolCall(
      { type: 'function', function: { name: 'read', arguments: '{"file_path":"/a.ts"}' } },
      0
    );

    expect(result.valid).toBe(true);
    expect(result.repaired.function.arguments).toEqual({ file_path: '/a.ts' });
  });

  it('treats a whitespace-only arguments string as no arguments', () => {
    const result = repairSingleToolCall(
      { type: 'function', function: { name: 'ls', arguments: '   ' } },
      0
    );

    expect(result.valid).toBe(true);
    expect(result.repaired.function.arguments).toEqual({});
  });

  it('reports malformed arguments instead of dropping the call', () => {
    const result = repairSingleToolCall(
      { type: 'function', function: { name: 'read', arguments: '{"file_path":' } },
      2
    );

    expect(result.valid).toBe(false);
    expect(result.repaired).toBeUndefined();
    expect(result.errors[0]).toContain('Tool call 2: Invalid JSON in arguments');
  });

  it('hoists a flat name/arguments pair and fills in a missing type', () => {
    const result = repairSingleToolCall({ name: 'grep', arguments: { pattern: 'x' } }, 0);

    expect(result.valid).toBe(true);
    expect(result.repaired.type).toBe('function');
    expect(result.repaired.function).toEqual({ name: 'grep', arguments: { pattern: 'x' } });
    expect(result.repaired.name).toBeUndefined();
    expect(result.repaired.arguments).toBeUndefined();
  });

  it('rejects a call with no usable function name', () => {
    expect(repairSingleToolCall({ type: 'function', function: { arguments: {} } }, 0).valid).toBe(false);
    expect(repairSingleToolCall({ type: 'function' }, 1).errors[0]).toContain('Missing or invalid function object');
  });
});

describe('normalizeToolCallsInMessage', () => {
  it('replaces reused ids with unique ones', () => {
    const message = {
      tool_calls: [
        { id: 'functions.glob:4', type: 'function', function: { name: 'glob', arguments: {} } },
        { id: 'functions.glob:4', type: 'function', function: { name: 'glob', arguments: {} } },
      ],
    };

    const result = normalizeToolCallsInMessage(message);

    expect(result.valid).toBe(true);
    const ids = message.tool_calls.map(c => c.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every(id => id.startsWith('call-'))).toBe(true);
  });

  it('is a no-op for a message without tool calls', () => {
    expect(normalizeToolCallsInMessage({ content: 'hi' })).toEqual({ valid: true, errors: [] });
  });
});

describe('validateToolCalls', () => {
  it('returns the repaired response when every call is valid', () => {
    const response = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"file_path":"/a"}' } }],
    } as unknown as LLMResponse;

    const result = validateToolCalls(response);

    expect(result.error).toBeUndefined();
    expect(result.tool_calls![0].function.arguments).toEqual({ file_path: '/a' });
  });

  it('surfaces a validation failure the agent can turn into a repair prompt', () => {
    const response = {
      role: 'assistant',
      content: 'here you go',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{oops' } }],
    } as unknown as LLMResponse;

    const result = validateToolCalls(response);

    expect(result.error).toBe(true);
    expect(result.tool_call_validation_failed).toBe(true);
    expect(result.validation_errors?.[0]).toContain('Invalid JSON in arguments');
    // The malformed calls travel with the error so the model sees what it sent.
    expect(result.tool_calls).toHaveLength(1);
    expect(result.content).toBe('here you go');
  });
});
