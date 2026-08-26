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
import { getEmptyTodoGuidance } from '../utils/messageUtils.js';

// --- Core Agent Identity and Directives ---

// Core identity for main Ally assistant
const ALLY_IDENTITY = 'You are Ally, a coding assistant. Complete the request with the fewest correct operations.';

// Cache-stable rules shared by every main-agent request. Tool-specific details
// belong in tool schemas/guidance so this prefix stays short and unambiguous.
const BEHAVIORAL_DIRECTIVES = `Tool rules:
- Choose the narrowest tool that directly matches the operation.
- Read a file before editing it.
- When scope is unknown, search or list first; when the target is known, read only the required ranges.
- Batch related reads only when their combined output will fit the available budget. Do not reread whole files merely to orient.
- After a checkpoint, trust its carried state and query only a specific missing fact needed by the next action.
- Once evidence supports the next edit or verification, act and use build/test feedback for narrow follow-up.
- Treat self-authored tests as hypotheses: before changing production behavior to satisfy one, confirm its expectation against the request and established contract; fix the test when its premise is wrong.
- Delegate self-contained work or synthesis, not raw context transport. Ask for compact conclusions, exact symbols or locations, or an independently verifiable change.
- Never ask a delegate to dump whole files or large tool outputs. Create scratch notes only to preserve durable synthesized conclusions across a long investigation.
- For different independent operations, emit separate native tool calls in one response.
- Do not call unrelated tools or describe a tool call instead of making it.`;

// Complete directives for main Ally assistant
const CORE_DIRECTIVES = `${ALLY_IDENTITY}

${BEHAVIORAL_DIRECTIVES}`;

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
        // Latched per compaction epoch: flipping this section in or out changes
        // the system message and forfeits backend KV-cache reuse for the whole
        // window, so the decision holds until the next re-baseline.
        const allowInjection = tokenManager && typeof tokenManager.allowPromptInjections === 'function'
          ? tokenManager.allowPromptInjections(CONTEXT_THRESHOLDS.INJECTION_CEILING)
          : true;
        if (allowInjection) {
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
      // Only include skills under the injection ceiling. Latched per compaction
      // epoch — same KV-cache rationale as the memory index gate above.
      const allowInjection = tokenManager && typeof tokenManager.allowPromptInjections === 'function'
        ? tokenManager.allowPromptInjections(CONTEXT_THRESHOLDS.INJECTION_CEILING)
        : true;

      if (allowInjection) {
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
  /** Injectable clock for deterministic request snapshots and evaluations. */
  now?: Date;
  /** Injectable IANA zone for deterministic request snapshots and evaluations. */
  timeZone?: string;
  /** Include volatile clock data; ordinary coding turns omit it. */
  includeTime?: boolean;
} = {}): Promise<string> {
  const { includeTodos = false, includePlanMode = false } = options;

  const now = options.now ?? new Date();
  const localTimeZone = options.timeZone ?? getDefaultTimeZone();
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
          todoContext = `\n${todoStatus || getEmptyTodoGuidance()}`;
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

**PLAN MODE ACTIVE — read-only.**
Explore and ask questions as needed. Write the plan with write-plan, then call exit-plan-mode for approval. Do not modify project files.`;
        }
      }
    } catch (error) {
      logger.warn('Failed to check plan mode state:', formatError(error));
    }
  }

  const timeContext = options.includeTime === false ? '' : `- Current Local Time: ${currentLocalTime}
- Current Time Zone: ${localTimeZone}
- Current UTC Time: ${currentUtcTime}Z`;
  const body = `${timeContext}${todoContext}${planModeSection}`.trim();
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
 * the core directives and cache-stable context (environment, project
 * instructions, memory index, rosters). Tool-specific guidance travels with
 * each runtime-filtered function definition instead. Per-round-trip
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

  // Scheduled runs are already single-response runs. Emit one unattended block
  // instead of two overlapping copies of the same completion protocol.
  const unattendedInstructions = isScheduledRun
    ? `

**Scheduled Task Run${scheduledTaskId ? ` — \`${scheduledTaskId}\`` : ''}:**
Execute unattended. Do not ask follow-up questions. Use safe alternatives after recoverable failures. Prose does not finish the run: call \`complete-objective\` after the work and verification, or \`block-objective\` only when no safe automatic path remains. Saved as \`scheduled_<task-id>_<timestamp>\`.`
    : isOnceMode
      ? `

**Single Response Run:**
No user is available. Use safe alternatives after recoverable failures. Prose does not finish the run: call \`complete-objective\` after the work and verification, or \`block-objective\` only when no safe automatic path remains.`
      : '';

  // Combine core directives with the cache-stable context. Volatile state (date,
  // usage, todos, plan-mode, budget) is appended separately per round-trip.
  return `${CORE_DIRECTIVES}${unattendedInstructions}

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

${BEHAVIORAL_DIRECTIVES}`;

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

**Return to parent**
Execute with available tools. End with a self-contained summary of work, findings, evidence, and material caveats or recommendations. At 90% context, stop using tools and summarize.`;
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
