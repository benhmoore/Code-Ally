/**
 * PromptAgentTool - Unified tool for interacting with agents
 *
 * Auto-detects agent state and routes appropriately:
 * - Executing background agents: Injects steering message (fire-and-forget)
 * - Idle pooled agents: Sends query and waits for response (blocking)
 * - Completed/errored agents: Directs to agent-output tool
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, ActivityEventType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { AgentPoolService, AgentMetadata, PooledAgent } from '../services/AgentPoolService.js';
import { BackgroundAgentManager } from '../services/BackgroundAgentManager.js';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { getAgentType, getAgentDisplayName } from '../utils/agentTypeUtils.js';
import { TEXT_LIMITS, FORMATTING, PERMISSION_MESSAGES } from '../config/constants.js';
import { getThoroughnessDuration, formatMinutesSeconds, formatElapsed, type ThoroughnessLevel } from '../ui/utils/timeUtils.js';
import { createAgentTaskContextReminder } from '../utils/messageUtils.js';

export class PromptAgentTool extends BaseTool {
  readonly name = 'prompt-agent';
  private currentPooledAgent: PooledAgent | null = null;
  readonly displayName = 'Prompt';
  readonly description =
    'Send a message to any agent. Auto-detects state: queries idle agents for response, steers executing agents with guidance.';
  readonly requiresConfirmation = false;
  readonly suppressExecutionAnimation = true;
  readonly shouldCollapse = true;
  readonly hideOutput = false;
  readonly visibleInChat = true;

  readonly usageGuidance = `**When to use prompt-agent:**
Works with ANY agent regardless of state:
- Idle agents (pooled): Sends message, waits for response
- Executing agents (background): Injects guidance, returns immediately

Use when:
- Following up on explore/plan/agent results
- Steering background agents mid-execution
- Asking clarifying questions
- Providing additional context or course correction

The tool auto-detects agent state - no need to track which tool to use.`;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Provide custom function definition
   */
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
              description: 'Agent ID (from explore/plan/agent or background agent)',
            },
            message: {
              type: 'string',
              description: 'Message to send. For idle agents: question/request. For executing agents: steering/guidance.',
            },
            thoroughness: {
              type: 'string',
              description: 'Level of thoroughness for idle agents (ignored for executing agents): "quick" (~1 min), "medium" (~5 min), "very thorough" (~10 min), "uncapped" (default).',
            },
          },
          required: ['agent_id', 'message'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const agentId = args.agent_id;
    const message = args.message;
    const thoroughness = args.thoroughness ?? 'uncapped';

    // Validate agent_id parameter
    if (!agentId || typeof agentId !== 'string') {
      return this.formatErrorResponse(
        'agent_id parameter is required and must be a string',
        'validation_error',
        'Example: prompt-agent(agent_id="pool-agent-123-456", message="What about error handling?")'
      );
    }

    // Validate message parameter
    if (!message || typeof message !== 'string') {
      return this.formatErrorResponse(
        'message parameter is required and must be a string',
        'validation_error',
        'Example: prompt-agent(agent_id="pool-agent-123-456", message="What about error handling?")'
      );
    }

    // Validate thoroughness parameter (only used for query mode)
    const validThoroughness = ['quick', 'medium', 'very thorough', 'uncapped'];
    if (!validThoroughness.includes(thoroughness)) {
      return this.formatErrorResponse(
        `thoroughness must be one of: ${validThoroughness.join(', ')}`,
        'validation_error',
        'Example: prompt-agent(agent_id="...", message="...", thoroughness="uncapped")'
      );
    }

    // Get call ID for tracking
    const callId = this.currentCallId;
    if (!callId) {
      return this.formatErrorResponse(
        'Internal error: callId not set',
        'system_error'
      );
    }

    // Get services from registry
    const registry = ServiceRegistry.getInstance();
    const backgroundManager = registry.get<BackgroundAgentManager>('background_agent_manager');
    const agentPoolService = registry.get<AgentPoolService>('agent_pool');

    // State detection logic
    // 1. Check BackgroundAgentManager first (for executing/completed background agents)
    if (backgroundManager) {
      const bgInfo = backgroundManager.getAgent(agentId);
      if (bgInfo) {
        if (bgInfo.status === 'executing') {
          // STEER MODE: Inject steering message into executing background agent
          return await this.steerAgent(agentId, message, backgroundManager);
        } else if (bgInfo.status === 'completed' || bgInfo.status === 'error') {
          // ERROR: Agent has completed, direct user to agent-output
          return this.formatErrorResponse(
            `Agent ${agentId} has ${bgInfo.status}. Use agent-output(agent_id="${agentId}") to read ${bgInfo.status === 'error' ? 'error details' : 'results'}.`,
            'user_error',
            `Background agents cannot be queried after ${bgInfo.status === 'error' ? 'failing' : 'completion'}`
          );
        }
      }
    }

    // 2. Check AgentPoolService (for idle pooled agents)
    if (agentPoolService) {
      if (agentPoolService.hasAgent(agentId)) {
        // Get metadata to check if in use
        const metadata = agentPoolService.getAgentMetadata(agentId);
        if (!metadata) {
          return this.formatErrorResponse(
            `Agent metadata not found: ${agentId}`,
            'system_error'
          );
        }

        if (metadata.inUse) {
          // ERROR: Agent is busy
          return this.formatErrorResponse(
            `Agent ${agentId} is currently in use. Wait for current operation to complete.`,
            'execution_error',
            'Try again in a moment'
          );
        }

        // QUERY MODE: Send message to idle pooled agent
        return await this.queryAgent(agentId, message, thoroughness, callId, agentPoolService);
      }
    }

    // 3. Neither - agent not found
    return this.formatErrorResponse(
      `Agent not found: ${agentId}. Agent may have been evicted from pool or ID is invalid.`,
      'validation_error',
      'Use explore/plan/agent to create an agent and get an agent_id'
    );
  }

  /**
   * STEER MODE: Inject steering message into executing background agent
   */
  private async steerAgent(
    agentId: string,
    message: string,
    manager: BackgroundAgentManager
  ): Promise<ToolResult> {
    logger.debug('[PROMPT_AGENT_TOOL] STEER MODE: Injecting steering message into', agentId);

    // Inject steering message
    const success = manager.injectSteering(agentId, message);

    if (!success) {
      // This shouldn't happen since we already checked status, but handle it anyway
      const info = manager.getAgent(agentId);
      if (!info) {
        return this.formatErrorResponse(
          `Background agent ${agentId} not found`,
          'user_error',
          'Check agent IDs in system reminders.'
        );
      }
      return this.formatErrorResponse(
        `Cannot steer agent ${agentId}: agent is ${info.status}, not executing`,
        'user_error',
        'Steering only works for executing agents.'
      );
    }

    return this.formatSuccessResponse({
      message: `Steering message injected into agent ${agentId}`,
      agent_id: agentId,
      mode: 'steering',
    });
  }

  /**
   * QUERY MODE: Send message to idle pooled agent and wait for response
   */
  private async queryAgent(
    agentId: string,
    message: string,
    thoroughness: string,
    callId: string,
    agentPoolService: AgentPoolService
  ): Promise<ToolResult> {
    logger.debug('[PROMPT_AGENT_TOOL] QUERY MODE: Sending message to agent, callId:', callId, 'agentId:', agentId, 'thoroughness:', thoroughness);
    const startTime = Date.now();

    try {
      // Get agent metadata (already validated above)
      const metadata = agentPoolService.getAgentMetadata(agentId)!;
      const agent = metadata.agent;

      // Track pooled agent for interjection routing
      this.currentPooledAgent = {
        agent,
        agentId,
        release: () => {} // No-op since we're using an existing pooled agent
      };

      // Register delegation context for INSTRUCT option in permission prompts
      // This enables "Tell Ally what to do differently" instead of plain "Deny"
      let delegationManager: any = null;
      const registry = ServiceRegistry.getInstance();
      try {
        const toolManager = registry.get<any>('tool_manager');
        delegationManager = toolManager?.getDelegationContextManager();
        if (delegationManager) {
          delegationManager.register(callId, 'prompt-agent', this.currentPooledAgent);
          logger.debug(`[PROMPT_AGENT_TOOL] Registered delegation: callId=${callId}`);
        }
      } catch (error) {
        logger.debug(`[PROMPT_AGENT_TOOL] Delegation registration skipped: ${error}`);
      }

      // Map thoroughness to max duration for this turn
      const maxDuration = getThoroughnessDuration(thoroughness as any);
      agent.setMaxDuration(maxDuration);
      agent.setThoroughness(thoroughness);
      logger.debug('[PROMPT_AGENT_TOOL] Set agent maxDuration to', maxDuration, 'minutes and thoroughness to', thoroughness);

      // Emit agent start event
      this.emitEvent({
        id: callId,
        type: ActivityEventType.AGENT_START,
        timestamp: Date.now(),
        data: {
          agentName: 'agent-ask',
          taskPrompt: message,
        },
      });

      // Save original parent call ID and temporarily update to current call ID
      // This ensures tool calls made by the agent nest under the current prompt-agent call
      const orchestrator = agent.getToolOrchestrator();
      const originalParentCallId = orchestrator.getParentCallId();

      try {
        // Set parent call ID to current prompt-agent call ID
        orchestrator.setParentCallId(callId);
        logger.debug('[PROMPT_AGENT_TOOL] Updated agent parent call ID from', originalParentCallId, 'to', callId);

        // Send message to agent with parentCallId in execution context
        // This ensures tool calls are nested under this prompt-agent call in the UI
        logger.debug('[PROMPT_AGENT_TOOL] Sending message to agent:', agentId);
        const response = await agent.sendMessage(message, { parentCallId: callId });
        logger.debug('[PROMPT_AGENT_TOOL] Agent response received, length:', response?.length || 0);

        // Check if the response indicates permission denial or interruption
        // In these cases, report failure to the parent agent so it knows the task didn't complete
        if (
          response === PERMISSION_MESSAGES.USER_FACING_DENIAL ||
          response === PERMISSION_MESSAGES.USER_FACING_INTERRUPTION
        ) {
          logger.debug('[PROMPT_AGENT_TOOL] Agent was interrupted or permission denied:', response);
          return this.formatErrorResponse(
            response,
            'permission_denied'
          );
        }


        let finalResponse: string;

        // Ensure we have a substantial response
        if (!response || response.trim().length === 0) {
          logger.debug('[PROMPT_AGENT_TOOL] Empty response, extracting from conversation');
          finalResponse = this.extractSummaryFromConversation(agent) ||
            'Agent responded but no summary was provided.';
        } else if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
          logger.debug('[PROMPT_AGENT_TOOL] Incomplete response, attempting to extract summary');
          const summary = this.extractSummaryFromConversation(agent);
          finalResponse = (summary && summary.length > response.length) ? summary : response;
        } else {
          finalResponse = response;
        }

        const duration = (Date.now() - startTime) / 1000;

        // Emit agent end event
        this.emitEvent({
          id: callId,
          type: ActivityEventType.AGENT_END,
          timestamp: Date.now(),
          data: {
            agentName: 'agent-ask',
            result: finalResponse,
            duration,
          },
        });

        // Build context reminder with original task
        const taskContext = this.buildTaskContext(metadata);

        // Append note that user cannot see this
        const result = finalResponse + '\n\nIMPORTANT: The user CANNOT see this response. You must share relevant information, summarized or verbatim with the user in your own response, if appropriate.';

        // Build response
        const successResponse: Record<string, any> = {
          content: result,
          agent_id: agentId, // Return agent_id for potential chaining
          duration_seconds: Math.round(duration * Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES)) / Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES),
          mode: 'query',
        };

        // Add task context reminder if available (with explicit persistence flag)
        if (taskContext) {
          Object.assign(successResponse, taskContext);
        }

        return this.formatSuccessResponse(successResponse);
      } finally {
        // Always restore original parent call ID
        orchestrator.setParentCallId(originalParentCallId);
        logger.debug('[PROMPT_AGENT_TOOL] Restored agent parent call ID to', originalParentCallId);

        // Clear delegation context
        if (delegationManager) {
          delegationManager.transitionToCompleting(callId);
          delegationManager.clear(callId);
          logger.debug(`[PROMPT_AGENT_TOOL] Cleared delegation: callId=${callId}`);
        }

        // Clear tracked pooled agent
        this.currentPooledAgent = null;
      }
    } catch (error) {
      const duration = (Date.now() - startTime) / 1000;

      // Emit agent end event for error path
      this.emitEvent({
        id: callId,
        type: ActivityEventType.AGENT_END,
        timestamp: Date.now(),
        data: {
          agentName: 'agent-ask',
          result: `Error: ${formatError(error)}`,
          duration,
        },
      });

      return this.formatErrorResponse(
        `Failed to send message to agent: ${formatError(error)}`,
        'execution_error'
      );
    }
  }

  /**
   * Build task context reminder from agent metadata
   *
   * Includes original task/requirements for context
   * Returns object with both system_reminder and system_reminder_persist
   */
  private buildTaskContext(metadata: AgentMetadata): {
    system_reminder: string;
    system_reminder_persist: boolean;
  } | null {
    try {
      const config = metadata.config;

      // Extract task context from agent config
      const taskPrompt = config.taskPrompt;

      if (!taskPrompt) {
        return null;
      }

      // Use centralized utility to determine agent type
      const agentType = getAgentType(metadata);
      const displayName = getAgentDisplayName(agentType);

      // Extract optional context
      const maxDuration = config.maxDuration;
      const thoroughness = config.thoroughness || 'uncapped';
      const maxDurationNum = maxDuration ? getThoroughnessDuration(thoroughness as ThoroughnessLevel) || null : null;
      const maxDurationStr = maxDurationNum ? formatMinutesSeconds(maxDurationNum) : null;

      // PERSIST: true - Persistent: Explains specialized agent's purpose and constraints
      // Kept throughout agent's entire lifecycle to maintain role clarity
      return createAgentTaskContextReminder(displayName, taskPrompt, maxDurationStr, thoroughness);
    } catch (error) {
      logger.debug('[PROMPT_AGENT_TOOL] Error building task context:', error);
      return null;
    }
  }

  /**
   * Extract summary from agent's conversation history
   */
  private extractSummaryFromConversation(agent: any): string | null {
    try {
      const messages = agent.getMessages();

      // Find all assistant messages
      const assistantMessages = messages
        .filter((msg: any) => msg.role === 'assistant' && msg.content && msg.content.trim().length > 0)
        .map((msg: any) => msg.content);

      if (assistantMessages.length === 0) {
        logger.debug('[PROMPT_AGENT_TOOL] No assistant messages found in conversation');
        return null;
      }

      // Combine recent messages if multiple exist
      if (assistantMessages.length > 1) {
        const recentMessages = assistantMessages.slice(-3);
        const summary = recentMessages.join('\n\n');
        logger.debug('[PROMPT_AGENT_TOOL] Extracted summary from', recentMessages.length, 'messages, length:', summary.length);
        return `Agent response:\n\n${summary}`;
      }

      // Single assistant message
      const summary = assistantMessages[0];
      if (summary) {
        logger.debug('[PROMPT_AGENT_TOOL] Using single assistant message as summary, length:', summary.length);
        return summary;
      }

      return null;
    } catch (error) {
      logger.debug('[PROMPT_AGENT_TOOL] Error extracting summary:', error);
      return null;
    }
  }

  /**
   * Format subtext for display in UI
   * Shows the message being sent to the agent
   */
  formatSubtext(args: Record<string, any>): string | null {
    const message = args.message as string;

    if (!message) {
      return null;
    }

    return message;
  }

  /**
   * Get parameters shown in subtext
   * PromptAgentTool shows 'message' in subtext
   */
  getSubtextParameters(): string[] {
    return ['message'];
  }

  /**
   * Custom result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];

    // Show mode (query vs steering)
    if (result.mode === 'steering') {
      lines.push('Steering message injected');
      if (result.agent_id) {
        lines.push(`Agent: ${result.agent_id}`);
      }
      return lines.slice(0, maxLines);
    }

    // Query mode - show agent ID
    if (result.agent_id) {
      lines.push(`Agent: ${result.agent_id}`);
    }

    // Show duration if available
    if (result.duration_seconds !== undefined) {
      lines.push(`Responded in ${formatElapsed(result.duration_seconds)}`);
    }

    // Show content preview
    if (result.content) {
      const contentPreview =
        result.content.length > TEXT_LIMITS.AGENT_RESULT_PREVIEW_MAX
          ? result.content.substring(0, TEXT_LIMITS.AGENT_RESULT_PREVIEW_MAX - 3) + '...'
          : result.content;
      lines.push(contentPreview);
    }

    return lines.slice(0, maxLines);
  }

  /**
   * Inject user message into active pooled agent
   *
   * NOTE: This method exists for interface compatibility but is NOT used.
   * prompt-agent is intentionally excluded from injectable tools in ToolManager.
   * When prompt-agent is running, interjections route to main agent instead,
   * since prompt-agent is just querying for information while the main
   * conversation continues with the main agent.
   *
   * This differs from explore/plan/agent which DO accept interjections
   * because those tools represent direct interactions with subagents.
   */
  injectUserMessage(message: string): void {
    if (!this.currentPooledAgent) {
      logger.warn('[PROMPT_AGENT_TOOL] injectUserMessage called but no active pooled agent');
      return;
    }

    const agent = this.currentPooledAgent.agent;
    if (!agent) {
      logger.warn('[PROMPT_AGENT_TOOL] injectUserMessage called but pooled agent has no agent instance');
      return;
    }

    logger.debug('[PROMPT_AGENT_TOOL] Injecting user message into pooled agent:', this.currentPooledAgent.agentId);
    agent.addUserInterjection(message);
    agent.interrupt('interjection');
  }
}
