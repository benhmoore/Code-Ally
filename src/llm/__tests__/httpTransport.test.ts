import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyHttpError,
  createHttpResponseError,
  HttpResponseError,
  isStreamTimeoutError,
  readResponseTextWithTimeout,
  readWithTimeout,
  StreamProgressDeadline,
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

  it.each([408, 425, 502, 504])('retries transient HTTP %s responses', (status) => {
    expect(classifyHttpError(createHttpResponseError(status, 'temporary'))).toBe('server');
  });

  it('classifies the clients own request timeout as retryable', () => {
    expect(classifyHttpError(new Error('Request timeout'))).toBe('network');
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

  it('lets a foreground owner recover after more than the auxiliary failure ceiling', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const promise = runWithRetries({
      attempt: async () => {
        attempts += 1;
        if (attempts < RETRY_CONFIG.MAX_CONSECUTIVE_FAILURES + 3) throw new Error('ECONNREFUSED');
        return 'recovered';
      },
      onInterrupted: () => 'interrupted',
      onError: (error) => `error:${error.message}`,
      maxFailures: Infinity,
      maxTotalMs: Infinity,
    });
    await vi.runAllTimersAsync();
    expect(await promise).toBe('recovered');
    expect(attempts).toBe(RETRY_CONFIG.MAX_CONSECUTIVE_FAILURES + 3);
  });

  it('cancels an in-progress backoff immediately', async () => {
    const controller = new AbortController();
    let attempts = 0;
    const result = await runWithRetries({
      attempt: async () => { attempts += 1; throw new Error('ECONNREFUSED'); },
      onInterrupted: () => 'interrupted',
      onError: () => 'error',
      onRetry: () => controller.abort(),
      signal: controller.signal,
      maxFailures: Infinity,
      maxTotalMs: Infinity,
    });
    expect(result).toBe('interrupted');
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
    expect(classifyHttpError(new Error('Stream progress timeout - no model output received'))).toBe('stream_timeout');
    expect(isStreamTimeoutError(new Error('Stream progress timeout - no model output received'))).toBe(true);
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

describe('StreamProgressDeadline', () => {
  it('is not extended by transport reads, only explicit model progress', () => {
    let now = 1000;
    const deadline = new StreamProgressDeadline(100, () => now);

    now = 1090;
    expect(deadline.nextReadTimeout(1000)).toBe(10);
    now = 1100;
    expect(() => deadline.nextReadTimeout()).toThrow('Stream progress timeout');

    deadline.progress();
    now = 1190;
    expect(deadline.nextReadTimeout(1000)).toBe(10);
  });

  it('preserves a shorter ordinary per-read timeout', () => {
    const deadline = new StreamProgressDeadline(1000, () => 0);
    expect(deadline.nextReadTimeout(25)).toBe(25);
  });
});

describe('readResponseTextWithTimeout', () => {
  it('aborts a response whose body never arrives after headers', async () => {
    const controller = new AbortController();
    const response = { text: () => new Promise<string>(() => {}) };
    await expect(readResponseTextWithTimeout(response, 5, controller)).rejects.toThrow('Request timeout');
    expect(controller.signal.aborted).toBe(true);
  });
});
