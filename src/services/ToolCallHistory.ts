import type { ToolCallState } from '@shared/index.js';

/**
 * ToolCallHistory - In-memory history of tool call executions
 *
 * Maintains a circular buffer of completed tool calls for debugging purposes.
 * Stores the last N tool calls with their parameters, outputs, and timing information.
 * Thread-safe for single-threaded environments (Node.js main thread).
 */
export class ToolCallHistory {
  private history: ToolCallState[] = [];
  private readonly maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  /**
   * Add a completed tool call to the history
   */
  addCall(toolCall: ToolCallState): void {
    // Only store completed calls (success or error)
    if (toolCall.status !== 'success' && toolCall.status !== 'error') {
      return;
    }

    this.history.push(toolCall);

    // Maintain circular buffer
    if (this.history.length > this.maxSize) {
      this.history.shift();
    }
  }

  /**
   * Get the last N tool calls
   */
  getLastN(n: number): ToolCallState[] {
    if (n < 0) return [];
    const count = Math.min(n, this.history.length);
    return this.history.slice(-count);
  }

  /**
   * Get all tool calls in history
   */
  getAll(): ToolCallState[] {
    return [...this.history];
  }

  /**
   * Clear all history
   */
  clear(): void {
    this.history = [];
  }

  /**
   * Get total number of calls in history
   */
  getCount(): number {
    return this.history.length;
  }
}
