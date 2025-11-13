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
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { AgentPoolService, AgentMetadata, PooledAgent } from '../services/AgentPoolService.js';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { TEXT_LIMITS, FORMATTING } from '../config/constants.js';
import { getThoroughnessDuration } from '../ui/utils/timeUtils.js';

export class AgentAskTool extends BaseTool {
  readonly name = 'agent_ask';
  private currentPooledAgent: PooledAgent | null = null;
  readonly description =
    'Continue conversation with a persistent agent created by explore/plan/agent. Send additional messages to the same agent instance. All agents automatically persist and can be queried later. Use when you need follow-up questions or iterative refinement.';
  readonly requiresConfirmation = false; // Read-only operation (for explore agents) or planning operation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = true; // Hide detailed output
  readonly visibleInChat = false; // Silent tool call - not shown in UI

  readonly usageGuidance = `**When to use agent_ask:**
DEFAULT for ANY follow-up to explore/plan/agent. Agent already has context → dramatically more efficient than starting fresh.

Use agent_ask when:
- Asking clarifying questions ("How many X?", "What about Y?", "Where is Z?")
- Drilling deeper into findings ("Show me that implementation", "Explain how that works")
- Asking related questions ("What about the related feature?")
- Continuing investigation in same area

Start NEW agent only when:
- Investigating completely unrelated area/problem
- Switching to different system/module/concern

When uncertain: Use agent_ask first. Much cheaper than restarting.`;

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
        'Example: agent_ask(agent_id="pool-agent-123-456", message="What about error handling?")'
      );
    }

    // Validate message parameter
    if (!message || typeof message !== 'string') {
      return this.formatErrorResponse(
        'message parameter is required and must be a string',
        'validation_error',
        'Example: agent_ask(agent_id="pool-agent-123-456", message="What about error handling?")'
      );
    }

    // Validate thoroughness parameter
    const validThoroughness = ['quick', 'medium', 'very thorough', 'uncapped'];
    if (!validThoroughness.includes(thoroughness)) {
      return this.formatErrorResponse(
        `thoroughness must be one of: ${validThoroughness.join(', ')}`,
        'validation_error',
        'Example: agent_ask(agent_id="...", message="...", thoroughness="uncapped")'
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
          'AgentPoolService not available. agent_ask requires the agent pool service.',
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

      // Map thoroughness to max duration for this turn
      const maxDuration = getThoroughnessDuration(thoroughness as any);
      agent.setMaxDuration(maxDuration);
      logger.debug('[ASK_AGENT_TOOL] Set agent maxDuration to', maxDuration, 'minutes for thoroughness:', thoroughness);

      // Save original parent call ID and temporarily update to current call ID
      // This ensures tool calls made by the agent nest under the current agent_ask call
      const orchestrator = agent.getToolOrchestrator();
      const originalParentCallId = orchestrator.getParentCallId();

      try {
        // Set parent call ID to current agent_ask call ID
        orchestrator.setParentCallId(callId);
        logger.debug('[ASK_AGENT_TOOL] Updated agent parent call ID from', originalParentCallId, 'to', callId);

        // Send message to agent
        logger.debug('[ASK_AGENT_TOOL] Sending message to agent:', agentId);
        const response = await agent.sendMessage(message);
        logger.debug('[ASK_AGENT_TOOL] Agent response received, length:', response?.length || 0);

        let finalResponse: string;

        // Ensure we have a substantial response
        if (!response || response.trim().length === 0) {
          logger.debug('[ASK_AGENT_TOOL] Empty response, extracting from conversation');
          finalResponse = this.extractSummaryFromConversation(agent) ||
            'Agent responded but no summary was provided.';
        } else if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
          logger.debug('[ASK_AGENT_TOOL] Incomplete response, attempting to extract summary');
          const summary = this.extractSummaryFromConversation(agent);
          finalResponse = (summary && summary.length > response.length) ? summary : response;
        } else {
          finalResponse = response;
        }

        const duration = (Date.now() - startTime) / 1000;

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

        // Add task context reminder if available
        if (taskContext) {
          successResponse.system_reminder = taskContext;
        }

        return this.formatSuccessResponse(successResponse);
      } finally {
        // Always restore original parent call ID
        orchestrator.setParentCallId(originalParentCallId);
        logger.debug('[ASK_AGENT_TOOL] Restored agent parent call ID to', originalParentCallId);
        // Clear tracked pooled agent
        this.currentPooledAgent = null;
      }
    } catch (error) {
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
   */
  private buildTaskContext(metadata: AgentMetadata): string | null {
    try {
      const config = metadata.config;

      // Extract task context from agent config
      const taskPrompt = config.taskPrompt;
      const baseAgentPrompt = config.baseAgentPrompt;

      if (!taskPrompt) {
        return null;
      }

      // Determine agent type from base prompt
      let agentType = 'agent';
      if (baseAgentPrompt?.includes('codebase exploration')) {
        agentType = 'exploration agent';
      } else if (baseAgentPrompt?.includes('implementation planning')) {
        agentType = 'planning agent';
      }

      return `This agent is a ${agentType} created for: "${taskPrompt}"`;
    } catch (error) {
      logger.debug('[ASK_AGENT_TOOL] Error building task context:', error);
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
        logger.debug('[ASK_AGENT_TOOL] No assistant messages found in conversation');
        return null;
      }

      // Combine recent messages if multiple exist
      if (assistantMessages.length > 1) {
        const recentMessages = assistantMessages.slice(-3);
        const summary = recentMessages.join('\n\n');
        logger.debug('[ASK_AGENT_TOOL] Extracted summary from', recentMessages.length, 'messages, length:', summary.length);
        return `Agent response:\n\n${summary}`;
      }

      // Single assistant message
      const summary = assistantMessages[0];
      if (summary) {
        logger.debug('[ASK_AGENT_TOOL] Using single assistant message as summary, length:', summary.length);
        return summary;
      }

      return null;
    } catch (error) {
      logger.debug('[ASK_AGENT_TOOL] Error extracting summary:', error);
      return null;
    }
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
      lines.push(`Responded in ${result.duration_seconds}s`);
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
   * agent_ask is intentionally excluded from injectable tools in ToolManager.
   * When agent_ask is running, interjections route to main agent instead,
   * since agent_ask is just querying for information while the main
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
