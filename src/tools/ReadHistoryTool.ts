import { BaseTool } from './BaseTool.js';
import { ToolCapability } from './ToolCapability.js';
import { tokenCounter } from '../services/TokenCounter.js';
import type { FunctionDefinition, ToolExecutionContext, ToolResult } from '../types/index.js';

interface HistoryArgs {
  session_id?: string;
  before?: number;
  message_id?: string;
  offset?: number;
  role?: 'user' | 'assistant' | 'tool' | 'all';
}

/** Bounded access to the root conversation's existing canonical archive. */
export class ReadHistoryTool extends BaseTool {
  readonly name = 'read-history';
  readonly description = 'Retrieve original messages from this session, including before compaction. Defaults to user requests, newest first. Follow returned cursors to recover complete earlier requirements; newer requests supersede conflicting older ones.';
  readonly capabilities = [ToolCapability.FsRead] as const;
  readonly mainAgentOnly = true;
  readonly isExploratoryTool = true;

  getFunctionDefinition(): FunctionDefinition {
    return { type: 'function', function: {
      name: this.name, description: this.description,
      parameters: { type: 'object', properties: {
        session_id: { type: 'string', description: 'Identity returned by the first page; required for continuation.' },
        before: { type: 'integer', description: 'Exclusive transcript index. Use next_before from the previous response.' },
        message_id: { type: 'string', description: 'Message identity returned with a partial message; required when offset is nonzero.' },
        offset: { type: 'integer', description: 'Unicode character offset; use next_offset when continuing a partial message.' },
        role: { type: 'string', enum: ['user', 'assistant', 'tool', 'all'], description: 'Message role filter; default user. Keep unchanged while paging.' },
      } },
    } };
  }

  protected async executeImpl(
    args: HistoryArgs, _callId?: string, _userInitiated?: boolean, _contextFile?: boolean,
    executionContext?: ToolExecutionContext,
  ): Promise<ToolResult> {
    const offset = args.offset ?? 0;
    const role = args.role ?? 'user';
    if (!['user', 'assistant', 'tool', 'all'].includes(role)
      || !Number.isSafeInteger(offset) || offset < 0
      || (args.before !== undefined && (!Number.isSafeInteger(args.before) || args.before < 0 || !args.session_id))
      || (offset > 0 && (!args.message_id || args.before === undefined || !args.session_id))) {
      return this.formatErrorResponse('Invalid history cursor.', 'validation_error', 'Use the cursor and identities returned by the previous page.');
    }
    const sessions = this.getExecutionRegistry(executionContext).get('session_manager');
    const sessionId = sessions?.getCurrentSession();
    if (!sessions || !sessionId) return this.formatErrorResponse('No persisted session is available.', 'validation_error');
    if (args.session_id && args.session_id !== sessionId) {
      return this.formatErrorResponse('The active session changed. Restart history retrieval.', 'validation_error');
    }
    const page = await sessions.getTranscriptPage(sessionId, args.before, 100, 128 * 1024);
    if (sessions.getCurrentSession() !== sessionId) {
      return this.formatErrorResponse('The active session changed. Restart history retrieval.', 'validation_error');
    }
    const start = page.nextCursor ?? 0;
    const budget = this.getOutputTokenAllowance(1024, executionContext);
    const index = page.messages.findLastIndex(message => role === 'all' || message.role === role);
    if (index < 0) {
      if (offset > 0) return this.formatErrorResponse('The history message changed. Restart retrieval.', 'validation_error');
      const result = this.formatSuccessResponse({ session_id: sessionId, content: '', next_before: page.nextCursor, next_offset: null });
      return tokenCounter.count(JSON.stringify(result)) <= budget
        ? { ...result, _non_truncatable: true }
        : this.formatErrorResponse('Insufficient output budget for a history cursor.', 'validation_error');
    }
    const message = page.messages[index]!;
    if (args.message_id && args.message_id !== message.id) {
      return this.formatErrorResponse('The history message changed. Restart retrieval.', 'validation_error');
    }
    const characters = Array.from(message.content);
    if (offset > characters.length) return this.formatErrorResponse('Offset exceeds message length.', 'validation_error');
    let count = Math.min(2000, characters.length - offset);
    while (true) {
      const end = offset + count;
      const partial = end < characters.length;
      const result = this.formatSuccessResponse({
        session_id: sessionId, message_id: message.id, role: message.role,
        content: characters.slice(offset, end).join(''), offset,
        total_characters: characters.length,
        next_before: partial ? start + index + 1 : (start + index || null),
        next_offset: partial ? end : null,
      });
      if (tokenCounter.count(JSON.stringify(result)) <= budget) return { ...result, _non_truncatable: true };
      if (count <= 1) return this.formatErrorResponse('Insufficient output budget for a history page.', 'validation_error', 'Read history separately from other tool calls.');
      count = Math.floor(count / 2);
    }
  }
}
