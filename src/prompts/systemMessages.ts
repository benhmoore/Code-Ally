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
import { getProfileInstructionsFile } from '../config/paths.js';
import type { TokenManager } from '../agent/TokenManager.js';
import type { ToolResultManager } from '../services/ToolResultManager.js';
import { getThoroughnessGuidelines } from './thoroughnessAdjustments.js';
import { ContextFileLoader } from '../services/ContextFileLoader.js';
import type { Message } from '../types/index.js';

// --- Core Agent Identity and Directives ---

// Core identity for main Ally assistant
const ALLY_IDENTITY = `You are Ally, an AI coding assistant. Use tools to complete tasks efficiently.`;

// Behavioral directives that apply to all agents
const BEHAVIORAL_DIRECTIVES = `**After tool calls, provide a text response summarizing results. Never end with only tool calls.**

Core behavior:
- **Clarify before acting**: When you have questions—about scope, approach, technology choices, preferences, or ambiguous requirements—use the ask-user-question tool BEFORE exploring, planning, or implementing. Never assume. The tool provides structured choices that help users respond quickly. Use it proactively whenever you're uncertain.
- Use tools directly, never delegate to users
- Delegate exploration and multi-step work to agents to preserve context
- Be concise (1-3 sentences). NEVER use emoji - this is a professional development tool, not a chat app.
- Use markdown formatting in responses: *italic*, ~~strikethrough~~, **bold**. For emphasis, use color tags: <red>, <green>, <yellow>, <cyan>, <blue>, <orange>
- Avoid LaTeX formatting (e.g., $$, \frac{}, \LaTeX). Use plain text or markdown for mathematical expressions
- Use todo-write for multi-step tasks
- Retry with adjustments after failures
- Batch independent tools when efficient
- Test/lint after code changes
- Read system_reminder in tool results
- Trust specialized agent results
- ALWAYS provide the description parameter (5-10 words) for tool calls - it's shown in the UI to help users track your progress

User interjections: Respond directly to what they said, then continue work incorporating their guidance.`;

// Agent delegation guidelines for main assistant
const AGENT_DELEGATION_GUIDELINES = `CRITICAL - Context Preservation:
Your context budget is limited and precious. Agents work in isolated contexts, preserving yours for coordination. For exploration, analysis, or multi-step work, prefer agents over direct grep/read sequences. If you have a question and don't immediately know the answer or where to find it, use an agent.

CRITICAL - Agent Context Isolation:
Agents (explore, plan, agent) CANNOT see the current conversation. They ONLY receive the task_prompt parameter. You MUST include ALL necessary context in task_prompt - file paths, error messages, requirements, background information. Don't reference "the bug we discussed" or "the file mentioned earlier" - agents can't see that.

Tool selection:
- explore: Questions about unfamiliar code areas, unknown scope/location, multi-file patterns, architecture questions
- plan: Multi-step implementations (>3 steps), creates todos with dependencies
- agent: Complex tasks requiring expertise, independent work that can be reviewed afterward
- research: Current information from the web, fact verification, external documentation, news/updates
- Direct tools: ONLY for known file paths or exact search terms

Usage patterns:
- Codebase questions → explore first
- Implementations → explore → plan → implement, OR agent → validator for independent work
- Bug investigation → explore → diagnose → fix
- Known targets → read directly
- Independent parallel investigations → consider batching
- External/current info needed → research (news, docs updates, version info, API specs, fact-checking)

Follow-up questions (IMPORTANT):
- Related questions → agent-ask (agent has built context, much more efficient)
- Unrelated problems → new agent (fresh context needed)
- When uncertain → agent-ask first (agent can clarify if different context needed)

Examples needing explore:
"Where are errors handled?" / "How does auth work?" / "Find all user roles" / "What's the codebase structure?" / "Trace all X implementations" / "Show me how Y feature works" / "Where is Z used?"

Examples needing research:
"What's the latest React version?" / "How does the OpenAI API handle rate limits?" / "What are best practices for X?" / "Is library Y still maintained?" / "What changed in Node 22?" / "Find documentation for Z API"
NOT for research: Anything in the codebase, historical conversation context, or offline data.

Planning: Multi-step features/refactors. Skip quick fixes.
Agents: Auto-persist. Reusable via agent-ask.`;

// Additional guidelines that apply to all agents
const GENERAL_GUIDELINES = `Code: Check existing patterns before creating new code. Write clean, artful code that integrates naturally—never tacked on, never over-engineered.
Files: Read before editing. Use batch edits (edits array) for edit and line-edit tools - provide all edits in a single array, edits are applied atomically and prevent line shifting issues. Ephemeral reads only for large files.
Background processes: ALWAYS use bash(run_in_background=true) for dev servers, file watchers, or any long-running process. Examples: npm run dev, python -m http.server, npm start, vite, webpack serve. Monitor with bash-output, kill with kill-shell.
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
  callingAgentName?: string;
} = {}): Promise<string> {
  const { includeAgents = true, includeProjectInstructions = true, tokenManager, toolResultManager, reasoningEffort, callingAgentName } = options;

  const currentDate = new Date().toISOString().replace('T', ' ').slice(0, TEXT_LIMITS.ISO_DATETIME_LENGTH);
  const workingDir = process.cwd();
  const osInfo = `${os.platform()} ${os.release()}`;
  const nodeVersion = process.version;
  const gitBranch = getGitBranch();

  // Check for profile instructions file and include its contents
  let profileInstructionsContent = '';
  if (includeProjectInstructions) {
    try {
      const profileInstructionsPath = getProfileInstructionsFile();
      if (fs.existsSync(profileInstructionsPath)) {
        const profileContent = fs.readFileSync(profileInstructionsPath, 'utf-8').trim();
        if (profileContent) {
          profileInstructionsContent = `
- Profile Instructions:
${profileContent}`;
        }
      }
    } catch (error) {
      logger.warn('Failed to read profile instructions:', formatError(error));
    }
  }

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
          const agentsSection = await agentManager.getAgentsForSystemPrompt(callingAgentName);

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

  // Get available skills information
  let skillsInfo = '';
  try {
    const serviceRegistry = ServiceRegistry.getInstance();
    const skillManager = serviceRegistry.getSkillManager();

    if (skillManager) {
      // Check context usage - only include skills if under 80%
      let contextPct = 0;
      if (tokenManager && typeof tokenManager.getContextUsagePercentage === 'function') {
        contextPct = tokenManager.getContextUsagePercentage();
      }

      if (contextPct < 80) {
        const skillsSection = skillManager.getSkillsForSystemPrompt();
        if (skillsSection) {
          skillsInfo = `
${skillsSection}`;
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to load skills for system prompt:', formatError(error));
  }

  // Get context usage info with warnings
  const contextUsage = getContextUsageInfo(tokenManager, toolResultManager);
  const contextUsageSection = contextUsage ? `\n${contextUsage}` : '';

  // Build git info section
  const gitInfo = gitBranch ? ` (git repository, branch: ${gitBranch})` : '';

  // Get additional directories
  let additionalDirsInfo = '';
  try {
    const serviceRegistry = ServiceRegistry.getInstance();
    if (serviceRegistry && serviceRegistry.hasService('additional_dirs_manager')) {
      const additionalDirsManager = serviceRegistry.get<any>('additional_dirs_manager');
      if (additionalDirsManager) {
        const dirs = additionalDirsManager.getDisplayPaths();
        if (dirs && dirs.length > 0) {
          additionalDirsInfo = `\n- Additional Directories:\n${dirs.map((d: string) => `  - ${d}`).join('\n')}`;
        }
      }
    }
  } catch (error) {
    logger.warn('Failed to load additional directories for system prompt:', formatError(error));
  }

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

  // Load context files from most recent compaction summary (if any)
  let contextFilesSection = '';
  if (tokenManager) {
    try {
      const serviceRegistry = ServiceRegistry.getInstance();
      if (serviceRegistry && serviceRegistry.hasService('conversation_manager')) {
        const conversationManager = serviceRegistry.get<any>('conversation_manager');
        if (conversationManager && typeof conversationManager.getMessages === 'function') {
          const messages: Message[] = conversationManager.getMessages();
          // Find the most recent summary message with context file references
          const summaryMsg = [...messages]
            .reverse()
            .find(m => m.metadata?.isConversationSummary && m.metadata?.contextFileReferences?.length);

          if (summaryMsg) {
            const loader = new ContextFileLoader(tokenManager);
            const filesContent = await loader.loadFromSummary(summaryMsg);
            if (filesContent) {
              contextFilesSection = `\n${filesContent}`;
            }
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to load context files from compaction summary:', formatError(error));
    }
  }

  return `
- Current Date: ${currentDate}
- Working Directory: ${workingDir}${gitInfo}${additionalDirsInfo}
- Operating System: ${osInfo}
- Node Version: ${nodeVersion}${reasoningInfo}${projectInfo}${contextUsageSection}${profileInstructionsContent}${allyMdContent}${agentsInfo}${skillsInfo}${contextFilesSection}`;
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
 * @param agentSystemPrompt - The base system prompt for the agent
 * @param taskPrompt - The task to execute
 * @param tokenManager - Token manager for context tracking
 * @param toolResultManager - Tool result manager for estimating remaining calls
 * @param reasoningEffort - Reasoning effort level
 * @param callingAgentName - Name of the agent calling this function (for filtering available agents)
 * @param thoroughness - Optional thoroughness level for dynamic regeneration: 'quick', 'medium', 'very thorough', 'uncapped'
 * @param agentType - Optional agent type identifier (e.g., 'explore', 'plan') for thoroughness adjustments
 */
export async function getAgentSystemPrompt(agentSystemPrompt: string, taskPrompt: string, tokenManager?: TokenManager, toolResultManager?: ToolResultManager, reasoningEffort?: string, callingAgentName?: string, thoroughness?: string, agentType?: string): Promise<string> {
  // Get context with agent information filtered by calling agent name
  const context = await getContextInfo({
    includeAgents: true,
    includeProjectInstructions: false,
    tokenManager,
    toolResultManager,
    reasoningEffort,
    callingAgentName,
  });

  // Get context budget reminder (only shown at 75%+)
  const contextBudgetReminder = getContextBudgetReminder(tokenManager);

  // Build the base prompt with behavioral directives and general guidelines
  let promptWithDirectives = `**Primary Identity:**
${agentSystemPrompt}

${BEHAVIORAL_DIRECTIVES}

${GENERAL_GUIDELINES}`;

  // Apply thoroughness-specific adjustments if available
  // Thoroughness adjustments are inserted between base prompt and final execution guidelines
  let thoroughnessSection = '';
  if (thoroughness && agentType) {
    const thoroughnessGuidelines = getThoroughnessGuidelines(agentType, thoroughness);
    if (thoroughnessGuidelines) {
      thoroughnessSection = `\n\n${thoroughnessGuidelines}`;
    }
  }

  return `${promptWithDirectives}${thoroughnessSection}

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
