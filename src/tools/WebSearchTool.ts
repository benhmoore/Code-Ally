/**
 * WebSearchTool - Search the web using configured search provider
 *
 * Provides web search functionality through SerperProvider or BraveProvider.
 * Requires configuration via IntegrationStore before use.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { IntegrationStore } from '../services/IntegrationStore.js';
import { SerperProvider, BraveProvider } from '../services/providers/index.js';
import { SearchResult, ISearchProvider } from '../types/integration.js';
import { TOOL_OUTPUT_ESTIMATES } from '../config/toolDefaults.js';
import { logger } from '../services/Logger.js';

const DEFAULT_NUM_RESULTS = 5;
const MAX_NUM_RESULTS = 10;

export class WebSearchTool extends BaseTool {
  readonly name = 'web-search';
  readonly displayName = 'Web Search';
  readonly description =
    'Search the web for information using the configured search provider. Returns search results with title, URL, and snippet.';
  readonly requiresConfirmation = false; // Read-only operation
  readonly isExploratoryTool = true;

  /**
   * Restrict visibility to research agents only
   * This tool should not be available to the main agent
   */
  readonly visibleTo = ['research'];

  constructor(activityStream: ActivityStream) {
    super(activityStream);
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
            query: {
              type: 'string',
              description: 'The search query to execute',
            },
            num_results: {
              type: 'integer',
              description: `Maximum number of results to return (default: ${DEFAULT_NUM_RESULTS}, max: ${MAX_NUM_RESULTS})`,
            },
          },
          required: ['query'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const query = args.query as string;
    const numResults = Math.min(
      Math.max(1, Number(args.num_results) || DEFAULT_NUM_RESULTS),
      MAX_NUM_RESULTS
    );

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return this.formatErrorResponse(
        'query parameter is required and must be a non-empty string',
        'validation_error',
        'Example: web-search(query="latest TypeScript features")'
      );
    }

    // Get IntegrationStore from ServiceRegistry
    const registry = ServiceRegistry.getInstance();
    const integrationStore = registry.get<IntegrationStore>('integration_store');

    if (!integrationStore) {
      return this.formatErrorResponse(
        'Integration store is not available',
        'system_error',
        'This is an internal error - please report it'
      );
    }

    // Check if search is configured
    if (!integrationStore.isSearchConfigured()) {
      return this.formatErrorResponse(
        'Web search is not configured',
        'user_error',
        'Configure search with: ally --config-set search_provider=serper search_api_key=YOUR_KEY\n' +
        'Supported providers: serper (https://serper.dev), brave (https://brave.com/search/api/)'
      );
    }

    // Get settings and create appropriate provider
    const settings = integrationStore.getSettings();
    const { searchProvider, searchAPIKey } = settings;

    if (!searchAPIKey) {
      return this.formatErrorResponse(
        'Search API key is not set',
        'user_error',
        'Configure search API key with: ally --config-set search_api_key=YOUR_KEY'
      );
    }

    let provider: ISearchProvider;
    switch (searchProvider) {
      case 'serper':
        provider = new SerperProvider();
        break;
      case 'brave':
        provider = new BraveProvider();
        break;
      default:
        return this.formatErrorResponse(
          `Unknown search provider: ${searchProvider}`,
          'user_error',
          'Supported providers: serper, brave'
        );
    }

    try {
      logger.debug(`[WebSearchTool] Executing search: "${query}" (max: ${numResults})`);

      // Execute search
      const results = await provider.search(query, numResults, searchAPIKey);

      // Increment search count
      integrationStore.incrementSearchCount();

      // Save settings to persist the incremented count
      try {
        await integrationStore.saveSettings();
      } catch (saveError) {
        // Log but don't fail the search if we can't persist the count
        logger.warn('[WebSearchTool] Failed to persist search count:', saveError);
      }

      logger.debug(`[WebSearchTool] Search returned ${results.length} results`);

      // Format results for return
      const formattedResults = results.map((r: SearchResult, index: number) => ({
        position: index + 1,
        title: r.title,
        url: r.url,
        snippet: r.snippet,
      }));

      return this.formatSuccessResponse({
        query,
        provider: searchProvider,
        result_count: results.length,
        results: formattedResults,
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Handle specific error types
      if (errorMessage.includes('Rate limit')) {
        return this.formatErrorResponse(
          'Search rate limit exceeded',
          'execution_error',
          'Wait a moment before trying again, or check your API plan limits'
        );
      }

      if (errorMessage.includes('Invalid') || errorMessage.includes('unauthorized') || errorMessage.includes('API key')) {
        return this.formatErrorResponse(
          'Invalid or unauthorized API key',
          'permission_error',
          'Check your API key and update with: ally --config-set search_api_key=YOUR_KEY'
        );
      }

      if (errorMessage.includes('timed out')) {
        return this.formatErrorResponse(
          'Search request timed out',
          'timeout_error',
          'The search service took too long to respond. Try again later.'
        );
      }

      if (errorMessage.includes('unavailable')) {
        return this.formatErrorResponse(
          'Search service is temporarily unavailable',
          'execution_error',
          'The search provider is experiencing issues. Try again later.'
        );
      }

      return this.formatErrorResponse(
        `Search failed: ${errorMessage}`,
        'system_error'
      );
    }
  }

  /**
   * Format subtext for display in UI
   */
  formatSubtext(args: Record<string, any>, _result?: any): string | null {
    const query = args.query as string;
    const description = args.description as string;

    if (!query) return description || null;

    const truncatedQuery = query.length > 50
      ? query.substring(0, 47) + '...'
      : query;

    if (description) {
      return `${description} ("${truncatedQuery}")`;
    }
    return `"${truncatedQuery}"`;
  }

  /**
   * Get parameters shown in subtext
   */
  getSubtextParameters(): string[] {
    return ['query', 'description'];
  }

  /**
   * Get truncation guidance
   */
  getTruncationGuidance(): string {
    return 'Use num_results parameter to limit the number of search results returned';
  }

  /**
   * Get estimated output size
   */
  getEstimatedOutputSize(): number {
    return TOOL_OUTPUT_ESTIMATES.DEFAULT;
  }

  /**
   * Custom result preview
   */
  getResultPreview(result: ToolResult, maxLines: number = 3): string[] {
    if (!result.success) {
      return super.getResultPreview(result, maxLines);
    }

    const lines: string[] = [];
    const resultCount = result.result_count as number;
    const provider = result.provider as string;
    const query = result.query as string;

    lines.push(`Found ${resultCount} result${resultCount !== 1 ? 's' : ''} for "${query}" (${provider})`);

    // Show first few results
    const results = result.results as Array<{ title: string; url: string }>;
    if (results && results.length > 0) {
      for (let i = 0; i < Math.min(results.length, maxLines - 1); i++) {
        const r = results[i];
        if (r) {
          const title = r.title.length > 60 ? r.title.substring(0, 57) + '...' : r.title;
          lines.push(`${i + 1}. ${title}`);
        }
      }
      if (results.length > maxLines - 1) {
        lines.push(`   ... and ${results.length - (maxLines - 1)} more`);
      }
    }

    return lines;
  }
}
