/**
 * ResearchTool - Web research delegation tool
 *
 * Delegates to a specialized research agent with access to web search and fetch tools.
 * Handles graceful degradation when search provider is not configured.
 *
 * Key features:
 * - Uses web-search for querying search providers (Brave/Serper)
 * - Uses web-fetch for retrieving and extracting content from URLs
 * - Graceful fallback: when no search API key configured, still allows web-fetch
 * - Follows BaseDelegationTool pattern for consistent agent management
 */

import { BaseDelegationTool, DelegationToolConfig } from './BaseDelegationTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { AGENT_TYPES, THOROUGHNESS_LEVELS, VALID_THOROUGHNESS } from '../config/constants.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import type { Config } from '../types/index.js';
import type { IntegrationStore } from '../services/IntegrationStore.js';

// Tools available for research (web access)
const RESEARCH_TOOLS = ['web-search', 'web-fetch'];

/**
 * Generate research agent system prompt
 *
 * @param hasSearchProvider - Whether a search provider is configured
 */
function getResearchSystemPrompt(hasSearchProvider: boolean): string {
  const searchNote = hasSearchProvider
    ? `- **web-search**: Find information with targeted queries. Follow up with web-fetch for full content.`
    : `- **web-search**: Not available (no search provider configured). Work with provided URLs only.`;

  return `You are a specialized web research assistant. Find, retrieve, and synthesize information from the web.

## Tools

${searchNote}
- **web-fetch**: Retrieve page content from URLs (HTML extracted as text).

## Strategy

1. Understand what information is needed
2. ${hasSearchProvider ? 'Search with targeted queries, then fetch promising results' : 'Fetch provided URLs'}
3. Cross-reference multiple sources when possible
4. Synthesize findings with source URLs

## Constraints

- Cannot access authenticated pages, paywalls, or dynamic JS content
- Prefer authoritative sources (.gov, .edu, official docs)
- Be cautious with unfamiliar domains
- On failures: try alternative sources/queries, always report what worked and what didn't
- Always cite sources with URLs`;
}

export class ResearchTool extends BaseDelegationTool {
  readonly name = 'research';
  readonly description =
    'Perform web research using search and fetch capabilities. Delegates to specialized research agent. Use when you need to find information from the web, verify facts, or gather current data. Returns synthesized findings with sources.';
  readonly requiresConfirmation = false; // Research is read-only
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = false; // Agents never hide their own output

  readonly usageGuidance = `**When to use research:**
Current information, fact verification, external data gathering.
NOT for: Codebase information, offline data, historical conversation context.
web-search requires configured provider (Brave/Serper); web-fetch always available.`;

  private hasSearchProvider: boolean = false;

  /**
   * Get tool configuration
   */
  protected getConfig(): DelegationToolConfig {
    return {
      agentType: AGENT_TYPES.RESEARCH,
      allowedTools: RESEARCH_TOOLS,
      modelConfigKey: 'research_model',
      emptyResponseFallback: 'Research completed but no summary was provided.',
      summaryLabel: 'Research findings:',
    };
  }

  /**
   * Perform additional setup - check search provider availability
   */
  protected async performAdditionalSetup(_config: Config): Promise<any> {
    try {
      const registry = ServiceRegistry.getInstance();
      const integrationStore = registry.get<IntegrationStore>('integration_store');

      if (integrationStore) {
        this.hasSearchProvider = await integrationStore.isSearchConfigured();
      } else {
        this.hasSearchProvider = false;
      }
    } catch {
      this.hasSearchProvider = false;
    }

    return { hasSearchProvider: this.hasSearchProvider };
  }

  /**
   * Get system prompt for research agent
   */
  protected getSystemPrompt(_config: Config, additionalContext?: any): string {
    const hasSearch = additionalContext?.hasSearchProvider ?? this.hasSearchProvider;
    return getResearchSystemPrompt(hasSearch);
  }

  /**
   * Extract task prompt from arguments
   */
  protected getTaskPromptFromArgs(args: any): string {
    return args.task_prompt;
  }

  /**
   * Format task message for research
   */
  protected formatTaskMessage(taskPrompt: string): string {
    return `Execute this research task: ${taskPrompt}`;
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
              description: 'Complete research instructions: what to find, why, and any constraints.',
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
        'Example: research(task_prompt="Find the latest Node.js LTS version and its release date")'
      );
    }

    // Validate thoroughness parameter
    if (!VALID_THOROUGHNESS.includes(thoroughness)) {
      return this.formatErrorResponse(
        `thoroughness parameter must be one of: ${VALID_THOROUGHNESS.join(', ')}`,
        'validation_error',
        'Example: research(task_prompt="...", thoroughness="medium")'
      );
    }

    // Execute research - pass currentCallId to avoid race conditions
    const callId = this.currentCallId;
    if (!callId) {
      return this.formatErrorResponse('Internal error: callId not set', 'system_error');
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
   * ResearchTool shows both 'task_prompt' and 'description' in subtext
   */
  getSubtextParameters(): string[] {
    return ['task_prompt', 'description'];
  }
}
