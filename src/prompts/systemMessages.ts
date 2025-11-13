/**
 * System messages for the Code Ally agent.
 *
 * This module centralizes system messages, including the core operational prompt
 * and functions for dynamically providing tool-specific guidance.
 *
 * Ported from Python CodeAlly implementation.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { formatError } from '../utils/errorUtils.js';
import { CONTEXT_THRESHOLDS } from '../config/toolDefaults.js';
import { logger } from '../services/Logger.js';
import { getGitBranch } from '../utils/gitUtils.js';
import { TEXT_LIMITS } from '../config/constants.js';
import type { TokenManager } from '../agent/TokenManager.js';
import type { ToolResultManager } from '../services/ToolResultManager.js';

// --- Core Agent Identity and Directives ---

// Core identity for main Ally assistant
const ALLY_IDENTITY = `You are Ally, an AI coding assistant. Use tools to complete tasks efficiently.`;

// Behavioral directives that apply to all agents
const BEHAVIORAL_DIRECTIVES = `**After tool calls, provide a text response summarizing results. Never end with only tool calls.**

Core behavior:
- Use tools directly, never delegate to users
- Be concise (1-3 sentences). No emoji.
- Use markdown formatting in responses: *italic*, ~~strikethrough~~, **bold**. For emphasis, use color tags: <red>, <green>, <yellow>, <cyan>, <blue>, <orange>
- Use todos for multi-step tasks
- Retry with adjustments after failures
- Batch independent tools when efficient
- Test/lint after code changes
- Read system_reminder in tool results
- Trust specialized agent results

User interjections: Respond directly to what they said, then continue work incorporating their guidance.`;

// Agent delegation guidelines for main assistant
const AGENT_DELEGATION_GUIDELINES = `CRITICAL - Context Preservation:
When exploring codebases or answering questions that aren't needle queries for specific files/classes/functions, you MUST use explore() instead of grep/read directly. Multi-step grep/read rapidly consumes your context, reducing remaining tool calls and forcing premature restart.

Tool selection:
- explore: Unknown scope/location, multi-file patterns, architecture questions
- plan: Multi-step implementations (>3 steps), creates todos with dependencies
- agent: Complex tasks requiring expertise
- Direct tools: ONLY for known file paths or exact search terms

Usage patterns:
- Codebase questions → explore first
- Implementations → explore → plan → implement
- Bug investigation → explore → diagnose → fix
- Known targets → read directly
- Independent parallel investigations → consider batching

Follow-up questions (IMPORTANT):
- Related questions → agent_ask (agent has built context, much more efficient)
- Unrelated problems → new agent (fresh context needed)
- When uncertain → agent_ask first (agent can clarify if different context needed)

Examples needing explore:
"Where are errors handled?" / "How does auth work?" / "Find all user roles" / "What's the codebase structure?" / "Trace all X implementations"

Planning: Multi-step features/refactors. Skip quick fixes.
Agents: Auto-persist. Reusable via agent_ask.`;

// Additional guidelines that apply to all agents
const GENERAL_GUIDELINES = `Code: Check existing patterns before creating new code.
Files: Use incremental edits (edit, line_edit). Ephemeral reads only for large files.
Prohibited: No commits without request. No unsolicited explanations.`;

// Complete directives for main Ally assistant
const CORE_DIRECTIVES = `${ALLY_IDENTITY}

${BEHAVIORAL_DIRECTIVES}

${AGENT_DELEGATION_GUIDELINES}

${GENERAL_GUIDELINES}`;

/**
 * Get context usage information with warnings
 */
function getContextUsageInfo(tokenManager?: TokenManager, toolResultManager?: ToolResultManager): string {
  try {
    // Use provided instances or fall back to ServiceRegistry
    let tm = tokenManager;
    let trm = toolResultManager;

    if (!tm || !trm) {
      const serviceRegistry = ServiceRegistry.getInstance();
      if (!serviceRegistry) return '';

      // Note: Using ServiceRegistry.get<any>() is intentional to avoid circular dependencies.
      // Services are optional/lazy-loaded and duck-typed at runtime via method checks below.
      if (!tm) tm = serviceRegistry.get<any>('token_manager');
      if (!trm) trm = serviceRegistry.get<any>('tool_result_manager');
    }

    if (!tm || typeof tm.getContextUsagePercentage !== 'function') {
      return '';
    }

    const contextPct = tm.getContextUsagePercentage();
    const remainingTokens = tm.getRemainingTokens ? tm.getRemainingTokens() : 0;
    let remainingCalls = 0;

    if (trm && typeof trm.estimateRemainingToolCalls === 'function') {
      remainingCalls = trm.estimateRemainingToolCalls();
    }

    // Format remaining tokens in a human-readable way (KB)
    const remainingKB = Math.round(remainingTokens / 250); // ~250 tokens per KB of text

    let contextLine = `- Context Usage: ${contextPct}% (~${remainingCalls} tool calls, ${remainingKB}KB remaining)`;

    // Add graduated warnings based on usage level
    if (contextPct >= CONTEXT_THRESHOLDS.CRITICAL) {
      contextLine += `\n  🚨 CRITICAL: ${CONTEXT_THRESHOLDS.WARNINGS[95]}`;
    } else if (contextPct >= CONTEXT_THRESHOLDS.WARNING) {
      contextLine += `\n  ⚠️ ${CONTEXT_THRESHOLDS.WARNINGS[85]}`;
    } else if (contextPct >= CONTEXT_THRESHOLDS.NORMAL) {
      contextLine += `\n  💡 ${CONTEXT_THRESHOLDS.WARNINGS[70]}`;
    }

    return contextLine;
  } catch (error) {
    // Context usage determination failed - continue without warning
    logger.warn('Failed to determine context usage:', formatError(error));
    return '';
  }
}

/**
 * Get context budget reminder for system prompt
 * Returns a warning message to inject into the system prompt at 75% and 90% usage
 */
function getContextBudgetReminder(tokenManager?: TokenManager): string {
  try {
    // Use provided instance or fall back to ServiceRegistry
    let tm = tokenManager;

    if (!tm) {
      const serviceRegistry = ServiceRegistry.getInstance();
      if (!serviceRegistry) return '';
      tm = serviceRegistry.get<any>('token_manager');
    }

    if (!tm || typeof tm.getContextUsagePercentage !== 'function') {
      return '';
    }

    const contextPct = tm.getContextUsagePercentage();

    // Don't add reminders below 75% (not overzealous)
    if (contextPct < CONTEXT_THRESHOLDS.MODERATE_REMINDER) {
      return '';
    }

    // Strong warning at 90%
    if (contextPct >= CONTEXT_THRESHOLDS.STRONG_REMINDER) {
      return `\n\n**CONTEXT BUDGET WARNING:**\n${CONTEXT_THRESHOLDS.SYSTEM_REMINDERS[90]}`;
    }

    // Moderate reminder at 75%
    if (contextPct >= CONTEXT_THRESHOLDS.MODERATE_REMINDER) {
      return `\n\n**Context Budget Notice:**\n${CONTEXT_THRESHOLDS.SYSTEM_REMINDERS[75]}`;
    }

    return '';
  } catch (error) {
    logger.warn('Failed to get context budget reminder:', formatError(error));
    return '';
  }
}

/**
 * Get context information for system prompts
 */
export async function getContextInfo(options: {
  includeAgents?: boolean;
  includeProjectInstructions?: boolean;
  tokenManager?: TokenManager;
  toolResultManager?: ToolResultManager;
  reasoningEffort?: string;
} = {}): Promise<string> {
  const { includeAgents = true, includeProjectInstructions = true, tokenManager, toolResultManager, reasoningEffort } = options;

  const currentDate = new Date().toISOString().replace('T', ' ').slice(0, TEXT_LIMITS.ISO_DATETIME_LENGTH);
  const workingDir = process.cwd();
  const osInfo = `${os.platform()} ${os.release()}`;
  const nodeVersion = process.version;
  const gitBranch = getGitBranch();

  // Check for ALLY.md file and include its contents
  let allyMdContent = '';
  if (includeProjectInstructions) {
    try {
      const allyMdPath = path.join(workingDir, 'ALLY.md');
      if (fs.existsSync(allyMdPath)) {
        const allyContent = fs.readFileSync(allyMdPath, 'utf-8').trim();
        if (allyContent) {
          allyMdContent = `
- Project Instructions (ALLY.md):
${allyContent}`;
        }
      }
    } catch (error) {
      logger.warn('Failed to read ALLY.md:', formatError(error));
    }
  }

  // Get available agents information
  let agentsInfo = '';
  if (includeAgents) {
    try {
      const serviceRegistry = ServiceRegistry.getInstance();

      if (serviceRegistry && serviceRegistry.hasService('agent_manager')) {
        const agentManager = serviceRegistry.get<any>('agent_manager');
        if (agentManager && typeof agentManager.getAgentsForSystemPrompt === 'function') {
          const agentsSection = await agentManager.getAgentsForSystemPrompt();

          if (agentsSection && !agentsSection.includes('No specialized agents available')) {
            agentsInfo = `
${agentsSection}`;
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to load agents for system prompt:', formatError(error));
    }
  }

  // Get context usage info with warnings
  const contextUsage = getContextUsageInfo(tokenManager, toolResultManager);
  const contextUsageSection = contextUsage ? `\n${contextUsage}` : '';

  // Build git info section
  const gitInfo = gitBranch ? ` (git repository, branch: ${gitBranch})` : '';

  // Build reasoning effort info
  const reasoningInfo = reasoningEffort ? `\n- Reasoning: ${reasoningEffort}` : '';

  // Get project context
  let projectInfo = '';
  try {
    const serviceRegistry = ServiceRegistry.getInstance();
    if (serviceRegistry && serviceRegistry.hasService('project_context_detector')) {
      const detector = serviceRegistry.get<any>('project_context_detector');
      const context = detector?.getCached();

      if (context) {
        const parts: string[] = [];

        if (context.projectType) parts.push(context.projectType);
        if (context.languages?.length) parts.push(context.languages.join(', '));
        if (context.frameworks?.length) parts.push(context.frameworks.join(', '));
        if (context.packageManager) parts.push(context.packageManager);
        if (context.hasDocker) parts.push('Docker');
        if (context.cicd?.length) parts.push(context.cicd.join(', '));

        if (parts.length > 0) {
          projectInfo = `\n- Project: ${parts.join(' • ')}`;
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to load project context for system prompt:', formatError(error));
  }

  return `
- Current Date: ${currentDate}
- Working Directory: ${workingDir}${gitInfo}
- Operating System: ${osInfo}
- Node Version: ${nodeVersion}${reasoningInfo}${projectInfo}${contextUsageSection}${allyMdContent}${agentsInfo}`;
}

/**
 * Generate the main system prompt dynamically
 */
export async function getMainSystemPrompt(tokenManager?: TokenManager, toolResultManager?: ToolResultManager, isOnceMode: boolean = false, reasoningEffort?: string): Promise<string> {
  // Tool definitions are provided separately by the LLM client as function definitions
  const context = await getContextInfo({ includeAgents: true, tokenManager, toolResultManager, reasoningEffort });

  // Get todo context
  let todoContext = '';
  try {
    const serviceRegistry = ServiceRegistry.getInstance();

    if (serviceRegistry && serviceRegistry.hasService('todo_manager')) {
      const todoManager = serviceRegistry.get<any>('todo_manager');
      if (todoManager && typeof todoManager.generateActiveContext === 'function') {
        const todoStatus = todoManager.generateActiveContext();

        if (todoStatus) {
          todoContext = `\n${todoStatus}`;
        }

        // Log todos once per turn (when system prompt is regenerated)
        if (typeof todoManager.logTodosIfChanged === 'function') {
          todoManager.logTodosIfChanged();
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to load todos for system prompt:', formatError(error));
  }

  // Get tool usage guidance
  let toolGuidanceContext = '';
  try {
    const serviceRegistry = ServiceRegistry.getInstance();

    if (serviceRegistry && serviceRegistry.hasService('tool_manager')) {
      const toolManager = serviceRegistry.get<any>('tool_manager');
      if (toolManager && typeof toolManager.getToolUsageGuidance === 'function') {
        const guidances = toolManager.getToolUsageGuidance();

        if (guidances && guidances.length > 0) {
          toolGuidanceContext = `

## Tool Usage Guidance

${guidances.join('\n\n')}`;
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to load tool guidance for system prompt:', formatError(error));
  }

  // Get agent usage guidance
  let agentGuidanceContext = '';
  try {
    const serviceRegistry = ServiceRegistry.getInstance();

    if (serviceRegistry && serviceRegistry.hasService('agent_manager')) {
      const agentManager = serviceRegistry.get<any>('agent_manager');
      if (agentManager && typeof agentManager.getAgentUsageGuidance === 'function') {
        const guidances = await agentManager.getAgentUsageGuidance();

        if (guidances && guidances.length > 0) {
          agentGuidanceContext = `

## Agent Usage Guidance

${guidances.join('\n\n')}`;
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to load agent guidance for system prompt:', formatError(error));
  }

  // Add once-mode specific instructions
  const onceModeInstructions = isOnceMode
    ? `

**IMPORTANT - Single Response Mode:**
This is a non-interactive, single-turn conversation. Your response will be final and the conversation will end immediately after you respond. There is no opportunity for follow-up questions or clarification. Make your response complete, clear, and self-contained.`
    : '';

  // Get context budget reminder (only shown at 75%+)
  const contextBudgetReminder = getContextBudgetReminder(tokenManager);

  // Combine core directives with context
  return `${CORE_DIRECTIVES}${onceModeInstructions}${toolGuidanceContext}${agentGuidanceContext}${contextBudgetReminder}

**Context:**
${context}${todoContext}`;
}

/**
 * Generate a system prompt for specialized agents
 */
export async function getAgentSystemPrompt(agentSystemPrompt: string, taskPrompt: string, tokenManager?: TokenManager, toolResultManager?: ToolResultManager, reasoningEffort?: string): Promise<string> {
  // Get context without agent information and project instructions to avoid recursion
  const context = await getContextInfo({
    includeAgents: false,
    includeProjectInstructions: false,
    tokenManager,
    toolResultManager,
    reasoningEffort,
  });

  // Get context budget reminder (only shown at 75%+)
  const contextBudgetReminder = getContextBudgetReminder(tokenManager);

  return `**Primary Identity:**
${agentSystemPrompt}

${BEHAVIORAL_DIRECTIVES}

${GENERAL_GUIDELINES}

**Current Task:**
${taskPrompt}

**Context:**
${context}${contextBudgetReminder}

**Final Response Requirement**
As a specialized agent, you must conclude with a comprehensive final response. Your final message will be returned as the tool result to the parent agent.

- Monitor your context usage (shown above)
- At 90%+ context, stop using tools and provide your final summary
- Your final response should summarize: what you did, what you found, and any recommendations
- If you run low on context, summarize what you've learned so far rather than making more tool calls

Execute this task thoroughly using available tools, then provide your comprehensive final summary.`;
}

// Dictionary of specific system messages
export const SYSTEM_MESSAGES = {
  compaction_notice: 'Context compacted to save space.',
  git_commit_template: `( o)> Generated with Code Ally`,
};

/**
 * Retrieve a specific system message by its key
 */
export async function getSystemMessage(key: string): Promise<string> {
  if (key === 'main_prompt') {
    return await getMainSystemPrompt();
  }
  return SYSTEM_MESSAGES[key as keyof typeof SYSTEM_MESSAGES] || '';
}
