/**
 * ClearCommand - Clear conversation history
 *
 * Removes all messages from the conversation except the system message,
 * and updates the token manager accordingly.
 */

import { Command } from './Command.js';
import type { Message } from '../../types/index.js';
import type { ServiceRegistry } from '../../services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { Agent } from '../Agent.js';

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
    const messages = agent.getMessages();
    const systemMessage = messages.find(m => m.role === 'system');

    // Keep only system message
    const clearedMessages = systemMessage ? [systemMessage] : [];
    agent.setMessages(clearedMessages);

    // Update token manager
    const tokenManager = serviceRegistry.get('token_manager');
    if (tokenManager && typeof (tokenManager as any).updateTokenCount === 'function') {
      (tokenManager as any).updateTokenCount(clearedMessages);
    }

    return this.createResponse('Conversation history cleared.');
  }
}
