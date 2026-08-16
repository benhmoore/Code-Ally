import { describe, expect, it } from 'vitest';
import { classifyHttpError, createHttpResponseError, HttpResponseError } from '../httpTransport.js';

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
