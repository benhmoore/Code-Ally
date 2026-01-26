/**
 * AgentAskTool - Continue conversation with persistent pooled agents
 *
 * Enables the main agent to continue conversations with previously created
 * persistent agents by sending additional messages to them. Works in conjunction
 * with ExploreTool/PlanTool/AgentTool (which automatically persist agents).
 *
 * Key features:
 * - Retrieve agent from pool by ID
 * - Send message to agent (continuing existing conversation)
 * - Return agent's response
 * - Include original task context in system reminder
 * - Handle agent-not-found gracefully
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, ActivityEventType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { AgentPoolService, AgentMetadata, PooledAgent } from '../services/AgentPoolService.js';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { getAgentType, getAgentDisplayName } from '../utils/agentTypeUtils.js';
import { extractSummaryFromConversation } from '../utils/agentUtils.js';
import { TEXT_LIMITS, FORMATTING, PERMISSION_MESSAGES } from '../config/constants.js';
import { getThoroughnessDuration, formatMinutesSeconds, formatElapsed, type ThoroughnessLevel } from '../ui/utils/timeUtils.js';
import { createAgentTaskContextReminder } from '../utils/messageUtils.js';

export class AgentAskTool extends BaseTool {
  readonly name = 'agent-ask';
  private currentPooledAgent: PooledAgent | null = null;
  readonly displayName = 'Follow Up';
  readonly description =
    'Continue conversation with a persistent agent created by explore/plan/agent. Send additional messages to the same agent instance. All agents automatically persist and can be queried later. Use when you need follow-up questions or iterative refinement.';
  readonly requiresConfirmation = false; // Read-only operation (for explore agents) or planning operation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = false; // Show output (but controlled by formatSubtext)
  readonly visibleInChat = true; // Show in UI with "Follow Up" display name

  readonly usageGuidance = `**When to use agent-ask:**
DEFAULT for ANY follow-up to explore/plan/agent. Agent already has context → dramatically more efficient than starting fresh.

Use agent-ask when:
- Asking clarifying questions ("How many X?", "What about Y?", "Where is Z?")
- Drilling deeper into findings ("Show me that implementation", "Explain how that works")
- Asking related questions ("What about the related feature?")
- Continuing investigation in same area

Start NEW agent only when:
- Investigating completely unrelated area/problem
- Switching to different system/module/concern

When uncertain: Use agent-ask first. Much cheaper than restarting.`;

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
              description: 'Agent ID from previous explore/plan/agent call (agents automatically persist)',
            },
            message: {
              type: 'string',
              description: 'Question or request to send to the agent. Be specific about what you want.',
            },
            thoroughness: {
              type: 'string',
              description: 'Level of thoroughness for this interaction: "quick" (~1 min, 2-5 tool calls), "medium" (~5 min, 5-10 tool calls), "very thorough" (~10 min, 10-20 tool calls), "uncapped" (no time limit, default). Controls time budget and depth.',
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
        'Example: agent-ask(agent_id="pool-agent-123-456", message="What about error handling?")'
      );
    }

    // Validate message parameter
    if (!message || typeof message !== 'string') {
      return this.formatErrorResponse(
        'message parameter is required and must be a string',
        'validation_error',
        'Example: agent-ask(agent_id="pool-agent-123-456", message="What about error handling?")'
      );
    }

    // Validate thoroughness parameter
    const validThoroughness = ['quick', 'medium', 'very thorough', 'uncapped'];
    if (!validThoroughness.includes(thoroughness)) {
      return this.formatErrorResponse(
        `thoroughness must be one of: ${validThoroughness.join(', ')}`,
        'validation_error',
        'Example: agent-ask(agent_id="...", message="...", thoroughness="uncapped")'
      );
    }

    // Execute ask agent - pass currentCallId to avoid race conditions
    const callId = this.currentCallId;
    if (!callId) {
      return this.formatErrorResponse(
        'Internal error: callId not set',
        'system_error'
      );
    }

    return await this.askAgent(agentId, message, thoroughness, callId);
  }

  /**
   * Send message to persistent agent and return response
   *
   * @param agentId - ID of the agent from pool
   * @param message - Message to send to the agent
   * @param thoroughness - Level of thoroughness for this interaction
   * @param callId - Unique call identifier for tracking
   */
  private async askAgent(
    agentId: string,
    message: string,
    thoroughness: string,
    callId: string
  ): Promise<ToolResult> {
    logger.debug('[ASK_AGENT_TOOL] Sending message to agent, callId:', callId, 'agentId:', agentId, 'thoroughness:', thoroughness);
    const startTime = Date.now();

    try {
      // Get AgentPoolService
      const registry = ServiceRegistry.getInstance();
      const agentPoolService = registry.get<AgentPoolService>('agent_pool');

      if (!agentPoolService) {
        return this.formatErrorResponse(
          'AgentPoolService not available. agent-ask requires the agent pool service.',
          'system_error',
          'Ensure AgentPoolService is registered in ServiceRegistry'
        );
      }

      // Check if agent exists in pool
      if (!agentPoolService.hasAgent(agentId)) {
        return this.formatErrorResponse(
          `Agent not found: ${agentId}. Agent may have been evicted from pool or ID is invalid.`,
          'validation_error',
          'Use explore/plan/agent to create a persistent agent and get an agent_id (agents automatically persist)'
        );
      }

      // Get agent metadata
      const metadata = agentPoolService.getAgentMetadata(agentId);
      if (!metadata) {
        // Should not happen if hasAgent returned true, but check anyway
        return this.formatErrorResponse(
          `Agent metadata not found: ${agentId}`,
          'system_error'
        );
      }

      // Check if agent is currently in use
      if (metadata.inUse) {
        return this.formatErrorResponse(
          `Agent ${agentId} is currently in use. Wait for current operation to complete.`,
          'execution_error',
          'Try again in a moment'
        );
      }

      // Get agent instance
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
      try {
        const toolManager = registry.get<any>('tool_manager');
        delegationManager = toolManager?.getDelegationContextManager();
        if (delegationManager) {
          delegationManager.register(callId, 'agent-ask', this.currentPooledAgent);
          logger.debug(`[ASK_AGENT_TOOL] Registered delegation: callId=${callId}`);
        }
      } catch (error) {
        logger.debug(`[ASK_AGENT_TOOL] Delegation registration skipped: ${error}`);
      }

      // Map thoroughness to max duration for this turn
      const maxDuration = getThoroughnessDuration(thoroughness as any);
      agent.setMaxDuration(maxDuration);
      agent.setThoroughness(thoroughness);
      logger.debug('[ASK_AGENT_TOOL] Set agent maxDuration to', maxDuration, 'minutes and thoroughness to', thoroughness);

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
      // This ensures tool calls made by the agent nest under the current agent-ask call
      const orchestrator = agent.getToolOrchestrator();
      const originalParentCallId = orchestrator.getParentCallId();

      try {
        // Set parent call ID to current agent-ask call ID
        orchestrator.setParentCallId(callId);
        logger.debug('[ASK_AGENT_TOOL] Updated agent parent call ID from', originalParentCallId, 'to', callId);

        // Send message to agent with parentCallId in execution context
        // This ensures tool calls are nested under this agent-ask call in the UI
        logger.debug('[ASK_AGENT_TOOL] Sending message to agent:', agentId);
        const response = await agent.sendMessage(message, { parentCallId: callId });
        logger.debug('[ASK_AGENT_TOOL] Agent response received, length:', response?.length || 0);

        let finalResponse: string;

        // Ensure we have a substantial response
        if (!response || response.trim().length === 0) {
          logger.debug('[ASK_AGENT_TOOL] Empty response, extracting from conversation');
          finalResponse = extractSummaryFromConversation(agent, '[ASK_AGENT_TOOL]', 'Agent response:') ||
            'Agent responded but no summary was provided.';
        } else if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
          logger.debug('[ASK_AGENT_TOOL] Incomplete response, attempting to extract summary');
          const summary = extractSummaryFromConversation(agent, '[ASK_AGENT_TOOL]', 'Agent response:');
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

        // Check if the response indicates permission denial or interruption
        // In these cases, report failure to the parent agent so it knows the task didn't complete
        if (
          response === PERMISSION_MESSAGES.USER_FACING_DENIAL ||
          response === PERMISSION_MESSAGES.USER_FACING_INTERRUPTION
        ) {
          logger.debug('[ASK_AGENT_TOOL] Agent was interrupted or permission denied:', response);
          return this.formatErrorResponse(
            response,
            'permission_denied'
          );
        }

        // Build context reminder with original task
        const taskContext = this.buildTaskContext(metadata);

        // Append note that user cannot see this
        const result = finalResponse + '\n\nIMPORTANT: The user CANNOT see this response. You must share relevant information, summarized or verbatim with the user in your own response, if appropriate.';

        // Build response
        const successResponse: Record<string, any> = {
          content: result,
          agent_id: agentId, // Return agent_id for potential chaining
          duration_seconds: Math.round(duration * Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES)) / Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES),
        };

        // Add task context reminder if available (with explicit persistence flag)
        if (taskContext) {
          Object.assign(successResponse, taskContext);
        }

        return this.formatSuccessResponse(successResponse);
      } finally {
        // Always restore original parent call ID
        orchestrator.setParentCallId(originalParentCallId);
        logger.debug('[ASK_AGENT_TOOL] Restored agent parent call ID to', originalParentCallId);

        // Clear delegation context
        if (delegationManager) {
          delegationManager.transitionToCompleting(callId);
          delegationManager.clear(callId);
          logger.debug(`[ASK_AGENT_TOOL] Cleared delegation: callId=${callId}`);
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
      logger.debug('[ASK_AGENT_TOOL] Error building task context:', error);
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
   * AgentAskTool shows 'message' in subtext
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

    // Show agent ID
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
   * agent-ask is intentionally excluded from injectable tools in ToolManager.
   * When agent-ask is running, interjections route to main agent instead,
   * since agent-ask is just querying for information while the main
   * conversation continues with the main agent.
   *
   * This differs from explore/plan/agent which DO accept interjections
   * because those tools represent direct interactions with subagents.
   */
  injectUserMessage(message: string): void {
    if (!this.currentPooledAgent) {
      logger.warn('[AGENT_ASK_TOOL] injectUserMessage called but no active pooled agent');
      return;
    }

    const agent = this.currentPooledAgent.agent;
    if (!agent) {
      logger.warn('[AGENT_ASK_TOOL] injectUserMessage called but pooled agent has no agent instance');
      return;
    }

    logger.debug('[AGENT_ASK_TOOL] Injecting user message into pooled agent:', this.currentPooledAgent.agentId);
    agent.addUserInterjection(message);
    agent.interrupt('interjection');
  }
}
