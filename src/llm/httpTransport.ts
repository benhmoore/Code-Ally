/**
 * Shared HTTP transport concerns for ModelClient implementations.
 *
 * Error classification, retry backoff, and the circuit breaker are protocol-
 * agnostic — they behave identically whether the backend speaks Ollama's native
 * NDJSON API or an OpenAI-compatible /v1 API. Keeping them here means both
 * clients share one battle-tested implementation instead of diverging copies.
 */

import { RETRY_CONFIG } from '../config/constants.js';

/** Retry category for a request error. */
export type ErrorClass = 'network' | 'server' | 'json' | 'stream_timeout' | 'rate_limit' | 'non_retryable';

/**
 * Classify an error for retry decisions. Returns a category that determines the
 * retry strategy; 'non_retryable' means surface the error to the caller.
 */
export function classifyHttpError(error: any): ErrorClass {
  if (error?.name === 'AbortError') return 'non_retryable';

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
 * Circuit breaker that opens after a run of consecutive failures and stays open
 * for a cooldown window, so a persistently-failing backend stops being hammered.
 */
export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  /** Clear all state — call at the start of each new top-level request. */
  reset(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  /** Whether the breaker is currently open (retries paused). */
  isOpen(): boolean {
    return Date.now() < this.openUntil;
  }

  /** Reset just the failure counter (call on a successful response). */
  recordSuccess(): void {
    this.failures = 0;
  }

  /**
   * Record a failure. Returns true if this failure tripped the breaker open.
   */
  recordFailure(): boolean {
    this.failures++;
    if (this.failures >= RETRY_CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
      this.openUntil = Date.now() + RETRY_CONFIG.CIRCUIT_BREAKER_COOLDOWN;
      return true;
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Drive a request to completion with the shared retry policy: capped
 * exponential backoff for retryable errors, a circuit breaker for persistent
 * failures, and an overall time budget. The protocol-specific work (build the
 * request, parse the response, run any validation) lives entirely inside
 * `attempt`; everything here is identical across backends.
 *
 * `attempt` should return the final response for a non-retryable outcome — even
 * an application-level error response that should NOT trigger a retry (e.g. a
 * tool-call validation failure surfaced to the caller). Throw only for genuinely
 * retryable transport errors (network/server/json/stream-timeout/rate-limit) or
 * an AbortError on cancellation.
 */
export async function runWithRetries<T>(params: {
  breaker: CircuitBreaker;
  /** Execute one attempt. `attemptNum` starts at 0. */
  attempt: (attemptNum: number) => Promise<T>;
  /** Build the response returned when the caller aborts (AbortError). */
  onInterrupted: () => T;
  /** Build the terminal response for a non-retryable / budget-exhausted error. */
  onError: (error: any) => T;
  /** Notified before each backoff sleep, for user-visible status. */
  onRetry?: (label: string, delaySeconds: string, attemptNum: number) => void;
}): Promise<T> {
  const { breaker, attempt, onInterrupted, onError, onRetry } = params;
  breaker.reset();

  let attemptNum = 0;
  const startTime = Date.now();

  while (true) {
    if (breaker.isOpen()) {
      return onError(new Error('Circuit breaker open - retries paused'));
    }
    if (Date.now() - startTime > RETRY_CONFIG.MAX_TOTAL_REQUEST_TIME) {
      return onError(new Error('Request timeout after 30 minutes'));
    }

    try {
      const result = await attempt(attemptNum);
      breaker.recordSuccess();
      return result;
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        return onInterrupted();
      }

      const errorClass = classifyHttpError(error);
      if (errorClass !== 'non_retryable') {
        if (breaker.recordFailure()) {
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
