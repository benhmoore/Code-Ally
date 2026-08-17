import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';

const PAGE_MESSAGES = 50;
const PAGE_BYTES = 256 * 1024;
const DISPLAY_MESSAGE_CHARS = 4000;

export class HistoryCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/history',
    description: 'Read transcript history in bounded pages',
    helpCategory: 'Core',
    subcommands: [
      { name: 'older', description: 'Load the next older page' },
      { name: 'latest', description: 'Return to the newest page' },
    ],
  };

  static { CommandRegistry.register(HistoryCommand.metadata); }

  readonly name = HistoryCommand.metadata.name;
  readonly description = HistoryCommand.metadata.description;
  private readonly cursors = new Map<string, number | undefined>();

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry,
  ): Promise<CommandResult> {
    const sessionManager = serviceRegistry.get('session_manager');
    if (!sessionManager) return this.createError('Session history is not available');
    const sessionId = sessionManager.getCurrentSession();
    if (!sessionId) return this.createError('No active session');

    const action = args[0]?.toLowerCase() ?? 'older';
    if (action !== 'older' && action !== 'latest') {
      return this.createError('Usage: /history [older|latest]');
    }
    if (action === 'latest') this.cursors.delete(sessionId);
    const cursor = this.cursors.get(sessionId);
    const page = await sessionManager.getTranscriptPage(sessionId, cursor, PAGE_MESSAGES, PAGE_BYTES);
    this.cursors.set(sessionId, page.nextCursor ?? 0);
    if (this.cursors.size > 20) this.cursors.delete(this.cursors.keys().next().value!);

    if (page.messages.length === 0) {
      return this.createResponse('No older transcript messages.');
    }
    const firstIndex = (page.nextCursor ?? 0) + 1;
    const lastIndex = firstIndex + page.messages.length - 1;
    const lines = page.messages.map((message) => {
      const label = message.role === 'tool'
        ? `tool${message.name ? `:${message.name}` : ''}`
        : message.role;
      const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      const content = raw.length > DISPLAY_MESSAGE_CHARS
        ? `${raw.slice(0, DISPLAY_MESSAGE_CHARS)}\n… [message clipped for history view]`
        : raw;
      return `**${label}**\n${content}`;
    });
    const older = page.nextCursor === null ? 'start of transcript' : 'use `/history older` for the previous page';
    return this.createResponse(
      `Transcript ${firstIndex}–${lastIndex} of ${page.totalMessages} (${older})\n\n${lines.join('\n\n')}`
    );
  }
}
