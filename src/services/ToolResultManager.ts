/**
 * ToolResultManager - Context-aware tool result processing
 *
 * Responsibilities:
 * - Process tool results with progressive truncation based on context usage
 * - Track tool usage statistics for estimation
 * - Calculate remaining tool call capacity
 * - Generate context status messages for the model
 * - Provide configurable token limits for each truncation level
 *
 * Based on Python implementation: code_ally/agent/tool_result_manager.py
 */

import { TokenManager } from '../agent/TokenManager.js';
import { ConfigManager } from './ConfigManager.js';
import { ToolManager } from '../tools/ToolManager.js';

/**
 * Truncation level definitions
 */
type TruncationLevel = 'normal' | 'moderate' | 'aggressive' | 'critical';

/**
 * Truncation level thresholds (context usage percentage)
 */
interface TruncationLevels {
  [key: string]: { min: number; max: number };
}

/**
 * Maximum token limits for tool results at each level
 */
interface MaxTokenLimits {
  normal: number;
  moderate: number;
  aggressive: number;
  critical: number;
}

/**
 * Tool usage statistics
 */
interface ToolStats {
  callCount: number;
  totalTokens: number;
}

/**
 * ToolResultManager provides context-aware tool result processing
 */
export class ToolResultManager {
  // Progressive truncation based on context usage percentage
  private static readonly TRUNCATION_LEVELS: TruncationLevels = {
    normal: { min: 0, max: 70 }, // Full results up to 70% context
    moderate: { min: 70, max: 85 }, // Moderate truncation 70-85%
    aggressive: { min: 85, max: 95 }, // Heavy truncation 85-95%
    critical: { min: 95, max: 100 }, // Minimal results 95%+
  };

  // Default maximum tokens for tool results at each level
  private static readonly DEFAULT_MAX_TOKENS: MaxTokenLimits = {
    normal: 1000,
    moderate: 750,
    aggressive: 500,
    critical: 200,
  };

  private tokenManager: TokenManager;
  private toolManager?: ToolManager;
  private maxTokens: MaxTokenLimits;
  private toolUsageStats: Map<string, ToolStats> = new Map();

  /**
   * Create a new ToolResultManager
   *
   * @param tokenManager TokenManager instance for context tracking
   * @param configManager Optional ConfigManager for customizable limits
   * @param toolManager Optional ToolManager for accessing tool metadata
   */
  constructor(tokenManager: TokenManager, configManager?: ConfigManager, toolManager?: ToolManager) {
    this.tokenManager = tokenManager;
    this.toolManager = toolManager;

    // Load configurable token limits from config
    if (configManager) {
      this.maxTokens = {
        normal:
          (configManager.getValue('tool_result_max_tokens_normal') as number) ||
          ToolResultManager.DEFAULT_MAX_TOKENS.normal,
        moderate:
          (configManager.getValue('tool_result_max_tokens_moderate') as number) ||
          ToolResultManager.DEFAULT_MAX_TOKENS.moderate,
        aggressive:
          (configManager.getValue(
            'tool_result_max_tokens_aggressive'
          ) as number) || ToolResultManager.DEFAULT_MAX_TOKENS.aggressive,
        critical:
          (configManager.getValue('tool_result_max_tokens_critical') as number) ||
          ToolResultManager.DEFAULT_MAX_TOKENS.critical,
      };
    } else {
      this.maxTokens = { ...ToolResultManager.DEFAULT_MAX_TOKENS };
    }
  }

  /**
   * Process tool result with context-aware truncation
   *
   * @param toolName Name of the tool that generated the result
   * @param rawResult The raw tool result string
   * @returns Processed (potentially truncated) tool result
   */
  processToolResult(toolName: string, rawResult: string): string {
    if (!rawResult || rawResult.length === 0) {
      return rawResult;
    }

    // Get current context level
    const contextPct = this.tokenManager.getContextUsagePercentage();
    const truncationLevel = this.getTruncationLevel(contextPct);
    const maxTokens = this.maxTokens[truncationLevel];

    // Update tool usage statistics
    const actualTokens = this.tokenManager.estimateTokens(rawResult);
    this.updateToolStats(toolName, actualTokens);

    // Apply truncation if needed
    if (actualTokens <= maxTokens) {
      return rawResult;
    }

    // Generate tool-specific truncation notice
    const notice = this.getTruncationNotice(toolName, truncationLevel);
    const noticeTokens = this.tokenManager.estimateTokens(notice);
    let contentTokens = maxTokens - noticeTokens;

    // Ensure we don't go negative
    if (contentTokens < 50) {
      contentTokens = Math.floor(maxTokens / 2);
      const minimalNotice = '\n\n[Truncated - output too long]';
      const minimalTokens = this.tokenManager.estimateTokens(minimalNotice);
      contentTokens = maxTokens - minimalTokens;

      const truncatedResult = this.tokenManager.truncateContentToTokens(
        rawResult,
        contentTokens
      );
      return truncatedResult + minimalNotice;
    }

    const truncatedResult = this.tokenManager.truncateContentToTokens(
      rawResult,
      contentTokens
    );
    return truncatedResult + notice;
  }

  /**
   * Get tool-specific truncation notice with guidance
   *
   * @param toolName Name of the tool
   * @param truncationLevel Current truncation level
   * @returns Formatted truncation notice
   */
  private getTruncationNotice(toolName: string, truncationLevel: TruncationLevel): string {
    const toolGuidance = this.getToolSpecificGuidance(toolName);

    let contextReason = '';
    if (truncationLevel === 'critical') {
      contextReason = 'critical context usage';
    } else if (truncationLevel === 'aggressive') {
      contextReason = 'high context usage';
    } else {
      contextReason = 'length';
    }

    return `\n\n[Output truncated due to ${contextReason}. ${toolGuidance}]`;
  }

  /**
   * Get tool-specific guidance for handling truncated output
   *
   * @param toolName Name of the tool
   * @returns Tool-specific guidance string
   */
  private getToolSpecificGuidance(toolName: string): string {
    // If we have ToolManager, query the tool directly
    if (this.toolManager) {
      const tool = this.toolManager.getTool(toolName);
      if (tool && typeof tool.getTruncationGuidance === 'function') {
        return tool.getTruncationGuidance();
      }
    }

    // Fallback to default guidance
    return 'Consider narrowing the scope of your query or using filters';
  }

  /**
   * Estimate how many tool calls can still be made
   *
   * @returns Estimated number of remaining tool calls
   */
  estimateRemainingToolCalls(): number {
    // Calculate remaining context budget
    const remainingTokens = this.getRemainingContextBudget();

    // Get average tool result size
    const avgToolSize = this.getAverageToolSize();

    // Estimate remaining calls
    if (remainingTokens <= 0 || avgToolSize <= 0) {
      return 0;
    }

    const estimatedCalls = Math.max(
      0,
      Math.floor(remainingTokens / avgToolSize)
    );
    return Math.min(estimatedCalls, 50); // Cap at 50 for reasonable display
  }

  /**
   * Generate context status message with guidance for the model
   *
   * @returns Formatted context status message
   */
  getContextStatusMessage(): string {
    const contextPct = this.tokenManager.getContextUsagePercentage();
    const remainingCalls = this.estimateRemainingToolCalls();
    const truncationLevel = this.getTruncationLevel(contextPct);

    // Provide forceful, actionable guidance based on context level
    if (truncationLevel === 'critical') {
      return (
        `🚨 CRITICAL: ${contextPct}% context used | ${remainingCalls} tools remaining\n` +
        `⛔ STOP TOOL USE NOW. You MUST:\n` +
        `   1. Summarize work completed so far\n` +
        `   2. Conclude your response immediately\n` +
        `   3. Do NOT make additional tool calls\n` +
        `Further tool calls will likely be BLOCKED due to context overflow.`
      );
    } else if (truncationLevel === 'aggressive') {
      return (
        `⚠️ WARNING: ${contextPct}% context used | ~${remainingCalls} tools remaining\n` +
        `⚠️ Context approaching limits. You should:\n` +
        `   1. Complete ONLY your current task\n` +
        `   2. Avoid starting new investigations\n` +
        `   3. Provide a summary soon\n` +
        `Tool results are heavily truncated (${this.maxTokens.aggressive} tokens max).`
      );
    } else if (truncationLevel === 'moderate') {
      return (
        `💡 Notice: ${contextPct}% context used | ~${remainingCalls} tools remaining\n` +
        `💡 Context filling up. Consider:\n` +
        `   1. Prioritizing essential operations\n` +
        `   2. Wrapping up non-critical work\n` +
        `Tool results now limited to ${this.maxTokens.moderate} tokens.`
      );
    } else {
      return `✅ ${contextPct}% context used | ~${remainingCalls} tools available | Normal operation`;
    }
  }

  /**
   * Get truncation level based on context percentage
   *
   * @param contextPct Current context usage percentage
   * @returns Truncation level name
   */
  private getTruncationLevel(contextPct: number): TruncationLevel {
    for (const [level, range] of Object.entries(
      ToolResultManager.TRUNCATION_LEVELS
    )) {
      if (contextPct >= range.min && contextPct < range.max) {
        return level as TruncationLevel;
      }
    }
    return 'critical'; // Default for 95%+
  }

  /**
   * Calculate remaining context budget in tokens
   *
   * @returns Remaining tokens available for tool results
   */
  private getRemainingContextBudget(): number {
    const totalContext = this.tokenManager.getContextSize();
    const usedTokens = this.tokenManager.getCurrentTokenCount();
    const bufferTokens = Math.floor(totalContext * 0.1); // 10% buffer for safety

    return Math.max(0, totalContext - usedTokens - bufferTokens);
  }

  /**
   * Get average tool result size for estimation
   *
   * @returns Average tool result size in tokens
   */
  private getAverageToolSize(): number {
    // If we have actual usage statistics, use those (most accurate)
    if (this.toolUsageStats.size > 0) {
      let totalTokens = 0;
      let totalCalls = 0;

      for (const stats of this.toolUsageStats.values()) {
        totalTokens += stats.totalTokens;
        totalCalls += stats.callCount;
      }

      if (totalCalls > 0) {
        return Math.floor(totalTokens / totalCalls);
      }
    }

    // If no stats but we have ToolManager, average tool estimates
    if (this.toolManager) {
      const tools = this.toolManager.getAllTools();
      if (tools.length > 0) {
        const totalEstimate = tools.reduce((sum, tool) => {
          const estimate = typeof tool.getEstimatedOutputSize === 'function'
            ? tool.getEstimatedOutputSize()
            : 400;
          return sum + estimate;
        }, 0);
        return Math.floor(totalEstimate / tools.length);
      }
    }

    // Final fallback to default
    return 400;
  }

  /**
   * Update tool usage statistics
   *
   * @param toolName Name of the tool
   * @param resultTokens Number of tokens in the result
   */
  private updateToolStats(toolName: string, resultTokens: number): void {
    if (!this.toolUsageStats.has(toolName)) {
      this.toolUsageStats.set(toolName, {
        callCount: 0,
        totalTokens: 0,
      });
    }

    const stats = this.toolUsageStats.get(toolName)!;
    stats.callCount++;
    stats.totalTokens += resultTokens;

    // Keep statistics reasonable (prevent overflow in long sessions)
    if (stats.callCount > 100) {
      // Reset with current averages to maintain recent behavior
      const avgSize = Math.floor(stats.totalTokens / stats.callCount);
      stats.callCount = 10;
      stats.totalTokens = avgSize * 10;
    }
  }

  /**
   * Get current statistics
   *
   * @returns Statistics about tool usage and context
   */
  getStats(): {
    toolCount: number;
    totalCalls: number;
    averageSize: number;
    remainingCalls: number;
    truncationLevel: TruncationLevel;
  } {
    const contextPct = this.tokenManager.getContextUsagePercentage();
    let totalCalls = 0;
    for (const stats of this.toolUsageStats.values()) {
      totalCalls += stats.callCount;
    }

    return {
      toolCount: this.toolUsageStats.size,
      totalCalls,
      averageSize: this.getAverageToolSize(),
      remainingCalls: this.estimateRemainingToolCalls(),
      truncationLevel: this.getTruncationLevel(contextPct),
    };
  }
}
