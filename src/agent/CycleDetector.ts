/**
 * CycleDetector - Detects repetitive tool call patterns
 *
 * Responsibilities:
 * - Track recent tool call signatures
 * - Detect when same tool call is repeated multiple times
 * - Differentiate between true cycles and valid repeats (e.g., file modifications)
 * - Provide cycle information for warning messages
 *
 * This class helps identify when an agent is stuck in a loop, repeatedly
 * calling the same tools with the same arguments without making progress.
 */

import { logger } from '../services/Logger.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { AGENT_CONFIG } from '../config/constants.js';

/**
 * Tool call entry for cycle detection history
 */
interface ToolCallHistoryEntry {
  /** Normalized signature of the tool call */
  signature: string;
  /** Tool name */
  toolName: string;
  /** Timestamp when tool was called */
  timestamp: number;
  /** File content hashes for read operations (to detect modifications) */
  fileHashes?: Map<string, string>;
}

/**
 * Cycle detection result for a specific tool call
 */
export interface CycleInfo {
  /** Tool name */
  toolName: string;
  /** Number of times this signature appeared */
  count: number;
  /** Whether this is a valid repeat (e.g., file was modified) */
  isValidRepeat: boolean;
}

/**
 * Configuration for CycleDetector
 */
export interface CycleDetectorConfig {
  /** Maximum tool call history to track (sliding window) */
  maxHistory?: number;
  /** Number of identical calls to trigger cycle detection */
  cycleThreshold?: number;
  /** Agent instance ID for logging */
  instanceId?: string;
}

/**
 * Detects tool call cycles and repetitive patterns
 */
export class CycleDetector {
  /** Tool call history (sliding window) */
  private toolCallHistory: ToolCallHistoryEntry[] = [];

  /** Maximum history size */
  private readonly maxHistory: number;

  /** Cycle detection threshold (same signature N times = cycle) */
  private readonly cycleThreshold: number;

  /** Agent instance ID for logging */
  private readonly instanceId: string;

  /**
   * Create a new CycleDetector
   *
   * @param config - Configuration options
   */
  constructor(config: CycleDetectorConfig = {}) {
    this.maxHistory = config.maxHistory ?? AGENT_CONFIG.MAX_TOOL_HISTORY;
    this.cycleThreshold = config.cycleThreshold ?? AGENT_CONFIG.CYCLE_THRESHOLD;
    this.instanceId = config.instanceId ?? 'unknown';
  }

  /**
   * Create a normalized signature for a tool call
   *
   * Signatures are used to identify identical tool calls.
   *
   * @param toolCall - Tool call to create signature for
   * @returns Normalized signature string
   */
  private createToolCallSignature(toolCall: {
    function: { name: string; arguments: Record<string, any> };
  }): string {
    const { name, arguments: args } = toolCall.function;

    // Start with tool name
    let signature = name;

    // Sort argument keys for consistency
    const sortedKeys = Object.keys(args || {}).sort();

    // Add each argument to signature
    for (const key of sortedKeys) {
      const value = args[key];

      // Handle arrays specially (join with comma)
      if (Array.isArray(value)) {
        signature += `|${key}:${value.join(',')}`;
      } else if (typeof value === 'object' && value !== null) {
        // For objects, stringify and sort keys
        signature += `|${key}:${JSON.stringify(value)}`;
      } else {
        signature += `|${key}:${value}`;
      }
    }

    return signature;
  }

  /**
   * Get hash of file content for tracking modifications
   *
   * @param filePath - Path to file
   * @returns MD5 hash of file content or null if file doesn't exist
   */
  private getFileHash(filePath: string): string | null {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return crypto.createHash('md5').update(content).digest('hex');
    } catch (error) {
      // File doesn't exist or can't be read
      return null;
    }
  }

  /**
   * Check if a repeated read call is valid (file was modified)
   *
   * @param toolCall - Current tool call
   * @param previousCalls - Previous history entries with same signature
   * @returns True if file was modified between reads
   */
  private isValidFileRepeat(
    toolCall: { function: { name: string; arguments: Record<string, any> } },
    previousCalls: ToolCallHistoryEntry[]
  ): boolean {
    // Only applies to read tool
    if (toolCall.function.name !== 'Read' && toolCall.function.name !== 'read') {
      return false;
    }

    // Get file path from arguments
    const filePath = toolCall.function.arguments.file_path || toolCall.function.arguments.file_paths?.[0];
    if (!filePath) {
      return false;
    }

    // Get current file hash
    const currentHash = this.getFileHash(filePath);
    if (!currentHash) {
      return false; // File doesn't exist
    }

    // Check if any previous call has a different hash (file was modified)
    for (const prevCall of previousCalls) {
      if (prevCall.fileHashes && prevCall.fileHashes.has(filePath)) {
        const prevHash = prevCall.fileHashes.get(filePath);
        if (prevHash !== currentHash) {
          return true; // File was modified
        }
      }
    }

    return false; // File unchanged
  }

  /**
   * Detect tool call cycles in the current batch of tool calls
   *
   * @param toolCalls - Array of tool calls to check
   * @returns Map of tool_call_id to cycle info (if cycle detected)
   */
  detectCycles(
    toolCalls: Array<{
      id: string;
      function: { name: string; arguments: Record<string, any> };
    }>
  ): Map<string, CycleInfo> {
    const cycles = new Map<string, CycleInfo>();

    for (const toolCall of toolCalls) {
      const signature = this.createToolCallSignature(toolCall);

      // Count occurrences in recent history
      const previousCalls = this.toolCallHistory.filter(entry => entry.signature === signature);
      const count = previousCalls.length + 1; // +1 for current call

      if (count >= this.cycleThreshold) {
        // Check if this is a valid repeat (file modification)
        const isValidRepeat = this.isValidFileRepeat(toolCall, previousCalls);

        cycles.set(toolCall.id, {
          toolName: toolCall.function.name,
          count,
          isValidRepeat,
        });

        logger.debug(
          '[CYCLE_DETECTOR]',
          this.instanceId,
          `Detected cycle: ${toolCall.function.name} called ${count} times (valid repeat: ${isValidRepeat})`
        );
      }
    }

    return cycles;
  }

  /**
   * Add tool calls to history for cycle detection
   *
   * Should be called AFTER tool execution to track what was executed.
   *
   * @param toolCalls - Tool calls to add to history
   */
  recordToolCalls(
    toolCalls: Array<{
      id: string;
      function: { name: string; arguments: Record<string, any> };
    }>
  ): void {
    for (const toolCall of toolCalls) {
      const signature = this.createToolCallSignature(toolCall);
      let fileHashes: Map<string, string> | undefined;

      // For read tools, capture file hashes BEFORE execution
      if (toolCall.function.name === 'Read' || toolCall.function.name === 'read') {
        fileHashes = new Map();
        const filePath = toolCall.function.arguments.file_path || toolCall.function.arguments.file_paths?.[0];

        if (filePath) {
          const hash = this.getFileHash(filePath);
          if (hash) {
            fileHashes.set(filePath, hash);
          }
        }

        // Handle multiple file paths if provided
        if (toolCall.function.arguments.file_paths && Array.isArray(toolCall.function.arguments.file_paths)) {
          for (const path of toolCall.function.arguments.file_paths) {
            const hash = this.getFileHash(path);
            if (hash) {
              fileHashes.set(path, hash);
            }
          }
        }
      }

      this.toolCallHistory.push({
        signature,
        toolName: toolCall.function.name,
        timestamp: Date.now(),
        fileHashes,
      });
    }

    // Trim history to max size (sliding window)
    while (this.toolCallHistory.length > this.maxHistory) {
      this.toolCallHistory.shift();
    }
  }

  /**
   * Clear cycle history if the pattern is broken
   *
   * Called after tool execution to check if last 3 calls are all different.
   * If so, the cycle is considered broken and history is cleared.
   */
  clearIfBroken(): void {
    if (this.toolCallHistory.length < AGENT_CONFIG.CYCLE_BREAK_THRESHOLD) {
      return;
    }

    // Check last N entries (where N = CYCLE_BREAK_THRESHOLD)
    const lastN = this.toolCallHistory.slice(-AGENT_CONFIG.CYCLE_BREAK_THRESHOLD);
    const signatures = lastN.map(entry => entry.signature);

    // If all different, cycle is broken - clear history
    if (new Set(signatures).size === AGENT_CONFIG.CYCLE_BREAK_THRESHOLD) {
      logger.debug('[CYCLE_DETECTOR]', this.instanceId, 'Cycle broken - clearing history');
      this.toolCallHistory = [];
    }
  }

  /**
   * Clear all history
   *
   * Called on new user input to reset cycle detection state.
   */
  clearHistory(): void {
    this.toolCallHistory = [];
    logger.debug('[CYCLE_DETECTOR]', this.instanceId, 'History cleared');
  }

  /**
   * Get current history size
   *
   * @returns Number of tool calls in history
   */
  getHistorySize(): number {
    return this.toolCallHistory.length;
  }

  /**
   * Get cycle threshold
   *
   * @returns Number of identical calls that trigger cycle detection
   */
  getCycleThreshold(): number {
    return this.cycleThreshold;
  }
}
