import { describe, expect, it } from 'vitest';
import { OpenAIResponsesClient } from '../OpenAIResponsesClient.js';
import type { Message } from '../../types/index.js';

function client(modelName = 'gpt-5.4') {
  return new OpenAIResponsesClient({
    endpoint: 'https://api.openai.com',
    modelName,
    temperature: 0.3,
    contextSize: 32_000,
    maxTokens: 4_000,
    reasoningEffort: 'low',
    apiKey: 'test-key',
  });
}

describe('OpenAIResponsesClient stateless replay', () => {
  it('deduplicates covered messages and pending assistant output', () => {
    const transport = client() as any;
    const first: Message[] = [
      { id: 'system', role: 'system', content: 'Be precise.' },
      { id: 'user-1', role: 'user', content: 'Hello' },
    ];
    const prepared = transport.prepareInput(first, undefined);
    const result = transport.toResult({
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hi' }] }],
      output_text: 'Hi',
      usage: { input_tokens: 10, output_tokens: 2 },
    }, prepared);

    const next = transport.prepareInput([
      ...first,
      { id: 'assistant-1', role: 'assistant', content: 'Hi' },
    ], result.providerState);

    expect(next.persistentInput).toEqual([]);
    expect(next.coveredMessageIds).toContain('assistant-1');
    expect(next.input).toEqual(result.providerState.items);
  });

  it('never persists ephemeral request items into canonical provider state', () => {
    const transport = client() as any;
    const prepared = transport.prepareInput([
      { id: 'user-1', role: 'user', content: 'Work' },
      { id: 'volatile', role: 'system', content: 'Current time: now', metadata: { ephemeral: true } },
    ], undefined);
    expect(prepared.input).toHaveLength(2);

    const result = transport.toResult({ output: [], output_text: '', usage: {} }, prepared);
    expect(result.providerState.items).toHaveLength(1);
    expect(JSON.stringify(result.providerState.items)).not.toContain('Current time');
  });

  it('prunes only before the latest same-stream compaction item', () => {
    const transport = client() as any;
    const prepared = {
      input: [],
      baseItems: [{ type: 'message', role: 'user', content: 'old' }],
      persistentInput: [],
      coveredMessageIds: ['old'],
    };
    const compaction = { type: 'compaction', encrypted_content: 'opaque' };
    const after = { type: 'message', role: 'assistant', content: 'new' };
    const result = transport.toResult({ output: [compaction, after], output_text: 'new', usage: {} }, prepared);

    expect(result.nativeCompaction).toBe(true);
    expect(result.providerState.items).toEqual([compaction, after]);
  });

  it('omits temperature for reasoning models and omits reasoning controls for conventional models', () => {
    const reasoning = client('gpt-5.4') as any;
    const conventional = client('gpt-4.1') as any;
    const options = { signal: new AbortController().signal };
    const prepared = { input: [], baseItems: [], persistentInput: [], coveredMessageIds: [] };

    expect(reasoning.payload(prepared, options)).not.toHaveProperty('temperature');
    expect(reasoning.payload(prepared, options)).toHaveProperty('reasoning.effort', 'low');
    expect(conventional.payload(prepared, options)).toHaveProperty('temperature', 0.3);
    expect(conventional.payload(prepared, options)).not.toHaveProperty('reasoning');
  });

  it('preserves the provider temperature default when no override is configured', () => {
    const conventional = new OpenAIResponsesClient({
      endpoint: 'https://api.openai.com',
      modelName: 'gpt-4.1',
      contextSize: 32_000,
      maxTokens: 4_000,
      apiKey: 'test-key',
    }) as any;
    const prepared = { input: [], baseItems: [], persistentInput: [], coveredMessageIds: [] };
    expect(conventional.payload(prepared, { signal: new AbortController().signal }))
      .not.toHaveProperty('temperature');
  });
});
