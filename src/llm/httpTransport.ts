/**
 * Shared HTTP transport concerns for ModelClient implementations.
 *
 * Error classification, retry backoff, and stream-read timeouts are protocol-
 * agnostic — they behave identically whether the backend speaks Ollama's native
 * NDJSON API or an OpenAI-compatible /v1 API. Keeping them here means both
 * clients share one battle-tested implementation instead of diverging copies.
 */

import { API_TIMEOUTS, RETRY_CONFIG } from '../config/constants.js';

/** Retry category for a request error. */
export type ErrorClass = 'network' | 'server' | 'json' | 'stream_timeout' | 'rate_limit' | 'non_retryable';

const NON_RETRYABLE_SERVER_ERROR_PATTERNS = [
  /system message must be at the beginning/i,
  /(?:does not support|unsupported) (?:tools?|images?|thinking|reasoning)/i,
  /invalid (?:model|request|message|role|option|parameter|format|template)/i,
  /model .+ (?:not found|does not exist)/i,
  /(?:requires more|not enough|insufficient) (?:system )?(?:memory|ram)/i,
];

/** HTTP failure with the response body and an explicit retry decision. */
export class HttpResponseError extends Error {
  readonly httpStatus: number;
  readonly responseBody: string;
  readonly retryable: boolean;

  constructor(httpStatus: number, responseBody: string) {
    const detail = extractHttpErrorDetail(responseBody);
    super(detail ? `HTTP ${httpStatus}: ${detail}` : `HTTP ${httpStatus}`);
    this.name = 'HttpResponseError';
    this.httpStatus = httpStatus;
    this.responseBody = responseBody;
    this.retryable = isRetryableHttpResponse(httpStatus, responseBody);
  }
}

function extractHttpErrorDetail(responseBody: string): string {
  const trimmed = responseBody.trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed?.error === 'string') return parsed.error;
    if (typeof parsed?.message === 'string') return parsed.message;
  } catch {
    // The body is plain text; surface it as received.
  }

  return trimmed;
}

function isRetryableHttpResponse(httpStatus: number, responseBody: string): boolean {
  if (httpStatus === 429) return true;
  if (httpStatus !== 500 && httpStatus !== 503) return false;

  return !NON_RETRYABLE_SERVER_ERROR_PATTERNS.some(pattern => pattern.test(responseBody));
}

/** Build a response-aware error for the shared retry policy. */
export function createHttpResponseError(httpStatus: number, responseBody: string): HttpResponseError {
  return new HttpResponseError(httpStatus, responseBody);
}

/**
 * Classify an error for retry decisions. Returns a category that determines the
 * retry strategy; 'non_retryable' means surface the error to the caller.
 */
export function classifyHttpError(error: any): ErrorClass {
  if (error?.name === 'AbortError') return 'non_retryable';

  if (error?.retryable === false) return 'non_retryable';

  if (error?.httpStatus === 429) return 'rate_limit';

  if (
    error?.name === 'TypeError' ||
    error?.message?.includes('fetch') ||
    error?.message?.includes('network') ||
    error?.message?.includes('ECONNREFUSED') ||
    error?.message?.includes('ECONNRESET') ||
    error?.message?.includes('EPIPE') ||
    error?.message?.includes('ETIMEDOUT')
  ) return 'network';

  if (error?.httpStatus === 500 || error?.httpStatus === 503) return 'server';

  if (error instanceof SyntaxError) return 'json';

  if (error?.message?.includes('Stream read timeout')) return 'stream_timeout';

  return 'non_retryable';
}

/** Human-readable label per retry category, for status messages. */
export function retryLabel(errorClass: ErrorClass, httpStatus?: number): string {
  const labels: Record<string, string> = {
    network: 'Connection failed',
    server: `Server error (HTTP ${httpStatus})`,
    json: 'Response parse error',
    stream_timeout: 'Stream timeout',
    rate_limit: 'Rate limited',
  };
  return labels[errorClass] || 'Error';
}

/**
 * Compute retry delay with exponential backoff and jitter.
 *
 * Formula: base * 2^attempt + random(0, 0.25 * base * 2^attempt), capped.
 * The jitter spreads retries across time to avoid thundering herds.
 */
export function getRetryDelayMs(attempt: number, maxDelaySeconds: number = RETRY_CONFIG.MAX_BACKOFF_SECONDS): number {
  const baseDelayMs = Math.min(1000 * Math.pow(2, attempt), maxDelaySeconds * 1000);
  const jitter = Math.random() * 0.25 * baseDelayMs;
  return baseDelayMs + jitter;
}

/**
 * Read the next chunk from a response stream, bounded by a timeout.
 *
 * A backend can open a stream, send headers, and then stall indefinitely without
 * closing the connection. The overall request budget is only checked *between*
 * attempts, so without this the read would hang forever. The thrown message is
 * the one `classifyHttpError` maps to the retryable 'stream_timeout' class.
 */
export async function readWithTimeout<T>(
  reader: { read(): Promise<{ done: boolean; value?: T }> },
  timeoutMs: number = API_TIMEOUTS.LLM_REQUEST_BASE
): Promise<{ done: boolean; value?: T }> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error('Stream read timeout - no data received'));
    }, timeoutMs);
  });

  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    // Always clear the timer: a settled read must never leave a dangling timer
    // that later rejects (and aborts) a healthy iteration.
    clearTimeout(timeoutHandle);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Drive a request to completion with the shared retry policy: capped
 * exponential backoff for retryable errors, a consecutive-failure ceiling, and
 * an overall time budget. The protocol-specific work (build the request, parse
 * the response, run any validation) lives entirely inside `attempt`; everything
 * here is identical across backends.
 *
 * All retry bookkeeping is per-request local state. Clients are shared across
 * concurrent agents, so anything stored on the instance would let one agent's
 * failures cancel another's request.
 *
 * `attempt` should return the final response for a non-retryable outcome — even
 * an application-level error response that should NOT trigger a retry (e.g. a
 * tool-call validation failure surfaced to the caller). Throw only for genuinely
 * retryable transport errors (network/server/json/stream-timeout/rate-limit) or
 * an AbortError on cancellation.
 */
export async function runWithRetries<T>(params: {
  /** Execute one attempt. `attemptNum` starts at 0. */
  attempt: (attemptNum: number) => Promise<T>;
  /** Build the response returned when the caller aborts (AbortError). */
  onInterrupted: () => T;
  /** Build the terminal response for a non-retryable / budget-exhausted error. */
  onError: (error: any) => T;
  /** Notified before each backoff sleep, for user-visible status. */
  onRetry?: (label: string, delaySeconds: string, attemptNum: number) => void;
}): Promise<T> {
  const { attempt, onInterrupted, onError, onRetry } = params;

  let attemptNum = 0;
  let failures = 0;
  const startTime = Date.now();

  while (true) {
    if (Date.now() - startTime > RETRY_CONFIG.MAX_TOTAL_REQUEST_TIME) {
      return onError(new Error('Request timeout after 30 minutes'));
    }

    try {
      return await attempt(attemptNum);
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return onInterrupted();
      }

      const errorClass = classifyHttpError(error);
      if (errorClass !== 'non_retryable') {
        failures++;
        if (failures >= RETRY_CONFIG.MAX_CONSECUTIVE_FAILURES) {
          return onError(new Error('Too many consecutive failures'));
        }
        const delayMs = getRetryDelayMs(attemptNum);
        onRetry?.(retryLabel(errorClass, error?.httpStatus), (delayMs / 1000).toFixed(1), attemptNum + 1);
        await sleep(delayMs);
        attemptNum++;
        continue;
      }

      return onError(error);
    }
  }
}
