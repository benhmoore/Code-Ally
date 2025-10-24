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
import { DirectoryTraversalError, PermissionDeniedError } from '../security/PathSecurity.js';
import { logger } from '../services/Logger.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoManager } from '../services/TodoManager.js';
import { formatError } from '../utils/errorUtils.js';

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
 * ToolOrchestrator coordinates tool execution
 */
export class ToolOrchestrator {
  private toolManager: ToolManager;
  private activityStream: ActivityStream;
  private agent: any; // Reference to parent agent (for adding messages)
  private config: AgentConfig;
  private toolResultManager: ToolResultManager | null = null;
  private permissionManager: PermissionManager | null = null;
  private parentCallId?: string; // Parent context for nested agents

  constructor(
    toolManager: ToolManager,
    activityStream: ActivityStream,
    agent: any,
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
   * Execute tool calls (concurrent or sequential based on tool types)
   *
   * @param toolCalls - Array of tool calls from LLM
   */
  async executeToolCalls(toolCalls: ToolCall[]): Promise<void> {
    logger.debug('[TOOL_ORCHESTRATOR] executeToolCalls called with', toolCalls.length, 'tool calls');

    if (toolCalls.length === 0) {
      return;
    }

    // Unwrap batch tool calls into individual tool calls
    const unwrappedCalls = this.unwrapBatchCalls(toolCalls);
    logger.debug('[TOOL_ORCHESTRATOR] After unwrapping batch calls:', unwrappedCalls.length, 'tool calls');

    // Determine execution mode
    const canRunConcurrently = this.canRunConcurrently(unwrappedCalls);

    if (canRunConcurrently && this.config.config.parallel_tools) {
      await this.executeConcurrent(unwrappedCalls);
    } else {
      await this.executeSequential(unwrappedCalls);
    }
  }

  /**
   * Unwrap batch tool calls into individual tool calls
   *
   * Batch is a transparent wrapper - we extract its children and execute them as if
   * the model called them directly.
   */
  private unwrapBatchCalls(toolCalls: ToolCall[]): ToolCall[] {
    const unwrapped: ToolCall[] = [];

    for (const toolCall of toolCalls) {
      // Check if this is a batch call
      if (toolCall.function.name === 'batch') {
        const tools = toolCall.function.arguments.tools;

        if (Array.isArray(tools)) {
          // Convert each tool spec into a proper tool call
          tools.forEach((spec: any, index: number) => {
            unwrapped.push({
              id: `${toolCall.id}-unwrapped-${index}`,
              type: 'function',
              function: {
                name: spec.name,
                arguments: spec.arguments,
              },
            });
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
   */
  private async executeConcurrent(toolCalls: ToolCall[]): Promise<void> {
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

    try {
      // Execute all tools in parallel
      const results = await Promise.all(
        toolCalls.map(tc => this.executeSingleTool(tc, groupId))
      );

      // Process results (add to conversation)
      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i];
        const result = results[i];
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
          success: results.every(r => r.success),
        },
      });
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
   */
  private async executeSequential(toolCalls: ToolCall[]): Promise<void> {
    for (const toolCall of toolCalls) {
      const result = await this.executeSingleTool(toolCall);
      await this.processToolResult(toolCall, result);
    }
  }

  /**
   * Execute a single tool call
   *
   * @param toolCall - Tool call to execute
   * @param parentId - Optional parent ID for grouped execution
   * @returns Tool execution result
   */
  private async executeSingleTool(
    toolCall: ToolCall,
    parentId?: string
  ): Promise<ToolResult> {
    const { id, function: func } = toolCall;
    const { name: toolName, arguments: args } = func;

    // Get the tool to check properties
    const tool = this.toolManager.getTool(toolName);

    // If we have a parent context from a nested agent, use it; otherwise use the group parentId
    const effectiveParentId = this.parentCallId || parentId;
    logger.debug('[TOOL_ORCHESTRATOR] executeSingleTool - id:', id, 'tool:', toolName, 'args:', JSON.stringify(args), 'parentId:', parentId, 'effectiveParentId:', effectiveParentId);

    // Reset tool call activity timer to prevent timeout
    this.agent.resetToolCallActivity();

    // Auto-promote first pending todo to in_progress
    // This helps the agent track progress through the todo list
    if (toolName !== 'todo_write') {
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

    // Emit start event FIRST (creates tool call in UI state)
    const isCollapsed = this.config.isSpecializedAgent === true;
    const shouldCollapse = (tool as any)?.shouldCollapse || false;
    const hideOutput = (tool as any)?.hideOutput || false;

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

    // CRITICAL: After TOOL_CALL_START, we MUST emit TOOL_CALL_END
    // Use try-finally to guarantee this happens
    let result: ToolResult = {
      success: false,
      error: 'Tool execution failed unexpectedly',
      error_type: 'system_error',
    };

    try {
      // Preview changes (e.g., diffs) BEFORE permission check
      // Tool call now exists in state, so diff can attach to it
      if (tool) {
        await tool.previewChanges(args, id);
      }

      // Check permissions if PermissionManager is available
      if (this.permissionManager) {
        // Get the tool to check if it requires confirmation
        const tool = this.toolManager.getTool(toolName);

        // Only check permissions if the tool requires confirmation
        if (tool && tool.requiresConfirmation) {
          await this.permissionManager.checkPermission(toolName, args);
        }
      }

      // Execute tool via tool manager (pass ID for streaming output)
      result = await this.toolManager.executeTool(toolName, args, id);

      // Record successful tool call for in-progress todo tracking (main agent only)
      if (result.success && !this.config.isSpecializedAgent && toolName !== 'todo_write') {
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
      // Handle any errors during execution
      if (
        error instanceof DirectoryTraversalError ||
        error instanceof PermissionDeniedError
      ) {
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
    } finally {
      // GUARANTEE: Always emit TOOL_CALL_END after TOOL_CALL_START
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
    // Format result as natural language
    const formattedResult = this.formatToolResult(toolCall.function.name, result);

    logger.debug('[TOOL_ORCHESTRATOR] processToolResult - tool:', toolCall.function.name, 'id:', toolCall.id, 'success:', result.success, 'resultLength:', formattedResult.length);

    // Add tool result message to conversation
    this.agent.addMessage({
      role: 'tool',
      content: formattedResult,
      tool_call_id: toolCall.id,
      name: toolCall.function.name,
    });

    logger.debug('[TOOL_ORCHESTRATOR] processToolResult - tool result added to agent conversation');
  }

  /**
   * Format tool result as natural language
   *
   * Serializes the entire result object to JSON (matching Python implementation)
   * to ensure all metadata (like file_check) is included in LLM context.
   *
   * @param toolName - Name of the tool
   * @param result - Tool execution result
   * @returns Formatted result string
   */
  private formatToolResult(toolName: string, result: ToolResult): string {
    // Handle internal-only tool results (for special tools like delegate_task)
    if ((result as any)._internal_only) {
      return (result as any).result || 'Internal operation completed';
    }

    // Extract warning before serialization to ensure it's not lost during truncation
    const warning = result.warning;
    const resultWithoutWarning = { ...result };
    delete resultWithoutWarning.warning;

    // Serialize result object to JSON (includes all metadata like file_check)
    // This matches Python CodeAlly's behavior in response_processor.py
    let resultStr: string;
    try {
      resultStr = JSON.stringify(resultWithoutWarning);
    } catch (error) {
      // Fallback for non-serializable objects
      resultStr = String(resultWithoutWarning);
    }

    // Apply context-aware truncation if ToolResultManager is available
    if (this.toolResultManager) {
      resultStr = this.toolResultManager.processToolResult(toolName, resultStr);
    }

    // Append warning after truncation to ensure it's always visible
    if (warning) {
      resultStr += `\n\n⚠️  ${warning}`;
    }

    // Inject focus reminder in every tool result if there's an active todo (main agent only)
    if (!this.config.isSpecializedAgent) {
      const focusReminder = this.generateFocusReminder();
      if (focusReminder) {
        resultStr += `\n\n<system-reminder>${focusReminder}</system-reminder>`;
      }
    }

    return resultStr;
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
          const argStr = uniqueArgs.slice(0, 3).join(', ') + (uniqueArgs.length > 3 ? '...' : '');
          reminder += `\n- ${toolName}(${argStr})`;
        }
      }

      reminder += `\n\nStay on task. Use todo_write to mark complete when finished.`;

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
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}
