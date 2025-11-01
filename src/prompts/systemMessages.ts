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

// --- Core Agent Identity and Directives ---

// Core identity for main Ally assistant
const ALLY_IDENTITY = `You are Ally, an AI pair programming assistant. Use tools directly to complete tasks efficiently. Apply creative problem solving and leverage tool combinations to find elegant solutions.`;

// Behavioral directives that apply to all agents
const BEHAVIORAL_DIRECTIVES = `## Behavior

**CRITICAL: After executing tools, you MUST provide a text response. NEVER end with only tool calls.**
- Summarize what you learned/accomplished
- If tools failed, explain what went wrong and next steps
- If continuing work, briefly state progress

- **Direct execution**: Use tools yourself, never ask users to run commands
- **Concise responses**: 1-3 sentences unless detail requested. No emoji.
- **Task management**: Use todos for multi-step tasks (todo_add, todo_update, todo_remove, todo_clear)
- **Error handling**: Analyze failures and retry with adjustments
- **Avoid loops**: If repeating steps, reassess your approach
- **Efficiency**: Use multiple tools per response when independent
- **Verification**: Test/lint code after changes when applicable
- **Objectivity**: Prioritize accuracy over validating beliefs. Investigate before confirming.
- **Available tools only**: Don't use tools that aren't explicitly listed
- **System reminders**: Tool results may include a `system_reminder` key containing additional context. You should read and respect this content when generating responses.

- **Trust delegation**: Trust specialized agent results`;

// Agent delegation guidelines for main assistant
const AGENT_DELEGATION_GUIDELINES = `## Tool Selection
- \`plan\`: Multi-step features/fixes needing structured approach (creates todos with dependencies/subtasks)
- \`explore\`: Read-only codebase investigation for understanding architecture and structure
- \`agent\`: Complex tasks requiring specialized expertise or multiple steps
- Manual tools: Simple single-file operations and targeted searches

## Exploration and Analysis

**When to use explore:**
- Understanding codebase structure and architecture: "What is the codebase structure?"
- Finding implementations when you don't know the specific location: "Where are errors from the client handled?"
- Tracing feature implementations across files: "How does the authentication system work?"
- Analyzing dependencies and relationships between components
- Answering "how does X work?" questions (not "where is X?")

**When NOT to use explore (use direct tools instead):**
- Reading a specific file path → use \`read\` tool: "Read the file at src/utils/helper.ts"
- Searching for a specific class definition → use \`glob\` tool: "Find the class Foo definition"
- Searching code within a specific file or 2-3 files → use \`read\` tool: "Check for TODO comments in src/app.ts"
- Needle-in-haystack queries where you know exactly what you're looking for → use \`glob\` or \`grep\` tools

## Planning
- **Use plan for**: New features, complex fixes, significant changes
- **Skip planning for**: Quick fixes, simple adjustments, continuing existing plans
- Plan creates proposed todos; use deny_proposal if misaligned with intent

## Large Todo Lists
- For 5+ items, delegate subsets to agents (group related tasks, run in parallel)

## Agent Tagging
- @agent_name syntax → delegate using agent tool

## Creative Agent Usage
Agents persist in memory (persist=true, default) and can be queried later with agent_ask:
- **File muse**: explore(task="Understand auth.ts architecture") → agent_ask(agent_id="...", message="How does token refresh work?")
- **Implement + validate**: agent(task="Add OAuth", agent_name="implementor") → agent(task="Review OAuth implementation", agent_name="validator")
- **Iterative refinement**: plan(requirements="Add feature X") → agent_ask(agent_id="...", message="How would we handle edge case Y?")
- **Context preservation**: Create specialized agents to offload deep analysis, keeping main conversation focused`;

// Additional guidelines that apply to all agents
const GENERAL_GUIDELINES = `## Code Conventions
- Check existing patterns/libraries before creating new code
- Follow surrounding context for framework choices

## File Operations
- Structural corruption or failed line edits: Read entire file, Write clean version
- Normal changes: Use incremental editing (edit, line_edit)
- Reading files: Always use regular reads by default to keep content in context
- Ephemeral reads: Only for files exceeding token limits; content is lost after one turn
- Keep useful files in context for future reference

## File References
- With line number: [src/utils/helper.ts:42](src/utils/helper.ts:42)
- Without: [src/example.txt](src/example.txt)
- Avoid brackets elsewhere: "Files are ALLY.md, src, and dist" (not [ALLY.md], [src])

## Prohibited
- Committing without explicit request
- Adding explanations unless asked
- Making framework assumptions`;

// Complete directives for main Ally assistant
const CORE_DIRECTIVES = `${ALLY_IDENTITY}

${BEHAVIORAL_DIRECTIVES}

${AGENT_DELEGATION_GUIDELINES}

${GENERAL_GUIDELINES}`;

/**
 * Get context usage information with warnings
 */
function getContextUsageInfo(tokenManager?: any, toolResultManager?: any): string {
  try {
    // Use provided instances or fall back to ServiceRegistry
    let tm = tokenManager;
    let trm = toolResultManager;

    if (!tm || !trm) {
      const serviceRegistry = ServiceRegistry.getInstance();
      if (!serviceRegistry) return '';

      if (!tm) tm = serviceRegistry.get<any>('token_manager');
      if (!trm) trm = serviceRegistry.get<any>('tool_result_manager');
    }

    if (!tm || typeof tm.getContextUsagePercentage !== 'function') {
      return '';
    }

    const contextPct = tm.getContextUsagePercentage();
    let remainingCalls = 0;

    if (trm && typeof trm.estimateRemainingToolCalls === 'function') {
      remainingCalls = trm.estimateRemainingToolCalls();
    }

    let contextLine = `- Context Usage: ${contextPct}% (~${remainingCalls} tool calls remaining)`;

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
 * Get context information for system prompts
 */
export async function getContextInfo(options: {
  includeAgents?: boolean;
  includeProjectInstructions?: boolean;
  tokenManager?: any;
  toolResultManager?: any;
} = {}): Promise<string> {
  const { includeAgents = true, includeProjectInstructions = true, tokenManager, toolResultManager } = options;

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
- Node Version: ${nodeVersion}${projectInfo}${contextUsageSection}${allyMdContent}${agentsInfo}`;
}

/**
 * Generate the main system prompt dynamically
 */
export async function getMainSystemPrompt(tokenManager?: any, toolResultManager?: any, isOnceMode: boolean = false): Promise<string> {
  // Tool definitions are provided separately by the LLM client as function definitions
  const context = await getContextInfo({ includeAgents: true, tokenManager, toolResultManager });

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

  // Add once-mode specific instructions
  const onceModeInstructions = isOnceMode
    ? `

**IMPORTANT - Single Response Mode:**
This is a non-interactive, single-turn conversation. Your response will be final and the conversation will end immediately after you respond. There is no opportunity for follow-up questions or clarification. Make your response complete, clear, and self-contained.`
    : '';

  // Combine core directives with context
  return `${CORE_DIRECTIVES}${onceModeInstructions}${toolGuidanceContext}

**Context:**
${context}${todoContext}`;
}

/**
 * Generate a system prompt for specialized agents
 */
export async function getAgentSystemPrompt(agentSystemPrompt: string, taskPrompt: string, tokenManager?: any, toolResultManager?: any): Promise<string> {
  // Get context without agent information and project instructions to avoid recursion
  const context = await getContextInfo({
    includeAgents: false,
    includeProjectInstructions: false,
    tokenManager,
    toolResultManager,
  });

  return `**Primary Identity:**
${agentSystemPrompt}

${BEHAVIORAL_DIRECTIVES}

${GENERAL_GUIDELINES}

**Current Task:**
${taskPrompt}

**Context:**
${context}

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
  git_commit_template: `🤖 Generated with Code Ally

Co-Authored-By: Ally <noreply@codeally.dev>`,
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
