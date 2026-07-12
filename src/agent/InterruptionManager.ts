/**
 * InterruptionManager - Manages agent interruption state and behavior
 *
 * Responsibilities:
 * - Track interruption state (interrupted, wasInterrupted)
 * - Preserve a typed interruption cause
 * - Handle abort controller lifecycle for tool execution
 * - Provide clean API for interruption operations
 *
 * User cancellation ends a turn. Interjections and internal recovery causes stop
 * only the current generation so the owning Agent can continue coherently.
 */

/**
 * Context information about an interruption
 */
export type UserInterruptionCause =
  | { kind: 'user_cancel' }
  | { kind: 'user_interjection' };

export type RecoverableInterruptionCause =
  | { kind: 'activity_timeout'; reason: string }
  | { kind: 'thinking_loop'; reason: string }
  | { kind: 'response_loop'; reason: string };

export type InterruptionCause = UserInterruptionCause | RecoverableInterruptionCause;

export function isRecoverableInterruption(
  cause: InterruptionCause | null
): cause is RecoverableInterruptionCause {
  return cause !== null && cause.kind !== 'user_cancel' && cause.kind !== 'user_interjection';
}

/**
 * InterruptionManager handles all interruption-related state and behavior
 */
export class InterruptionManager {
  /** Current interruption state - true if currently interrupted */
  private interrupted: boolean = false;

  /** Whether the previous request was interrupted */
  private wasInterrupted: boolean = false;

  /** The single source of truth for why generation stopped. */
  private cause: InterruptionCause | null = null;

  /** Abort controller for ongoing tool executions */
  private toolAbortController?: AbortController;

  /**
   * Abort controller for the in-flight LLM request.
   *
   * Owned by this agent and handed to ModelClient.send() as its `signal`, so an
   * interrupt cancels only THIS agent's request — never sibling agents that share
   * the same underlying client. Distinct from the tool controller because an
   * interjection cancels the in-flight generation but must NOT abort running tools.
   */
  private requestAbortController?: AbortController;

  /**
   * Check if currently interrupted
   *
   * @returns true if an interruption is active
   */
  isInterrupted(): boolean {
    return this.interrupted;
  }

  /**
   * Check if the previous request was interrupted
   *
   * @returns true if previous request was interrupted
   */
  wasRequestInterrupted(): boolean {
    return this.wasInterrupted;
  }

  /**
   * Get the current interruption type
   *
   * @returns Interruption type or null if not interrupted
   */
  getCause(): InterruptionCause | null {
    return this.cause ? { ...this.cause } : null;
  }

  /**
   * Set an interruption
   *
   * Marks the agent as interrupted and stores the interruption type.
   * For cancel interruptions, also aborts any ongoing tool executions.
   *
   * @param type Type of interruption (default: 'cancel')
   */
  interrupt(cause: InterruptionCause): void {
    this.interrupted = true;
    this.cause = cause;

    // Both a hard cancel and an interjection stop the in-flight generation, so the
    // request signal is aborted for either type. Abort the EXISTING controller (the
    // one send() is listening to) rather than replacing it.
    this.ensureRequestAbortController();
    this.requestAbortController!.abort();

    // Only a hard cancel tears down running tools; an interjection lets them finish.
    if (cause.kind === 'user_cancel' || cause.kind === 'activity_timeout') {
      this.ensureAbortController();
      if (this.toolAbortController) {
        this.toolAbortController.abort();
      }
    }
  }

  /**
   * Reset interruption state after handling
   *
   * Clears the interrupted flag and interruption type.
   * Does NOT clear wasInterrupted - that persists until next user message.
   */
  reset(): void {
    this.interrupted = false;
    this.cause = null;

    // A reset means the current interrupt has been handled and future work can
    // proceed. Do not keep an already-aborted controller around, or the next
    // tool batch / LLM request will fail immediately with a false interruption.
    if (this.toolAbortController?.signal.aborted) {
      this.toolAbortController = undefined;
    }
    if (this.requestAbortController?.signal.aborted) {
      this.requestAbortController = undefined;
    }
  }

  /**
   * Mark the current request as interrupted for next request
   *
   * Sets wasInterrupted flag so the next user message gets a reminder.
   */
  markRequestAsInterrupted(): void {
    this.wasInterrupted = true;
  }

  /**
   * Clear the wasInterrupted flag
   *
   * Called after injecting the interruption reminder message.
   */
  clearWasInterrupted(): void {
    this.wasInterrupted = false;
  }

  /**
   * Ensure abort controller exists
   *
   * Creates the controller if it doesn't exist. This ensures an interrupt can
   * abort even if it arrives before startToolExecution() is called.
   */
  private ensureAbortController(): void {
    if (!this.toolAbortController || this.toolAbortController.signal.aborted) {
      this.toolAbortController = new AbortController();
    }
  }

  /**
   * Ensure the LLM request abort controller exists.
   *
   * Unlike the tool controller, this does NOT replace an already-aborted
   * controller: when interrupt() runs, the in-flight send() is listening to the
   * current controller's signal, so we must abort that exact instance rather
   * than swap in a fresh one (which would never fire). reset()/beginRequest()
   * handle retiring a spent controller.
   */
  private ensureRequestAbortController(): void {
    if (!this.requestAbortController) {
      this.requestAbortController = new AbortController();
    }
  }

  /**
   * Begin an LLM request and get the abort signal to hand to ModelClient.send().
   *
   * Each request gets a fresh controller so a prior request's cancellation never
   * leaks into the next one. If an interrupt is already pending when the request
   * starts, the signal is born aborted so send() returns immediately instead of
   * issuing a doomed network call.
   *
   * @returns AbortSignal that this agent owns for the request
   */
  beginRequest(): AbortSignal {
    this.requestAbortController = new AbortController();

    if (this.interrupted) {
      this.requestAbortController.abort();
    }

    return this.requestAbortController.signal;
  }

  /**
   * Start tool execution by creating a fresh AbortController
   *
   * Call this at the beginning of each tool execution batch.
   * Returns an AbortSignal that can be passed to tool implementations.
   *
   * @returns AbortSignal for the tool execution
   */
  startToolExecution(): AbortSignal {
    this.toolAbortController = new AbortController();

    if (this.interrupted && (this.cause?.kind === 'user_cancel' || this.cause?.kind === 'activity_timeout')) {
      this.toolAbortController.abort();
    }

    return this.toolAbortController!.signal;
  }

  /**
   * Get the current tool abort signal
   *
   * Used by ToolOrchestrator to pass signal to tools.
   *
   * @returns AbortSignal if available, undefined otherwise
   */
  getToolAbortSignal(): AbortSignal | undefined {
    return this.toolAbortController?.signal;
  }

  /**
   * Clean up request state after completion or error
   *
   * Full teardown at end of request: resets interruption state and clears the abort controller.
   * Use reset() for retry/continuation within a request; use cleanup() at request end.
   */
  cleanup(): void {
    this.reset();
    this.toolAbortController = undefined;
    this.requestAbortController = undefined;
  }
}
