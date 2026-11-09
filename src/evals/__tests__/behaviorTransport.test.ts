import { afterEach, describe, expect, it, vi } from 'vitest';
import { installBehaviorTransport } from '../behaviorTransport.js';
import { BASELINE_OPERATION_RULE, OUTCOME_OPERATION_RULE } from '../behaviorPolicies.js';
const endpoint = 'http://local:11434';
const body = JSON.stringify({
  model: 'test',
  messages: [{ role: 'system', content: `You are Ally\n${BASELINE_OPERATION_RULE}` }],
  stream: false,
  options: { temperature: 0 },
});
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
describe('behavior transport', () => {
  it('changes only the operation rule and forwards abort and headers', async () => {
    const fake = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ message: { content: 'done' }, prompt_eval_count: 3, eval_count: 4 }))
      );
    globalThis.fetch = fake;
    const observer = installBehaviorTransport({ endpoint, variant: 'outcome' });
    const signal = new AbortController().signal;
    const headers = { 'x-test': 'preserved' };
    const response = await fetch(`${endpoint}/api/chat`, { method: 'POST', body, signal, headers });
    expect(await response.json()).toMatchObject({ message: { content: 'done' } });
    await observer.drain();
    const forwarded = fake.mock.calls[0]![1]!;
    expect(forwarded.signal).toBe(signal);
    expect(forwarded.headers).toBe(headers);
    expect(JSON.parse(forwarded.body as string)).toEqual({
      ...JSON.parse(body),
      messages: [{ role: 'system', content: `You are Ally\n${OUTCOME_OPERATION_RULE}` }],
    });
    expect(observer.requests[0]).toMatchObject({
      sequence: 1,
      owner: 'main',
      variantApplied: true,
      httpStatus: 200,
      response: { content: 'done', usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 } },
    });
    observer.restore();
    expect(globalThis.fetch).toBe(fake);
  });
  it('sets matched provider seeds while preserving all existing provider options', async () => {
    const fake = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    globalThis.fetch = fake;
    const observer = installBehaviorTransport({ endpoint, variant: 'baseline', seed: 0 });
    await fetch(`${endpoint}/api/chat`, { method: 'POST', body });
    await observer.drain();
    expect(observer.requests[0]?.payload.options).toEqual({ temperature: 0, seed: 0 });
    expect(observer.requests[0]?.variantApplied).toBe(false);
    expect(JSON.parse(fake.mock.calls[0]![1]!.body as string).options).toEqual({ temperature: 0, seed: 0 });
  });
  it('leaves unseeded requests unchanged and flags absent ablation directives as unchanged', async () => {
    globalThis.fetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    const observer = installBehaviorTransport({ endpoint, variant: 'outcome' });
    const payload = { messages: [{ role: 'system', content: 'You are Ally' }], options: { temperature: 0 } };
    await fetch(`${endpoint}/api/chat`, { method: 'POST', body: JSON.stringify(payload) });
    await observer.drain();
    expect(observer.requests[0]?.payload).toEqual(payload);
    expect(observer.requests[0]?.variantApplied).toBe(false);
  });
  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid backend seed %s before installing fetch',
    seed => {
      const fetchBefore = globalThis.fetch;
      expect(() => installBehaviorTransport({ endpoint, variant: 'baseline', seed })).toThrow('seed');
      expect(globalThis.fetch).toBe(fetchBefore);
    }
  );
  it('observes streams without waiting for or consuming the caller response', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const encoder = new TextEncoder();
    globalThis.fetch = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              streamController = controller;
            },
          })
        )
    );
    const observer = installBehaviorTransport({ endpoint, variant: 'baseline' });
    const response = await fetch(`${endpoint}/api/chat`, { method: 'POST', body });
    expect(observer.requests[0]?.response).toBeUndefined();
    streamController!.enqueue(encoder.encode('{"message":{"content":"a","thinking":"h"}}\n'));
    streamController!.enqueue(
      encoder.encode('{"message":{"content":"b","tool_calls":[{"function":{"name":"read"}}]},"eval_count":2}\n')
    );
    streamController!.close();
    expect(await response.text()).toContain('content');
    await observer.drain();
    expect(observer.requests[0]?.response).toMatchObject({
      content: 'ab',
      thinking: 'h',
      tool_calls: [{ function: { name: 'read' } }],
    });
  });
  it('ignores other endpoints and enforces request ceilings', async () => {
    const fake = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    globalThis.fetch = fake;
    const observer = installBehaviorTransport({ endpoint, variant: 'baseline', maxRequests: 1 });
    await fetch('http://other:11434/api/chat', { method: 'POST', body });
    await fetch(`${endpoint}/api/chat-extra`, { method: 'POST', body });
    expect(observer.requests).toHaveLength(0);
    await fetch(`${endpoint}/api/chat`, { method: 'POST', body });
    await expect(fetch(`${endpoint}/api/chat`, { method: 'POST', body })).rejects.toThrow('ceiling');
    expect(fake).toHaveBeenCalledTimes(3);
    await observer.drain();
  });
  it('preserves Request options and bounds concurrent Request inputs', async () => {
    const fake = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    globalThis.fetch = fake;
    const observer = installBehaviorTransport({ endpoint, variant: 'baseline', maxRequests: 1 });
    const request = () =>
      new Request(`${endpoint}/api/chat`, { method: 'POST', body, headers: { authorization: 'example' } });
    const outcomes = await Promise.allSettled([fetch(request()), fetch(request())]);
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(fake).toHaveBeenCalledTimes(1);
    expect((fake.mock.calls[0]![0] as Request).headers.get('authorization')).toBe('example');
    await observer.drain();
  });
  it('caps observed bytes while leaving the response intact', async () => {
    globalThis.fetch = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ message: { content: 'x'.repeat(10000) } })));
    const observer = installBehaviorTransport({ endpoint, variant: 'baseline', maxResponseBytes: 100 });
    const response = await fetch(`${endpoint}/api/chat`, { method: 'POST', body });
    expect((await response.text()).length).toBeGreaterThan(10000);
    await observer.drain();
    expect(observer.requests[0]?.responseTruncated).toBe(true);
  });
  it('records delegates, compaction and network errors', async () => {
    globalThis.fetch = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    const observer = installBehaviorTransport({ endpoint, variant: 'baseline' });
    await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ messages: [{ role: 'system', content: 'You are a specialist' }] }),
    });
    await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      body: JSON.stringify({ format: { type: 'object' }, messages: [] }),
    });
    await observer.drain();
    expect(observer.requests.map(request => request.owner)).toEqual(['delegate', 'compaction']);
    observer.restore();
    globalThis.fetch = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'));
    const failed = installBehaviorTransport({ endpoint, variant: 'baseline' });
    await expect(fetch(`${endpoint}/api/chat`, { method: 'POST', body })).rejects.toThrow('offline');
    expect(failed.requests[0]?.error).toContain('offline');
  });
});
