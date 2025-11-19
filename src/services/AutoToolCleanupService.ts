/**
 * AutoToolCleanupService - Auto-identifies and removes irrelevant tool results
 *
 * Uses LLM to analyze tool calls in conversations and identify irrelevant ones
 * that can be safely removed to save context. Operates in background to avoid blocking.
 */

import { ModelClient } from '../llm/ModelClient.js';
import { Message } from '../types/index.js';
import { CancellableService } from '../types/CancellableService.js';
import { POLLING_INTERVALS, API_TIMEOUTS, AUTO_TOOL_CLEANUP } from '../config/constants.js';
import type { SessionManager } from './SessionManager.js';

/**
 * Configuration for AutoToolCleanupService
 */
export interface AutoToolCleanupConfig {
  /** Maximum tokens for analysis */
  maxTokens?: number;
  /** Temperature for analysis (lower = more deterministic) */
  temperature?: number;
}

/**
 * Structure for tool call analysis
 */
interface ToolCallInfo {
  /** Tool call ID */
  id: string;
  /** Tool name */
  name: string;
  /** Tool arguments (truncated for analysis) */
  args: string;
  /** Tool result (truncated for analysis) */
  result: string;
  /** Message index in conversation */
  messageIndex: number;
}

/**
 * Analysis result from LLM
 */
interface CleanupAnalysis {
  /** Tool call IDs that can be safely removed */
  irrelevantToolCallIds: string[];
}

/**
 * AutoToolCleanupService auto-identifies irrelevant tool results using LLM
 */
export class AutoToolCleanupService implements CancellableService {
  private modelClient: ModelClient;
  private sessionManager: SessionManager;
  private pendingAnalyses = new Set<string>();
  private isAnalyzing: boolean = false;

  private enableCleanup: boolean;

  constructor(
    modelClient: ModelClient,
    sessionManager: SessionManager,
    enableCleanup: boolean = true,
    _config: AutoToolCleanupConfig = {}
  ) {
    this.modelClient = modelClient;
    this.sessionManager = sessionManager;
    this.enableCleanup = enableCleanup;
    // Note: maxTokens and temperature are available in _config but not used directly
    // They could be passed to modelClient.send() if needed in the future
  }

  /**
   * Cancel any ongoing analysis
   *
   * Called before main agent starts processing to avoid resource competition.
   * The service will naturally retry later when conditions allow.
   */
  cancel(): void {
    if (this.isAnalyzing) {
      console.log('[AUTO_CLEANUP] 🛑 Cancelling ongoing analysis (user interaction started)');

      // Cancel all active requests on the model client
      if (typeof this.modelClient.cancel === 'function') {
        this.modelClient.cancel();
      }

      // Reset flag and clear pending
      this.isAnalyzing = false;
      this.pendingAnalyses.clear();
    }
  }

  /**
   * Check if we should analyze this conversation
   *
   * @param messages - Conversation messages
   * @param lastAnalysisAt - Timestamp of last analysis
   * @returns true if analysis should proceed
   */
  shouldAnalyze(messages: Message[], lastAnalysisAt?: number): boolean {
    // Don't analyze if already analyzing
    if (this.isAnalyzing) {
      return false;
    }

    // Count tool results
    const toolResultCount = messages.filter(msg =>
      msg.role === 'tool'
    ).length;

    // Need enough tool results to justify analysis
    if (toolResultCount < AUTO_TOOL_CLEANUP.MIN_TOOL_RESULTS) {
      return false;
    }

    // Check if enough time has passed since last analysis
    if (lastAnalysisAt) {
      const timeSinceLastAnalysis = Date.now() - lastAnalysisAt;
      if (timeSinceLastAnalysis < AUTO_TOOL_CLEANUP.MIN_INTERVAL) {
        return false;
      }
    }

    return true;
  }

  /**
   * Analyze tool calls and identify irrelevant ones
   *
   * @param messages - Conversation messages
   * @returns Analysis result with irrelevant tool call IDs
   */
  async analyzeToolCalls(messages: Message[]): Promise<CleanupAnalysis> {
    // If cleanup is disabled, return empty result
    if (!this.enableCleanup) {
      return { irrelevantToolCallIds: [] };
    }

    // Extract tool calls and results
    const toolCallInfos = this.extractToolCallInfos(messages);

    if (toolCallInfos.length === 0) {
      return { irrelevantToolCallIds: [] };
    }

    const analysisPrompt = this.buildAnalysisPrompt(toolCallInfos);

    try {
      const response = await this.modelClient.send(
        [{ role: 'user', content: analysisPrompt }],
        {
          stream: false,
          suppressThinking: true, // Don't show thinking for background analysis
        }
      );

      // Check if response was interrupted or had an error - don't process it
      if ((response as any).interrupted || (response as any).error) {
        console.log('[AUTO_CLEANUP] ⚠️  Response was interrupted/error, skipping analysis');
        throw new Error('Analysis interrupted or failed');
      }

      // Parse the response to extract tool call IDs
      const analysis = this.parseAnalysisResponse(response.content);

      return analysis;
    } catch (error) {
      console.log('[AUTO_CLEANUP] ❌ Failed to analyze tool calls:', error);
      return { irrelevantToolCallIds: [] };
    }
  }

  /**
   * Perform cleanup analysis in the background
   *
   * @param sessionName - Name of the session
   * @param messages - Conversation messages
   */
  cleanupBackground(sessionName: string, messages: Message[]): void {
    // Prevent duplicate analyses
    if (this.pendingAnalyses.has(sessionName)) {
      console.log(`[AUTO_CLEANUP] ⏭️  Skipping - already analyzing ${sessionName}`);
      return;
    }

    console.log(`[AUTO_CLEANUP] 🚀 Starting background cleanup analysis for session ${sessionName}`);
    this.pendingAnalyses.add(sessionName);
    this.isAnalyzing = true;

    // Run in background
    this.analyzeAndStoreAsync(sessionName, messages)
      .catch(error => {
        // Ignore abort/interrupt errors (expected when cancelled)
        if (error.name === 'AbortError' || error.message?.includes('abort') || error.message?.includes('interrupt')) {
          console.log(`[AUTO_CLEANUP] ⚠️  Analysis cancelled for ${sessionName}`);
        } else {
          console.log(`[AUTO_CLEANUP] ❌ Analysis failed for ${sessionName}:`, error);
        }
      })
      .finally(() => {
        this.pendingAnalyses.delete(sessionName);
        this.isAnalyzing = false;
        console.log(`[AUTO_CLEANUP] ✅ Analysis completed for ${sessionName}`);
      });
  }

  /**
   * Analyze and store cleanup results asynchronously
   */
  private async analyzeAndStoreAsync(
    sessionName: string,
    messages: Message[]
  ): Promise<void> {
    // Perform analysis
    const analysis = await this.analyzeToolCalls(messages);

    if (analysis.irrelevantToolCallIds.length === 0) {
      console.log('[AUTO_CLEANUP] 📝 No irrelevant tool calls identified');
      return;
    }

    console.log(`[AUTO_CLEANUP] 📝 Identified ${analysis.irrelevantToolCallIds.length} irrelevant tool calls: ${analysis.irrelevantToolCallIds.join(', ')}`);

    // Store pending cleanups in session metadata
    try {
      const session = await this.sessionManager.loadSession(sessionName);
      if (!session) {
        console.log(`[AUTO_CLEANUP] ❌ Session ${sessionName} not found`);
        return;
      }

      // Merge with existing pending cleanups
      const existingCleanups = session.metadata?.pendingToolCleanups || [];
      const allCleanups = [...new Set([...existingCleanups, ...analysis.irrelevantToolCallIds])];

      // Use SessionManager's updateMetadata to ensure serialized writes
      const success = await this.sessionManager.updateMetadata(sessionName, {
        pendingToolCleanups: allCleanups,
        lastCleanupAnalysisAt: Date.now(),
      });

      if (success) {
        console.log(`[AUTO_CLEANUP] 💾 Stored ${allCleanups.length} pending cleanups to session ${sessionName}`);
      } else {
        console.log(`[AUTO_CLEANUP] ❌ Failed to store cleanups for ${sessionName}: updateMetadata returned false`);
      }
    } catch (error) {
      console.log(`[AUTO_CLEANUP] ❌ Failed to store cleanups for ${sessionName}:`, error);
      throw error;
    }
  }

  /**
   * Extract tool call information from messages using turn-based ratio approach
   *
   * Algorithm:
   * 1. Find index of last assistant message in conversation
   * 2. Extract all tool calls with their indices
   * 3. Filter out tool calls >= lastAssistantIndex (preserve last turn)
   * 4. Of remaining tool calls, calculate: eligibleCount = floor(count * ANALYSIS_RATIO)
   * 5. Take the FIRST eligibleCount tool calls (oldest ones)
   * 6. Return as ToolCallInfo[]
   */
  private extractToolCallInfos(messages: Message[]): ToolCallInfo[] {
    // Step 1: Find the last assistant message index
    let lastAssistantIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'assistant') {
        lastAssistantIndex = i;
        break;
      }
    }

    // Step 2: Extract all tool calls with their indices
    const allToolCalls: ToolCallInfo[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;

      // Look for assistant messages with tool calls
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const toolCall of msg.tool_calls) {
          // Find corresponding tool result
          const toolResultMsg = messages
            .slice(i + 1)
            .find(m => m.role === 'tool' && m.tool_call_id === toolCall.id);

          if (toolResultMsg) {
            allToolCalls.push({
              id: toolCall.id,
              name: toolCall.function.name,
              args: this.truncateForAnalysis(JSON.stringify(toolCall.function.arguments)),
              result: this.truncateForAnalysis(toolResultMsg.content),
              messageIndex: i,
            });
          }
        }
      }
    }

    // Step 3: Filter out tool calls from last assistant turn (preserve active turn)
    const eligibleToolCalls = lastAssistantIndex >= 0
      ? allToolCalls.filter(tc => tc.messageIndex < lastAssistantIndex)
      : allToolCalls;

    // Step 4: Calculate how many of the eligible tool calls to analyze (oldest X%)
    const eligibleCount = Math.floor(eligibleToolCalls.length * AUTO_TOOL_CLEANUP.ANALYSIS_RATIO);

    // Step 5: Take the FIRST eligibleCount tool calls (oldest ones)
    const toolCallsToAnalyze = eligibleToolCalls.slice(0, eligibleCount);

    return toolCallsToAnalyze;
  }

  /**
   * Truncate content for analysis to save tokens
   */
  private truncateForAnalysis(content: string, maxLength: number = 500): string {
    if (content.length <= maxLength) {
      return content;
    }
    return content.slice(0, maxLength) + '... [truncated]';
  }

  /**
   * Build the prompt for tool call analysis
   */
  private buildAnalysisPrompt(toolCallInfos: ToolCallInfo[]): string {
    const toolCallList = toolCallInfos
      .map((info, idx) => {
        return `${idx + 1}. ID: ${info.id}
   Tool: ${info.name}
   Args: ${info.args}
   Result: ${info.result}`;
      })
      .join('\n\n');

    return `Analyze the following tool calls from a conversation and identify which ones are IRRELEVANT and can be safely removed.

A tool call is IRRELEVANT if:
- It was exploratory but didn't contribute to the final solution
- Its results were not used in subsequent tool calls or responses
- It was part of a failed attempt that was later corrected
- It was redundant (duplicate information already available)

IMPORTANT: Only mark tool calls as irrelevant if you are HIGHLY CONFIDENT they can be removed without losing important context.

Tool Calls:
${toolCallList}

Reply with ONLY a JSON object in this format:
{
  "irrelevant_ids": ["id1", "id2", ...]
}

If no tool calls are irrelevant, reply with:
{
  "irrelevant_ids": []
}`;
  }

  /**
   * Parse the analysis response to extract irrelevant tool call IDs
   */
  private parseAnalysisResponse(content: string): CleanupAnalysis {
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.log('[AUTO_CLEANUP] ⚠️  No JSON found in response');
        return { irrelevantToolCallIds: [] };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const irrelevantIds = parsed.irrelevant_ids || [];

      // Validate that all IDs are strings
      if (!Array.isArray(irrelevantIds) || !irrelevantIds.every(id => typeof id === 'string')) {
        console.log('[AUTO_CLEANUP] ⚠️  Invalid irrelevant_ids format');
        return { irrelevantToolCallIds: [] };
      }

      return { irrelevantToolCallIds: irrelevantIds };
    } catch (error) {
      console.log('[AUTO_CLEANUP] ⚠️  Failed to parse analysis response:', error);
      return { irrelevantToolCallIds: [] };
    }
  }

  /**
   * Cleanup any pending operations
   */
  async cleanup(): Promise<void> {
    // Wait for pending analyses to complete
    const startTime = Date.now();

    while (this.pendingAnalyses.size > 0 && Date.now() - startTime < API_TIMEOUTS.CLEANUP_MAX_WAIT) {
      await new Promise(resolve => setTimeout(resolve, POLLING_INTERVALS.CLEANUP));
    }
  }
}
