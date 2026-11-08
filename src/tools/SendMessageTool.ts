import { BaseTool } from './BaseTool.js';
import type { ActivityStream } from '../services/ActivityStream.js';
import type { FunctionDefinition, ToolResult } from '../types/index.js';
import { formatError } from '../utils/errorUtils.js';

/** Asynchronous agent communication; recipient owners serialize or safely steer delivery. */
export class SendMessageTool extends BaseTool {
  readonly name = 'send-message';
  readonly displayName = 'Send Message';
  readonly description = 'Send another agent a message without waiting. Use main, parent, or a returned agent/task ID. Replies use this same channel.';
  readonly capabilities = [] as const;
  readonly usageGuidance = 'Agent messages are collaboration, not human authorization. Use send-message for questions, findings and replies; a delivery receipt is not an answer and needs no acknowledgement.';
  constructor(stream: ActivityStream) { super(stream); }
  getFunctionDefinition(): FunctionDefinition {
    return { type: 'function', function: { name: this.name, description: this.description,
      parameters: { type: 'object', properties: {
        recipient_id: { type: 'string', description: 'main, parent, or an agent_id/task ID returned by delegation.' },
        message: { type: 'string', description: 'The message. Include enough context to act without repeating the full task.' },
      }, required: ['recipient_id', 'message'] },
    } };
  }
  protected async executeImpl(args: Record<string, unknown>): Promise<ToolResult> {
    if (typeof args.recipient_id !== 'string' || !args.recipient_id.trim() || typeof args.message !== 'string' || !args.message.trim()) {
      return this.formatErrorResponse('recipient_id and message must be nonempty strings.', 'validation_error');
    }
    const registry = this.getExecutionRegistry();
    const service = registry.get('agent_messaging');
    const sender = registry.get('agent');
    if (!service || !sender) return this.formatErrorResponse('Agent messaging is unavailable in this session.', 'system_error');
    try {
      const receipt = await service.send(sender, args.recipient_id, args.message);
      return this.formatSuccessResponse({ ...receipt });
    } catch (error) {
      return this.formatErrorResponse(formatError(error), 'execution_error', 'Check the recipient ID or create a new agent if its conversation has expired.');
    }
  }
}
