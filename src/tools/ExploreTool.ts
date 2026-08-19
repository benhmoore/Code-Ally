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

const EXPLORATION_TOOLS = ['read', 'glob', 'grep', 'ls', 'tree', 'write-temp'];

/**
 * Generate exploration base prompt with temp directory
 */
function getExplorationBasePrompt(tempDir: string): string {
  return `You are a specialized codebase exploration assistant. READ-ONLY access - no file modifications, no internet access.

## Tool Usage

- **tree/ls**: Directory structure overview
- **glob**: File pattern matching ("**/*.ts")
- **grep**: Content search with regex
- **read**: Examine specific files
- **write-temp**: Save notes to ${tempDir} (e.g., write-temp(content="...", filename="notes.txt"))

## Constraints

- All file paths MUST be absolute
- Always use absolute paths (cwd resets between bash calls)
- Match exploration to the request. When exact files or symbols are named, skip tree/glob discovery and query those targets directly.
- Prefer grep for declarations/references, then read only the narrow ranges needed to interpret the matches. Read whole files only when their complete behavior is genuinely required.
- Parallel reads share one output budget. Do not batch full-file reads that may exceed it; group only small known files and inspect larger files narrowly.
- Stop calling tools as soon as the requested evidence is sufficient. Do not reread evicted output or source merely for reassurance; re-query only the missing symbol or range.
- For long multi-file investigations, save compact accumulated findings with write-temp before earlier evidence can be evicted, then synthesize from those notes.
- Never copy whole source files or large raw tool outputs into notes or the final response. Return compact conclusions with exact symbols and locations so the caller can verify only what it needs.
- Mention any temp files created in your final response with full paths
- Report findings with file paths and relevant code snippets`;
}

export class ExploreTool extends BaseDelegationTool {
  readonly name = 'explore';
  readonly description =
    'Delegate broad read-only repository investigation when scope is unknown or multi-file synthesis is needed.';
  /** Delegates read-only exploration; the child's tool calls are gated individually. */
  readonly capabilities = [] as const;
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = false; // Agents never hide their own output

  readonly usageGuidance = `**When to use explore:**
Unknown scope/location, multi-file synthesis, architecture analysis. Preserves your context.
NOT for: Known file paths, single-file questions, simple lookups. No internet access.
Expect compact findings with exact symbols and locations. Temp notes are for durable synthesized findings, never source-file dumps.`;

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
              description: 'What to find, where, and why.',
            },
            thoroughness: {
              type: 'string',
              description: '"quick", "medium", "very thorough", or "uncapped" (default)',
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
