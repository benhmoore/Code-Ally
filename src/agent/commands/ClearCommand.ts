/**
 * ClearCommand - Clear conversation history
 *
 * Removes all messages from the conversation except the system message,
 * clears the UI view completely, and updates the token manager accordingly.
 */

import { Command } from './Command.js';
import { ActivityEventType } from '@shared/index.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { Agent } from '../Agent.js';
import type { ActivityStream } from '@services/ActivityStream.js';

export class ClearCommand extends Command {
  readonly name = '/clear';
  readonly description = 'Clear conversation history';

  // Use yellow output for simple status messages
  protected readonly useYellowOutput = true;

  async execute(
    _args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // Get agent from service registry
    const agent = serviceRegistry.get<Agent>('agent');

    if (!agent) {
      return this.createError('Agent not available');
    }

    // Get system message if it exists
    const messages = agent.getMessagesCopy();
    const systemMessage = messages.find(m => m.role === 'system');

    // Keep only system message
    const clearedMessages = systemMessage ? [systemMessage] : [];
    agent.setMessages(clearedMessages);

    // Update token manager
    const tokenManager = serviceRegistry.get('token_manager');
    if (tokenManager && typeof (tokenManager as any).updateTokenCount === 'function') {
      (tokenManager as any).updateTokenCount(clearedMessages);
    }

    // Emit event to reset the UI view completely
    const activityStream = serviceRegistry.get<ActivityStream>('activity_stream');
    if (activityStream) {
      activityStream.emit({
        id: `clear-${Date.now()}`,
        type: ActivityEventType.CONVERSATION_CLEAR,
        timestamp: Date.now(),
        data: {},
      });
    }

    // Return silent success - UI will be completely reset so no message needed
    return this.createSilentResponse();
  }
}
