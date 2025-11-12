/**
 * ToolOrchestrator - Handles concurrent and sequential tool execution
 *
 * Responsibilities:
 * - Execute tool calls (sequentially or in parallel)
 * - Process tool results and add to conversation
 * - Emit events for UI updates
 * - Handle errors gracefully
 * - Determine execution mode based on tool types
 *
 * Execution modes:
 * - Concurrent: Safe read-only tools executed in parallel
 * - Sequential: Destructive tools executed one at a time
 */

import { ToolManager } from '../tools/ToolManager.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ActivityEventType, ToolResult } from '../types/index.js';
import { AgentConfig } from './Agent.js';
import { ToolResultManager } from '../services/ToolResultManager.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { DirectoryTraversalError, isPermissionDeniedError } from '../security/PathSecurity.js';
import { logger } from '../services/Logger.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';
import { formatMinutesSeconds } from '../ui/utils/timeUtils.js';
import { BUFFER_SIZES, ID_GENERATION } from '../config/constants.js';
import { TOOL_NAMES } from '../config/toolDefaults.js';

/**
 * Tool call structure from LLM
 */
interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: Record<string, any>;
  };
}

/**
 * Safe tools that can run concurrently
 */
const SAFE_CONCURRENT_TOOLS = new Set([
  'read',
  'file_read',
  'grep',
  'glob',
  'ls',
  'bash_readonly',
  'git_status',
  'git_log',
  'git_diff',
  'web_fetch',
  'agent', // Agent delegations are context-isolated
]);

/**
 * Interface for Agent methods used by ToolOrchestrator
 * This breaks the circular dependency while maintaining type safety
 */
export interface IAgentForOrchestrator {
  resetToolCallActivity(): void;
  addMessage(message: any): void;
  getToolAbortSignal(): AbortSignal | undefined;
  getTurnStartTime(): number | undefined;
  getMaxDuration(): number | undefined;
  getTokenManager(): {
    getContextUsagePercentage(): number;
    trackToolResult(toolCallId: string, content: string): string | null;
  };
}

/**
 * ToolOrchestrator coordinates tool execution
 */
export class ToolOrchestrator {
  private toolManager: ToolManager;
  private activityStream: ActivityStream;
  private agent: IAgentForOrchestrator; // Reference to parent agent (for adding messages)
  private config: AgentConfig;
  private toolResultManager: ToolResultManager | null = null;
  private permissionManager: PermissionManager | null = null;
  private parentCallId?: string; // Parent context for nested agents
  private cycleDetectionResults: Map<string, import('./CycleDetector.js').CycleInfo> = new Map();

  constructor(
    toolManager: ToolManager,
    activityStream: ActivityStream,
    agent: IAgentForOrchestrator,
    config: AgentConfig,
    toolResultManager?: ToolResultManager,
    permissionManager?: PermissionManager
  ) {
    this.toolManager = toolManager;
    this.activityStream = activityStream;
    this.agent = agent;
    this.config = config;
    this.toolResultManager = toolResultManager || null;
    this.permissionManager = permissionManager || null;
    this.parentCallId = config.parentCallId; // Store parent context
    logger.debug('[TOOL_ORCHESTRATOR] Created with parentCallId:', this.parentCallId);
  }

  /**
   * Update the parent call ID for nested tool calls
   * Used by agent_ask to temporarily reparent tool calls under the current call
   *
   * @param parentCallId - New parent call ID
   */
  setParentCallId(parentCallId: string | undefined): void {
    this.parentCallId = parentCallId;
    logger.debug('[TOOL_ORCHESTRATOR] Updated parentCallId to:', this.parentCallId);
  }

  /**
   * Get the current parent call ID
   *
   * @returns Current parent call ID
   */
  getParentCallId(): string | undefined {
    return this.parentCallId;
  }

  /**
   * Execute tool calls (concurrent or sequential based on tool types)
   *
   * @param toolCalls - Array of tool calls from LLM
   * @param cycles - Optional map of tool call ID to cycle detection info
   * @returns Array of tool results matching the unwrapped tool calls
   */
  async executeToolCalls(
    toolCalls: ToolCall[],
    cycles?: Map<string, import('./CycleDetector.js').CycleInfo>
  ): Promise<ToolResult[]> {
    logger.debug('[TOOL_ORCHESTRATOR] executeToolCalls called with', toolCalls.length, 'tool calls');

    if (toolCalls.length === 0) {
      return [];
    }

    // Store cycles for later use in result formatting
    this.cycleDetectionResults = cycles || new Map();

    // Unwrap batch tool calls into individual tool calls
    const unwrappedCalls = this.unwrapBatchCalls(toolCalls);
    logger.debug('[TOOL_ORCHESTRATOR] After unwrapping batch calls:', unwrappedCalls.length, 'tool calls');

    // Determine execution mode
    const canRunConcurrently = this.canRunConcurrently(unwrappedCalls);

    if (canRunConcurrently && this.config.config.parallel_tools) {
      return await this.executeConcurrent(unwrappedCalls);
    } else {
      return await this.executeSequential(unwrappedCalls);
    }
  }

  /**
   * Unwrap batch tool calls into individual tool calls
   *
   * Batch is a transparent wrapper - we extract its children and execute them as if
   * the model called them directly.
   *
   * IMPORTANT: Invalid batches are NOT unwrapped. They execute normally so
   * BatchTool.executeImpl() can validate and return proper errors.
   */
  private unwrapBatchCalls(toolCalls: ToolCall[]): ToolCall[] {
    const unwrapped: ToolCall[] = [];

    for (const toolCall of toolCalls) {
      // Check if this is a batch call
      if (toolCall.function.name === 'batch') {
        const tools = toolCall.function.arguments.tools;

        // Quick pre-validation: if obviously invalid, don't unwrap
        // Let BatchTool.executeImpl() run and provide detailed validation errors
        const shouldUnwrap =
          Array.isArray(tools) &&
          tools.length > 0 &&
          tools.length <= BUFFER_SIZES.MAX_BATCH_SIZE &&
          tools.every(spec =>
            typeof spec === 'object' && spec !== null &&
            typeof spec.name === 'string' &&
            typeof spec.arguments === 'object' && spec.arguments !== null
          );

        if (!shouldUnwrap) {
          // Invalid batch - keep as batch tool call, will validate when executed
          unwrapped.push(toolCall);
          continue;
        }

        // Valid batch - unwrap into individual tool calls
        for (let index = 0; index < tools.length; index++) {
          const spec = tools[index];
          unwrapped.push({
            id: `${toolCall.id}-unwrapped-${index}`,
            type: 'function',
            function: {
              name: spec.name,
              arguments: spec.arguments,
            },
          });
        }
      } else {
        // Not a batch call, keep as-is
        unwrapped.push(toolCall);
      }
    }

    return unwrapped;
  }

  /**
   * Check if tool calls can run concurrently
   *
   * Only safe read-only tools can run in parallel.
   */
  private canRunConcurrently(toolCalls: ToolCall[]): boolean {
    return toolCalls.every(tc => SAFE_CONCURRENT_TOOLS.has(tc.function.name));
  }

  /**
   * Execute tool calls concurrently
   *
   * @param toolCalls - Array of tool calls
   * @returns Array of tool results
   */
  private async executeConcurrent(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    // Emit group start event (with parent context if nested)
    const groupId = this.generateId('tool-group');
    logger.debug('[TOOL_ORCHESTRATOR] executeConcurrent - groupId:', groupId, 'parentCallId:', this.parentCallId, 'toolCount:', toolCalls.length);
    logger.debug('[TOOL_ORCHESTRATOR] Tools in group:', toolCalls.map(tc => `${tc.function.name}(${JSON.stringify(tc.function.arguments)})`).join(', '));
    this.emitEvent({
      id: groupId,
      type: ActivityEventType.TOOL_CALL_START,
      timestamp: Date.now(),
      parentId: this.parentCallId, // Use orchestrator's parent context
      data: {
        groupExecution: true,
        toolCount: toolCalls.length,
        tools: toolCalls.map(tc => tc.function.name),
      },
    });

    // IMPORTANT: Emit START events for all tools BEFORE execution begins
    // This ensures batch tool calls are visible in UI immediately, not when they start executing
    const effectiveParentId = this.parentCallId || groupId;
    const isCollapsed = this.config.isSpecializedAgent === true;

    for (const toolCall of toolCalls) {
      const tool = this.toolManager.getTool(toolCall.function.name);
      const shouldCollapse = (tool as any)?.shouldCollapse || false;
      const hideOutput = (tool as any)?.hideOutput || false;

      this.emitEvent({
        id: toolCall.id,
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        parentId: effectiveParentId,
        data: {
          toolName: toolCall.function.name,
          arguments: toolCall.function.arguments,
          visibleInChat: tool?.visibleInChat ?? true,
          isTransparent: tool?.isTransparentWrapper || false,
          collapsed: isCollapsed,
          shouldCollapse,
          hideOutput,
        },
      });
    }

    try {
      // Execute all tools in parallel
      // Use Promise.allSettled to handle permission denials gracefully
      const results = await Promise.allSettled(
        toolCalls.map(tc => this.executeSingleToolAfterStart(tc, groupId))
      );

      // Check if any tool was denied permission
      const successfulResults: (ToolResult | null)[] = [];

      for (let i = 0; i < results.length; i++) {
        const settledResult = results[i];

        // TypeScript check - Promise.allSettled should always return results
        if (!settledResult) {
          // Push placeholder to maintain alignment with toolCalls array
          successfulResults.push({
            success: false,
            error: 'Unexpected empty result from Promise.allSettled',
            error_type: 'system_error',
          });
          continue;
        }

        if (settledResult.status === 'rejected') {
          // Check if this is a permission denial
          if (isPermissionDeniedError(settledResult.reason)) {
            logger.debug('[TOOL_ORCHESTRATOR] Permission denied in concurrent execution, stopping group');

            const deniedError = settledResult.reason;

            // Emit TOOL_CALL_END for all tools in the batch before stopping
            for (let j = 0; j < toolCalls.length; j++) {
              const toolCall = toolCalls[j];
              if (!toolCall) continue;

              const toolResult = results[j];
              const tool = this.toolManager.getTool(toolCall.function.name);
              const isCollapsed = this.config.isSpecializedAgent === true;
              const shouldCollapse = (tool as any)?.shouldCollapse || false;
              const hideOutput = (tool as any)?.hideOutput || false;

              let resultData: ToolResult;
              if (j === i) {
                // This is the tool that was denied
                resultData = {
                  success: false,
                  error: deniedError.message || 'Permission denied',
                  error_type: 'permission_denied',
                };
              } else if (toolResult && toolResult.status === 'rejected') {
                // Other error
                resultData = {
                  success: false,
                  error: formatError(toolResult.reason),
                  error_type: 'system_error',
                };
              } else if (toolResult && toolResult.status === 'fulfilled') {
                // Successful result
                resultData = toolResult.value;
              } else {
                // Fallback for missing result
                resultData = {
                  success: false,
                  error: 'Unknown error',
                  error_type: 'system_error',
                };
              }

              this.emitEvent({
                id: toolCall.id,
                type: ActivityEventType.TOOL_CALL_END,
                timestamp: Date.now(),
                parentId: effectiveParentId,
                data: {
                  toolName: toolCall.function.name,
                  result: resultData,
                  success: resultData.success,
                  error: resultData.success ? undefined : resultData.error,
                  visibleInChat: true, // Always show in group with permission denial
                  isTransparent: tool?.isTransparentWrapper || false,
                  collapsed: isCollapsed,
                  shouldCollapse,
                  hideOutput,
                },
              });
            }

            // Emit group end event
            this.emitEvent({
              id: groupId,
              type: ActivityEventType.TOOL_CALL_END,
              timestamp: Date.now(),
              parentId: this.parentCallId,
              data: {
                groupExecution: true,
                toolCount: toolCalls.length,
                success: false,
                error: 'Permission denied',
              },
            });

            // Re-throw to stop agent
            throw deniedError;
          }
          // Other errors: create error result
          successfulResults.push({
            success: false,
            error: formatError(settledResult.reason),
            error_type: 'system_error',
          });
        } else {
          successfulResults.push(settledResult.value);
        }
      }

      // If we got here, no permission was denied - process all results
      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i];
        const result = successfulResults[i];
        if (toolCall && result) {
          await this.processToolResult(toolCall, result);
        }
      }

      // Emit group end event (with parent context if nested)
      this.emitEvent({
        id: groupId,
        type: ActivityEventType.TOOL_CALL_END,
        timestamp: Date.now(),
        parentId: this.parentCallId, // Use orchestrator's parent context
        data: {
          groupExecution: true,
          toolCount: toolCalls.length,
          success: successfulResults.every(r => r?.success),
        },
      });

      // Return results (filter out any nulls that shouldn't exist but TypeScript requires)
      return successfulResults.filter((r): r is ToolResult => r !== null);
    } catch (error) {
      // Emit error event (with parent context if nested)
      this.emitEvent({
        id: groupId,
        type: ActivityEventType.ERROR,
        timestamp: Date.now(),
        parentId: this.parentCallId, // Use orchestrator's parent context
        data: {
          groupExecution: true,
          error: formatError(error),
        },
      });

      throw error;
    }
  }

  /**
   * Execute tool calls sequentially
   *
   * @param toolCalls - Array of tool calls
   * @returns Array of tool results
   */
  private async executeSequential(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const toolCall of toolCalls) {
      const result = await this.executeSingleTool(toolCall);
      await this.processToolResult(toolCall, result);
      results.push(result);
    }
    return results;
  }

  /**
   * Execute a single tool call after START event has been emitted
   * Used by concurrent execution where START events are emitted upfront
   *
   * @param toolCall - Tool call to execute
   * @param parentId - Optional parent ID for grouped execution
   * @returns Tool execution result
   */
  private async executeSingleToolAfterStart(
    toolCall: ToolCall,
    parentId?: string
  ): Promise<ToolResult> {
    return this.executeSingleTool(toolCall, parentId, false);
  }

  /**
   * Execute a single tool call
   *
   * @param toolCall - Tool call to execute
   * @param parentId - Optional parent ID for grouped execution
   * @param emitStartEvent - Whether to emit START event (default: true)
   * @returns Tool execution result
   */
  private async executeSingleTool(
    toolCall: ToolCall,
    parentId?: string,
    emitStartEvent: boolean = true
  ): Promise<ToolResult> {
    const { id, function: func } = toolCall;
    const { name: toolName, arguments: args } = func;

    // Get the tool to check properties
    const tool = this.toolManager.getTool(toolName);

    // If we have a parent context from a nested agent, use it; otherwise use the group parentId
    const effectiveParentId = this.parentCallId || parentId;
    logger.debug('[TOOL_ORCHESTRATOR] executeSingleTool - id:', id, 'tool:', toolName, 'args:', JSON.stringify(args), 'parentId:', parentId, 'effectiveParentId:', effectiveParentId, 'emitStartEvent:', emitStartEvent);

    // Reset tool call activity timer to prevent timeout
    this.agent.resetToolCallActivity();

    // Auto-promote first pending todo to in_progress
    // This helps the agent track progress through the todo list
    if (!(TOOL_NAMES.TODO_MANAGEMENT_TOOLS as readonly string[]).includes(toolName)) {
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (todoManager) {
        const inProgress = todoManager.getInProgressTodo();
        if (!inProgress) {
          const nextPending = todoManager.getNextPendingTodo();
          if (nextPending) {
            // Find and update the todo
            const todos = todoManager.getTodos();
            const updated = todos.map(t =>
              t.id === nextPending.id ? { ...t, status: 'in_progress' as const } : t
            );
            todoManager.setTodos(updated);
          }
        }
      }
    }

    // Prepare tool display properties (needed for both START and END events)
    const isCollapsed = this.config.isSpecializedAgent === true;
    const shouldCollapse = (tool as any)?.shouldCollapse || false;
    const hideOutput = (tool as any)?.hideOutput || false;

    // Emit start event FIRST (creates tool call in UI state)
    // Skip if already emitted (for concurrent execution)
    if (emitStartEvent) {
      this.emitEvent({
        id,
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        parentId: effectiveParentId,
        data: {
          toolName,
          arguments: args,
          visibleInChat: tool?.visibleInChat ?? true,
          isTransparent: tool?.isTransparentWrapper || false,
          collapsed: isCollapsed, // Collapse tools from subagents immediately
          shouldCollapse, // Collapse after completion (for AgentTool)
          hideOutput, // Never show output (for AgentTool)
        },
      });
    }

    // CRITICAL: After TOOL_CALL_START, we MUST emit TOOL_CALL_END
    // Use try-finally to guarantee this happens
    let result: ToolResult = {
      success: false,
      error: 'Tool execution failed unexpectedly',
      error_type: 'system_error',
    };
    let permissionDenied = false; // Track if permission was denied to skip TOOL_CALL_END

    try {
      // Preview changes (e.g., diffs) BEFORE permission check
      // Tool call now exists in state, so diff can attach to it
      if (tool) {
        await tool.previewChanges(args, id);
      }

      // Check permissions if PermissionManager is available
      if (this.permissionManager && tool && tool.requiresConfirmation) {
        // Emit permission request event (user will deliberate, timer paused)
        this.emitEvent({
          id,
          type: ActivityEventType.TOOL_PERMISSION_REQUEST,
          timestamp: Date.now(),
          parentId: effectiveParentId,
          data: {
            toolName,
          },
        });

        // Wait for user permission (this can take 0-30 seconds)
        await this.permissionManager.checkPermission(toolName, args);

        // Emit execution start event (timer starts NOW, after permission granted)
        this.emitEvent({
          id,
          type: ActivityEventType.TOOL_EXECUTION_START,
          timestamp: Date.now(),
          parentId: effectiveParentId,
          data: {
            toolName,
          },
        });
      }

      // Execute tool via tool manager (pass ID for streaming output)
      result = await this.toolManager.executeTool(
        toolName,
        args,
        id,
        false,
        this.agent.getToolAbortSignal()
      );

      // For specialized agents: report elapsed turn duration in minutes
      const turnStartTime = this.agent.getTurnStartTime();
      if (turnStartTime !== undefined) {
        const elapsedMinutes = (Date.now() - turnStartTime) / 1000 / 60;
        (result as any).total_turn_duration = elapsedMinutes;
      }

      // Record successful tool call for in-progress todo tracking (main agent only)
      if (result.success && !this.config.isSpecializedAgent && !(TOOL_NAMES.TODO_MANAGEMENT_TOOLS as readonly string[]).includes(toolName)) {
        const registry = ServiceRegistry.getInstance();
        const todoManager = registry.get<TodoManager>('todo_manager');
        if (todoManager) {
          todoManager.recordToolCall(toolName, args);
        }
      }

      // Emit output chunks if result has content
      if (result.success && (result as any).content) {
        this.emitEvent({
          id,
          type: ActivityEventType.TOOL_OUTPUT_CHUNK,
          timestamp: Date.now(),
          parentId: effectiveParentId,
          data: {
            toolName,
            chunk: (result as any).content,
          },
        });
      }
    } catch (error) {
      // Permission denied errors should propagate to Agent for handling
      // Emit TOOL_CALL_END before re-throwing so UI shows the failed tool call
      if (isPermissionDeniedError(error)) {
        permissionDenied = true;

        // Emit TOOL_CALL_END event for this failed tool call
        this.emitEvent({
          id,
          type: ActivityEventType.TOOL_CALL_END,
          timestamp: Date.now(),
          parentId: effectiveParentId,
          data: {
            toolName,
            result: {
              success: false,
              error: error.message || 'Permission denied',
              error_type: 'permission_denied' as const,
            },
            success: false,
            error: error.message || 'Permission denied',
            visibleInChat: true, // Always show permission denials
            isTransparent: tool?.isTransparentWrapper || false,
            collapsed: isCollapsed,
            shouldCollapse,
            hideOutput,
          },
        });

        throw error;
      }

      // Handle abort/interrupt errors specially
      if (error instanceof Error && (error.name === 'AbortError' || error.message.includes('interrupted'))) {
        result = {
          success: false,
          error: 'Tool execution interrupted by user',
          error_type: 'interrupted',
        };
      } else if (error instanceof DirectoryTraversalError) {
        result = {
          success: false,
          error: error.message,
          error_type: 'permission_denied',
        };
      } else {
        result = {
          success: false,
          error: formatError(error),
          error_type: 'system_error',
        };
      }

      // For specialized agents: report elapsed turn duration in minutes (error case)
      const turnStartTime = this.agent.getTurnStartTime();
      if (turnStartTime !== undefined) {
        const elapsedMinutes = (Date.now() - turnStartTime) / 1000 / 60;
        (result as any).total_turn_duration = elapsedMinutes;
      }
    } finally {
      // Skip TOOL_CALL_END when permission is denied since agent is being fully interrupted
      // Don't return here - let the exception propagate!
      if (!permissionDenied) {
        // GUARANTEE: Always emit TOOL_CALL_END after TOOL_CALL_START (except permission denial)
        // Show silent tools in chat if they error (for debugging)
        const shouldShowInChat = !result.success || (tool?.visibleInChat ?? true);

        this.emitEvent({
          id,
          type: ActivityEventType.TOOL_CALL_END,
          timestamp: Date.now(),
          parentId: effectiveParentId,
          data: {
            toolName,
            result,
            success: result.success,
            error: result.success ? undefined : result.error,
            visibleInChat: shouldShowInChat,
            isTransparent: tool?.isTransparentWrapper || false,
            collapsed: isCollapsed, // Use same collapsed state as TOOL_CALL_START
            shouldCollapse, // Pass through for completion-triggered collapse
            hideOutput, // Pass through for output visibility control
          },
        });
      }
    }

    return result;
  }

  /**
   * Process tool result and add to conversation
   *
   * @param toolCall - Original tool call
   * @param result - Tool execution result
   */
  private async processToolResult(
    toolCall: ToolCall,
    result: ToolResult
  ): Promise<void> {
    // Format result as natural language (pass toolCallId for cycle detection)
    const formattedResult = this.formatToolResult(toolCall.function.name, result, toolCall.id);

    logger.debug('[TOOL_ORCHESTRATOR] processToolResult - tool:', toolCall.function.name, 'id:', toolCall.id, 'success:', result.success, 'resultLength:', formattedResult.length);

    // Check if this is an ephemeral read
    const isEphemeral = (result as any)._ephemeral === true;

    // Skip duplicate detection for ephemeral reads (they're temporary anyway)
    const tokenManager = this.agent.getTokenManager();
    const previousCallId = isEphemeral
      ? null
      : tokenManager.trackToolResult(toolCall.id, formattedResult);

    let finalContent: string;
    if (previousCallId) {
      // Result is identical to a previous call - replace with reference
      finalContent = `[Duplicate result: This ${toolCall.function.name} call returned identical content to call ID ${previousCallId}. Review that result above instead of re-reading. Repeated identical reads waste context space.]`;
      logger.debug('[TOOL_ORCHESTRATOR] Deduplicated result for', toolCall.function.name, '- references call', previousCallId);
    } else {
      // Unique result - use full content
      // Add ephemeral warning if present
      const ephemeralWarning = (result as any)._ephemeral_warning;
      finalContent = ephemeralWarning
        ? `${ephemeralWarning}\n\n${formattedResult}`
        : formattedResult;
    }

    // Add tool result message to conversation with ephemeral metadata
    this.agent.addMessage({
      role: 'tool',
      content: finalContent,
      tool_call_id: toolCall.id,
      name: toolCall.function.name,
      metadata: isEphemeral ? { ephemeral: true } : undefined,
    });

    logger.debug('[TOOL_ORCHESTRATOR] processToolResult - tool result added to agent conversation',
      isEphemeral ? '(EPHEMERAL)' : '');
  }

  /**
   * Format tool result as natural language
   *
   * Serializes the entire result object to JSON (matching Python implementation)
   * to ensure all metadata (like file_check) is included in LLM context.
   *
   * @param toolName - Name of the tool
   * @param result - Tool execution result
   * @param toolCallId - Tool call ID for cycle detection
   * @returns Formatted result string
   */
  private formatToolResult(toolName: string, result: ToolResult, toolCallId?: string): string {
    // Handle internal-only tool results (for special tools like delegate_task)
    if ((result as any)._internal_only) {
      return (result as any).result || 'Internal operation completed';
    }

    // Extract warning, system_reminder, and total_turn_duration before serialization
    // to ensure they're not lost during truncation
    const warning = result.warning;
    const systemReminder = (result as any).system_reminder;
    const totalTurnDuration = (result as any).total_turn_duration;
    const resultWithoutExtras = { ...result };
    delete resultWithoutExtras.warning;
    delete (resultWithoutExtras as any).system_reminder;
    delete (resultWithoutExtras as any).total_turn_duration;

    // Serialize result object to JSON (includes all metadata like file_check)
    // This matches Python CodeAlly's behavior in response_processor.py
    let resultStr: string;
    try {
      resultStr = JSON.stringify(resultWithoutExtras);
    } catch (error) {
      // Fallback for non-serializable objects
      resultStr = String(resultWithoutExtras);
    }

    // Apply context-aware truncation if ToolResultManager is available
    if (this.toolResultManager) {
      resultStr = this.toolResultManager.processToolResult(toolName, resultStr);
    }

    // Append warning after truncation to ensure it's always visible
    if (warning) {
      resultStr += `\n\n⚠️  ${warning}`;
    }

    // Helper to inject and log system reminders
    const injectSystemReminder = (reminder: string, source: string) => {
      resultStr += `\n\n<system-reminder>${reminder}</system-reminder>`;
      logger.debug('[SYSTEM_REMINDER]', `${source} for ${toolName}:`, reminder.substring(0, 100) + (reminder.length > 100 ? '...' : ''));
    };

    // Inject system_reminder from tool result (if provided)
    // This allows tools to inject contextual reminders directly into their results
    if (systemReminder) {
      injectSystemReminder(systemReminder, 'Tool result');
    }

    // Inject time reminder if agent has max duration set
    const maxDuration = this.agent.getMaxDuration();
    if (maxDuration !== undefined && totalTurnDuration !== undefined) {
      const timeReminder = this.generateTimeReminder(maxDuration, totalTurnDuration);
      if (timeReminder) {
        injectSystemReminder(timeReminder, `Time (${totalTurnDuration.toFixed(2)}/${maxDuration}min)`);
      }
    }

    // Inject cycle detection warning if this tool call is part of a cycle
    if (toolCallId && this.cycleDetectionResults.has(toolCallId)) {
      const cycleInfo = this.cycleDetectionResults.get(toolCallId)!;

      // Determine if we should inject warning:
      // - Always inject if !isValidRepeat (critical cycles)
      // - Also inject if severity is 'high' (even if marked as valid repeat)
      const shouldWarn = !cycleInfo.isValidRepeat || cycleInfo.severity === 'high';

      if (shouldWarn) {
        // Use custom message if provided, otherwise fallback to default
        const message = cycleInfo.customMessage ||
          `You've called "${cycleInfo.toolName}" with identical arguments ${cycleInfo.count} times recently, getting the same results. This suggests you're stuck in a loop. Consider trying a different approach or re-reading previous results.`;

        // Use issueType for label if provided, otherwise default to 'Cycle detection'
        const label = cycleInfo.issueType || 'Cycle detection';

        injectSystemReminder(message, label);
      }
    }

    // Also check for global pattern detections (empty_streak, low_hit_rate)
    // These apply to the entire execution, not specific tool calls
    if (this.cycleDetectionResults.has('global-pattern-detection')) {
      const globalInfo = this.cycleDetectionResults.get('global-pattern-detection')!;

      // Global patterns are always high severity
      const shouldWarn = !globalInfo.isValidRepeat || globalInfo.severity === 'high';

      if (shouldWarn) {
        const message = globalInfo.customMessage ||
          `Pattern detected: ${globalInfo.issueType}`;

        const label = globalInfo.issueType || 'Pattern detection';

        injectSystemReminder(message, label);
      }
    }

    // Inject focus reminder in every tool result if there's an active todo (main agent only)
    if (!this.config.isSpecializedAgent) {
      const focusReminder = this.generateFocusReminder();
      if (focusReminder) {
        injectSystemReminder(focusReminder, 'Focus (todo)');
      }
    }

    return resultStr;
  }

  /**
   * Generate a time reminder for agents with max duration
   *
   * Uses escalating urgency at multiple thresholds:
   * - 50%: Gentle reminder that time is half gone
   * - 75%: Warning to start wrapping up
   * - 90%: Urgent - finish current work
   * - 100%+: Critical - time exceeded, wrap up immediately
   *
   * @param maxDuration - Maximum duration in minutes
   * @param currentDuration - Current elapsed duration in minutes
   * @returns Time reminder string or null if no reminder needed
   */
  private generateTimeReminder(maxDuration: number, currentDuration: number): string | null {
    const percentUsed = (currentDuration / maxDuration) * 100;
    const remainingMinutes = maxDuration - currentDuration;

    if (percentUsed >= 100) {
      // Critical: Time exceeded
      return `⏰ TIME EXCEEDED! You have surpassed your allotted time. Wrap up your work immediately and summarize what is left, if any.`;
    } else if (percentUsed >= 90) {
      // Urgent: 90% time used
      return `⏰ URGENT: You have ${formatMinutesSeconds(remainingMinutes)} left (${Math.round(100 - percentUsed)}% remaining). Finish your current work and prepare to wrap up.`;
    } else if (percentUsed >= 75) {
      // Warning: 75% time used
      return `⏰ You have ${formatMinutesSeconds(remainingMinutes)} left (${Math.round(100 - percentUsed)}% remaining). Start wrapping up your exploration.`;
    } else if (percentUsed >= 50) {
      // Gentle reminder: 50% time used
      return `You're halfway through your allotted time (${formatMinutesSeconds(remainingMinutes)} remaining). Keep your exploration focused and efficient.`;
    }

    // Below 50% - no reminder needed
    return null;
  }

  /**
   * Generate a focus reminder based on current in_progress todo
   *
   * @returns Focus reminder string or null if no reminder needed
   */
  private generateFocusReminder(): string | null {
    try {
      const registry = ServiceRegistry.getInstance();
      const todoManager = registry.get<TodoManager>('todo_manager');

      if (!todoManager) {
        return null;
      }

      const todos = todoManager.getTodos();
      const inProgressTodo = todos.find((t: any) => t.status === 'in_progress');

      if (!inProgressTodo) {
        return null;
      }

      // Build reminder with tool call summary
      let reminder = `Stay focused. You're working on: ${inProgressTodo.task}.`;

      // Add tool call summary if any calls have been made
      const toolCalls = inProgressTodo.toolCalls || [];
      if (toolCalls.length > 0) {
        reminder += ` You've made ${toolCalls.length} tool call${toolCalls.length > 1 ? 's' : ''} for this task:`;

        // Group tool calls by tool name and show brief summary
        const callsByTool = new Map<string, string[]>();
        toolCalls.forEach((call: any) => {
          if (!callsByTool.has(call.toolName)) {
            callsByTool.set(call.toolName, []);
          }
          if (call.args) {
            callsByTool.get(call.toolName)!.push(call.args);
          }
        });

        // Format as brief list
        for (const [toolName, argsList] of callsByTool) {
          const uniqueArgs = [...new Set(argsList)]; // Deduplicate
          const argStr = uniqueArgs.slice(0, BUFFER_SIZES.TOP_ITEMS_PREVIEW).join(', ') + (uniqueArgs.length > BUFFER_SIZES.TOP_ITEMS_PREVIEW ? '...' : '');
          reminder += `\n- ${toolName}(${argStr})`;
        }
      }

      reminder += `\n\nStay on task. Use todo_update to mark todos as complete when finished.`;

      return reminder;
    } catch (error) {
      logger.warn('[TOOL_ORCHESTRATOR] Failed to generate focus reminder:', formatError(error));
      return null;
    }
  }

  /**
   * Emit an activity event
   */
  private emitEvent(event: any): void {
    this.activityStream.emit(event);
  }

  /**
   * Generate a unique ID
   */
  private generateId(prefix: string = 'tool'): string {
    // Generate ID: {prefix}-{timestamp}-{9-char-random} (base-36, skip '0.' prefix)
    return `${prefix}-${Date.now()}-${Math.random().toString(ID_GENERATION.RANDOM_STRING_RADIX).substring(ID_GENERATION.RANDOM_STRING_SUBSTRING_START, ID_GENERATION.RANDOM_STRING_SUBSTRING_START + ID_GENERATION.RANDOM_STRING_LENGTH_LONG)}`;
  }
}
