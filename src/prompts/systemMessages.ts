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
import { getProfileInstructionsFile, resolveProjectInstructionFiles } from '../config/paths.js';
import type { TokenManager } from '../agent/TokenManager.js';
import type { ToolResultManager } from '../services/ToolResultManager.js';
import { getThoroughnessGuidelines } from './thoroughnessAdjustments.js';
import type { Message } from '../types/index.js';
import { getDefaultTimeZone } from '../services/ScheduledTaskManager.js';

// --- Core Agent Identity and Directives ---

// Core identity for main Ally assistant
const ALLY_IDENTITY = `You are Ally, an AI coding assistant. Use tools to complete tasks efficiently.`;

// Cache-stable rules shared by every main-agent request. Tool-specific details
// belong in tool schemas/guidance so this prefix stays short and unambiguous.
const BEHAVIORAL_DIRECTIVES = `Operational rules:
- Complete exactly the requested task with the fewest correct operations. Avoid unrelated features, refactors, and files.
- Make reasonable reversible assumptions. Ask only when ambiguity materially changes the result or authorizes a consequential action.
- Read files before editing. Follow existing patterns and test or lint relevant changes.
- Use available tools yourself. Emit separate native tool calls together for independent operations.
- Read and act on system_reminder fields. After failures, adjust using the error; never repeat an identical invalid call.
- For 3+ distinct steps, maintain todo-write with exactly one item in_progress.
- After tool work, report what changed, verification, and caveats. Stop when the requested outcome is verified.
- Respond to user interjections, then continue with their guidance.`;

const GENERAL_GUIDELINES = `Files: Put related edit or line-edit changes in one atomic edits array. Use ephemeral reads only for large one-time content.
Processes: Run servers, watchers, and other long-lived commands in background; monitor or stop them with the process tools.
Do not commit unless requested.`;

// Complete directives for main Ally assistant
const CORE_DIRECTIVES = `${ALLY_IDENTITY}

${BEHAVIORAL_DIRECTIVES}

${GENERAL_GUIDELINES}`;

/**
 * Get the cache-stable context for the system prompt (msg[0]).
 *
 * This deliberately excludes anything that changes per round-trip — the current
 * date and live context-usage percentage live in {@link getDynamicContextBlock},
 * a trailing ephemeral message. Keeping msg[0] byte-stable across round-trips is
 * what lets the backend reuse the KV cache for the entire system prefix and the
 * conversation that follows it. The only content here that can shift mid-session
 * (memory index, skills/agents rosters, gated by context %) changes rarely, so a
 * one-time cache break on those events is an acceptable trade for a much smaller
 * per-round-trip recompute.
 */
export async function getContextInfo(options: {
  includeAgents?: boolean;
  includeProjectInstructions?: boolean;
  tokenManager?: TokenManager;
  toolResultManager?: ToolResultManager;
  reasoningEffort?: string;
  callingAgentName?: string;
  conversationMessages?: readonly Message[];
} = {}): Promise<string> {
  // toolResultManager is accepted for caller compatibility but no longer read
  // here — live tool-call estimates moved to getDynamicContextBlock.
  const { includeAgents = true, includeProjectInstructions = true, tokenManager, reasoningEffort, callingAgentName } = options;

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

  // Check for a project instructions file and include its contents. We honor a
  // precedence hierarchy (ALLY.md > CLAUDE.md > AGENTS.md) and ingest only the
  // first one present, so a project can supply guidance under whichever name it
  // already uses without instructions being duplicated across files.
  let allyMdContent = '';
  if (includeProjectInstructions) {
    try {
      const instructionFiles = resolveProjectInstructionFiles(workingDir);
      const sections = instructionFiles.map((instructionPath) => {
        const projectContent = fs.readFileSync(instructionPath, 'utf-8').trim();
        const relativePath = path.relative(workingDir, instructionPath) || path.basename(instructionPath);
        return projectContent ? `### ${relativePath}\n${projectContent}` : '';
      }).filter(Boolean);
      if (sections.length > 0) allyMdContent = `\n- Project Instructions (root to leaf):\n${sections.join('\n\n')}`;
    } catch (error) {
      logger.warn('Failed to read project instructions:', formatError(error));
    }
  }

  // Include the project memory index (agent-managed counterpart to ALLY.md).
  // Only the compact index is injected; full entries are pulled on demand via
  // the memory tool. Gated under 80% context, like skills, to protect budget.
  let memoryIndexContent = '';
  if (includeProjectInstructions) {
    try {
      const serviceRegistry = ServiceRegistry.getInstance();
      const memoryService = serviceRegistry.get('memory_service');
      if (memoryService && typeof memoryService.getPromptContext === 'function') {
        const contextPct = tokenManager && typeof tokenManager.getContextUsagePercentage === 'function'
          ? tokenManager.getContextUsagePercentage()
          : 0;
        if (contextPct < CONTEXT_THRESHOLDS.INJECTION_CEILING) {
          const memoryContext = await memoryService.getPromptContext();
          if (memoryContext) {
            memoryIndexContent = `
- Project Memory (index — recall full entries with the memory tool):
${memoryContext.text}`;
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to load project memory for system prompt:', formatError(error));
    }
  }

  // Get available agents information
  let agentsInfo = '';
  if (includeAgents) {
    try {
      const serviceRegistry = ServiceRegistry.getInstance();

      if (serviceRegistry && serviceRegistry.hasService('agent_manager')) {
        const agentManager = serviceRegistry.get('agent_manager');
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
      // Check context usage - only include skills under the injection ceiling
      let contextPct = 0;
      if (tokenManager && typeof tokenManager.getContextUsagePercentage === 'function') {
        contextPct = tokenManager.getContextUsagePercentage();
      }

      if (contextPct < CONTEXT_THRESHOLDS.INJECTION_CEILING) {
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

  // Build git info section
  const gitInfo = gitBranch ? ` (git repository, branch: ${gitBranch})` : '';

  // Get additional directories
  let additionalDirsInfo = '';
  try {
    const serviceRegistry = ServiceRegistry.getInstance();
    if (serviceRegistry && serviceRegistry.hasService('additional_dirs_manager')) {
      const additionalDirsManager = serviceRegistry.get('additional_dirs_manager');
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
      const detector = serviceRegistry.get('project_context_detector');
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
- Working Directory: ${workingDir}${gitInfo}${additionalDirsInfo}
- Operating System: ${osInfo}
- Node Version: ${nodeVersion}${reasoningInfo}${projectInfo}${profileInstructionsContent}${allyMdContent}${memoryIndexContent}${agentsInfo}${skillsInfo}`;
}

/**
 * Build the volatile context block: the per-round-trip state (date, live context
 * usage, todos, plan-mode banner, budget warnings) that must NOT live in the
 * cached system prefix. Agent.getLLMResponse appends the returned string as a
 * trailing ephemeral system-reminder right before each send and strips it after
 * the response — so the model always sees current state at the end of the prompt
 * while the stable prefix (msg[0] + conversation) stays KV-cacheable.
 *
 * @param includeTodos - main agent only; sub-agents don't drive the todo list
 * @param includePlanMode - main agent only; plan mode is a root-level concept
 * @returns the block string, or '' when there is nothing volatile to report
 */
export async function getDynamicContextBlock(options: {
  tokenManager?: TokenManager;
  toolResultManager?: ToolResultManager;
  includeTodos?: boolean;
  includePlanMode?: boolean;
} = {}): Promise<string> {
  const { includeTodos = false, includePlanMode = false } = options;

  const now = new Date();
  const localTimeZone = getDefaultTimeZone();
  const currentLocalTime = new Intl.DateTimeFormat('en-US', {
    timeZone: localTimeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(now);
  const currentUtcTime = now.toISOString().replace('T', ' ').slice(0, TEXT_LIMITS.ISO_DATETIME_LENGTH);

  // Todo state (main agent only) — surfaced every round-trip so the model keeps
  // the plan in view, not just on the turn that the turn-start reminder fires.
  let todoContext = '';
  if (includeTodos) {
    try {
      const serviceRegistry = ServiceRegistry.getInstance();
      if (serviceRegistry && serviceRegistry.hasService('todo_manager')) {
        const todoManager = serviceRegistry.get('todo_manager');
        if (todoManager && typeof todoManager.generateActiveContext === 'function') {
          const todoStatus = todoManager.generateActiveContext();
          if (todoStatus) {
            todoContext = `\n${todoStatus}`;
          }
          if (typeof todoManager.logTodosIfChanged === 'function') {
            todoManager.logTodosIfChanged();
          }
        }
      }
    } catch (error) {
      logger.warn('Failed to load todos for dynamic context:', formatError(error));
    }
  }

  // Plan-mode banner (main agent only)
  let planModeSection = '';
  if (includePlanMode) {
    try {
      const serviceRegistry = ServiceRegistry.getInstance();
      if (serviceRegistry && serviceRegistry.hasService('plan_mode_manager')) {
        const planModeManager = serviceRegistry.get('plan_mode_manager');
        if (planModeManager?.isActive()) {
          planModeSection = `

**PLAN MODE ACTIVE**
You are in read-only plan mode. Only exploratory tools and write-plan are available.
- Explore the codebase to understand patterns and architecture
- Ask clarifying questions with ask-user-question
- Write your plan with write-plan when ready
- Call exit-plan-mode to present the plan for user approval
You CANNOT write, edit, or delete project files in this mode.`;
        }
      }
    } catch (error) {
      logger.warn('Failed to check plan mode state:', formatError(error));
    }
  }

  const body = `- Current Local Time: ${currentLocalTime}
- Current Time Zone: ${localTimeZone}
- Current UTC Time: ${currentUtcTime}Z${todoContext}${planModeSection}`;
  if (!body.trim()) {
    return '';
  }
  return `**Current Context:**
${body}`;
}

/**
 * Generate the main system prompt (the cache-stable msg[0]).
 *
 * Returns ONLY content that is stable across round-trips within a session:
 * the core directives, tool/agent usage guidance, and the cache-stable context
 * (environment, project instructions, memory index, rosters). Per-round-trip
 * volatile state — date, live context usage, todos, plan-mode banner, budget
 * warnings — is produced separately by {@link getDynamicContextBlock} and
 * appended as a trailing ephemeral message, so this prefix can be KV-cached.
 */
export async function getMainSystemPrompt(
  tokenManager?: TokenManager,
  toolResultManager?: ToolResultManager,
  isOnceMode: boolean = false,
  reasoningEffort?: string,
  conversationMessages?: readonly Message[],
  isScheduledRun: boolean = false,
  scheduledTaskId?: string,
): Promise<string> {
  // Tool definitions are provided separately by the LLM client as function definitions
  const context = await getContextInfo({ includeAgents: true, tokenManager, toolResultManager, reasoningEffort, conversationMessages });

  // Add once-mode specific instructions
  const onceModeInstructions = isOnceMode
    ? `

**IMPORTANT - Single Response Mode:**
This is a non-interactive automatic run. No user is available for questions, forms, approvals, or permission elevation. A policy denial is a recoverable tool result: choose a safe alternative and continue. Ordinary assistant prose is progress, not completion. After all required work, background dependencies, todos, and verification are finished, call \`complete-objective\` with concise evidence. If and only if no safe automatic path remains, call \`block-objective\` with the concrete blocker.`
    : '';

  const scheduledRunInstructions = isScheduledRun
    ? `

**IMPORTANT - Scheduled Task Run:**
This is an unattended scheduled task execution${scheduledTaskId ? ` for \`${scheduledTaskId}\`` : ''}. Execute the scheduled prompt automatically. Do not ask follow-up questions or request any other human input. Policy denials must be handled by choosing a safe alternative. Only \`complete-objective\` records success; use \`block-objective\` when no safe path remains. This run will be saved in session history as a \`scheduled_<task-id>_<timestamp>\` session.`
    : '';

  // Combine core directives with the cache-stable context. Volatile state (date,
  // usage, todos, plan-mode, budget) is appended separately per round-trip.
  return `${CORE_DIRECTIVES}${onceModeInstructions}${scheduledRunInstructions}

**Context:**
${context}`;
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
export async function getAgentSystemPrompt(agentSystemPrompt: string, taskPrompt: string, tokenManager?: TokenManager, toolResultManager?: ToolResultManager, reasoningEffort?: string, callingAgentName?: string, thoroughness?: string, agentType?: string, conversationMessages?: readonly Message[], agentDepth: number = 0): Promise<string> {
  // Get context with agent information filtered by calling agent name.
  // Single-level delegation: only the root agent (depth 0 — the main agent or a
  // root-level custom persona) sees the agent roster. A sub-agent (depth >= 1) is a
  // leaf and is not shown other agents, reinforcing that it cannot delegate.
  const context = await getContextInfo({
    includeAgents: agentDepth < 1,
    includeProjectInstructions: false,
    tokenManager,
    toolResultManager,
    reasoningEffort,
    callingAgentName,
    conversationMessages,
  });

  // Build the base prompt with behavioral directives and general guidelines
  const promptWithDirectives = `**Primary Identity:**
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
${context}

**Final Response Requirement**
As a specialized agent, you must conclude with a comprehensive final response. Your final message will be returned as the tool result to the parent agent.

- Monitor your context usage (shown in the Current Context block at the end of the prompt)
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
