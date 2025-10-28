/**
 * AskSessionTool - Ask specific questions about past sessions
 *
 * Uses LLM to answer questions about session content. Complements session_lookup
 * and session_read by allowing targeted queries without loading full sessions.
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition, Message } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { SessionManager } from '../services/SessionManager.js';
import { ModelClient } from '../llm/ModelClient.js';
import { formatError } from '../utils/errorUtils.js';
import { formatSessionForQuery } from '../utils/sessionUtils.js';

export class AskSessionTool extends BaseTool {
  readonly name = 'ask_session';
  readonly description =
    'Ask a specific question about a past session. Use after session_lookup to query session content without reading the full transcript. Useful for "How did we solve X?", "What was the outcome of Y?", etc.';
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
            session_id: {
              type: 'string',
              description: 'Session ID from session_lookup results',
            },
            question: {
              type: 'string',
              description: 'Specific question to ask about the session',
            },
          },
          required: ['session_id', 'question'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    const sessionId = args.session_id as string;
    const question = args.question as string;

    if (!sessionId) {
      return {
        success: false,
        error: 'session_id is required',
      };
    }

    if (!question) {
      return {
        success: false,
        error: 'question is required',
      };
    }

    const registry = ServiceRegistry.getInstance();
    const sessionManager = registry.get<SessionManager>('session_manager');
    const serviceModelClient = registry.get<ModelClient>('service_model_client');

    if (!sessionManager) {
      return {
        success: false,
        error: 'SessionManager not available',
      };
    }

    if (!serviceModelClient) {
      return {
        success: false,
        error: 'Service model client not available',
      };
    }

    try {
      // Load session
      const session = await sessionManager.loadSession(sessionId);

      if (!session) {
        return {
          success: false,
          error: `Session "${sessionId}" not found`,
        };
      }

      // Format session content for LLM query
      const formattedSession = formatSessionForQuery(session);

      // Build query prompt
      const systemPrompt = `You are analyzing a past conversation session. Answer the question based ONLY on the session content provided. Be concise and specific.`;

      const userPrompt = `<session_content>
${formattedSession}
</session_content>

<question>
${question}
</question>

Answer the question based on the session content above. Be direct and concise.`;

      const messages: Message[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      // Query LLM
      const response = await serviceModelClient.send(messages, {
        stream: false,
      });

      if (!response || !response.content) {
        return {
          success: false,
          error: 'No response from model',
        };
      }

      const displayTitle = session.metadata?.title || sessionId;

      return {
        success: true,
        error: '',
        output: `Session: "${displayTitle}"\n\n${response.content}`,
      };
    } catch (error) {
      return {
        success: false,
        error: formatError(error),
      };
    }
  }
}
