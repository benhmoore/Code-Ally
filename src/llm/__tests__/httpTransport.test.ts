import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyHttpError,
  createHttpResponseError,
  HttpResponseError,
  readWithTimeout,
  runWithRetries,
} from '../httpTransport.js';
import { RETRY_CONFIG } from '../../config/constants.js';

describe('HTTP response errors', () => {
  it('surfaces a JSON error detail without retrying a deterministic server rejection', () => {
    const error = createHttpResponseError(500, JSON.stringify({ error: 'system message must be at the beginning' }));

    expect(error).toBeInstanceOf(HttpResponseError);
    expect(error.message).toBe('HTTP 500: system message must be at the beginning');
    expect(error.responseBody).toContain('system message');
    expect(error.retryable).toBe(false);
    expect(classifyHttpError(error)).toBe('non_retryable');
  });

  it('continues to retry generic transient server failures', () => {
    const error = createHttpResponseError(503, 'service temporarily unavailable');

    expect(error.retryable).toBe(true);
    expect(classifyHttpError(error)).toBe('server');
  });

  it('does not retry ordinary client errors', () => {
    const error = createHttpResponseError(400, 'bad request');

    expect(error.retryable).toBe(false);
    expect(classifyHttpError(error)).toBe('non_retryable');
  });
});

describe('runWithRetries failure budget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const harness = (attempt: () => Promise<string>) =>
    runWithRetries<string>({
      attempt,
      onInterrupted: () => 'interrupted',
      onError: (error: any) => `error:${error.message}`,
    });

  it('gives up after the configured run of consecutive retryable failures', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const promise = harness(async () => {
      attempts++;
      throw new Error('ECONNREFUSED');
    });

    await vi.runAllTimersAsync();

    expect(await promise).toBe('error:Too many consecutive failures');
    expect(attempts).toBe(RETRY_CONFIG.MAX_CONSECUTIVE_FAILURES);
  });

  it('counts failures per request, so an exhausted request never poisons the next one', async () => {
    vi.useFakeTimers();
    const exhausted = harness(async () => {
      throw new Error('ECONNREFUSED');
    });
    await vi.runAllTimersAsync();
    expect(await exhausted).toBe('error:Too many consecutive failures');

    // A restarted local server is healthy immediately: the very next request
    // must reach it rather than being refused by leftover failure state.
    expect(await harness(async () => 'ok')).toBe('ok');
  });

  it('stops immediately on a non-retryable error without consuming the budget', async () => {
    let attempts = 0;
    const result = await harness(async () => {
      attempts++;
      throw createHttpResponseError(400, 'bad request');
    });

    expect(result).toBe('error:HTTP 400: bad request');
    expect(attempts).toBe(1);
  });
});

describe('readWithTimeout', () => {
  it('returns the chunk when the read settles in time', async () => {
    const reader = { read: async () => ({ done: false, value: 'chunk' }) };

    expect(await readWithTimeout(reader, 1000)).toEqual({ done: false, value: 'chunk' });
  });

  it('throws the retryable stream-timeout error when the stream stalls', async () => {
    const reader = { read: () => new Promise<{ done: boolean }>(() => {}) };

    await expect(readWithTimeout(reader, 5)).rejects.toThrow('Stream read timeout - no data received');
  });

  it('classifies its own timeout as retryable', () => {
    expect(classifyHttpError(new Error('Stream read timeout - no data received'))).toBe('stream_timeout');
  });

  it('clears its timer so a settled read leaves nothing pending', async () => {
    vi.useFakeTimers();
    try {
      const rejection = vi.fn();
      await readWithTimeout({ read: async () => ({ done: true }) }, 5).catch(rejection);
      await vi.advanceTimersByTimeAsync(50);
      expect(rejection).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
