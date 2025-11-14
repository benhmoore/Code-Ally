/**
 * SessionsTool - Analyze past conversation sessions
 *
 * Provides an agent-based tool for analyzing session history stored in .ally-sessions/.
 * The agent has read-only access to session files and can search, analyze, and synthesize
 * findings about past conversations.
 *
 * Key features:
 * - Agent-based exploration of session history
 * - Read-only access (Read, Grep, Glob tools)
 * - Operates in .ally-sessions/ directory
 * - Excludes current active session
 * - Returns synthesized findings about session history
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, ActivityEventType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { Agent, AgentConfig } from '../agent/Agent.js';
import { ModelClient } from '../llm/ModelClient.js';
import { logger } from '../services/Logger.js';
import { ToolManager } from './ToolManager.js';
import { formatError } from '../utils/errorUtils.js';
import { TEXT_LIMITS, FORMATTING } from '../config/constants.js';
import { AgentPoolService, PooledAgent } from '../services/AgentPoolService.js';
import { getThoroughnessDuration } from '../ui/utils/timeUtils.js';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { AgentData } from '../services/AgentManager.js';

// Read-only tools for session analysis
const SESSION_ANALYSIS_TOOLS = ['read', 'glob', 'grep'];

// System prompt for session analysis agent
const SESSION_ANALYSIS_PROMPT = `You are a specialized session analysis assistant. Your role is to analyze past conversation sessions to answer questions about conversation history, find relevant discussions, and provide insights.

**Your Environment:**
- You are operating in the .ally-sessions/ directory
- Each session is stored as a JSON file with structure:
  {
    "session_id": "session_...",
    "name": "session_...",
    "working_dir": "/path/to/project",
    "messages": [
      { "role": "user", "content": "..." },
      { "role": "assistant", "content": "..." }
    ],
    "metadata": { "title": "..." },
    "todos": [...],
    "created_at": "...",
    "updated_at": "..."
  }

**Your Capabilities:**
- Read session files (read) - view complete conversation history
- Search across sessions (grep) - find specific topics, keywords, or patterns
- Find session files (glob) - locate sessions by name pattern

**Your Approach:**
1. Use glob to find relevant session files (e.g., "session_*.json")
2. Use grep to search for keywords or topics across sessions
3. Use read to examine specific session contents in detail
4. Synthesize findings into clear, actionable answers

**Important Guidelines:**
- You have READ-ONLY access - you cannot modify sessions
- Focus on answering the user's specific question
- Provide session IDs and timestamps when referencing conversations
- Include relevant excerpts from conversations when helpful
- If no relevant sessions found, clearly state this
- Be thorough but efficient with tool usage

Analyze session history systematically and provide comprehensive results.`;

export class SessionsTool extends BaseTool {
  readonly name = 'sessions';
  readonly description =
    'Analyze past conversation sessions. Searches and analyzes session history stored in .ally-sessions/. Use when you need to find previous discussions, review past work, or understand conversation history.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = true; // Hide detailed output
  readonly persistAgent = true; // Keep agent alive in pool for follow-up questions
  // visibleInChat defaults to true from BaseTool

  private activeDelegations: Map<string, any> = new Map();
  private currentPooledAgent: PooledAgent | null = null;

  constructor(activityStream: ActivityStream) {
    super(activityStream);

    // Listen for global interrupt events
    this.activityStream.subscribe(ActivityEventType.INTERRUPT_ALL, () => {
      this.interruptAll();
    });
  }

  /**
   * Get agent metadata for registration with AgentManager
   */
  getAgentMetadata(): AgentData {
    return {
      name: 'sessions',
      description: 'Session analysis agent - sandboxed to .ally-sessions/ directory',
      system_prompt: SESSION_ANALYSIS_PROMPT, // Use the existing constant
      tools: ['read', 'glob', 'grep'], // Read-only tools, no agent delegation
      visible_from_agents: [], // Only main assistant can use (hidden from agents)
      can_delegate_to_agents: false, // Cannot delegate (sandboxed)
      can_see_agents: false, // Cannot see other agents (focused on sessions only)
    };
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
            task: {
              type: 'string',
              description: 'Question or task for analyzing session history. Be specific about what you want to find or understand.',
            },
          },
          required: ['task'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const task = args.task;

    // Validate task parameter
    if (!task || typeof task !== 'string') {
      return this.formatErrorResponse(
        'task parameter is required and must be a string',
        'validation_error',
        'Example: sessions(task="Find discussions about authentication")'
      );
    }

    // Execute session analysis - pass currentCallId to avoid race conditions
    const callId = this.currentCallId;
    if (!callId) {
      return this.formatErrorResponse(
        'Internal error: callId not set',
        'system_error'
      );
    }

    return await this.executeSessionAnalysis(task, callId);
  }

  /**
   * Execute session analysis with specialized agent
   *
   * @param task - The analysis task to execute
   * @param callId - Unique call identifier for tracking
   */
  private async executeSessionAnalysis(
    task: string,
    callId: string
  ): Promise<ToolResult> {
    logger.debug('[SESSIONS_TOOL] Starting session analysis, callId:', callId);
    const startTime = Date.now();

    try {
      // Get sessions directory path
      const sessionsDir = path.join(process.cwd(), '.ally-sessions');

      // Check if sessions directory exists
      try {
        await fs.access(sessionsDir);
      } catch {
        return this.formatErrorResponse(
          'No sessions directory found. Session history is not available.',
          'validation_error',
          'Sessions are stored in .ally-sessions/ within the project directory'
        );
      }

      // Get current session to exclude it
      const registry = ServiceRegistry.getInstance();
      const sessionManager = registry.get<any>('session_manager');
      const currentSessionId = sessionManager?.getCurrentSession();

      // Get required services
      const mainModelClient = registry.get<ModelClient>('model_client');
      const toolManager = registry.get<ToolManager>('tool_manager');
      const configManager = registry.get<any>('config_manager');
      const permissionManager = registry.get<any>('permission_manager');

      // Enforce strict service availability
      if (!mainModelClient) {
        throw new Error('SessionsTool requires model_client to be registered');
      }
      if (!toolManager) {
        throw new Error('SessionsTool requires tool_manager to be registered');
      }
      if (!configManager) {
        throw new Error('SessionsTool requires config_manager to be registered');
      }
      if (!permissionManager) {
        throw new Error('SessionsTool requires permission_manager to be registered');
      }

      const config = configManager.getConfig();
      if (!config) {
        throw new Error('ConfigManager.getConfig() returned null/undefined');
      }

      // Filter to read-only tools
      logger.debug('[SESSIONS_TOOL] Filtering to read-only tools:', SESSION_ANALYSIS_TOOLS);
      const allowedToolNames = new Set(SESSION_ANALYSIS_TOOLS);
      const allTools = toolManager.getAllTools();
      const filteredTools = allTools.filter(tool => allowedToolNames.has(tool.name));
      const filteredToolManager = new ToolManager(filteredTools, this.activityStream);
      logger.debug('[SESSIONS_TOOL] Filtered to', filteredTools.length, 'tools:', filteredTools.map(t => t.name).join(', '));

      // Create specialized system prompt
      const specializedPrompt = await this.createSessionAnalysisSystemPrompt(task, currentSessionId);

      // Emit session analysis start event
      this.emitEvent({
        id: callId,
        type: ActivityEventType.AGENT_START,
        timestamp: Date.now(),
        data: {
          agentName: 'sessions',
          taskPrompt: task,
        },
      });

      // Build exclude files list (current session if it exists)
      const excludeFiles: string[] = [];
      if (currentSessionId) {
        // Use path.resolve to ensure absolute path
        const currentSessionPath = path.resolve(sessionsDir, currentSessionId + '.json');
        excludeFiles.push(currentSessionPath);
        logger.debug('[SESSIONS_TOOL] Excluding current session from analysis:', currentSessionPath);
      }

      // Create agent configuration with focusDirectory set to sessions dir
      const agentConfig: AgentConfig = {
        isSpecializedAgent: true,
        verbose: false,
        systemPrompt: specializedPrompt,
        baseAgentPrompt: SESSION_ANALYSIS_PROMPT,
        taskPrompt: task,
        config: config,
        parentCallId: callId,
        maxDuration: getThoroughnessDuration('quick'), // 1 minute limit for session analysis
        focusDirectory: '.ally-sessions', // Restrict agent to sessions directory
        excludeFiles: excludeFiles, // Exclude current session
      };

      // Always use pooled agent for persistence
      let analysisAgent: Agent;
      let pooledAgent: PooledAgent | null = null;
      let agentId: string | null = null;

      // Use AgentPoolService for persistent agent
      const agentPoolService = registry.get<AgentPoolService>('agent_pool');

      if (!agentPoolService) {
        // Graceful fallback: AgentPoolService not available
        logger.warn('[SESSIONS_TOOL] AgentPoolService not available, falling back to ephemeral agent');
        analysisAgent = new Agent(
          mainModelClient,
          filteredToolManager,
          this.activityStream,
          agentConfig,
          configManager,
          permissionManager
        );
      } else {
        // Acquire agent from pool with filtered ToolManager
        logger.debug('[SESSIONS_TOOL] Acquiring agent from pool with filtered ToolManager');
        pooledAgent = await agentPoolService.acquire(agentConfig, filteredToolManager);
        analysisAgent = pooledAgent.agent;
        agentId = pooledAgent.agentId;
        this.currentPooledAgent = pooledAgent; // Track for interjection routing
        logger.debug('[SESSIONS_TOOL] Acquired pooled agent:', agentId);
      }

      // Track active delegation
      this.activeDelegations.set(callId, {
        agent: analysisAgent,
        task,
        startTime: Date.now(),
      });

      try {
        // Execute session analysis
        logger.debug('[SESSIONS_TOOL] Sending task to analysis agent...');
        const response = await analysisAgent.sendMessage(`Execute this session analysis task: ${task}`);
        logger.debug('[SESSIONS_TOOL] Analysis agent response received, length:', response?.length || 0);

        let finalResponse: string;

        // Ensure we have a substantial response
        if (!response || response.trim().length === 0) {
          logger.debug('[SESSIONS_TOOL] Empty response, extracting from conversation');
          finalResponse = this.extractSummaryFromConversation(analysisAgent) ||
            'Session analysis completed but no summary was provided.';
        } else if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
          logger.debug('[SESSIONS_TOOL] Incomplete response, attempting to extract summary');
          const summary = this.extractSummaryFromConversation(analysisAgent);
          finalResponse = (summary && summary.length > response.length) ? summary : response;
        } else {
          finalResponse = response;
        }

        const duration = (Date.now() - startTime) / 1000;

        // Emit session analysis end event
        this.emitEvent({
          id: callId,
          type: ActivityEventType.AGENT_END,
          timestamp: Date.now(),
          data: {
            agentName: 'sessions',
            result: finalResponse,
            duration,
          },
        });

        // Append note that user cannot see this
        const result = finalResponse + '\n\nIMPORTANT: The user CANNOT see this analysis. You must share relevant information, summarized or verbatim with the user in your own response, if appropriate.';

        // Build response with agent_id (always returned since agents always persist)
        const successResponse: Record<string, any> = {
          content: result,
          duration_seconds: Math.round(duration * Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES)) / Math.pow(10, FORMATTING.DURATION_DECIMAL_PLACES),
        };

        // Always include agent_id when available
        if (agentId) {
          successResponse.agent_id = agentId;
          successResponse.system_reminder = `Agent persists as ${agentId}. For related follow-ups, USE agent-ask(agent_id="${agentId}", message="...") - dramatically more efficient than starting fresh. Start new agents only for unrelated problems.`;
        }

        return this.formatSuccessResponse(successResponse);
      } finally {
        // Clean up delegation tracking
        logger.debug('[SESSIONS_TOOL] Cleaning up analysis agent...');
        this.activeDelegations.delete(callId);

        // Handle agent lifecycle based on persistAgent flag
        if (this.persistAgent && pooledAgent) {
          // Persist agent: restore focus only, then release to pool
          await analysisAgent.restoreFocus();
          logger.debug('[SESSIONS_TOOL] Releasing agent back to pool');
          pooledAgent.release();
          this.currentPooledAgent = null;
        } else {
          // Don't persist: full cleanup (restores focus + stops monitoring + closes resources)
          await analysisAgent.cleanup();
        }
      }
    } catch (error) {
      return this.formatErrorResponse(
        `Session analysis failed: ${formatError(error)}`,
        'execution_error'
      );
    }
  }

  /**
   * Create specialized system prompt for session analysis
   */
  private async createSessionAnalysisSystemPrompt(task: string, currentSessionId: string | null): Promise<string> {
    logger.debug('[SESSIONS_TOOL] Creating session analysis system prompt');
    try {
      const { getAgentSystemPrompt } = await import('../prompts/systemMessages.js');

      // Add context note about focus constraint
      let contextNote = '\n\n**Important:** You are sandboxed to the .ally-sessions/ directory. All file operations are automatically restricted to this directory.';

      // Note that current session is excluded (enforced at file system level)
      if (currentSessionId) {
        contextNote += '\n\n**Note:** The current active session is automatically excluded from your analysis - you only have access to historical sessions.';
      }

      const result = await getAgentSystemPrompt(SESSION_ANALYSIS_PROMPT + contextNote, task, undefined, undefined, undefined, 'sessions');
      logger.debug('[SESSIONS_TOOL] System prompt created, length:', result?.length || 0);
      return result;
    } catch (error) {
      logger.debug('[SESSIONS_TOOL] ERROR creating system prompt:', error);
      throw error;
    }
  }

  /**
   * Extract summary from analysis agent's conversation history
   */
  private extractSummaryFromConversation(agent: Agent): string | null {
    try {
      const messages = agent.getMessages();

      // Find all assistant messages
      const assistantMessages = messages
        .filter(msg => msg.role === 'assistant' && msg.content && msg.content.trim().length > 0)
        .map(msg => msg.content);

      if (assistantMessages.length === 0) {
        logger.debug('[SESSIONS_TOOL] No assistant messages found in conversation');
        return null;
      }

      // Combine recent messages if multiple exist
      if (assistantMessages.length > 1) {
        const recentMessages = assistantMessages.slice(-3);
        const summary = recentMessages.join('\n\n');
        logger.debug('[SESSIONS_TOOL] Extracted summary from', recentMessages.length, 'messages, length:', summary.length);
        return `Session analysis findings:\n\n${summary}`;
      }

      // Single assistant message
      const summary = assistantMessages[0];
      if (summary) {
        logger.debug('[SESSIONS_TOOL] Using single assistant message as summary, length:', summary.length);
        return summary;
      }

      return null;
    } catch (error) {
      logger.debug('[SESSIONS_TOOL] Error extracting summary:', error);
      return null;
    }
  }

  /**
   * Interrupt all active session analysis sessions
   */
  interruptAll(): void {
    logger.debug('[SESSIONS_TOOL] Interrupting', this.activeDelegations.size, 'active session analysis');
    for (const [callId, delegation] of this.activeDelegations.entries()) {
      const agent = delegation.agent;
      if (agent && typeof agent.interrupt === 'function') {
        logger.debug('[SESSIONS_TOOL] Interrupting session analysis:', callId);
        agent.interrupt();
      }
    }
  }

  /**
   * Inject user message into active pooled agent
   * Used for routing interjections to subagents
   */
  injectUserMessage(message: string): void {
    if (!this.currentPooledAgent) {
      logger.warn('[SESSIONS_TOOL] injectUserMessage called but no active pooled agent');
      return;
    }

    const agent = this.currentPooledAgent.agent;
    if (!agent) {
      logger.warn('[SESSIONS_TOOL] injectUserMessage called but pooled agent has no agent instance');
      return;
    }

    logger.debug('[SESSIONS_TOOL] Injecting user message into pooled agent:', this.currentPooledAgent.agentId);
    agent.addUserInterjection(message);
    agent.interrupt('interjection');
  }

  /**
   * Custom result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];

    // Show duration if available
    if (result.duration_seconds !== undefined) {
      lines.push(`Analyzed in ${result.duration_seconds}s`);
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
}
