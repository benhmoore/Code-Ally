/**
 * SessionReadTool - Read detailed messages from a specific session
 *
 * Companion tool to SessionLookupTool for loading more context from promising sessions
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, Message } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { SessionManager } from '../services/SessionManager.js';
import { formatError } from '../utils/errorUtils.js';
import { formatRelativeTime } from '../ui/utils/timeUtils.js';
import { BUFFER_SIZES } from '../config/constants.js';

export class SessionReadTool extends BaseTool {
  readonly name = 'session_read';
  readonly description =
    'Read detailed messages from a specific session found via session_lookup. Use this to get more context when session_lookup snippets are insufficient. Can load specific message ranges or full sessions.';
  readonly requiresConfirmation = false;
  readonly visibleInChat = false; // Don't clutter chat with session reads

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
            session_id: {
              type: 'string',
              description: 'Session ID from session_lookup results',
            },
            start_index: {
              type: 'integer',
              description: 'Start reading from this message index (0-based, inclusive)',
            },
            end_index: {
              type: 'integer',
              description: 'Stop reading at this message index (0-based, inclusive)',
            },
            load_full: {
              type: 'boolean',
              description: 'Load entire session (default: false, use range instead)',
            },
          },
          required: ['session_id'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    const sessionId = args.session_id as string;
    const startIndex = args.start_index as number | undefined;
    const endIndex = args.end_index as number | undefined;
    const loadFull = args.load_full === true;

    if (!sessionId) {
      return {
        success: false,
        error: 'session_id is required',
      };
    }

    const registry = ServiceRegistry.getInstance();
    const sessionManager = registry.get<SessionManager>('session_manager');

    if (!sessionManager) {
      return {
        success: false,
        error: 'SessionManager not available',
      };
    }

    try {
      const session = await sessionManager.loadSession(sessionId);

      if (!session) {
        return {
          success: false,
          error: `Session "${sessionId}" not found`,
        };
      }

      // Filter out system messages
      const messages = session.messages.filter(m => m.role !== 'system');

      if (messages.length === 0) {
        return {
          success: true,
          error: '',
          output: `Session "${sessionId}" has no user/assistant messages`,
          messages: [],
        };
      }

      // Determine which messages to return
      let selectedMessages: Message[];
      let rangeDescription: string;

      if (loadFull) {
        selectedMessages = messages;
        rangeDescription = `all ${messages.length} messages`;
      } else if (startIndex !== undefined || endIndex !== undefined) {
        const start = startIndex ?? 0;
        const end = endIndex !== undefined ? endIndex + 1 : messages.length;

        if (start < 0 || start >= messages.length) {
          return {
            success: false,
            error: `start_index ${start} is out of range (0-${messages.length - 1})`,
          };
        }

        if (end < start) {
          return {
            success: false,
            error: `end_index must be >= start_index`,
          };
        }

        selectedMessages = messages.slice(start, Math.min(end, messages.length));
        rangeDescription = `messages ${start}-${Math.min(end - 1, messages.length - 1)}`;
      } else {
        // Default: return first 10 messages
        selectedMessages = messages.slice(0, BUFFER_SIZES.DEFAULT_LIST_PREVIEW);
        rangeDescription = `first ${Math.min(BUFFER_SIZES.DEFAULT_LIST_PREVIEW, messages.length)} messages`;
      }

      const relativeTime = formatRelativeTime(session.updated_at);

      return {
        success: true,
        error: '',
        output: `Session "${session.metadata?.title || sessionId}" (${relativeTime}, ${session.working_dir})\nLoaded ${rangeDescription} of ${messages.length} total`,
        session_id: sessionId,
        display_name: session.metadata?.title || sessionId,
        working_dir: session.working_dir,
        total_messages: messages.length,
        messages: selectedMessages,
      };
    } catch (error) {
      return {
        success: false,
        error: formatError(error),
      };
    }
  }
}
