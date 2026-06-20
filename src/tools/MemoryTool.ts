/**
 * MemoryTool - Autonomous long-term memory for the agent
 *
 * Lets Ally persist and recall durable facts about a project without user
 * intervention. Writes are silent (no confirmation) because memory lives
 * privately under ~/.ally, never in the working tree. The tool owns the
 * frontmatter contract and keeps MEMORY.md in sync via MemoryService, so the
 * model never has to maintain an index by hand.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, ToolExecutionContext } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import {
  MemoryService,
  MemoryType,
  MEMORY_TYPES,
  MemoryValidationError,
  MemoryRecord,
} from '../services/MemoryService.js';

const ACTIONS = ['save', 'update', 'delete', 'recall', 'list'] as const;
type MemoryAction = (typeof ACTIONS)[number];

export class MemoryTool extends BaseTool {
  readonly name = 'memory';
  readonly description =
    'Persist or recall durable facts about this project across sessions. ' +
    'Save things worth remembering autonomously (user preferences, feedback on how to work, ' +
    'project constraints not derivable from the code, external references). ' +
    'Memory is private and stored outside the repo. ' +
    'Actions: save/update (upsert a fact), delete (remove one), recall (fetch by name or relevance), list (all).';
  readonly requiresConfirmation = false;
  readonly displayColor = 'cyan';
  // Only the main assistant curates long-term memory; sub-agents never see this tool.
  readonly mainAgentOnly = true;
  // Behavioral policy (when to save, restraint, taxonomy) lives in one place:
  // MEMORY_GUIDELINES in CORE_DIRECTIVES. Not duplicated here to save per-turn context.

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  validateArgs(args: Record<string, unknown>): { valid: boolean; error?: string; error_type?: string; suggestion?: string } | null {
    const action = args.action;
    if (typeof action !== 'string' || !ACTIONS.includes(action as MemoryAction)) {
      return {
        valid: false,
        error: `Invalid or missing action. Expected one of: ${ACTIONS.join(', ')}.`,
        error_type: 'validation_error',
        suggestion: 'Example: action="save", name="use-npm-not-yarn", description="...", type="project", body="..."',
      };
    }

    if (action === 'save' || action === 'update') {
      const missing = ['name', 'description', 'type', 'body'].filter(
        field => typeof args[field] !== 'string' || (args[field] as string).trim() === '',
      );
      if (missing.length > 0) {
        return {
          valid: false,
          error: `Memory ${action} requires non-empty: ${missing.join(', ')}.`,
          error_type: 'validation_error',
          suggestion: 'Provide name (kebab-case), description (one line), type, and body.',
        };
      }
      if (!MEMORY_TYPES.includes(args.type as MemoryType)) {
        return {
          valid: false,
          error: `Invalid type "${String(args.type)}". Expected one of: ${MEMORY_TYPES.join(', ')}.`,
          error_type: 'validation_error',
          suggestion: 'user = who the user is; feedback = how to work; project = project facts; reference = external pointers.',
        };
      }
    }

    if (action === 'delete' && (typeof args.name !== 'string' || args.name.trim() === '')) {
      return {
        valid: false,
        error: 'Memory delete requires a name.',
        error_type: 'validation_error',
        suggestion: 'Pass the name of the memory to remove (see action="list").',
      };
    }

    if (action === 'recall' && (typeof args.name !== 'string' || args.name.trim() === '') && (typeof args.query !== 'string' || args.query.trim() === '')) {
      return {
        valid: false,
        error: 'Memory recall requires either a name or a query.',
        error_type: 'validation_error',
        suggestion: 'Pass name="..." for an exact entry, or query="..." to search by relevance.',
      };
    }

    return null;
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
            action: {
              type: 'string',
              enum: [...ACTIONS],
              description: 'save or update (upsert), delete, recall, or list.',
            },
            name: {
              type: 'string',
              description: 'Kebab-case identifier (e.g. "use-npm-not-yarn"). Required for save/update/delete; optional for recall.',
            },
            description: {
              type: 'string',
              description: 'One-line summary used for the index and relevance matching. Required for save/update.',
            },
            type: {
              type: 'string',
              enum: [...MEMORY_TYPES],
              description: 'user (who the user is), feedback (how to work — include why), project (project facts), or reference (external pointers).',
            },
            body: {
              type: 'string',
              description: 'The fact itself (Markdown). Required for save/update.',
            },
            query: {
              type: 'string',
              description: 'Free-text query for recall by relevance.',
            },
          },
          required: ['action'],
        },
      },
    };
  }

  protected async executeImpl(
    args: any,
    _toolCallId?: string,
    _isUserInitiated?: boolean,
    _isContextFile?: boolean,
    executionContext?: ToolExecutionContext,
  ): Promise<ToolResult> {
    this.captureParams(args);

    const memoryService = this.getExecutionRegistry(executionContext).get<MemoryService>('memory_service');
    if (!memoryService) {
      return this.formatErrorResponse(
        'Memory service is not available.',
        'system_error',
        'Memory persistence is disabled in this environment.',
      );
    }

    const action = args.action as MemoryAction;

    try {
      switch (action) {
        case 'save':
        case 'update':
          return await this.handleSave(memoryService, args);
        case 'delete':
          return await this.handleDelete(memoryService, args);
        case 'recall':
          return await this.handleRecall(memoryService, args);
        case 'list':
          return await this.handleList(memoryService);
        default:
          return this.formatErrorResponse(`Unknown action "${action}".`, 'validation_error');
      }
    } catch (error) {
      if (error instanceof MemoryValidationError) {
        return this.formatErrorResponse(error.message, 'validation_error');
      }
      throw error;
    }
  }

  private async handleSave(memoryService: MemoryService, args: any): Promise<ToolResult> {
    const { name, created } = await memoryService.save({
      name: args.name,
      description: args.description,
      type: args.type,
      body: args.body,
    });

    return this.formatSuccessResponse({
      action: created ? 'saved' : 'updated',
      name,
      content: `Memory ${created ? 'saved' : 'updated'}: ${name}`,
    });
  }

  private async handleDelete(memoryService: MemoryService, args: any): Promise<ToolResult> {
    const removed = await memoryService.delete(args.name);
    if (!removed) {
      return this.formatErrorResponse(
        `No memory named "${args.name}".`,
        'validation_error',
        'Use action="list" to see existing memories.',
      );
    }
    return this.formatSuccessResponse({ action: 'deleted', name: args.name, content: `Memory deleted: ${args.name}` });
  }

  private async handleRecall(memoryService: MemoryService, args: any): Promise<ToolResult> {
    const records = await memoryService.recall({ name: args.name, query: args.query });
    if (records.length === 0) {
      return this.formatSuccessResponse({
        action: 'recall',
        count: 0,
        content: args.name ? `No memory named "${args.name}".` : 'No memories matched.',
      });
    }
    return this.formatSuccessResponse({
      action: 'recall',
      count: records.length,
      content: records.map(formatRecord).join('\n\n'),
    });
  }

  private async handleList(memoryService: MemoryService): Promise<ToolResult> {
    const records = await memoryService.list();
    const content = records.length === 0
      ? 'No memories yet.'
      : records.map(r => `- ${r.name} (${r.type}): ${r.description}`).join('\n');
    return this.formatSuccessResponse({ action: 'list', count: records.length, content });
  }

  formatSubtext(args: Record<string, any>, _result?: any): string | null {
    if (args.description && args.action !== 'save' && args.action !== 'update') {
      return args.description;
    }
    switch (args.action) {
      case 'save':
      case 'update':
        return args.name ? `Remembered: ${args.name}` : 'Remembering';
      case 'delete':
        return args.name ? `Forgot: ${args.name}` : 'Forgetting';
      case 'recall':
        return args.name ? `Recall: ${args.name}` : args.query ? `Recall: ${args.query}` : 'Recall';
      case 'list':
        return 'List memories';
      default:
        return null;
    }
  }

  getSubtextParameters(): string[] {
    return ['description', 'action', 'name', 'query'];
  }
}

/** Render a recalled record as frontmatter-free, readable text. */
function formatRecord(record: MemoryRecord): string {
  return `## ${record.name} (${record.type})\n${record.description}\n\n${record.body}`;
}
