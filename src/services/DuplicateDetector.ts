/**
 * DuplicateDetector - Unified duplicate detection for tool calls
 *
 * Detects when identical tool calls are made and provides appropriate feedback:
 * - Same turn: Returns error to block execution
 * - Different turn: Returns warning but allows execution
 */

import { createParameterSignature } from '../utils/parameterHasher.js';

interface ToolCallRecord {
  signature: string;
  toolName: string;
  turnNumber: number;
  timestamp: number;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  shouldBlock: boolean;
  message: string | null;
}

/**
 * Configuration for duplicate detection
 */
export interface DuplicateDetectorConfig {
  /** Tools to track for duplicate detection */
  trackedTools?: string[];
  /** Maximum number of records to keep (prevents unbounded growth) */
  maxRecords?: number;
}

/**
 * Detects duplicate tool calls across conversation history
 */
export class DuplicateDetector {
  private readonly trackedTools: Set<string>;
  private readonly maxRecords: number;
  private callHistory: Map<string, ToolCallRecord> = new Map();
  private currentTurn: number = 0;

  constructor(config: DuplicateDetectorConfig = {}) {
    this.trackedTools = new Set(config.trackedTools || ['read', 'ls', 'glob', 'grep']);
    this.maxRecords = config.maxRecords || 200;
  }

  /**
   * Check if a tool call is a duplicate
   *
   * Returns result indicating if duplicate was found and whether to block execution.
   * Does not record the call - use recordCall() after successful execution.
   */
  check(
    toolName: string,
    params: Record<string, any>
  ): DuplicateCheckResult {
    if (!this.trackedTools.has(toolName)) {
      return { isDuplicate: false, shouldBlock: false, message: null };
    }

    const signature = createParameterSignature(toolName, params);
    const previousCall = this.callHistory.get(signature);

    if (!previousCall) {
      return { isDuplicate: false, shouldBlock: false, message: null };
    }

    const turnsAgo = this.currentTurn - previousCall.turnNumber;

    if (turnsAgo === 0) {
      // Same turn - block execution
      return {
        isDuplicate: true,
        shouldBlock: true,
        message: `Redundant tool call detected: ${toolName} was already called with the same arguments in this turn`,
      };
    } else {
      // Different turn - warn but allow
      const agoText = turnsAgo === 1 ? '1 turn ago' : `${turnsAgo} turns ago`;
      return {
        isDuplicate: true,
        shouldBlock: false,
        message: `This exact ${toolName} call was previously made in turn ${previousCall.turnNumber} (${agoText}). The previous result should still be in your context. Consider reviewing it before making additional calls.`,
      };
    }
  }

  /**
   * Record a tool call after successful execution
   */
  recordCall(toolName: string, params: Record<string, any>): void {
    if (!this.trackedTools.has(toolName)) {
      return;
    }

    const signature = createParameterSignature(toolName, params);

    this.callHistory.set(signature, {
      signature,
      toolName,
      turnNumber: this.currentTurn,
      timestamp: Date.now(),
    });

    if (this.callHistory.size > this.maxRecords) {
      this.evictOldest();
    }
  }

  /**
   * Increment turn counter
   */
  nextTurn(): void {
    this.currentTurn++;
  }

  /**
   * Remove oldest entries when limit exceeded
   */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [key, record] of this.callHistory.entries()) {
      if (record.timestamp < oldestTimestamp) {
        oldestTimestamp = record.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.callHistory.delete(oldestKey);
    }
  }

  /**
   * Clear all tracked history
   */
  clear(): void {
    this.callHistory.clear();
    this.currentTurn = 0;
  }

  /**
   * Get statistics for monitoring
   */
  getStats(): { trackedCalls: number; currentTurn: number } {
    return {
      trackedCalls: this.callHistory.size,
      currentTurn: this.currentTurn,
    };
  }
}
