/**
 * CompactCommand - Compact conversation context
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import { CommandRegistry } from './CommandRegistry.js';
import type { CommandMetadata } from './types.js';
import { ActivityEventType } from '@shared/index.js';
import { BUFFER_SIZES } from '../../config/constants.js';
import { CONTEXT_THRESHOLDS } from '../../config/toolDefaults.js';

export class CompactCommand extends Command {
  static readonly metadata: CommandMetadata = {
    name: '/compact',
    description: 'Compact conversation context',
    helpCategory: 'Core',
    subcommands: [
      { name: '<instructions>', description: 'Custom compaction instructions' },
    ],
  };

  static {
    CommandRegistry.register(CompactCommand.metadata);
  }

  readonly name = CompactCommand.metadata.name;
  readonly description = CompactCommand.metadata.description;

  async execute(
    args: string[],
    messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    // Get agent from service registry
    const agent = serviceRegistry.get('agent');

    if (!agent) {
      return {
        handled: true,
        response: 'Error: Agent not available for compaction',
      };
    }

    // Check if we have enough messages
    if (messages.length < BUFFER_SIZES.MIN_MESSAGES_TO_ATTEMPT_COMPACTION) {
      return {
        handled: true,
        response: `Not enough messages to compact (only ${messages.length} messages). Need at least ${BUFFER_SIZES.MIN_MESSAGES_TO_ATTEMPT_COMPACTION} messages.`,
      };
    }

    // Extract custom instructions if provided
    const customInstructions = args.join(' ').trim() || undefined;

    try {
      const activityStream = serviceRegistry.get('activity_stream');
      if (!activityStream || typeof (activityStream as any).emit !== 'function') {
        throw new Error('Activity stream not available');
      }

      // Emit compaction start event
      (activityStream as any).emit({
        id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        type: ActivityEventType.COMPACTION_START,
        timestamp: Date.now(),
        data: {},
      });

      // Get context usage before compaction
      const tokenManager = serviceRegistry.get('token_manager');
      const oldContextUsage = tokenManager && typeof (tokenManager as any).getContextUsagePercentage === 'function'
        ? (tokenManager as any).getContextUsagePercentage()
        : 0;

      // Perform compaction
      const compactedMessages = await (agent as any).compactConversation((agent as any).getMessages(), {
        customInstructions,
        preserveLastUserMessage: false,
        timestampLabel: undefined,
      });

      // Update agent's internal messages
      (agent as any).updateMessagesAfterCompaction(compactedMessages);

      // Update token count
      if (tokenManager && typeof (tokenManager as any).updateTokenCount === 'function') {
        (tokenManager as any).updateTokenCount(compactedMessages);
      }

      const newContextUsage = tokenManager && typeof (tokenManager as any).getContextUsagePercentage === 'function'
        ? (tokenManager as any).getContextUsagePercentage()
        : 0;

      // Emit compaction complete event
      (activityStream as any).emit({
        id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        type: ActivityEventType.COMPACTION_COMPLETE,
        timestamp: Date.now(),
        data: {
          oldContextUsage,
          newContextUsage,
          threshold: CONTEXT_THRESHOLDS.CRITICAL,
          compactedMessages,
        },
      });

      return {
        handled: true,
        response: '',
      };
    } catch (error) {
      return {
        handled: true,
        response: `Error compacting conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }
}
