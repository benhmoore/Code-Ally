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
import { CONTEXT_THRESHOLDS, TOOL_OUTPUT_ESTIMATES } from '../config/toolDefaults.js';
import { BUFFER_SIZES, TOKEN_MANAGEMENT } from '../config/constants.js';
import { DEFAULT_CONFIG } from '../config/defaults.js';

/**
 * Truncation level definitions (for warning messages)
 */
type TruncationLevel = 'normal' | 'moderate' | 'aggressive' | 'critical';

/**
 * Truncation level thresholds (context usage percentage)
 */
interface TruncationLevels {
  [key: string]: { min: number; max: number };
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
  // Truncation levels for warning severity (context usage percentage)
  private static readonly TRUNCATION_LEVELS: TruncationLevels = {
    normal: { min: 0, max: CONTEXT_THRESHOLDS.NORMAL },
    moderate: { min: CONTEXT_THRESHOLDS.NORMAL, max: CONTEXT_THRESHOLDS.WARNING },
    aggressive: { min: CONTEXT_THRESHOLDS.WARNING, max: CONTEXT_THRESHOLDS.CRITICAL },
    critical: { min: CONTEXT_THRESHOLDS.CRITICAL, max: CONTEXT_THRESHOLDS.MAX_PERCENT },
  };

  private tokenManager: TokenManager;
  private toolManager?: ToolManager;
  private maxContextPercent: number; // Maximum percentage of remaining context per tool result
  private minTokens: number; // Minimum tokens even when context is very full
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

    // Load configurable limits from config
    if (configManager) {
      this.maxContextPercent =
        (configManager.getValue('tool_result_max_context_percent') as number) ||
        DEFAULT_CONFIG.tool_result_max_context_percent;
      this.minTokens =
        (configManager.getValue('tool_result_min_tokens') as number) ||
        DEFAULT_CONFIG.tool_result_min_tokens;
    } else {
      this.maxContextPercent = DEFAULT_CONFIG.tool_result_max_context_percent;
      this.minTokens = DEFAULT_CONFIG.tool_result_min_tokens;
    }
  }

  /**
   * Process tool result with context-aware truncation
   *
   * @param toolName Name of the tool that generated the result
   * @param rawResult The raw tool result string or ToolResult object
   * @returns Processed (potentially truncated) tool result
   */
  processToolResult(toolName: string, rawResult: string | any): string {
    if (!rawResult) {
      return '';
    }

    // Check if this is a non-truncatable result
    const isNonTruncatable = typeof rawResult === 'object' && rawResult._non_truncatable === true;

    // Extract string content from object if needed
    const resultString = typeof rawResult === 'string' ? rawResult : JSON.stringify(rawResult);

    if (!resultString || resultString.length === 0) {
      return resultString;
    }

    // Update tool usage statistics
    const actualTokens = this.tokenManager.estimateTokens(resultString);
    this.updateToolStats(toolName, actualTokens);

    // If result is marked as non-truncatable, never truncate it
    if (isNonTruncatable) {
      return resultString;
    }

    // Calculate dynamic max tokens based on remaining context
    const remainingTokens = this.getRemainingContextBudget();
    const dynamicMaxTokens = Math.floor(remainingTokens * this.maxContextPercent);
    const maxTokens = Math.max(dynamicMaxTokens, this.minTokens);

    // Get current context level for warning severity
    const contextPct = this.tokenManager.getContextUsagePercentage();
    const truncationLevel = this.getTruncationLevel(contextPct);

    // Apply truncation if needed
    if (actualTokens <= maxTokens) {
      return resultString;
    }

    // Calculate percentage kept for the warning
    const percentageKept = Math.round((maxTokens / actualTokens) * 100);

    // Generate tool-specific truncation notice with percentage
    const notice = this.getTruncationNotice(toolName, truncationLevel, percentageKept);
    const noticeTokens = this.tokenManager.estimateTokens(notice);
    let contentTokens = maxTokens - noticeTokens;

    // Ensure we don't go negative
    if (contentTokens < BUFFER_SIZES.MIN_CONTENT_TOKENS) {
      contentTokens = Math.floor(maxTokens / 2);
      const percentKept = Math.round((contentTokens / actualTokens) * 100);
      const minimalNotice = `\n\n⚠️ WARNING: Output truncated to ${percentKept}% - CONTENT BELOW IS INCOMPLETE due to context limits`;
      const minimalTokens = this.tokenManager.estimateTokens(minimalNotice);
      contentTokens = maxTokens - minimalTokens;

      const truncatedResult = this.tokenManager.truncateContentToTokens(
        resultString,
        contentTokens
      );
      return minimalNotice + '\n' + truncatedResult;
    }

    const truncatedResult = this.tokenManager.truncateContentToTokens(
      resultString,
      contentTokens
    );
    return notice + '\n' + truncatedResult;
  }

  /**
   * Get tool-specific truncation notice with guidance
   *
   * @param toolName Name of the tool
   * @param truncationLevel Current truncation level
   * @param percentageKept Percentage of original result kept (1-100)
   * @returns Formatted truncation notice
   */
  private getTruncationNotice(toolName: string, truncationLevel: TruncationLevel, percentageKept: number): string {
    const toolGuidance = this.getToolSpecificGuidance(toolName);

    // Create clear, prominent warning at the top
    let warning = '';
    if (truncationLevel === 'critical') {
      warning = `⚠️ CRITICAL: Output truncated to ${percentageKept}% - CONTENT BELOW IS INCOMPLETE (context nearly full)`;
    } else if (truncationLevel === 'aggressive') {
      warning = `⚠️ WARNING: Output truncated to ${percentageKept}% - CONTENT BELOW IS INCOMPLETE (high context usage)`;
    } else if (truncationLevel === 'moderate') {
      warning = `⚠️ Output truncated to ${percentageKept}% - CONTENT BELOW IS INCOMPLETE (context limit)`;
    } else {
      warning = `⚠️ Output truncated to ${percentageKept}% - CONTENT BELOW IS INCOMPLETE`;
    }

    return `${warning}\n${toolGuidance ? `Next step: ${toolGuidance}` : ''}`;
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
    return Math.min(estimatedCalls, BUFFER_SIZES.MAX_ESTIMATED_TOOL_CALLS);
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

    // Calculate current max tokens per tool result
    const remainingTokens = this.getRemainingContextBudget();
    const currentMaxTokens = Math.max(
      Math.floor(remainingTokens * this.maxContextPercent),
      this.minTokens
    );

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
        `Tool results are heavily truncated (~${currentMaxTokens} tokens max per result).`
      );
    } else if (truncationLevel === 'moderate') {
      return (
        `💡 Notice: ${contextPct}% context used | ~${remainingCalls} tools remaining\n` +
        `💡 Context filling up. Consider:\n` +
        `   1. Prioritizing essential operations\n` +
        `   2. Wrapping up non-critical work\n` +
        `Tool results limited to ~${currentMaxTokens} tokens per result.`
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
    const bufferTokens = Math.floor(totalContext * TOKEN_MANAGEMENT.SAFETY_BUFFER_PERCENT); // 10% buffer for safety

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
            : TOOL_OUTPUT_ESTIMATES.DEFAULT;
          return sum + estimate;
        }, 0);
        return Math.floor(totalEstimate / tools.length);
      }
    }

    // Final fallback to default
    return TOOL_OUTPUT_ESTIMATES.DEFAULT;
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
    if (stats.callCount > BUFFER_SIZES.STATS_RESET_THRESHOLD) {
      // Reset with current averages to maintain recent behavior
      const avgSize = Math.floor(stats.totalTokens / stats.callCount);
      const resetValue = BUFFER_SIZES.STATS_RESET_THRESHOLD / 10; // Reset to 1/10th of threshold for averaging
      stats.callCount = resetValue;
      stats.totalTokens = avgSize * resetValue;
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
