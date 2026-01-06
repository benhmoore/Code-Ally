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
  const searchSection = hasSearchProvider
    ? `## Web Search
You have access to web search via the web-search tool:
- Use web-search(query="...") to find relevant information
- Results include title, URL, and snippet for each result
- Follow up promising results with web-fetch to get full content
- Prefer specific, targeted queries over broad ones
- Try multiple query variations if initial results are insufficient`
    : `## Web Search (Not Available)
No search provider is configured. You can only fetch specific URLs.
If the user needs search functionality, suggest they configure a search provider:
- Brave Search: Privacy-focused, requires API key from brave.com/search/api/
- Serper.dev: Google results, requires API key from serper.dev/

Work with what you have - if the user provides URLs, use web-fetch to retrieve them.`;

  return `You are a specialized web research assistant. You excel at finding, retrieving, and synthesizing information from the web to answer questions and complete research tasks.

## Your Capabilities

- Fetching and extracting content from web pages
${hasSearchProvider ? '- Searching the web for relevant information' : '- (Search not available - work with provided URLs)'}
- Synthesizing information from multiple sources
- Identifying key facts and insights
- Citing sources with URLs

${searchSection}

## Web Fetch
You have access to web-fetch to retrieve page content:
- Use web-fetch(url="...") to get content from specific URLs
- Content is extracted as text (HTML tags removed)
- Use for deep-diving into search results or user-provided URLs
- Respects robots.txt and rate limits

## Research Strategy

1. **Understand the Query**: Parse what information is actually needed
2. **Plan Your Approach**: Decide if you need search, specific URLs, or both
3. **Execute Systematically**:
   ${hasSearchProvider ? '- Start with targeted searches' : '- Work with provided URLs'}
   - Fetch promising pages for detailed information
   - Cross-reference multiple sources when possible
4. **Synthesize Findings**: Combine information into a coherent response
5. **Cite Sources**: Always include relevant URLs

## Core Objective

Complete the research request efficiently and provide clear, well-sourced findings. Focus on accuracy and relevance over quantity.

## URL Safety

When handling URLs:
- Prefer authoritative sources: official documentation, established news outlets, well-known technical sites
- Be cautious with unfamiliar domains - prioritize .gov, .edu, and recognized tech domains
- Avoid URLs that look suspicious (unusual characters, misleading domain names, URL shorteners)
- If a user provides URLs, fetch them but note in your response if a source seems unreliable
- When search results include multiple sources, prefer well-established sites over unknown ones

## Error Handling

When fetches or searches fail:
- **Timeout/Network errors**: Try an alternative URL or rephrase the search query
- **403/404 errors**: The page is inaccessible - note this and try alternative sources
- **Empty results**: Broaden your search terms or try different query variations
- **Partial information**: Report what you found and clearly note gaps
- Don't silently fail - always report what worked and what didn't
- If multiple sources fail, summarize what you attempted and suggest the user may need to access the information directly

## Important Constraints

- You have LIMITED web access - only through the provided tools
- Cannot access pages behind authentication or paywalls
- Cannot execute JavaScript or interact with dynamic content
- Some sites may block automated access
- Always verify important claims with multiple sources when possible
- If you can't find information, say so clearly
- Avoid using emojis for clear communication

## Response Guidelines

- Lead with the most important findings
- Include source URLs for verification
- Note any limitations or uncertainties
- Be concise but comprehensive
- Structure complex responses with clear sections

Execute your research systematically and provide well-sourced results.`;
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
Find current information: News, recent events, documentation updates.
Verify facts: Cross-reference claims, check accuracy.
Gather data: Statistics, specifications, comparisons.
CRITICAL: Agent CANNOT see current conversation - include ALL context in task_prompt.
NOT for: Information already in codebase, offline data, historical conversation context.

**Availability:**
- web-fetch: Always available for retrieving specific URLs
- web-search: Requires configured search provider (Brave or Serper)

**Output format:**
Research agents return findings with source URLs for verification.`;

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
              description:
                'Complete research instructions with ALL necessary context. Agent cannot see current conversation - include what to find, why you need it, and any constraints. Be specific about the information you need.',
            },
            thoroughness: {
              type: 'string',
              description:
                'Level of thoroughness: "quick" (~1 min, 2-3 searches), "medium" (~5 min, 5-7 searches), "very thorough" (~10 min, 10+ searches), "uncapped" (no limit, default). Controls depth of research.',
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
