/**
 * AgentOutputTool - Read output from background agents
 *
 * Retrieves status and results from agents started with agent(run_in_background=true).
 * Returns clean, structured output:
 * - Executing: Shows current activity, progress, and recent tool calls
 * - Completed: Returns only the final result
 * - Error: Returns the error message
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { BackgroundAgentManager } from '../services/BackgroundAgentManager.js';
import { formatDuration } from '../ui/utils/timeUtils.js';
import { BACKGROUND_AGENT_OUTPUT } from '../config/constants.js';
import { logger } from '../services/Logger.js';

interface ToolCallInfo {
  tool: string;
  args: Record<string, any>;
  result?: string;
  status: 'completed' | 'executing';
}

export class AgentOutputTool extends BaseTool {
  readonly name = 'agent-output';
  readonly description = 'Read output from a background agent';
  readonly requiresConfirmation = false; // Read-only operation
  readonly hideOutput = false;

  /** Track last seen tool call count per agent to detect changes */
  private lastSeenToolCallCount: Map<string, number> = new Map();

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            agent_id: {
              type: 'string',
              description: 'Agent ID returned from agent(run_in_background=true)',
            },
          },
          required: ['agent_id'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const agentId = args.agent_id as string;

    if (!agentId) {
      return this.formatErrorResponse(
        'agent_id parameter is required',
        'validation_error',
        'Example: agent-output(agent_id="bg-agent-1234567890-abc123")'
      );
    }

    // Get agent manager from registry
    const registry = ServiceRegistry.getInstance();
    const agentManager = registry.get<BackgroundAgentManager>('background_agent_manager');

    if (!agentManager) {
      return this.formatErrorResponse(
        'BackgroundAgentManager not available',
        'system_error'
      );
    }

    // Get agent info
    const agentInfo = agentManager.getAgent(agentId);

    if (!agentInfo) {
      return this.formatErrorResponse(
        `Background agent ${agentId} not found`,
        'user_error',
        'Use agent(run_in_background=true) to start a background agent. Check agent IDs in system reminders.'
      );
    }

    // For executing agents, wait for new activity if nothing changed since last check
    if (agentInfo.status === 'executing') {
      const toolCallCount = this.extractToolCalls(agentInfo.agent).length;
      const lastCount = this.lastSeenToolCallCount.get(agentId) ?? -1;

      if (toolCallCount === lastCount && toolCallCount > 0) {
        // No new activity - wait up to POLL_WAIT_MS for changes
        await this.waitForActivity(agentManager, agentId, lastCount);
      }

      this.lastSeenToolCallCount.set(agentId, toolCallCount);
    }

    // Re-fetch in case status changed during wait
    const currentInfo = agentManager.getAgent(agentId);
    if (!currentInfo) {
      return this.formatErrorResponse(`Background agent ${agentId} no longer exists`, 'user_error');
    }

    const now = Date.now();
    const elapsed = formatDuration(now - currentInfo.startTime);

    // Build response based on agent status
    if (currentInfo.status === 'executing') {
      const toolCalls = this.extractToolCalls(currentInfo.agent);
      const recentCalls = toolCalls.slice(-BACKGROUND_AGENT_OUTPUT.RECENT_TOOL_CALLS);
      const completedCount = toolCalls.filter(tc => tc.status === 'completed').length;

      const currentCall = toolCalls.find(tc => tc.status === 'executing');
      const currentActivity = currentCall
        ? this.formatToolActivity(currentCall.tool, currentCall.args)
        : 'thinking...';

      return this.formatSuccessResponse({
        status: 'executing',
        elapsed,
        current_activity: currentActivity,
        tool_calls_completed: completedCount,
        recent_tool_calls: recentCalls,
      });
    } else if (currentInfo.status === 'completed') {
      // Agent completed - return final result only
      const duration = currentInfo.completionTime
        ? formatDuration(currentInfo.completionTime - currentInfo.startTime)
        : elapsed;

      return this.formatSuccessResponse({
        status: 'completed',
        duration,
        result: currentInfo.finalResult || 'Agent completed successfully',
      });
    } else {
      // Agent errored
      const duration = currentInfo.completionTime
        ? formatDuration(currentInfo.completionTime - currentInfo.startTime)
        : elapsed;

      return this.formatSuccessResponse({
        status: 'error',
        duration,
        error: currentInfo.errorMessage || 'Agent failed with unknown error',
      });
    }
  }

  /**
   * Wait for new activity on an agent
   * Waits at least POLL_MIN_WAIT_MS, up to POLL_MAX_WAIT_MS if no new activity
   */
  private async waitForActivity(
    agentManager: BackgroundAgentManager,
    agentId: string,
    lastCount: number
  ): Promise<void> {
    const waitStart = Date.now();

    while (Date.now() - waitStart < BACKGROUND_AGENT_OUTPUT.POLL_MAX_WAIT_MS) {
      await new Promise(resolve => setTimeout(resolve, BACKGROUND_AGENT_OUTPUT.POLL_INTERVAL_MS));

      const info = agentManager.getAgent(agentId);
      if (!info || info.status !== 'executing') break;

      const currentCount = this.extractToolCalls(info.agent).length;
      if (currentCount !== lastCount) {
        // New activity - return after minimum wait reached
        if (Date.now() - waitStart >= BACKGROUND_AGENT_OUTPUT.POLL_MIN_WAIT_MS) break;
      }
    }
  }

  /**
   * Format subtext for display in UI
   * Shows short agent ID and tool call count if agent is found
   */
  formatSubtext(args: Record<string, any>): string | null {
    const agentId = args.agent_id as string;
    if (!agentId) return null;

    // Shorten agent ID for display (show first 8 chars after "bg-agent-")
    const shortId = agentId.startsWith('bg-agent-')
      ? agentId.substring(9, 17)
      : agentId;

    // Try to get tool call count from agent
    try {
      const registry = ServiceRegistry.getInstance();
      const agentManager = registry.get<BackgroundAgentManager>('background_agent_manager');
      if (agentManager) {
        const agentInfo = agentManager.getAgent(agentId);
        if (agentInfo) {
          const toolCalls = this.extractToolCalls(agentInfo.agent);
          return `${shortId} (${toolCalls.length} tool calls)`;
        }
      }
    } catch {
      // Fall back to just ID if we can't get tool count
    }

    return shortId;
  }

  /**
   * Get parameters shown in subtext
   */
  getSubtextParameters(): string[] {
    return ['agent_id'];
  }

  /**
   * Extract tool calls from agent's conversation with parameters and results
   */
  private extractToolCalls(agent: any): ToolCallInfo[] {
    const toolCalls: ToolCallInfo[] = [];

    try {
      const messages = agent.getMessages?.() || agent.getMessagesCopy?.() || [];

      // Build a map of tool_call_id -> result content
      const resultMap = new Map<string, string>();
      for (const msg of messages) {
        if (msg.role === 'tool' && msg.tool_call_id) {
          const resultContent = this.extractResultContent(msg.content);
          resultMap.set(msg.tool_call_id, resultContent);
        }
      }

      // Extract tool calls with their args and results
      for (const msg of messages) {
        if (msg.role === 'assistant' && msg.tool_calls && Array.isArray(msg.tool_calls)) {
          for (const tc of msg.tool_calls) {
            const toolName = tc.function?.name || tc.name || 'unknown';
            const toolCallId = tc.id;

            // Skip internal tools
            if (toolName === 'cleanup-call') continue;

            // Parse arguments
            const args = this.parseAndTruncateArgs(tc);

            // Get result if available
            const result = toolCallId ? resultMap.get(toolCallId) : undefined;
            const hasResult = result !== undefined;

            toolCalls.push({
              tool: toolName,
              args,
              result: hasResult ? result : undefined,
              status: hasResult ? 'completed' : 'executing',
            });
          }
        }
      }
    } catch (error) {
      // Log extraction errors for debugging but return empty to avoid breaking UI
      logger.debug('[AgentOutputTool] Failed to extract tool calls:', error);
    }

    return toolCalls;
  }

  /**
   * Extract and truncate result content from tool message
   */
  private extractResultContent(content: any): string {
    try {
      let resultContent = '';

      if (typeof content === 'string') {
        resultContent = content;
      } else if (content) {
        const parsed = typeof content === 'string' ? JSON.parse(content) : content;
        if (parsed.content) resultContent = String(parsed.content);
        else if (parsed.error) resultContent = `ERROR: ${parsed.error}`;
        else resultContent = JSON.stringify(parsed);
      }

      // Truncate to max length
      if (resultContent.length > BACKGROUND_AGENT_OUTPUT.MAX_RESULT_LENGTH) {
        return resultContent.slice(0, BACKGROUND_AGENT_OUTPUT.MAX_RESULT_LENGTH) + '...';
      }
      return resultContent;
    } catch (error) {
      // Fallback to string conversion on parse error
      logger.debug('[AgentOutputTool] Failed to parse result content:', error);
      return String(content).slice(0, BACKGROUND_AGENT_OUTPUT.MAX_RESULT_LENGTH);
    }
  }

  /**
   * Parse tool call arguments and truncate long values
   */
  private parseAndTruncateArgs(toolCall: any): Record<string, any> {
    try {
      const rawArgs = typeof toolCall.function?.arguments === 'string'
        ? JSON.parse(toolCall.function.arguments)
        : toolCall.function?.arguments || toolCall.arguments || {};

      const truncatedArgs: Record<string, any> = {};

      for (const [key, value] of Object.entries(rawArgs)) {
        if (typeof value === 'string' && value.length > BACKGROUND_AGENT_OUTPUT.MAX_ARG_LENGTH) {
          truncatedArgs[key] = value.slice(0, BACKGROUND_AGENT_OUTPUT.MAX_ARG_LENGTH) + '...';
        } else if (Array.isArray(value)) {
          // For arrays, show count if too many items
          if (value.length > 3) {
            truncatedArgs[key] = `[${value.length} items]`;
          } else {
            truncatedArgs[key] = value;
          }
        } else {
          truncatedArgs[key] = value;
        }
      }

      return truncatedArgs;
    } catch (error) {
      // Fallback to empty args on parse error
      logger.debug('[AgentOutputTool] Failed to parse tool arguments:', error);
      return {};
    }
  }

  /**
   * Format a tool call into a human-readable activity description
   */
  private formatToolActivity(toolName: string, args: Record<string, any>): string {
    switch (toolName) {
      case 'read':
        if (args.file_path) {
          const filename = String(args.file_path).split('/').pop() || args.file_path;
          return `Reading ${filename}`;
        }
        if (args.file_paths) {
          return `Reading files`;
        }
        return 'Reading file';

      case 'glob':
        return args.pattern ? `Searching for ${args.pattern}` : 'Searching files';

      case 'grep':
        return args.pattern ? `Searching for "${args.pattern}"` : 'Searching content';

      case 'tree':
        return 'Listing directory structure';

      case 'ls':
        return args.path ? `Listing ${args.path}` : 'Listing directory';

      case 'bash':
        if (args.command) {
          const cmd = String(args.command).slice(0, 40);
          return `Running: ${cmd}${String(args.command).length > 40 ? '...' : ''}`;
        }
        return 'Running command';

      case 'write':
      case 'edit':
        if (args.file_path) {
          const filename = String(args.file_path).split('/').pop() || args.file_path;
          return `${toolName === 'write' ? 'Writing' : 'Editing'} ${filename}`;
        }
        return toolName === 'write' ? 'Writing file' : 'Editing file';

      case 'write-temp':
        return 'Writing temporary notes';

      default:
        return toolName;
    }
  }
}
