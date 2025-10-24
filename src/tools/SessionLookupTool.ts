/**
 * SessionLookupTool - Search through past sessions for relevant conversations
 *
 * Helps answer questions like "How did we fix this before?" or "Haven't we tried this?"
 */

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { SessionManager } from '../services/SessionManager.js';
import { formatError } from '../utils/errorUtils.js';
import { formatRelativeTime } from '../ui/utils/timeUtils.js';

interface MessageSnippet {
  message_index: number;
  role: 'user' | 'assistant';
  content: string;
  match_preview: string;
}

interface SearchResult {
  session_id: string;
  display_name: string;
  working_dir: string;
  match_count: number;
  last_modified_timestamp: number;
  message_snippets: MessageSnippet[];
}

export class SessionLookupTool extends BaseTool {
  readonly name = 'session_lookup';
  readonly description =
    'Search through past conversation sessions. Use this when the user asks about previous work (e.g., "what was our last conversation?", "how did we fix X before?"). Provide keywords array to search (supports multiple keywords with "any" or "all" mode), or omit keywords to get most recent sessions by time. Returns matching sessions with optional message snippets.';
  readonly requiresConfirmation = false;
  readonly visibleInChat = false; // Don't clutter chat with session lookups

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
            keywords: {
              type: 'array',
              description: 'List of keywords to search for in past sessions. Can be a single keyword or multiple. Omit to get most recent sessions without filtering.',
              items: {
                type: 'string',
              },
            },
            search_mode: {
              type: 'string',
              description: 'How to match keywords: "any" (match any keyword, OR logic) or "all" (match all keywords, AND logic). Default: "any"',
            },
            max_results: {
              type: 'integer',
              description: 'Maximum number of sessions to return (default: 5)',
            },
            current_directory_only: {
              type: 'boolean',
              description: 'Only search sessions from current working directory (default: true)',
            },
            min_messages: {
              type: 'integer',
              description: 'Minimum number of messages in session to consider (default: 3)',
            },
          },
          required: [],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    const keywords = (args.keywords as string[]) ?? [];
    const searchMode = (args.search_mode as 'any' | 'all') ?? 'any';
    const maxResults = (args.max_results as number) ?? 5;
    const currentDirectoryOnly = args.current_directory_only !== false; // default true
    const minMessages = (args.min_messages as number) ?? 3;
    const hasKeywords = keywords.length > 0;

    const registry = ServiceRegistry.getInstance();
    const sessionManager = registry.get<SessionManager>('session_manager');

    if (!sessionManager) {
      return {
        success: false,
        error: 'SessionManager not available',
      };
    }

    try {
      // Get sessions to search
      const sessions = currentDirectoryOnly
        ? await sessionManager.getSessionsInfoByDirectory()
        : await sessionManager.getSessionsInfo();

      // Filter by min_messages
      const filteredSessions = sessions.filter(s => s.message_count >= minMessages);

      // If no keywords, return most recent sessions without keyword search
      if (!hasKeywords) {
        const recentSessions = filteredSessions
          .slice(0, maxResults)
          .map(s => ({
            session_id: s.session_id,
            display_name: s.display_name,
            working_dir: s.working_dir,
            match_count: 0,
            last_modified_timestamp: s.last_modified_timestamp,
            message_snippets: [],
          }));

        if (recentSessions.length === 0) {
          return {
            success: true,
            error: '',
            output: 'No sessions found',
            sessions: [],
          };
        }

        // Format output with session details
        const sessionList = recentSessions
          .map(s => `  - ${s.session_id}: ${s.display_name} (${formatRelativeTime(s.last_modified_timestamp)}, ${s.working_dir})`)
          .join('\n');

        return {
          success: true,
          error: '',
          output: `Found ${recentSessions.length} recent session(s):\n${sessionList}`,
          sessions: recentSessions,
        };
      }

      // Keyword search through session messages
      const searchResults: SearchResult[] = [];
      const keywordsLower = keywords.map(k => k.toLowerCase());

      for (const sessionInfo of filteredSessions) {
        const session = await sessionManager.loadSession(sessionInfo.session_id);
        if (!session) continue;

        const snippets: MessageSnippet[] = [];
        let matchCount = 0;
        const matchedKeywords = new Set<string>();

        // Search through messages
        for (let i = 0; i < session.messages.length; i++) {
          const message = session.messages[i];
          if (!message || message.role === 'system' || message.role === 'tool' || !message.content) continue;

          const contentLower = message.content.toLowerCase();

          // Check keyword matches based on search mode
          const keywordMatches = keywordsLower.filter(kw => contentLower.includes(kw));

          if (keywordMatches.length > 0) {
            // Track which keywords matched (for "all" mode)
            keywordMatches.forEach(kw => matchedKeywords.add(kw));
            matchCount++;

            // Extract snippet around first matching keyword
            const firstMatch = keywordMatches[0];
            if (firstMatch) {
              const matchIndex = contentLower.indexOf(firstMatch);
              const snippetStart = Math.max(0, matchIndex - 100);
              const snippetEnd = Math.min(message.content.length, matchIndex + firstMatch.length + 100);
              const snippet = message.content.slice(snippetStart, snippetEnd);

              // Create preview with ellipsis
              const preview = (snippetStart > 0 ? '...' : '') +
                snippet +
                (snippetEnd < message.content.length ? '...' : '');

              snippets.push({
                message_index: i,
                role: message.role as 'user' | 'assistant',
                content: preview,
                match_preview: message.content.slice(matchIndex, matchIndex + firstMatch.length + 50),
              });

              // Limit snippets per session to avoid overwhelming context
              if (snippets.length >= 3) break;
            }
          }
        }

        // For "all" mode, only include session if all keywords matched
        const shouldInclude = searchMode === 'any'
          ? matchCount > 0
          : matchedKeywords.size === keywordsLower.length;

        if (shouldInclude) {
          searchResults.push({
            session_id: sessionInfo.session_id,
            display_name: sessionInfo.display_name,
            working_dir: sessionInfo.working_dir,
            match_count: matchCount,
            last_modified_timestamp: sessionInfo.last_modified_timestamp,
            message_snippets: snippets,
          });
        }
      }

      // Sort by match count (desc), then by recency (desc)
      searchResults.sort((a, b) => {
        if (b.match_count !== a.match_count) {
          return b.match_count - a.match_count;
        }
        return b.last_modified_timestamp - a.last_modified_timestamp;
      });

      // Limit results
      const limitedResults = searchResults.slice(0, maxResults);

      const keywordDisplay = keywords.length === 1 ? `"${keywords[0]}"` : `[${keywords.join(', ')}]`;
      const modeDisplay = searchMode === 'all' ? ' (all keywords)' : ' (any keyword)';

      if (limitedResults.length === 0) {
        return {
          success: true,
          error: '',
          output: `No sessions found matching ${keywordDisplay}${keywords.length > 1 ? modeDisplay : ''}`,
          sessions: [],
        };
      }

      // Format output with session details
      const sessionList = limitedResults
        .map(s => `  - ${s.session_id}: ${s.display_name} (${s.match_count} matches, ${formatRelativeTime(s.last_modified_timestamp)}, ${s.working_dir})`)
        .join('\n');

      return {
        success: true,
        error: '',
        output: `Found ${limitedResults.length} session(s) matching ${keywordDisplay}${keywords.length > 1 ? modeDisplay : ''}:\n${sessionList}`,
        sessions: limitedResults,
      };
    } catch (error) {
      return {
        success: false,
        error: formatError(error),
      };
    }
  }
}
