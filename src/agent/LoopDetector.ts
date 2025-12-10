/**
 * LoopDetector - Unified loop and cycle detection system
 *
 * Detects when an agent is stuck in repetitive patterns:
 * 1. Text-based loops: Repeated patterns in streaming output (thinking/response)
 * 2. Tool call cycles: Repetitive tool invocations without progress
 */

import { logger } from '../services/Logger.js';
import type { ActivityStream } from '../services/ActivityStream.js';
import type { ActivityEventType } from '../types/index.js';
import type { LoopPattern, LoopInfo } from './types/loopDetection.js';
import * as crypto from 'crypto';
import * as fs from 'fs';
import { AGENT_CONFIG } from '../config/constants.js';

// ============================================================================
// TEXT LOOP DETECTION
// ============================================================================

/**
 * Configuration for text-based loop detection
 */
export interface TextLoopConfig {
  /** Event type to monitor (e.g., THOUGHT_CHUNK, RESPONSE_CHUNK) */
  eventType: ActivityEventType;
  /** Pattern matchers to apply */
  patterns: LoopPattern[];
  /** Grace period before starting checks (milliseconds) */
  warmupPeriodMs: number;
  /** How often to check for loops (milliseconds) */
  checkIntervalMs: number;
  /** Callback when loop detected */
  onLoopDetected: (info: LoopInfo) => void;
}

/**
 * TextLoopDetector monitors streaming text for repetitive patterns
 *
 * Detects loops in thinking or response streams by accumulating chunks
 * and periodically running pattern matchers against the accumulated text.
 */
class TextLoopDetector {
  private config: TextLoopConfig;
  private activityStream: ActivityStream;
  private instanceId: string;
  private accumulatedText: string = '';
  private warmupTimer: NodeJS.Timeout | null = null;
  private checkTimer: NodeJS.Timeout | null = null;
  private isMonitoring: boolean = false;
  private hasDetectedLoop: boolean = false;
  private unsubscribe: (() => void) | null = null;

  constructor(config: TextLoopConfig, activityStream: ActivityStream, instanceId: string) {
    this.config = config;
    this.activityStream = activityStream;
    this.instanceId = instanceId;
    this.subscribeToEvents();
  }

  private subscribeToEvents(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    this.unsubscribe = this.activityStream.subscribe(
      this.config.eventType,
      (event) => {
        const chunk = event.data?.chunk;
        if (chunk && typeof chunk === 'string' && chunk.trim().length > 0) {
          this.accumulatedText += chunk;
          if (!this.isMonitoring) {
            this.start();
          }
        }
      }
    );
  }

  private start(): void {
    if (this.isMonitoring) return;

    this.isMonitoring = true;
    this.hasDetectedLoop = false;

    logger.debug(
      '[TEXT_LOOP_DETECTOR]',
      this.instanceId,
      `Started - event: ${this.config.eventType}, warmup: ${this.config.warmupPeriodMs}ms, check interval: ${this.config.checkIntervalMs}ms, patterns: ${this.config.patterns.length}`
    );

    this.warmupTimer = setTimeout(() => {
      this.warmupTimer = null;
      this.checkTimer = setInterval(() => {
        this.checkForLoops();
      }, this.config.checkIntervalMs);
      this.checkForLoops();
      logger.debug('[TEXT_LOOP_DETECTOR]', this.instanceId, 'Warmup complete, checks started');
    }, this.config.warmupPeriodMs);
  }

  private checkForLoops(): void {
    if (this.hasDetectedLoop || this.accumulatedText.length === 0) return;

    logger.debug(
      '[TEXT_LOOP_DETECTOR]',
      this.instanceId,
      `Checking ${this.accumulatedText.length} chars for patterns (${this.config.patterns.length} patterns)`
    );

    // First match wins
    for (const pattern of this.config.patterns) {
      try {
        const loopInfo = pattern.check(this.accumulatedText);
        if (loopInfo) {
          this.handleLoopDetected(loopInfo);
          return;
        }
      } catch (error) {
        logger.error('[TEXT_LOOP_DETECTOR]', this.instanceId, `Pattern ${pattern.name} check failed:`, error);
      }
    }
  }

  private handleLoopDetected(info: LoopInfo): void {
    this.hasDetectedLoop = true;

    logger.debug(
      '[TEXT_LOOP_DETECTOR]',
      this.instanceId,
      `Loop detected: ${info.reason} (pattern: ${info.patternName})`
    );

    try {
      this.config.onLoopDetected(info);
    } catch (error) {
      logger.error('[TEXT_LOOP_DETECTOR]', this.instanceId, 'Loop detection callback failed:', error);
    }

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  stop(): void {
    if (!this.isMonitoring) return;

    if (this.warmupTimer) {
      clearTimeout(this.warmupTimer);
      this.warmupTimer = null;
    }

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    this.isMonitoring = false;
    logger.debug('[TEXT_LOOP_DETECTOR]', this.instanceId, 'Stopped');
  }

  reset(): void {
    this.stop();
    this.accumulatedText = '';
    this.hasDetectedLoop = false;
    this.subscribeToEvents();
    logger.debug('[TEXT_LOOP_DETECTOR]', this.instanceId, 'Reset');
  }

  getAccumulatedLength(): number {
    return this.accumulatedText.length;
  }

  isActive(): boolean {
    return this.isMonitoring;
  }

  hasDetected(): boolean {
    return this.hasDetectedLoop;
  }
}

// ============================================================================
// TOOL CALL CYCLE DETECTION
// ============================================================================

/**
 * Tool call entry for cycle detection history
 */
interface ToolCallHistoryEntry {
  signature: string;
  toolName: string;
  timestamp: number;
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
  toolName: string;
  count: number;
  isValidRepeat: boolean;
  issueType?: IssueType;
  severity?: Severity;
  customMessage?: string;
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
 * ToolCycleDetector tracks repetitive tool call patterns
 *
 * Detects when the same or similar tools are called repeatedly without progress,
 * indicating the agent is stuck in a cycle.
 */
class ToolCycleDetector {
  private instanceId: string;
  private toolCallHistory: ToolCallHistoryEntry[] = [];
  private fileAccessCount: Map<string, number> = new Map();
  private searchHits: number = 0;
  private searchTotal: number = 0;
  private consecutiveEmpty: number = 0;
  private readonly maxHistory: number;
  private readonly cycleThreshold: number;

  constructor(instanceId: string, maxHistory?: number, cycleThreshold?: number) {
    this.instanceId = instanceId;
    this.maxHistory = maxHistory ?? AGENT_CONFIG.MAX_TOOL_HISTORY;
    this.cycleThreshold = cycleThreshold ?? AGENT_CONFIG.CYCLE_THRESHOLD;
  }

  private createToolCallSignature(toolCall: {
    function: { name: string; arguments: Record<string, any> };
  }): string {
    const { name, arguments: args } = toolCall.function;
    let signature = name;

    const sortedKeys = Object.keys(args || {}).sort();
    for (const key of sortedKeys) {
      const value = args[key];
      if (Array.isArray(value)) {
        signature += `|${key}:${value.join(',')}`;
      } else if (typeof value === 'object' && value !== null) {
        signature += `|${key}:${JSON.stringify(value)}`;
      } else {
        signature += `|${key}:${value}`;
      }
    }

    return signature;
  }

  private getFileHash(filePath: string): string | null {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return crypto.createHash('md5').update(content).digest('hex');
    } catch (error) {
      return null;
    }
  }

  private isValidFileRepeat(
    toolCall: { function: { name: string; arguments: Record<string, any> } },
    previousCalls: ToolCallHistoryEntry[]
  ): boolean {
    if (toolCall.function.name !== 'Read' && toolCall.function.name !== 'read') {
      return false;
    }

    const filePath = toolCall.function.arguments.file_path || toolCall.function.arguments.file_paths?.[0];
    if (!filePath) return false;

    const currentHash = this.getFileHash(filePath);
    if (!currentHash) return false;

    for (const prevCall of previousCalls) {
      if (prevCall.fileHashes && prevCall.fileHashes.has(filePath)) {
        const prevHash = prevCall.fileHashes.get(filePath);
        if (prevHash !== currentHash) {
          return true; // File was modified
        }
      }
    }

    return false;
  }

  private detectRepeatedFileAccess(toolCall: {
    function: { name: string; arguments: Record<string, any> };
  }): CycleInfo | null {
    if (toolCall.function.name !== 'Read' && toolCall.function.name !== 'read') {
      return null;
    }

    const filePath = toolCall.function.arguments.file_path || toolCall.function.arguments.file_paths?.[0];
    if (!filePath) return null;

    const count = this.fileAccessCount.get(filePath) || 0;

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

  private parseSignature(signature: string): { toolName: string; params: Set<string> } {
    const parts = signature.split('|');
    const toolName = parts[0] || '';
    const params = new Set(parts.slice(1));
    return { toolName, params };
  }

  private areSimilarSignatures(sig1: string, sig2: string): boolean {
    if (sig1 === sig2) return false;

    const parsed1 = this.parseSignature(sig1);
    const parsed2 = this.parseSignature(sig2);

    if (parsed1.toolName !== parsed2.toolName) return false;

    const intersection = new Set([...parsed1.params].filter(p => parsed2.params.has(p)));
    const union = new Set([...parsed1.params, ...parsed2.params]);

    const similarity = union.size > 0 ? intersection.size / union.size : 0;
    return similarity >= 0.6;
  }

  private detectSimilarCalls(toolCall: {
    function: { name: string; arguments: Record<string, any> };
  }): CycleInfo | null {
    const signature = this.createToolCallSignature(toolCall);
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

  private detectLowHitRate(): CycleInfo | null {
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

      // 1. Exact duplicate detection
      const previousCalls = this.toolCallHistory.filter(entry => entry.signature === signature);
      const count = previousCalls.length + 1;

      if (count >= this.cycleThreshold) {
        const isValidRepeat = this.isValidFileRepeat(toolCall, previousCalls);
        cycles.set(toolCall.id, {
          toolName: toolCall.function.name,
          count,
          isValidRepeat,
          issueType: 'exact_duplicate',
          severity: isValidRepeat ? 'low' : 'high',
        });

        logger.debug(
          '[TOOL_CYCLE_DETECTOR]',
          this.instanceId,
          `Detected exact duplicate: ${toolCall.function.name} called ${count} times (valid repeat: ${isValidRepeat})`
        );
      }

      // 2. Repeated file access detection
      if (!cycles.has(toolCall.id)) {
        const repeatedFile = this.detectRepeatedFileAccess(toolCall);
        if (repeatedFile) {
          cycles.set(toolCall.id, repeatedFile);
          logger.debug('[TOOL_CYCLE_DETECTOR]', this.instanceId, `Detected repeated file access: ${repeatedFile.metadata?.filePath}`);
        }
      }

      // 3. Similar calls detection
      if (!cycles.has(toolCall.id)) {
        const similarCalls = this.detectSimilarCalls(toolCall);
        if (similarCalls) {
          cycles.set(toolCall.id, similarCalls);
          logger.debug('[TOOL_CYCLE_DETECTOR]', this.instanceId, `Detected similar calls: ${toolCall.function.name}`);
        }
      }
    }

    // Global detections
    const globalId = 'global-pattern-detection';

    const lowHitRate = this.detectLowHitRate();
    if (lowHitRate) {
      cycles.set(globalId, lowHitRate);
      logger.debug('[TOOL_CYCLE_DETECTOR]', this.instanceId, `Detected low hit rate: ${lowHitRate.metadata?.hitRate}`);
    }

    if (!cycles.has(globalId)) {
      const emptyStreak = this.detectEmptyStreak();
      if (emptyStreak) {
        cycles.set(globalId, emptyStreak);
        logger.debug('[TOOL_CYCLE_DETECTOR]', this.instanceId, `Detected empty streak: ${emptyStreak.metadata?.consecutiveEmpty}`);
      }
    }

    return cycles;
  }

  private recordMetrics(
    toolCall: { function: { name: string; arguments: Record<string, any> } },
    result?: { success: boolean; [key: string]: any }
  ): void {
    const toolName = toolCall.function.name;

    // Track file access counts
    if (toolName === 'Read' || toolName === 'read') {
      const filePath = toolCall.function.arguments.file_path || toolCall.function.arguments.file_paths?.[0];
      if (filePath) {
        const currentCount = this.fileAccessCount.get(filePath) || 0;
        this.fileAccessCount.set(filePath, currentCount + 1);
      }
    }

    // Track search hits/misses
    if (result && (toolName === 'Grep' || toolName === 'grep' || toolName === 'Glob' || toolName === 'glob')) {
      this.searchTotal++;

      const hasResults =
        result.success &&
        (result.matches?.length > 0 ||
          result.files?.length > 0 ||
          result.count > 0 ||
          (typeof result.output === 'string' && result.output.trim().length > 0));

      if (hasResults) {
        this.searchHits++;
        this.consecutiveEmpty = 0;
      } else {
        this.consecutiveEmpty++;
      }
    }
  }

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

      // Record metrics
      if (results && results[i]) {
        this.recordMetrics(toolCall, results[i]);
      } else {
        this.recordMetrics(toolCall);
      }

      // Capture file hashes for read operations
      if (toolCall.function.name === 'Read' || toolCall.function.name === 'read') {
        fileHashes = new Map();
        const filePath = toolCall.function.arguments.file_path || toolCall.function.arguments.file_paths?.[0];

        if (filePath) {
          const hash = this.getFileHash(filePath);
          if (hash) {
            fileHashes.set(filePath, hash);
          }
        }

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

    // Trim history to max size
    while (this.toolCallHistory.length > this.maxHistory) {
      this.toolCallHistory.shift();
    }
  }

  clearIfBroken(): void {
    if (this.toolCallHistory.length < AGENT_CONFIG.CYCLE_BREAK_THRESHOLD) {
      return;
    }

    const lastN = this.toolCallHistory.slice(-AGENT_CONFIG.CYCLE_BREAK_THRESHOLD);
    const signatures = lastN.map(entry => entry.signature);

    if (new Set(signatures).size === AGENT_CONFIG.CYCLE_BREAK_THRESHOLD) {
      logger.debug('[TOOL_CYCLE_DETECTOR]', this.instanceId, 'Cycle broken - clearing history');
      this.toolCallHistory = [];
    }
  }

  clearHistory(): void {
    this.toolCallHistory = [];
    this.fileAccessCount.clear();
    this.searchHits = 0;
    this.searchTotal = 0;
    this.consecutiveEmpty = 0;
    logger.debug('[TOOL_CYCLE_DETECTOR]', this.instanceId, 'History cleared');
  }

  getHistorySize(): number {
    return this.toolCallHistory.length;
  }

  getCycleThreshold(): number {
    return this.cycleThreshold;
  }
}

// ============================================================================
// UNIFIED LOOP DETECTOR
// ============================================================================

/**
 * Configuration for the unified loop detector
 */
export interface LoopDetectorConfig {
  /** Agent instance ID for logging */
  instanceId?: string;
  /** Configuration for thinking loop detection (optional) */
  thinkingLoopConfig?: TextLoopConfig;
  /** Configuration for response loop detection (optional) */
  responseLoopConfig?: TextLoopConfig;
  /** Maximum tool call history to track (optional) */
  maxToolHistory?: number;
  /** Number of identical calls to trigger cycle detection (optional) */
  cycleThreshold?: number;
}

/**
 * LoopDetector - Unified loop and cycle detection
 *
 * Single entry point for all loop detection:
 * - Text-based loops in thinking/response streams
 * - Tool call cycles and repetitive patterns
 */
export class LoopDetector {
  private readonly instanceId: string;
  private thinkingDetector: TextLoopDetector | null = null;
  private responseDetector: TextLoopDetector | null = null;
  private toolCycleDetector: ToolCycleDetector;

  constructor(config: LoopDetectorConfig, activityStream?: ActivityStream) {
    this.instanceId = config.instanceId ?? 'unknown';

    // Initialize text loop detectors if configured
    if (config.thinkingLoopConfig && activityStream) {
      this.thinkingDetector = new TextLoopDetector(
        config.thinkingLoopConfig,
        activityStream,
        this.instanceId
      );
    }

    if (config.responseLoopConfig && activityStream) {
      this.responseDetector = new TextLoopDetector(
        config.responseLoopConfig,
        activityStream,
        this.instanceId
      );
    }

    // Always initialize tool cycle detector
    this.toolCycleDetector = new ToolCycleDetector(
      this.instanceId,
      config.maxToolHistory,
      config.cycleThreshold
    );

    logger.debug('[LOOP_DETECTOR]', this.instanceId, 'Created');
  }

  // Text loop detection methods
  stopTextDetectors(): void {
    this.thinkingDetector?.stop();
    this.responseDetector?.stop();
  }

  resetTextDetectors(): void {
    this.thinkingDetector?.reset();
    this.responseDetector?.reset();
  }

  getThinkingAccumulatedLength(): number {
    return this.thinkingDetector?.getAccumulatedLength() ?? 0;
  }

  getResponseAccumulatedLength(): number {
    return this.responseDetector?.getAccumulatedLength() ?? 0;
  }

  isThinkingDetectorActive(): boolean {
    return this.thinkingDetector?.isActive() ?? false;
  }

  isResponseDetectorActive(): boolean {
    return this.responseDetector?.isActive() ?? false;
  }

  hasThinkingLoopDetected(): boolean {
    return this.thinkingDetector?.hasDetected() ?? false;
  }

  hasResponseLoopDetected(): boolean {
    return this.responseDetector?.hasDetected() ?? false;
  }

  // Tool cycle detection methods
  detectCycles(
    toolCalls: Array<{
      id: string;
      function: { name: string; arguments: Record<string, any> };
    }>
  ): Map<string, CycleInfo> {
    return this.toolCycleDetector.detectCycles(toolCalls);
  }

  recordToolCalls(
    toolCalls: Array<{
      id: string;
      function: { name: string; arguments: Record<string, any> };
    }>,
    results?: Array<{ success: boolean; [key: string]: any }>
  ): void {
    this.toolCycleDetector.recordToolCalls(toolCalls, results);
  }

  clearCyclesIfBroken(): void {
    this.toolCycleDetector.clearIfBroken();
  }

  clearToolHistory(): void {
    this.toolCycleDetector.clearHistory();
  }

  getToolHistorySize(): number {
    return this.toolCycleDetector.getHistorySize();
  }

  getCycleThreshold(): number {
    return this.toolCycleDetector.getCycleThreshold();
  }

  // Unified lifecycle methods
  reset(): void {
    this.resetTextDetectors();
    this.clearToolHistory();
    logger.debug('[LOOP_DETECTOR]', this.instanceId, 'Full reset');
  }

  stop(): void {
    this.stopTextDetectors();
    logger.debug('[LOOP_DETECTOR]', this.instanceId, 'Stopped');
  }
}
