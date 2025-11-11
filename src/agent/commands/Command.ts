/**
 * Base Command class for implementing slash commands
 *
 * Provides a clean, extensible architecture for adding new commands.
 * Each command controls its own presentation through the useYellowOutput flag.
 */

import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';

export abstract class Command {
  /**
   * Command name (e.g., "/undo")
   */
  abstract readonly name: string;

  /**
   * Command description for help text
   */
  abstract readonly description: string;

  /**
   * Whether simple text responses should be displayed in yellow.
   * Set to true for commands that output brief status messages.
   */
  protected readonly useYellowOutput: boolean = false;

  /**
   * Execute the command
   *
   * @param args - Command arguments (split by spaces)
   * @param messages - Current conversation messages
   * @param serviceRegistry - Access to application services
   * @returns Command result with optional response and metadata
   */
  abstract execute(
    args: string[],
    messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult>;

  /**
   * Helper to create a response with appropriate metadata
   *
   * @param content - Response content
   * @returns CommandResult with yellow styling if useYellowOutput is true
   */
  protected createResponse(content: string): CommandResult {
    return {
      handled: true,
      response: content,
      metadata: this.useYellowOutput ? { isCommandResponse: true } : undefined,
    };
  }

  /**
   * Helper to create an error response (not styled in yellow)
   *
   * @param error - Error message
   * @returns CommandResult with error message
   */
  protected createError(error: string): CommandResult {
    return {
      handled: true,
      response: `Error: ${error}`,
    };
  }

  /**
   * Helper to emit an activity stream event
   *
   * @param serviceRegistry - Service registry
   * @param eventType - Event type constant
   * @param data - Additional event data
   * @param requestIdPrefix - Prefix for the request ID (default: 'cmd')
   * @returns CommandResult indicating the event was emitted, or error if unavailable
   */
  protected emitActivityEvent(
    serviceRegistry: ServiceRegistry,
    eventType: any,
    data: Record<string, any>,
    requestIdPrefix: string = 'cmd'
  ): CommandResult {
    const activityStream = serviceRegistry.get('activity_stream');

    if (!activityStream || typeof (activityStream as any).emit !== 'function') {
      return this.createError('Activity stream not available');
    }

    const requestId = `${requestIdPrefix}_${Date.now()}`;

    (activityStream as any).emit({
      id: requestId,
      type: eventType,
      timestamp: Date.now(),
      data: {
        requestId,
        ...data,
      },
    });

    return { handled: true };
  }

  /**
   * Helper to get a required service from the registry
   *
   * Returns either the service or an error CommandResult.
   * Use type narrowing to check: `const service = this.getRequiredService(...); if ('response' in service) return service;`
   *
   * @param serviceRegistry - Service registry
   * @param serviceName - Name of the service
   * @param featureName - Human-readable feature name for error message
   * @returns The service or an error CommandResult
   */
  protected getRequiredService<T>(
    serviceRegistry: ServiceRegistry,
    serviceName: string,
    featureName: string
  ): T | CommandResult {
    const service = serviceRegistry.get<T>(serviceName);

    if (!service) {
      return this.createError(`${featureName} not available`);
    }

    return service;
  }
}
