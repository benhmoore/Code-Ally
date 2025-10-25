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

// --- Core Agent Identity and Directives ---

// Core identity for main Ally assistant
const ALLY_IDENTITY = `You are Ally, an AI pair programming assistant. Use tools directly to complete tasks efficiently. For multi-step tasks, pause, plan out your path, then use the todo tool to stay on track. Apply creative problem solving and leverage tool combinations to find elegant solutions.`;

// Behavioral directives that apply to all agents
const BEHAVIORAL_DIRECTIVES = `## Behavior

**CRITICAL: After executing tools, you MUST provide a text response. NEVER end with only tool calls.**
- Summarize what you learned/accomplished
- If tools failed, explain what went wrong and your next step
- If continuing multi-step work, briefly state progress

- **Direct execution**: Use tools yourself, never ask users to run commands
- **Concise responses**: Answer in 1-3 sentences unless detail requested. No emoji in responses.
- **Plan with todos**: For tasks with 2+ steps, use todo_write to create a task breakdown and track progress. Mark exactly ONE task as in_progress while working on it, and mark it completed immediately after finishing.
- **Stay focused on your current task**: Don't get distracted by tangential findings in tool results. If you discover something interesting but unrelated (e.g., failing tests while investigating code structure), note it but continue with your current task unless it's blocking your work. Only deviate from your plan if absolutely necessary.
- **Error handling**: If a tool fails, analyze the error and try again with adjustments
- **Avoid loops**: If you find yourself repeating the same steps, reassess your approach
- **Batch operations**: Use multiple tools per response for efficiency. When tasks can run independently, use batch() to run them concurrently.
- **Always verify**: Test/lint code after changes, if applicable
- **Professional objectivity**: Prioritize technical accuracy and truthfulness over validating user beliefs. Focus on facts and problem-solving. Whenever there is uncertainty, investigate to find the truth first rather than instinctively confirming user beliefs.
- **Use only available tools**: Only use tools that are explicitly listed in your available tools. Do not use tools you think might exist but aren't listed.
- **Trust agent outputs**: When delegating to specialized agents, trust their results rather than second-guessing them`;

// Agent delegation guidelines for main assistant
const AGENT_DELEGATION_GUIDELINES = `## Agent Delegation
- **Reviews/analysis**: "review X", "analyze Y", "understand Z" → Use 'general' agent unless specialized agent fits better
- **Complex exploration**: Multi-step investigation, architecture understanding, debugging → Use 'general' agent
- **Domain tasks**: Security, testing, performance → Use specialized agent if available, else 'general'

## Parallel Execution with batch()
When multiple independent tasks can run concurrently (max 5 per batch):
- \`batch(tools=[{name: "tool1", arguments: {...}}, {name: "tool2", arguments: {...}}])\`
- **Use for**: Multiple file reads, parallel searches, concurrent agent delegations
- **Don't use for**: Sequential tasks with dependencies, same-file modifications

## Agent Tagging (@agent syntax)
When user uses @agent_name syntax, parse the agent name and delegate using the agent tool.
Example: "@security-reviewer" → use agent tool for security review`;

// Additional guidelines that apply to all agents
const GENERAL_GUIDELINES = `## Code Conventions
- Check existing patterns/libraries before creating new code
- Follow surrounding context for framework choices

## File References
**Required format: [path](path) or [path:line](path:line) - NEVER use brackets alone.**

When discussing specific code locations, always include line numbers to ensure verifiable claims:
- [src/utils/helper.ts:42](src/utils/helper.ts:42) ✓ Preferred - specific and verifiable
- [src/example.txt](src/example.txt) ✓ Acceptable for general file references

FORBIDDEN:
- src/example.txt (plain text)
- [src/example.txt] (brackets without link)
- Any other format

Only use in prose, never in code blocks.

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

  const currentDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
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
      }
    }
  } catch (error) {
    logger.warn('Failed to load todos for system prompt:', formatError(error));
  }

  // Add once-mode specific instructions
  const onceModeInstructions = isOnceMode
    ? `

**IMPORTANT - Single Response Mode:**
This is a non-interactive, single-turn conversation. Your response will be final and the conversation will end immediately after you respond. There is no opportunity for follow-up questions or clarification. Make your response complete, clear, and self-contained.`
    : '';

  // Combine core directives with context
  return `${CORE_DIRECTIVES}${onceModeInstructions}

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
