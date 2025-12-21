/**
 * InterruptionManager - Manages agent interruption state and behavior
 *
 * Responsibilities:
 * - Track interruption state (interrupted, wasInterrupted)
 * - Manage interruption types (cancel vs interjection)
 * - Store interruption context (reason, timeout status)
 * - Handle abort controller lifecycle for tool execution
 * - Provide clean API for interruption operations
 *
 * Interruption types:
 * - cancel: User pressed Ctrl+C, abort everything
 * - interjection: User submitted new message mid-response, handle gracefully
 *
 * Interruption contexts:
 * - User-initiated: Ctrl+C or new message
 * - Timeout: Agent stuck without tool calls (activity timeout)
 * - Permission denied: Security violation during tool execution
 */

/**
 * Context information about an interruption
 */
export interface InterruptionContext {
  /** Human-readable reason for the interruption */
  reason: string;
  /** Whether this was triggered by a timeout */
  isTimeout: boolean;
  /** Whether this timeout is eligible for continuation (vs fatal) */
  canContinueAfterTimeout?: boolean;
}

/**
 * InterruptionManager handles all interruption-related state and behavior
 */
export class InterruptionManager {
  /** Current interruption state - true if currently interrupted */
  private interrupted: boolean = false;

  /** Whether the previous request was interrupted */
  private wasInterrupted: boolean = false;

  /** Type of interruption currently active */
  private interruptionType: 'cancel' | 'interjection' | null = null;

  /** Context information about the current interruption */
  private interruptionContext: InterruptionContext = {
    reason: '',
    isTimeout: false,
  };

  /** Abort controller for ongoing tool executions */
  private toolAbortController?: AbortController;

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
  getInterruptionType(): 'cancel' | 'interjection' | null {
    return this.interruptionType;
  }

  /**
   * Get the current interruption context
   *
   * @returns Context information about the interruption
   */
  getInterruptionContext(): InterruptionContext {
    return { ...this.interruptionContext };
  }

  /**
   * Set an interruption
   *
   * Marks the agent as interrupted and stores the interruption type.
   * For cancel interruptions, also aborts any ongoing tool executions.
   *
   * @param type Type of interruption (default: 'cancel')
   */
  interrupt(type: 'cancel' | 'interjection' = 'cancel'): void {
    this.interrupted = true;
    this.interruptionType = type;

    // Ensure abort controller exists before aborting
    if (type === 'cancel') {
      this.ensureAbortController();
      if (this.toolAbortController) {
        this.toolAbortController.abort();
        this.toolAbortController = undefined;
      }
    }
  }

  /**
   * Set interruption context
   *
   * Stores the reason and timeout status for this interruption.
   * Used to provide meaningful error messages to users.
   *
   * @param context Context information about the interruption
   */
  setInterruptionContext(context: InterruptionContext): void {
    this.interruptionContext = { ...context };
  }

  /**
   * Reset interruption state after handling
   *
   * Clears the interrupted flag and interruption type.
   * Does NOT clear wasInterrupted - that persists until next user message.
   */
  reset(): void {
    this.interrupted = false;
    this.interruptionType = null;
    this.interruptionContext = {
      reason: '',
      isTimeout: false,
    };
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
   * Creates the controller if it doesn't exist. This ensures an interrupt
   * can abort even if it arrives before startToolExecution() is called.
   */
  private ensureAbortController(): void {
    if (!this.toolAbortController) {
      this.toolAbortController = new AbortController();
    }
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
    this.ensureAbortController();
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
   * Delegates to reset() to avoid code duplication.
   * Kept as separate method for semantic clarity at call sites.
   */
  cleanup(): void {
    this.reset();
  }
}
