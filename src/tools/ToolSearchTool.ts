/**
 * ToolSearchTool - Load the full definition of a deferred tool
 *
 * On a small context window most tool schemas are advertised by name rather
 * than transmitted in full. This tool turns an advertised name into a loaded,
 * callable definition: it returns the matching schemas and marks them active
 * so subsequent requests include them.
 */

import { BaseTool } from './BaseTool.js';
import { ToolExecutionContext, ToolResult, FunctionDefinition, ErrorType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';

const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CEILING = 15;

export class ToolSearchTool extends BaseTool {
  readonly name = 'tool-search';
  readonly description =
    'Load the full definition of a tool that is available but not currently loaded. '
    + 'Use "select:name" for an exact tool, or keywords to find one. After loading, call the tool normally.';
  readonly capabilities = [] as const;
  readonly isExploratoryTool = true;
  readonly requiresConfirmationDefault = false;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  requiresConfirmation(): boolean {
    return false;
  }

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
              description: 'Exact names as "select:name1,name2", or keywords to search for.',
            },
            max_results: {
              type: 'number',
              description: `Maximum tools to load (default ${DEFAULT_MAX_RESULTS}).`,
            },
          },
          required: ['query'],
        },
      },
    };
  }

  validateArgs(args: Record<string, unknown>): { valid: boolean; error?: string; error_type?: ErrorType; suggestion?: string } | null {
    if (typeof args.query !== 'string' || args.query.trim().length === 0) {
      return {
        valid: false,
        error: 'query must be a non-empty string',
        error_type: 'validation_error',
        suggestion: 'Example: tool-search(query="select:web-fetch") or tool-search(query="browser screenshot")',
      };
    }
    return null;
  }

  protected async executeImpl(
    args: Record<string, unknown>,
    _callId?: string,
    _isUserInitiated?: boolean,
    _isContextFile?: boolean,
    executionContext?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const validation = this.validateArgs(args);
    if (validation) {
      return this.formatErrorResponse(validation.error!, validation.error_type, validation.suggestion);
    }

    const query = String(args.query).trim();
    const maxResults = Math.min(
      MAX_RESULTS_CEILING,
      Math.max(1, Number(args.max_results) || DEFAULT_MAX_RESULTS),
    );

    const registry = this.getExecutionRegistry(executionContext);
    const toolManager = registry.get('tool_manager');
    if (!toolManager) {
      return this.formatErrorResponse('Tool registry unavailable', 'execution_error');
    }

    // Search the complete surface, not the currently transmitted one — the
    // whole point is to reach tools whose schemas were withheld.
    const all: FunctionDefinition[] = toolManager.getFunctionDefinitions(
      undefined,
      undefined,
      undefined,
    );

    const matches = this.match(all, query, maxResults);
    if (matches.length === 0) {
      const names = all.map(d => d.function.name).sort().join(', ');
      return this.formatErrorResponse(
        `No tool matches "${query}".`,
        'validation_error',
        `Available tools: ${names}`,
      );
    }

    const activated = matches.map(definition => definition.function.name);
    registry.get('tool_activation_registry')
      ?.activate(this.getReadScopeId(executionContext), activated);

    const content = [
      `Loaded ${activated.length} tool(s): ${activated.join(', ')}. They are callable now.`,
      '',
      ...matches.map(definition => JSON.stringify(definition)),
    ].join('\n');

    return {
      success: true,
      error: '',
      content,
      tools_loaded: activated,
    } as ToolResult;
  }

  /** `select:` selects exact names; otherwise rank by keyword overlap. */
  private match(all: FunctionDefinition[], query: string, maxResults: number): FunctionDefinition[] {
    if (query.toLowerCase().startsWith('select:')) {
      const wanted = query
        .slice('select:'.length)
        .split(',')
        .map(name => name.trim().toLowerCase())
        .filter(Boolean);
      return all.filter(definition => wanted.includes(definition.function.name.toLowerCase()));
    }

    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return all
      .map(definition => {
        const name = definition.function.name.toLowerCase();
        const description = (definition.function.description ?? '').toLowerCase();
        let score = 0;
        for (const term of terms) {
          if (name === term) score += 10;
          else if (name.includes(term)) score += 5;
          if (description.includes(term)) score += 1;
        }
        return { definition, score };
      })
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults)
      .map(entry => entry.definition);
  }

  formatSubtext(args: Record<string, any>, result?: any): string | null {
    const loaded = result?.tools_loaded as string[] | undefined;
    if (loaded?.length) return `loaded ${loaded.join(', ')}`;
    return args.query ? `search "${args.query}"` : null;
  }
}
