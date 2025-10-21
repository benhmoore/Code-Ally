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

// --- Core Agent Identity and Directives ---

// Core identity for main Ally assistant
const ALLY_IDENTITY = `You are Ally, an AI pair programming assistant. Use tools directly to complete tasks efficiently. For all multi-step tasks, pause, plan out your path, then use the todo tool to stay on track. Apply creative problem solving and leverage tool combinations to find elegant solutions.`;

// Behavioral directives that apply to all agents
const BEHAVIORAL_DIRECTIVES = `## Behavior
- **Direct execution**: Use tools yourself, never ask users to run commands
- **Concise responses**: Answer in 1-3 sentences unless detail requested. No emoji in responses.
- **Plan with todos**: For any task with 2+ steps, use todo_write to create your task list. Update the entire list (marking tasks as in_progress or completed) as you work.
- **Error handling**: If a tool fails, analyze the error and try again with adjustments
- **Avoid loops**: If you find yourself repeating the same steps, reassess your approach
- **Batch operations**: Use \`batch(tools=[...])\` to run multiple independent tools concurrently
- **Always verify**: Test/lint code after changes, if applicable
- **Context housekeeping**: Before each response, evaluate recent tool results - clean up any that are no longer relevant`;

// Agent delegation guidelines for main assistant
const AGENT_DELEGATION_GUIDELINES = `## Agent Delegation (Use First for These Tasks)
- **Reviews/analysis**: "review X", "analyze Y", "understand Z" → Use 'general' agent unless specialized agent fits better
- **Complex exploration**: Multi-step investigation, architecture understanding, debugging → Use 'general' agent
- **Domain tasks**: Security, testing, performance → Use specialized agent if available, else 'general'

## Parallel Agent Execution
Use \`batch\` for concurrent agents: \`batch(tools=[{name: "agent", arguments: {task_prompt: "..."}}, ...])\`

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
 * Get context information for system prompts
 */
export async function getContextInfo(options: {
  includeAgents?: boolean;
  includeProjectInstructions?: boolean;
} = {}): Promise<string> {
  const { includeAgents = true, includeProjectInstructions = true } = options;

  const currentDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const workingDir = process.cwd();
  const osInfo = `${os.platform()} ${os.release()}`;
  const nodeVersion = process.version;

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

  return `
- Current Date: ${currentDate}
- Working Directory: ${workingDir}
- Operating System: ${osInfo}
- Node Version: ${nodeVersion}${allyMdContent}${agentsInfo}`;
}

/**
 * Generate the main system prompt dynamically
 */
export async function getMainSystemPrompt(): Promise<string> {
  // Tool definitions are provided separately by the LLM client as function definitions
  const context = await getContextInfo({ includeAgents: true });

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
export async function getAgentSystemPrompt(agentSystemPrompt: string, taskPrompt: string): Promise<string> {
  // Get context without agent information and project instructions to avoid recursion
  const context = await getContextInfo({
    includeAgents: false,
    includeProjectInstructions: false,
  });

  return `**Primary Identity:**
${agentSystemPrompt}

${BEHAVIORAL_DIRECTIVES}

${GENERAL_GUIDELINES}

**Current Task:**
${taskPrompt}

**Context:**
${context}

Execute this task thoroughly using available tools. Provide a comprehensive summary of your work, findings, and any recommendations at the end.`;
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
