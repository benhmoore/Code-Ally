/**
 * Tests for OpenAICompatClient — wire-format conversion, SSE parsing, auth.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAICompatClient } from '../OpenAICompatClient.js';
import type { Message } from '@shared/index.js';

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

function jsonResponse(body: any) {
  return { ok: true, json: async () => body };
}

/** Build a Response whose body streams the given SSE lines. */
function sseResponse(lines: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    body: {
      getReader() {
        return {
          read: async () => {
            if (i < lines.length) {
              return { done: false, value: encoder.encode(lines[i++] + '\n') };
            }
            return { done: true, value: undefined };
          },
        };
      },
    },
  };
}

describe('OpenAICompatClient', () => {
  let client: OpenAICompatClient;
  const signal = () => new AbortController().signal;

  beforeEach(() => {
    client = new OpenAICompatClient({
      endpoint: 'http://localhost:8000',
      modelName: 'gpt-oss:20b',
      temperature: 0.3,
      contextSize: 16384,
      maxTokens: 5000,
    });
    vi.clearAllMocks();
  });

  it('targets /v1/chat/completions (and tolerates a /v1 suffix)', () => {
    expect((client as any).apiUrl).toBe('http://localhost:8000/v1/chat/completions');
    const withV1 = new OpenAICompatClient({
      endpoint: 'http://host/v1', modelName: 'm', temperature: 0.3, contextSize: 8192, maxTokens: 100,
    });
    expect((withV1 as any).apiUrl).toBe('http://host/v1/chat/completions');
  });

  it('parses a non-streaming content response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: 'hello there' } }],
    }));
    const res = await client.send([{ role: 'user', content: 'hi' }], { stream: false, signal: signal() });
    expect(res.content).toBe('hello there');
  });

  it('parses tool_calls and converts string arguments to an object', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"file_path":"/a.ts"}' } },
      ] } }],
    }));
    const res = await client.send([{ role: 'user', content: 'read it' }], { stream: false, signal: signal() });
    expect(res.tool_calls).toHaveLength(1);
    expect(res.tool_calls![0].function.name).toBe('read');
    expect(res.tool_calls![0].function.arguments).toEqual({ file_path: '/a.ts' });
  });

  it('serializes outgoing assistant tool-call arguments to JSON strings', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const messages: Message[] = [
      { role: 'assistant', content: '', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'grep', arguments: { pattern: 'x' } } },
      ] },
      { role: 'tool', tool_call_id: 'c1', content: 'match' },
    ];
    await client.send(messages, { stream: false, signal: signal() });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].tool_calls[0].function.arguments).toBe('{"pattern":"x"}');
    expect(body.messages[0].content).toBeNull();
    expect(body.messages[1]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'match' });
  });

  it('sends an Authorization header when an apiKey is configured', async () => {
    const authed = new OpenAICompatClient({
      endpoint: 'http://host', modelName: 'm', temperature: 0.3, contextSize: 8192, maxTokens: 100,
      apiKey: 'secret-token',
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await authed.send([{ role: 'user', content: 'hi' }], { stream: false, signal: signal() });
    expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer secret-token');
  });

  it('only sends reasoning_effort for the gpt-oss family', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const reasoning = new OpenAICompatClient({
      endpoint: 'http://host', modelName: 'gpt-oss:20b', temperature: 0.3, contextSize: 8192, maxTokens: 100,
      reasoningEffort: 'high',
    });
    await reasoning.send([{ role: 'user', content: 'hi' }], { stream: false, signal: signal() });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body).reasoning_effort).toBe('high');

    mockFetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const plain = new OpenAICompatClient({
      endpoint: 'http://host', modelName: 'llama3.2', temperature: 0.3, contextSize: 8192, maxTokens: 100,
      reasoningEffort: 'high',
    });
    await plain.send([{ role: 'user', content: 'hi' }], { stream: false, signal: signal() });
    expect(JSON.parse(mockFetch.mock.calls[1][1].body).reasoning_effort).toBeUndefined();
  });

  it('assembles streamed content and tool calls from SSE chunks', async () => {
    mockFetch.mockResolvedValueOnce(sseResponse([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read","arguments":"{\\"file"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_path\\":\\"/a\\"}"}}]}}]}',
      'data: [DONE]',
    ]));
    const res = await client.send([{ role: 'user', content: 'go' }], { stream: true, signal: signal() });
    expect(res.content).toBe('Hello');
    expect(res.tool_calls).toHaveLength(1);
    expect(res.tool_calls![0].function.name).toBe('read');
    expect(res.tool_calls![0].function.arguments).toEqual({ file_path: '/a' });
  });
});
