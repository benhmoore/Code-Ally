/**
 * ListSessionsTool - List all sessions with message counts
 *
 * Simple overview of available sessions for browsing
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { SessionManager } from '../services/SessionManager.js';
import { formatError } from '../utils/errorUtils.js';
import { formatRelativeTime } from '../ui/utils/timeUtils.js';

export class ListSessionsTool extends BaseTool {
  readonly name = 'list_sessions';
  readonly description =
    'List all conversation sessions with message counts. Useful for browsing available sessions before searching or asking questions.';
  readonly requiresConfirmation = false;
  readonly visibleInChat = false;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
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
            current_directory_only: {
              type: 'boolean',
              description: 'Only list sessions from current working directory (default: true)',
            },
            max_results: {
              type: 'integer',
              description: 'Maximum number of sessions to return (default: 20)',
            },
          },
          required: [],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    const currentDirectoryOnly = args.current_directory_only !== false; // default true
    const maxResults = (args.max_results as number) ?? 20;

    const registry = ServiceRegistry.getInstance();
    const sessionManager = registry.get<SessionManager>('session_manager');

    if (!sessionManager) {
      return {
        success: false,
        error: 'SessionManager not available',
      };
    }

    try {
      // Get sessions
      const sessions = currentDirectoryOnly
        ? await sessionManager.getSessionsInfoByDirectory()
        : await sessionManager.getSessionsInfo();

      if (sessions.length === 0) {
        return {
          success: true,
          error: '',
          output: currentDirectoryOnly
            ? 'No sessions found in current directory'
            : 'No sessions found',
        };
      }

      // Limit results
      const limitedSessions = sessions.slice(0, maxResults);

      // Format output
      const lines = limitedSessions.map(s => {
        const title = s.display_name || s.session_id;
        const time = formatRelativeTime(s.last_modified_timestamp);
        const messages = `${s.message_count} msg${s.message_count !== 1 ? 's' : ''}`;
        const dir = currentDirectoryOnly ? '' : ` (${s.working_dir})`;
        return `  - ${s.session_id}: ${title} - ${messages}, ${time}${dir}`;
      });

      const header = currentDirectoryOnly
        ? `Found ${limitedSessions.length} session(s) in current directory:`
        : `Found ${limitedSessions.length} session(s):`;

      const output = [header, ...lines].join('\n');

      return {
        success: true,
        error: '',
        output,
      };
    } catch (error) {
      return {
        success: false,
        error: formatError(error),
      };
    }
  }
}
