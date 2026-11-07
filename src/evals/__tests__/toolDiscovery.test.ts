import { describe, expect, it, vi } from 'vitest';
import { evaluateToolDiscovery } from '../toolDiscovery.js';
import { createRuntimeCoreToolDefinitions } from '../runtimeToolProfiles.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import type { LLMResponse } from '../../llm/ModelClient.js';
import type { FunctionDefinition, Message } from '../../types/index.js';

function response(name: string, args: Record<string, unknown>): LLMResponse {
  return { role: 'assistant', content: '', tool_calls: [{ id: name, function: { name, arguments: args } }] };
}

describe('tool discovery evaluation', () => {
  it.each(['select:memory', 'durable project memory'])('executes real discovery and loads the requested schema: %s', async query => {
    const requests: { messages: Message[]; functions: FunctionDefinition[] }[] = [];
    const send = vi.fn(async (messages: Message[], functions: FunctionDefinition[]) => {
      requests.push({ messages: structuredClone(messages), functions });
      return requests.length === 1
        ? response('tool-search', { query })
        : response('memory', { action: 'save', name: 'package-manager', type: 'feedback', body: 'Use pnpm for this project.' });
    });
    const result = await evaluateToolDiscovery(send, 'Complete the request.', DEFAULT_CONFIG);
    expect(result.score).toBe(7);
    expect(requests[0]!.functions).toEqual(createRuntimeCoreToolDefinitions());
    expect(requests[0]!.functions.map(definition => definition.function.name)).not.toContain('memory');
    expect(requests[0]!.messages[0]!.content).toContain('- memory:');
    expect(requests[1]!.functions.map(definition => definition.function.name)).toContain('memory');
    expect(requests[1]!.messages.find(message => message.role === 'tool')!.content).toContain('Loaded');
    expect(result.notes).toContain('Target capability inspected only; no memory write executed');
  });

  it('does not award a direct call to a tool whose schema was deferred', async () => {
    const send = vi.fn(async () => response('memory', { action: 'save' }));
    expect((await evaluateToolDiscovery(send, 'Complete the request.', DEFAULT_CONFIG)).score).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps failed discovery visible and does not award hallucinated target arguments', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce(response('tool-search', { query: 'select:missing' }))
      .mockResolvedValueOnce(response('memory', { action: 'save', name: 'fake', body: 'pnpm', type: 'feedback' }));
    const result = await evaluateToolDiscovery(send, 'Complete the request.', DEFAULT_CONFIG);
    expect(result.score).toBe(0);
    expect(send.mock.calls[1]![1].map((definition: FunctionDefinition) => definition.function.name)).not.toContain('memory');
  });
});
