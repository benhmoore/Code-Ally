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

  it('preserves a length finish reason on a reasoning-only response', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{
        finish_reason: 'length',
        message: { role: 'assistant', content: '', reasoning_content: 'unfinished reasoning' },
      }],
    }));

    const res = await client.send(
      [{ role: 'user', content: 'continue' }],
      { stream: false, signal: signal() },
    );

    expect(res.finishReason).toBe('length');
    expect(res.thinking).toBe('unfinished reasoning');
  });

  it('retries explicit image rejection as text-only without mutating history', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 415,
        text: async () => JSON.stringify({ error: 'model does not support image input' }),
      })
      .mockResolvedValueOnce(jsonResponse({
        choices: [{ message: { role: 'assistant', content: 'recovered' } }],
      }));
    const messages: Message[] = [{
      role: 'user',
      content: 'Inspect this',
      images: ['data:image/png;base64,aW1hZ2U='],
    }];

    const result = await client.send(messages, { stream: false, signal: signal() });

    expect(result.content).toBe('recovered');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstPayload = JSON.parse(mockFetch.mock.calls[0]![1].body);
    const fallbackPayload = JSON.parse(mockFetch.mock.calls[1]![1].body);
    expect(firstPayload.messages[0].content[1].type).toBe('image_url');
    expect(fallbackPayload.messages[0].content).toContain('does not support image input');
    expect(messages[0]?.images).toEqual(['data:image/png;base64,aW1hZ2U=']);
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

  it('sends tool images after all parallel tool results', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    const messages: Message[] = [
      { role: 'assistant', content: '', tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'shot', arguments: {} } },
        { id: 'c2', type: 'function', function: { name: 'inspect', arguments: {} } },
      ] },
      { role: 'tool', name: 'shot', tool_call_id: 'c1', content: 'captured', images: ['data:image/png;base64,ONE'] },
      { role: 'tool', name: 'inspect', tool_call_id: 'c2', content: 'inspected', images: ['data:image/png;base64,TWO'] },
    ];

    await client.send(messages, { stream: false, signal: signal() });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);

    expect(body.messages.map((message: any) => message.role)).toEqual(['assistant', 'tool', 'tool', 'user']);
    expect(body.messages[3].content).toEqual(expect.arrayContaining([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,ONE' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,TWO' } },
    ]));
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

  it('omits temperature when no override is configured', async () => {
    const modelDefault = new OpenAICompatClient({
      endpoint: 'http://host', modelName: 'llama3.2', contextSize: 8192, maxTokens: 100,
    });
    mockFetch.mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: 'ok' } }] }));
    await modelDefault.send([{ role: 'user', content: 'hi' }], { stream: false, signal: signal() });
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).not.toHaveProperty('temperature');
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

  it('keeps already-streamed content as a partial response when the stream fails mid-flight', async () => {
    const encoder = new TextEncoder();
    let call = 0;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => {
            if (call++ === 0) {
              return { done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"Partial answer"}}]}\n') };
            }
            throw new Error('ECONNRESET');
          },
        }),
      },
    });

    const res = await client.send([{ role: 'user', content: 'go' }], { stream: true, signal: signal() });

    expect(res.partial).toBe(true);
    expect(res.error).toBe(true);
    expect(res.content).toBe('Partial answer');
    expect(res.error_message).toContain('ECONNRESET');
    // One attempt only: retrying would duplicate the chunks already in the UI.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('rethrows a mid-stream failure for retry when nothing has been streamed yet', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => ({ read: async () => { throw new Error('ECONNRESET'); } }) },
    });
    mockFetch.mockResolvedValueOnce(sseResponse([
      'data: {"choices":[{"delta":{"content":"retried ok"}}]}',
      'data: [DONE]',
    ]));

    const res = await client.send([{ role: 'user', content: 'go' }], { stream: true, signal: signal() });

    expect(res.content).toBe('retried ok');
    expect(res.partial).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('times out a stream that sends keepalives but no model output', async () => {
    vi.useFakeTimers();
    try {
      const encoder = new TextEncoder();
      let reads = 0;
      const response = {
        body: {
          getReader: () => ({
            read: () => reads++ === 0
              ? Promise.resolve({ done: false, value: encoder.encode(': keepalive\n\n') })
              : new Promise(() => {}),
          }),
        },
      } as unknown as Response;

      const pending = (client as any).parseStreamingResponse(
        'heartbeat-only', response, signal(), undefined, false, undefined,
      );
      const rejection = expect(pending).rejects.toThrow('Stream read timeout');
      await vi.advanceTimersByTimeAsync(120_001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a malformed tool call to the model instead of silently dropping it', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      choices: [{ message: { role: 'assistant', content: '', tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"file_path":' } },
      ] } }],
    }));

    const res = await client.send([{ role: 'user', content: 'read it' }], { stream: false, signal: signal() });

    expect(res.error).toBe(true);
    expect(res.tool_call_validation_failed).toBe(true);
    expect(res.validation_errors?.[0]).toContain('Invalid JSON in arguments');
    expect(res.tool_calls).toHaveLength(1);
  });

  it('accepts a streamed tool call that accumulated no arguments', async () => {
    mockFetch.mockResolvedValueOnce(sseResponse([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"list_todos"}}]}}]}',
      'data: [DONE]',
    ]));

    const res = await client.send([{ role: 'user', content: 'todos' }], { stream: true, signal: signal() });

    expect(res.tool_call_validation_failed).toBeUndefined();
    expect(res.tool_calls![0].function).toEqual({ name: 'list_todos', arguments: {} });
  });
});
