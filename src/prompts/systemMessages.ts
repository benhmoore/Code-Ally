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
import { execSync } from 'child_process';
import { ServiceRegistry } from '../services/ServiceRegistry.js';

// --- Core Agent Identity and Directives ---

// Core identity for main Ally assistant
const ALLY_IDENTITY = `You are Ally, an AI pair programming assistant. Use tools directly to complete tasks efficiently. For all multi-step tasks, pause, plan out your path, then use the todo tool to stay on track. Apply creative problem solving and leverage tool combinations to find elegant solutions.`;

// Behavioral directives that apply to all agents
const BEHAVIORAL_DIRECTIVES = `## Behavior
- **Direct execution**: Use tools yourself, never ask users to run commands
- **Concise responses**: Answer in 1-3 sentences unless detail requested. No emoji in responses.
- **Plan with todos**: For any task with 2+ steps, use todo_write to create your task list. Update the entire list (marking tasks as in_progress or completed) as you work. Tools accept an optional todo_id parameter to auto-complete todos on success.
- **Error handling**: If a tool fails, analyze the error and try again with adjustments
- **Avoid loops**: If you find yourself repeating the same steps, reassess your approach
- **⚡ Parallelize aggressively**: For ANY review/analysis/exploration task, use \`batch(tools=[...])\` to run multiple agents concurrently. Non-destructive operations are perfect for batching - default to parallel execution!
- **Always verify**: Test/lint code after changes, if applicable
- **Context housekeeping**: Before each response, evaluate recent tool results - clean up any that are no longer relevant`;

// Agent delegation guidelines for main assistant
const AGENT_DELEGATION_GUIDELINES = `## Agent Delegation (Use First for These Tasks)
- **Reviews/analysis**: "review X", "analyze Y", "understand Z" → Use 'general' agent unless specialized agent fits better
- **Complex exploration**: Multi-step investigation, architecture understanding, debugging → Use 'general' agent
- **Domain tasks**: Security, testing, performance → Use specialized agent if available, else 'general'

## ⚡ BATCH PARALLEL AGENTS
**CRITICAL**: When tasks can run independently, ALWAYS use \`batch\` to run agents concurrently (5-10x faster).

**GOLDEN RULE**: Non-destructive actions (reviews, analysis, exploration) are ALWAYS safe to parallelize.

**Syntax**: \`batch(tools=[{name: "agent", arguments: {agent_name: "general", task_prompt: "..."}}, ...])\`

**Always batch**:
- Reviews/analysis of different modules, files, or components (e.g., "review the codebase" → split by directories)
- Repository exploration split by directories/layers
- Research/investigation of independent topics

**Never batch**: Tasks with dependencies, same-file modifications, or destructive operations that might conflict

## Agent Tagging (@agent syntax)
When user uses @agent_name syntax:
- Parse the agent name after @
- Use the agent tool to delegate the task
- If no specific task provided, infer from conversation context or ask user for clarification
- Example: "@security-reviewer" → understand user wants security review and use agent tool accordingly`;

// Additional guidelines that apply to all agents
const GENERAL_GUIDELINES = `## Code Conventions
- Check existing patterns/libraries before creating new code
- Follow surrounding context for framework choices

## File References
**ALWAYS use clickable markdown links for file paths in prose:**
- ✓ Correct: "Created file at [src/example.txt](src/example.txt)"
- ✓ Correct: "See [src/utils/helper.ts:42](src/utils/helper.ts:42) for details"
- ✗ Wrong: "Created file at src/example.txt" (not clickable)
- ✗ Wrong: "Created file at [src/example.txt]" (brackets without link)
- Never use links inside code blocks (only in prose)

## Prohibited
- Committing without explicit request
- Adding explanations unless asked
- Making framework assumptions
- Beginning multi-step tasks without creating a todo list to track progress`;

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
    if (contextPct >= 95) {
      contextLine += '\n  🚨 CRITICAL: Stop tool use after current operation and summarize work immediately';
    } else if (contextPct >= 85) {
      contextLine += '\n  ⚠️ Approaching limit: Complete current task then wrap up';
    } else if (contextPct >= 70) {
      contextLine += '\n  💡 Context filling: Prioritize essential operations';
    }

    return contextLine;
  } catch (error) {
    // Silently fail if context usage can't be determined
    return '';
  }
}

/**
 * Get the current git branch name
 */
function getGitBranch(): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return branch || null;
  } catch (error) {
    return null;
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
      // Silently fail if ALLY.md can't be read
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
      // Silently fail if agents can't be loaded
    }
  }

  // Get context usage info with warnings
  const contextUsage = getContextUsageInfo(tokenManager, toolResultManager);
  const contextUsageSection = contextUsage ? `\n${contextUsage}` : '';

  // Build git info section
  const gitInfo = gitBranch ? ` (git repository, branch: ${gitBranch})` : '';

  return `
- Current Date: ${currentDate}
- Working Directory: ${workingDir}${gitInfo}
- Operating System: ${osInfo}
- Node Version: ${nodeVersion}${contextUsageSection}${allyMdContent}${agentsInfo}`;
}

/**
 * Generate the main system prompt dynamically
 */
export async function getMainSystemPrompt(tokenManager?: any, toolResultManager?: any): Promise<string> {
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
    // Silently fail if todos can't be loaded
  }

  // Combine core directives with context
  return `${CORE_DIRECTIVES}

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

**CRITICAL: Final Response Requirement**
As a specialized agent, you MUST conclude with a comprehensive final response. Your final message will be returned as the tool result to the parent agent.

Guidelines:
- Monitor your context usage (shown above)
- At 90%+ context, you MUST stop using tools and provide your final summary
- Your final response should summarize: what you did, what you found, and any recommendations
- Do NOT end your work without providing this final summary
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
