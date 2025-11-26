/**
 * ExploreTool - Simplified read-only codebase exploration
 *
 * Provides a focused, lightweight agent for codebase exploration with hardcoded
 * read-only tool access. Simpler alternative to AgentTool for exploration tasks.
 *
 * Key differences from AgentTool:
 * - No AgentManager dependency (hardcoded prompt and tools)
 * - Single purpose: codebase exploration
 * - Guaranteed read-only access
 * - Zero configuration needed
 * - Agents always persist in the pool for reuse
 */

import { BaseDelegationTool, DelegationToolConfig } from './BaseDelegationTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { AGENT_TYPES, THOROUGHNESS_LEVELS, VALID_THOROUGHNESS } from '../config/constants.js';
import type { Config } from '../types/index.js';

// Tools available for exploration (read-only + write-temp for note-taking + explore for delegation)
const EXPLORATION_TOOLS = ['read', 'glob', 'grep', 'ls', 'tree', 'write-temp', AGENT_TYPES.EXPLORE];

/**
 * Generate exploration base prompt with temp directory
 */
function getExplorationBasePrompt(tempDir: string): string {
  return `You are a specialized codebase exploration assistant. You excel at thoroughly navigating and exploring codebases to understand structure, find implementations, and analyze architecture.

## Your Strengths

- Rapidly finding files using glob patterns
- Searching code and text with regex patterns
- Reading and analyzing file contents
- Understanding directory structures with tree visualization
- Executing parallel operations for efficiency
- Delegating sub-explorations to protect your context

## Strategic Delegation (CRITICAL)

**At every step, evaluate whether breaking down the exploration would be more efficient and comprehensive.**

Delegating to other explore agents via explore() PROTECTS YOUR CONTEXT and should be PREFERRED whenever an exploration can be broken down efficiently.

### When to Delegate:

- **Multiple distinct areas**: Authentication AND error handling AND API patterns (3 separate explore calls)
- **Parallel investigations**: Frontend components, backend services, database schema (3 parallel calls)
- **Deep dives after overview**: First explore structure, then delegate deep dives into specific subsystems
- **Complex multi-part tasks**: Break into logical sub-explorations that can run independently

### Benefits of Delegation:

- Protects your token budget - each sub-agent has its own context
- Enables true parallelization - multiple investigations simultaneously
- Maintains focus - you orchestrate, sub-agents handle details
- Scales better - distribute work across multiple agents

### Delegation Patterns:

**Pattern 1 - Parallel Areas:**
\`\`\`
explore(task_prompt="Find authentication implementation")
explore(task_prompt="Find error handling patterns")
explore(task_prompt="Find API endpoint structure")
\`\`\`

**Pattern 2 - Overview then Deep Dive:**
\`\`\`
1. First: Use tree/glob/grep yourself to understand high-level structure
2. Then: Delegate detailed investigations of each major component
\`\`\`

**Pattern 3 - Divide and Conquer:**
\`\`\`
Large codebase? Split by directory:
explore(task_prompt="Explore src/frontend/* for user interface patterns")
explore(task_prompt="Explore src/backend/* for service architecture")
explore(task_prompt="Explore src/shared/* for common utilities")
\`\`\`

**Remember**: You can delegate up to 2 levels deep. If a task can be split into independent sub-tasks, DELEGATE.

## Tool Usage Guidelines

- Use Tree to understand directory hierarchy and project organization
- Use Glob for broad file pattern matching (e.g., "**/*.ts", "src/components/**")
- Use Grep for searching file contents with regex patterns
- Use Read when you know specific file paths you need to examine
- Use Ls for listing directory contents when exploring structure
- Use WriteTemp to save temporary notes for organizing findings during exploration
- Use Explore to delegate distinct sub-explorations (PREFER THIS - it protects your context)
- Adapt your search approach based on the thoroughness level specified

## Organizing Your Findings

- WriteTemp creates temporary notes in ${tempDir} (e.g., write-temp(content="...", filename="notes.txt"))
- Use separate files to organize by category: architecture.txt, patterns.txt, issues.txt
- Read your notes before generating final response to ensure comprehensive coverage
- Especially useful for longer explorations with many findings
- **IMPORTANT:** Mention any temporary files you created in your final response
  - Include full paths to temp files (e.g., "${tempDir}/architecture-notes.txt")
  - These notes are valuable for ancestor agents who called you
  - Example: "I've created detailed notes in ${tempDir}/findings.txt for further reference"

## Core Objective

Complete the exploration request efficiently and report your findings clearly with absolute file paths and relevant code snippets.

## Important Constraints

- You have READ-ONLY access - you cannot modify files
- Agent threads have cwd reset between bash calls - always use absolute file paths
- In your final response, always share relevant file names and code snippets
- All file paths in your response MUST be absolute, NOT relative
- Avoid using emojis for clear communication
- Be systematic: trace dependencies, identify relationships, understand flow

**Execution Guidelines:**

**FIRST: Assess Delegation Strategy**
- Can this task be split into 2+ independent sub-explorations? If YES → delegate via explore()
- Will investigating multiple areas consume significant context? If YES → delegate each area
- Is this a complex multi-part exploration? If YES → break it down and delegate

**THEN: Execute Your Approach**
- If delegating: Launch explore() calls (can be parallel) and synthesize results
- If exploring directly: Be efficient (aim for 5-10 tool calls), start with structure (tree/ls)
- Always provide clear, structured summaries of findings
- Highlight key files, patterns, and architectural decisions
- If you can't find something, explain what you searched and what was missing

**Remember**: Delegation is not a fallback - it's a primary strategy for context protection and efficiency.

Execute your exploration systematically and provide comprehensive results.`;
}

export class ExploreTool extends BaseDelegationTool {
  readonly name = 'explore';
  readonly description =
    'Explore codebase with read-only access. Delegates to specialized exploration agent. Use when you need to understand code structure, find implementations, or analyze architecture. Returns comprehensive findings.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = false; // Agents never hide their own output

  readonly usageGuidance = `**When to use explore:**
Unknown scope/location: Don't know where to start or how much code is involved.
Multi-file synthesis: Understanding patterns, relationships, or architecture across codebase.
Preserves your context - investigation happens in separate agent context.
CRITICAL: Agent CANNOT see current conversation - include ALL context in task_prompt (what to find, where to look, why).
Agent has NO internet access - only local codebase exploration.
NOT for: Known file paths, single-file questions, simple lookups.

**Output format:**
Explore agents may create temporary note files during complex investigations.
If temp file paths are mentioned in the response, you can read those files for additional detailed context.

Note: Explore agents can delegate to other explore agents (max 2 levels deep) for distinct sub-investigations.`;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Get tool configuration
   */
  protected getConfig(): DelegationToolConfig {
    return {
      agentType: AGENT_TYPES.EXPLORE,
      allowedTools: EXPLORATION_TOOLS,
      modelConfigKey: 'explore_model',
      emptyResponseFallback: 'Exploration completed but no summary was provided.',
      summaryLabel: 'Exploration findings:',
    };
  }

  /**
   * Get system prompt for exploration agent
   */
  protected getSystemPrompt(config: Config): string {
    return getExplorationBasePrompt(config.temp_directory);
  }

  /**
   * Extract task prompt from arguments
   */
  protected getTaskPromptFromArgs(args: any): string {
    return args.task_prompt;
  }

  /**
   * Format task message for exploration
   */
  protected formatTaskMessage(taskPrompt: string): string {
    return `Execute this exploration task: ${taskPrompt}`;
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
            task_prompt: {
              type: 'string',
              description: 'Complete exploration instructions with ALL necessary context. Agent cannot see current conversation - include what to find, where to look, and why. Be specific about what you want to understand.',
            },
            thoroughness: {
              type: 'string',
              description: 'Level of thoroughness for exploration: "quick" (~1 min, 2-5 tool calls), "medium" (~5 min, 5-10 tool calls), "very thorough" (~10 min, 10-20 tool calls), "uncapped" (no time limit, default). Controls time budget and depth.',
            },
          },
          required: ['task_prompt'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const taskPrompt = args.task_prompt;
    const thoroughness = args.thoroughness ?? THOROUGHNESS_LEVELS.UNCAPPED;

    // Validate task_prompt parameter
    if (!taskPrompt || typeof taskPrompt !== 'string') {
      return this.formatErrorResponse(
        'task_prompt parameter is required and must be a string',
        'validation_error',
        'Example: explore(task_prompt="Find how error handling is implemented")'
      );
    }

    // Validate thoroughness parameter
    if (!VALID_THOROUGHNESS.includes(thoroughness)) {
      return this.formatErrorResponse(
        `thoroughness parameter must be one of: ${VALID_THOROUGHNESS.join(', ')}`,
        'validation_error',
        'Example: explore(task_prompt="...", thoroughness="uncapped")'
      );
    }

    // Execute exploration - pass currentCallId to avoid race conditions
    const callId = this.currentCallId;
    if (!callId) {
      return this.formatErrorResponse(
        'Internal error: callId not set',
        'system_error'
      );
    }

    return await this.executeDelegation(taskPrompt, thoroughness, callId);
  }

  /**
   * Format subtext for display in UI
   * Shows full task_prompt (no truncation - displayed on separate indented lines)
   */
  formatSubtext(args: Record<string, any>): string | null {
    const taskPrompt = args.task_prompt as string;

    if (!taskPrompt) {
      return null;
    }

    return taskPrompt;
  }

  /**
   * Get parameters shown in subtext
   * ExploreTool shows both 'task_prompt' and 'description' in subtext
   */
  getSubtextParameters(): string[] {
    return ['task_prompt', 'description'];
  }
}
