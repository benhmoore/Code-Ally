/**
 * EventSubscriptionManager - Manages event subscriptions for background plugins
 *
 * Enables background plugins to subscribe to and receive read-only events from Ally
 * via JSON-RPC notifications sent to their Unix socket. Events are dispatched
 * asynchronously in a fire-and-forget manner to avoid blocking the main flow.
 *
 * Key features:
 * - Plugin subscription management (register/unregister)
 * - Event filtering by subscription (only send to subscribed plugins)
 * - Asynchronous event dispatching (non-blocking)
 * - Error handling (plugin failures don't affect Ally)
 * - JSON-RPC notification format (no response expected)
 *
 * Design decisions:
 * - Fire-and-forget: Event delivery failures are logged but don't retry
 * - Non-blocking: Events are dispatched asynchronously using setImmediate
 * - Daemon awareness: Only dispatch to running daemons (checked via processManager)
 * - Approved events: Only 12 approved event types can be subscribed to
 * - Timestamp injection: All events get a timestamp for ordering/debugging
 *
 * JSON-RPC Notification Format:
 * {
 *   "jsonrpc": "2.0",
 *   "method": "on_event",
 *   "params": {
 *     "event_type": "TOOL_CALL_START",
 *     "event_data": {...},
 *     "timestamp": 1234567890
 *   }
 * }
 *
 * Note: Notifications don't have an "id" field per JSON-RPC 2.0 spec
 */

import { logger } from '../services/Logger.js';
import { SocketClient } from './SocketClient.js';
import { BackgroundProcessManager } from './BackgroundProcessManager.js';

/**
 * Approved event types for Phase 1
 *
 * These are the only events plugins can subscribe to. Each event provides
 * read-only observation of Ally's runtime behavior:
 *
 * - TOOL_CALL_START/END: Tool execution lifecycle
 * - AGENT_START/END: Agent/subagent lifecycle
 * - PERMISSION_REQUEST/RESPONSE: User permission prompts and responses
 * - COMPACTION_START/COMPLETE: Context compaction operations
 * - CONTEXT_USAGE_UPDATE: Token usage updates
 * - TODO_UPDATE: Todo list changes
 * - THOUGHT_COMPLETE: LLM thinking blocks
 * - DIFF_PREVIEW: File diff previews
 */
export const APPROVED_EVENTS = [
  'TOOL_CALL_START',
  'TOOL_CALL_END',
  'AGENT_START',
  'AGENT_END',
  'PERMISSION_REQUEST',
  'COMPACTION_COMPLETE',
  'CONTEXT_USAGE_UPDATE',
  'TODO_UPDATE',
  'THOUGHT_COMPLETE',
  'DIFF_PREVIEW',
  'PERMISSION_RESPONSE',
  'COMPACTION_START',
] as const;

/**
 * Type for approved event names
 */
export type ApprovedEventType = (typeof APPROVED_EVENTS)[number];

/**
 * Event subscription details for a plugin
 */
export interface EventSubscription {
  /** Plugin name (unique identifier) */
  pluginName: string;
  /** Path to plugin's Unix socket for JSON-RPC communication */
  socketPath: string;
  /** Event types this plugin subscribes to */
  events: string[];
}

/**
 * Manages event subscriptions for background plugins
 */
export class EventSubscriptionManager {
  /** Map of plugin name to subscription details */
  private subscriptions: Map<string, EventSubscription> = new Map();

  /** SocketClient for sending JSON-RPC notifications */
  private socketClient: SocketClient;

  /** BackgroundProcessManager for checking daemon status */
  private processManager: BackgroundProcessManager;

  /**
   * Create an EventSubscriptionManager
   *
   * @param socketClient - SocketClient instance for JSON-RPC communication
   * @param processManager - BackgroundProcessManager for daemon status checks
   */
  constructor(socketClient: SocketClient, processManager: BackgroundProcessManager) {
    this.socketClient = socketClient;
    this.processManager = processManager;
    logger.debug('[EventSubscriptionManager] Initialized');
  }

  /**
   * Register a plugin's event subscriptions
   *
   * Validates that all requested events are approved, then stores the subscription.
   * If the plugin already has a subscription, it will be replaced.
   *
   * @param pluginName - Name of the plugin
   * @param socketPath - Path to plugin's Unix socket
   * @param events - Array of event types to subscribe to
   * @throws Error if any event type is not approved
   */
  subscribe(pluginName: string, socketPath: string, events: string[]): void {
    logger.debug(
      `[EventSubscriptionManager] Subscribe request: plugin=${pluginName}, events=[${events.join(', ')}]`
    );

    // Validate events array is not empty
    if (events.length === 0) {
      const errorMsg = `Plugin '${pluginName}' attempted to subscribe with an empty events array. Must specify at least one event.`;
      logger.error(`[EventSubscriptionManager] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // Validate socket path length (Unix domain socket path limit is 104 characters on most systems)
    const MAX_SOCKET_PATH_LENGTH = 104;
    if (socketPath.length > MAX_SOCKET_PATH_LENGTH) {
      const errorMsg = `Plugin '${pluginName}' socket path exceeds maximum length of ${MAX_SOCKET_PATH_LENGTH} characters: ${socketPath}`;
      logger.error(`[EventSubscriptionManager] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // Validate socket path is absolute
    if (!socketPath.startsWith('/')) {
      const errorMsg = `Plugin '${pluginName}' socket path must be absolute, got: ${socketPath}`;
      logger.error(`[EventSubscriptionManager] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // Deduplicate events array
    const uniqueEvents = Array.from(new Set(events));
    if (uniqueEvents.length < events.length) {
      logger.debug(
        `[EventSubscriptionManager] Removed ${events.length - uniqueEvents.length} duplicate event(s) from subscription`
      );
    }

    // Validate that all events are approved
    const unapprovedEvents = uniqueEvents.filter((event) => !APPROVED_EVENTS.includes(event as any));
    if (unapprovedEvents.length > 0) {
      const errorMsg = `Plugin '${pluginName}' attempted to subscribe to unapproved events: ${unapprovedEvents.join(', ')}. Approved events: ${APPROVED_EVENTS.join(', ')}`;
      logger.error(`[EventSubscriptionManager] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // Store subscription
    const subscription: EventSubscription = {
      pluginName,
      socketPath,
      events: uniqueEvents,
    };
    this.subscriptions.set(pluginName, subscription);

    logger.debug(
      `[EventSubscriptionManager] Plugin '${pluginName}' subscribed to ${uniqueEvents.length} event(s): ${uniqueEvents.join(', ')}`
    );
  }

  /**
   * Unregister a plugin's event subscriptions
   *
   * Removes all subscriptions for the plugin. Safe to call even if plugin
   * has no subscriptions.
   *
   * @param pluginName - Name of the plugin
   */
  unsubscribe(pluginName: string): void {
    const existed = this.subscriptions.delete(pluginName);
    if (existed) {
      logger.debug(`[EventSubscriptionManager] Plugin '${pluginName}' unsubscribed from all events`);
    } else {
      logger.debug(
        `[EventSubscriptionManager] Unsubscribe called for plugin '${pluginName}' with no active subscriptions`
      );
    }
  }

  /**
   * Dispatch an event to subscribed plugins
   *
   * This is a fire-and-forget operation that:
   * 1. Runs asynchronously (doesn't block caller)
   * 2. Filters plugins by subscription (only send to those subscribed to this event type)
   * 3. Checks daemon status (only send to running daemons)
   * 4. Sends JSON-RPC notification to each subscribed plugin
   * 5. Catches and logs errors (doesn't throw)
   *
   * The notification format is:
   * {
   *   "jsonrpc": "2.0",
   *   "method": "on_event",
   *   "params": {
   *     "event_type": "TOOL_CALL_START",
   *     "event_data": {...},
   *     "timestamp": 1234567890
   *   }
   * }
   *
   * @param eventType - Type of event (e.g., "TOOL_CALL_START")
   * @param eventData - Event data payload
   */
  async dispatch(eventType: string, eventData: any): Promise<void> {
    // Run asynchronously to avoid blocking the caller
    // Wrap in IIFE with catch to prevent unhandled promise rejections
    setImmediate(() => {
      (async () => {
        try {
          logger.debug(`[EventSubscriptionManager] Dispatching event: ${eventType}`);

          // Find all plugins subscribed to this event type
          const subscribers = this.getSubscribers(eventType);
          if (subscribers.length === 0) {
            logger.debug(
              `[EventSubscriptionManager] No subscribers for event '${eventType}', skipping dispatch`
            );
            return;
          }

          logger.debug(
            `[EventSubscriptionManager] Dispatching '${eventType}' to ${subscribers.length} subscriber(s): ${subscribers.join(', ')}`
          );

          // Build notification params with timestamp
          const params = {
            event_type: eventType,
            event_data: eventData,
            timestamp: Date.now(),
          };

          // Dispatch to all subscribed plugins in parallel (fire-and-forget)
          const dispatchPromises = subscribers.map(async (pluginName) => {
            const subscription = this.subscriptions.get(pluginName);
            if (!subscription) {
              // Shouldn't happen, but defensive check
              logger.debug(
                `[EventSubscriptionManager] Subscription not found for '${pluginName}', skipping`
              );
              return;
            }

            // Check if daemon is running
            if (!this.processManager.isRunning(pluginName)) {
              logger.debug(
                `[EventSubscriptionManager] Daemon for '${pluginName}' is not running, skipping event dispatch`
              );
              return;
            }

            try {
              // Send JSON-RPC notification (fire-and-forget, no response expected)
              await this.socketClient.sendNotification(subscription.socketPath, 'on_event', params);
              logger.debug(
                `[EventSubscriptionManager] Event '${eventType}' dispatched to '${pluginName}'`
              );
            } catch (error) {
              // Log errors but don't throw - we don't want plugin failures to affect Ally
              const errorMsg = error instanceof Error ? error.message : String(error);
              logger.debug(
                `[EventSubscriptionManager] Failed to dispatch event '${eventType}' to '${pluginName}': ${errorMsg}`
              );
            }
          });

          // Wait for all dispatches to complete (or fail)
          await Promise.all(dispatchPromises);
          logger.debug(
            `[EventSubscriptionManager] Finished dispatching event '${eventType}' to all subscribers`
          );
        } catch (error) {
          // Top-level error handler - should rarely be reached since we catch errors per-plugin
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`[EventSubscriptionManager] Error in event dispatch: ${errorMsg}`);
        }
      })().catch((error) => {
        // Last resort: catch any unhandled errors from the async IIFE
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error(`[EventSubscriptionManager] Unhandled error in event dispatch: ${errorMsg}`);
      });
    });
  }

  /**
   * Get list of subscribed plugins for an event type
   *
   * Returns plugin names of all plugins that have subscribed to this event type.
   * Useful for debugging and testing.
   *
   * @param eventType - Event type to check
   * @returns Array of plugin names subscribed to this event
   */
  getSubscribers(eventType: string): string[] {
    const subscribers: string[] = [];
    for (const [pluginName, subscription] of this.subscriptions) {
      if (subscription.events.includes(eventType)) {
        subscribers.push(pluginName);
      }
    }
    return subscribers;
  }

  /**
   * Check if a plugin is subscribed to any events
   *
   * @param pluginName - Plugin to check
   * @returns True if plugin has active subscriptions
   */
  isSubscribed(pluginName: string): boolean {
    return this.subscriptions.has(pluginName);
  }

  /**
   * Get all subscriptions (for debugging/monitoring)
   *
   * @returns Read-only copy of all subscriptions
   */
  getAllSubscriptions(): ReadonlyMap<string, Readonly<EventSubscription>> {
    return new Map(this.subscriptions);
  }

  /**
   * Get subscription details for a specific plugin
   *
   * @param pluginName - Plugin to get subscription for
   * @returns Deep copy of subscription details or undefined if not subscribed
   */
  getSubscription(pluginName: string): Readonly<EventSubscription> | undefined {
    const subscription = this.subscriptions.get(pluginName);
    if (!subscription) {
      return undefined;
    }
    // Return a deep copy to prevent mutation
    return {
      pluginName: subscription.pluginName,
      socketPath: subscription.socketPath,
      events: [...subscription.events],
    };
  }
}
