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
 * Issue types for cycle detection
 */
export type IssueType =
  | 'exact_duplicate'
  | 'repeated_file'
  | 'similar_calls'
  | 'low_hit_rate'
  | 'empty_streak';

/**
 * Severity levels for detected issues
 */
export type Severity = 'high' | 'medium' | 'low';

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
  /** Type of issue detected (optional) */
  issueType?: IssueType;
  /** Severity of the issue (optional) */
  severity?: Severity;
  /** Custom message to override default warning (optional) */
  customMessage?: string;
  /** Additional metadata about the issue (optional) */
  metadata?: {
    filePath?: string;
    hitRate?: number;
    consecutiveEmpty?: number;
    searchTotal?: number;
    searchHits?: number;
    fileAccessCount?: number;
    [key: string]: any;
  };
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

  /** File access count tracker (for repeated file detection) */
  private fileAccessCount: Map<string, number> = new Map();

  /** Number of searches that returned results */
  private searchHits: number = 0;

  /** Total number of searches performed */
  private searchTotal: number = 0;

  /** Consecutive empty result streak */
  private consecutiveEmpty: number = 0;

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
   * Detect repeated file access pattern
   *
   * @param toolCall - Tool call to check
   * @returns Cycle info if repeated file access detected, null otherwise
   */
  private detectRepeatedFileAccess(toolCall: {
    function: { name: string; arguments: Record<string, any> };
  }): CycleInfo | null {
    // Only applies to read tool
    if (toolCall.function.name !== 'Read' && toolCall.function.name !== 'read') {
      return null;
    }

    // Get file path from arguments
    const filePath = toolCall.function.arguments.file_path || toolCall.function.arguments.file_paths?.[0];
    if (!filePath) {
      return null;
    }

    // Get current access count
    const count = this.fileAccessCount.get(filePath) || 0;

    // Check if threshold exceeded
    if (count >= AGENT_CONFIG.REPEATED_FILE_THRESHOLD) {
      return {
        toolName: toolCall.function.name,
        count: count + 1,
        isValidRepeat: false,
        issueType: 'repeated_file',
        severity: 'medium',
        customMessage: `File ${filePath} has been read ${count + 1} times. Consider if this information is already available in context.`,
        metadata: {
          filePath,
          fileAccessCount: count + 1,
        },
      };
    }

    return null;
  }

  /**
   * Parse a signature into tool name and parameter set
   *
   * @param signature - Signature string to parse
   * @returns Object with tool name and parameter set
   */
  private parseSignature(signature: string): { toolName: string; params: Set<string> } {
    const parts = signature.split('|');
    const toolName = parts[0] || '';
    const params = new Set(parts.slice(1)); // All key:value pairs
    return { toolName, params };
  }

  /**
   * Check if two signatures are similar using Jaccard similarity on parameters
   *
   * This approach compares parameter overlap rather than string distance,
   * making it more robust to calls with varying numbers of parameters.
   *
   * @param sig1 - First signature
   * @param sig2 - Second signature
   * @returns True if signatures are similar (60%+ parameter overlap)
   */
  private areSimilarSignatures(sig1: string, sig2: string): boolean {
    // If exact match, not similar (handled by exact duplicate detection)
    if (sig1 === sig2) {
      return false;
    }

    const parsed1 = this.parseSignature(sig1);
    const parsed2 = this.parseSignature(sig2);

    // Tool names must match exactly
    if (parsed1.toolName !== parsed2.toolName) {
      return false;
    }

    // Calculate Jaccard similarity: intersection / union
    const intersection = new Set([...parsed1.params].filter(p => parsed2.params.has(p)));
    const union = new Set([...parsed1.params, ...parsed2.params]);

    const similarity = union.size > 0 ? intersection.size / union.size : 0;

    return similarity >= 0.6; // 60% parameter overlap
  }

  /**
   * Detect similar (but not identical) tool calls
   *
   * @param toolCall - Tool call to check
   * @returns Cycle info if similar calls detected, null otherwise
   */
  private detectSimilarCalls(toolCall: {
    function: { name: string; arguments: Record<string, any> };
  }): CycleInfo | null {
    const signature = this.createToolCallSignature(toolCall);

    // Count similar calls in history
    const similarCalls = this.toolCallHistory.filter(entry => this.areSimilarSignatures(entry.signature, signature));

    const count = similarCalls.length;

    if (count >= AGENT_CONFIG.SIMILAR_CALL_THRESHOLD) {
      return {
        toolName: toolCall.function.name,
        count: count + 1,
        isValidRepeat: false,
        issueType: 'similar_calls',
        severity: 'medium',
        customMessage: `Similar ${toolCall.function.name} calls detected ${count + 1} times. Consider if you're making progress or stuck in a pattern.`,
        metadata: {
          similarCallCount: count + 1,
        },
      };
    }

    return null;
  }

  /**
   * Detect low search hit rate
   *
   * @returns Cycle info if low hit rate detected, null otherwise
   */
  private detectLowHitRate(): CycleInfo | null {
    // Need minimum searches to establish pattern
    if (this.searchTotal < AGENT_CONFIG.MIN_SEARCHES_FOR_HIT_RATE) {
      return null;
    }

    const hitRate = this.searchHits / this.searchTotal;

    if (hitRate < AGENT_CONFIG.HIT_RATE_THRESHOLD) {
      return {
        toolName: 'Search',
        count: this.searchTotal,
        isValidRepeat: false,
        issueType: 'low_hit_rate',
        severity: 'high',
        customMessage: `Low search success rate: ${Math.round(hitRate * 100)}% (${this.searchHits}/${this.searchTotal}). Consider adjusting search strategy or looking in different locations.`,
        metadata: {
          hitRate,
          searchHits: this.searchHits,
          searchTotal: this.searchTotal,
        },
      };
    }

    return null;
  }

  /**
   * Detect consecutive empty search results
   *
   * @returns Cycle info if empty streak detected, null otherwise
   */
  private detectEmptyStreak(): CycleInfo | null {
    if (this.consecutiveEmpty >= AGENT_CONFIG.EMPTY_STREAK_THRESHOLD) {
      return {
        toolName: 'Search',
        count: this.consecutiveEmpty,
        isValidRepeat: false,
        issueType: 'empty_streak',
        severity: 'high',
        customMessage: `${this.consecutiveEmpty} consecutive searches with no results. Consider changing your search approach or exploring different paths.`,
        metadata: {
          consecutiveEmpty: this.consecutiveEmpty,
        },
      };
    }

    return null;
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

    // Per-tool-call detections
    for (const toolCall of toolCalls) {
      const signature = this.createToolCallSignature(toolCall);

      // 1. Exact duplicate detection (existing functionality)
      const previousCalls = this.toolCallHistory.filter(entry => entry.signature === signature);
      const count = previousCalls.length + 1; // +1 for current call

      if (count >= this.cycleThreshold) {
        // Check if this is a valid repeat (file modification)
        const isValidRepeat = this.isValidFileRepeat(toolCall, previousCalls);

        cycles.set(toolCall.id, {
          toolName: toolCall.function.name,
          count,
          isValidRepeat,
          issueType: 'exact_duplicate',
          severity: isValidRepeat ? 'low' : 'high',
        });

        logger.debug(
          '[CYCLE_DETECTOR]',
          this.instanceId,
          `Detected exact duplicate: ${toolCall.function.name} called ${count} times (valid repeat: ${isValidRepeat})`
        );
      }

      // 2. Repeated file access detection
      if (!cycles.has(toolCall.id)) {
        const repeatedFile = this.detectRepeatedFileAccess(toolCall);
        if (repeatedFile) {
          cycles.set(toolCall.id, repeatedFile);
          logger.debug('[CYCLE_DETECTOR]', this.instanceId, `Detected repeated file access: ${repeatedFile.metadata?.filePath}`);
        }
      }

      // 3. Similar calls detection
      if (!cycles.has(toolCall.id)) {
        const similarCalls = this.detectSimilarCalls(toolCall);
        if (similarCalls) {
          cycles.set(toolCall.id, similarCalls);
          logger.debug('[CYCLE_DETECTOR]', this.instanceId, `Detected similar calls: ${toolCall.function.name}`);
        }
      }
    }

    // Global detections (not tied to specific tool call)
    // We'll use a synthetic ID for these
    const globalId = 'global-pattern-detection';

    // 4. Low hit rate detection
    const lowHitRate = this.detectLowHitRate();
    if (lowHitRate) {
      cycles.set(globalId, lowHitRate);
      logger.debug('[CYCLE_DETECTOR]', this.instanceId, `Detected low hit rate: ${lowHitRate.metadata?.hitRate}`);
    }

    // 5. Empty streak detection
    if (!cycles.has(globalId)) {
      const emptyStreak = this.detectEmptyStreak();
      if (emptyStreak) {
        cycles.set(globalId, emptyStreak);
        logger.debug('[CYCLE_DETECTOR]', this.instanceId, `Detected empty streak: ${emptyStreak.metadata?.consecutiveEmpty}`);
      }
    }

    return cycles;
  }

  /**
   * Record metrics for a tool call and its result
   *
   * @param toolCall - Tool call to record metrics for
   * @param result - Optional result of the tool call
   */
  private recordMetrics(
    toolCall: { function: { name: string; arguments: Record<string, any> } },
    result?: { success: boolean; [key: string]: any }
  ): void {
    const toolName = toolCall.function.name;

    // Track file access counts for read operations
    if (toolName === 'Read' || toolName === 'read') {
      const filePath = toolCall.function.arguments.file_path || toolCall.function.arguments.file_paths?.[0];
      if (filePath) {
        const currentCount = this.fileAccessCount.get(filePath) || 0;
        this.fileAccessCount.set(filePath, currentCount + 1);
      }
    }

    // Track search hits/misses for grep/glob operations (only if result is provided)
    if (result && (toolName === 'Grep' || toolName === 'grep' || toolName === 'Glob' || toolName === 'glob')) {
      this.searchTotal++;

      // Check if search was successful
      // A search is successful if it returned results
      const hasResults =
        result.success &&
        (result.matches?.length > 0 ||
          result.files?.length > 0 ||
          result.count > 0 ||
          (typeof result.output === 'string' && result.output.trim().length > 0));

      if (hasResults) {
        this.searchHits++;
        this.consecutiveEmpty = 0; // Reset empty streak
      } else {
        this.consecutiveEmpty++;
      }
    }
  }

  /**
   * Add tool calls to history for cycle detection
   *
   * Should be called AFTER tool execution to track what was executed.
   *
   * @param toolCalls - Tool calls to add to history
   * @param results - Optional array of tool results (for metric tracking)
   */
  recordToolCalls(
    toolCalls: Array<{
      id: string;
      function: { name: string; arguments: Record<string, any> };
    }>,
    results?: Array<{ success: boolean; [key: string]: any }>
  ): void {
    for (let i = 0; i < toolCalls.length; i++) {
      const toolCall = toolCalls[i];
      if (!toolCall) continue;

      const signature = this.createToolCallSignature(toolCall);
      let fileHashes: Map<string, string> | undefined;

      // Record metrics if results provided
      if (results && results[i]) {
        this.recordMetrics(toolCall, results[i]);
      } else {
        // Still track file access counts even without results
        this.recordMetrics(toolCall);
      }

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
    this.fileAccessCount.clear();
    this.searchHits = 0;
    this.searchTotal = 0;
    this.consecutiveEmpty = 0;
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
