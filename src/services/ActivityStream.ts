/**
 * ActivityStream - Event-driven activity stream for tool calls, agents, and thoughts
 *
 * This is the core event system that enables React components to subscribe to
 * tool execution events without tight coupling. Inspired by Gemini-CLI's approach.
 */

import { ActivityEvent, ActivityEventType, ActivityCallback } from '../types/index.js';
import type { EventSubscriptionManager } from '../plugins/EventSubscriptionManager.js';
import { logger } from './Logger.js';

export class ActivityStream {
  private listeners: Map<ActivityEventType | string, Set<ActivityCallback>>;
  private parentId?: string;
  private eventSubscriptionManager?: EventSubscriptionManager;

  /**
   * Maximum listeners allowed per event type before warning about potential memory leak
   * This threshold helps detect scenarios where listeners accumulate without cleanup
   */
  private readonly MAX_LISTENERS_PER_TYPE = 50;

  constructor(parentId?: string, eventSubscriptionManager?: EventSubscriptionManager) {
    this.listeners = new Map();
    this.parentId = parentId;
    this.eventSubscriptionManager = eventSubscriptionManager;
  }

  /**
   * Emit an event to all registered listeners
   */
  emit(event: ActivityEvent): void {
    // Capture references to avoid race conditions
    const manager = this.eventSubscriptionManager;
    const parent = this.parentId;

    // If this is a scoped stream, ensure the event has the parent ID
    if (parent && !event.parentId) {
      event.parentId = parent;
    }

    // Notify listeners for this specific event type
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      typeListeners.forEach(callback => {
        try {
          callback(event);
        } catch (error) {
          console.error(`Error in activity stream listener:`, error);
        }
      });
    }

    // Notify wildcard listeners (subscribed to all events)
    const wildcardListeners = this.listeners.get('*');
    if (wildcardListeners) {
      wildcardListeners.forEach(callback => {
        try {
          callback(event);
        } catch (error) {
          console.error(`Error in wildcard activity stream listener:`, error);
        }
      });
    }

    // Forward approved events to background plugins via EventSubscriptionManager
    if (manager && !parent && event.data !== undefined && event.data !== null) {
      // Only forward from root ActivityStream, not scoped streams
      // Only forward events with valid data (not null or undefined)
      const pluginEventType = this.mapToPluginEventType(event.type);
      if (pluginEventType) {
        manager.dispatch(pluginEventType, event.data);
      }
    }
  }

  /**
   * Map ActivityEventType to plugin event type (approved events only)
   * Converts snake_case to UPPER_CASE for plugin event names
   */
  private mapToPluginEventType(activityEventType: ActivityEventType): string | null {
    const mapping: Record<string, string> = {
      [ActivityEventType.TOOL_CALL_START]: 'TOOL_CALL_START',
      [ActivityEventType.TOOL_CALL_END]: 'TOOL_CALL_END',
      [ActivityEventType.AGENT_START]: 'AGENT_START',
      [ActivityEventType.AGENT_END]: 'AGENT_END',
      [ActivityEventType.PERMISSION_REQUEST]: 'PERMISSION_REQUEST',
      [ActivityEventType.PERMISSION_RESPONSE]: 'PERMISSION_RESPONSE',
      [ActivityEventType.COMPACTION_START]: 'COMPACTION_START',
      [ActivityEventType.COMPACTION_COMPLETE]: 'COMPACTION_COMPLETE',
      [ActivityEventType.CONTEXT_USAGE_UPDATE]: 'CONTEXT_USAGE_UPDATE',
      [ActivityEventType.TODO_UPDATE]: 'TODO_UPDATE',
      [ActivityEventType.THOUGHT_COMPLETE]: 'THOUGHT_COMPLETE',
      [ActivityEventType.DIFF_PREVIEW]: 'DIFF_PREVIEW',
    };

    return mapping[activityEventType] ?? null;
  }

  /**
   * Subscribe to a specific event type
   *
   * IMPORTANT: Always call the returned unsubscribe function when done listening!
   * Failure to unsubscribe will cause memory leaks in long-running sessions.
   *
   * React components should use useActivityEvent hook which handles cleanup automatically.
   * For other contexts, ensure you call unsubscribe in cleanup/destructor methods.
   *
   * @param eventType - The event type to listen for, or '*' for all events
   * @param callback - The callback to invoke when the event is emitted
   * @returns Unsubscribe function - MUST be called to prevent memory leaks
   *
   * @example
   * ```typescript
   * const unsubscribe = stream.subscribe(ActivityEventType.TOOL_CALL_START, (event) => {
   *   console.log('Tool started:', event);
   * });
   *
   * // Later, when done listening:
   * unsubscribe();
   * ```
   */
  subscribe(
    eventType: ActivityEventType | '*',
    callback: ActivityCallback
  ): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, new Set());
    }

    const callbacks = this.listeners.get(eventType)!;
    callbacks.add(callback);

    // Warn if listener count exceeds threshold (potential memory leak)
    if (callbacks.size > this.MAX_LISTENERS_PER_TYPE) {
      logger.warn(
        `[ACTIVITY_STREAM] High listener count (${callbacks.size}) for event type '${String(eventType)}'. ` +
        `This may indicate a memory leak. Ensure all subscribers call unsubscribe() when done.`
      );
    }

    // Return unsubscribe function
    return () => {
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.listeners.delete(eventType);
      }
    };
  }

  /**
   * Create a scoped activity stream for nested contexts (e.g., sub-agents)
   *
   * Events emitted from the scoped stream will automatically include the parent ID,
   * allowing parent components to filter events from specific child contexts.
   *
   * Note: Scoped streams do NOT forward events to EventSubscriptionManager to avoid
   * duplicate events. Only the root ActivityStream forwards to plugins.
   *
   * @param parentId - The parent context identifier
   * @returns A new scoped ActivityStream
   */
  createScoped(parentId: string): ActivityStream {
    return new ActivityStream(parentId, this.eventSubscriptionManager);
  }

  /**
   * Get the parent ID for this scoped stream
   */
  getParentId(): string | undefined {
    return this.parentId;
  }

  /**
   * Clear all listeners (useful for cleanup)
   *
   * @deprecated Use cleanup() instead for better logging and monitoring
   */
  clear(): void {
    this.listeners.clear();
  }

  /**
   * Clean up all event listeners and release resources
   *
   * This method should be called when:
   * - An Agent is destroyed (in Agent.cleanup())
   * - A scoped ActivityStream is no longer needed
   * - The application is shutting down
   *
   * IMPORTANT: After calling cleanup(), this ActivityStream should not be used again.
   * Create a new instance if you need to listen to events after cleanup.
   */
  cleanup(): void {
    const totalListeners = Array.from(this.listeners.values())
      .reduce((sum, set) => sum + set.size, 0);

    if (totalListeners > 0) {
      logger.debug(
        `[ACTIVITY_STREAM] Cleaning up ActivityStream` +
        (this.parentId ? ` (scoped: ${this.parentId})` : ' (root)') +
        ` - removing ${totalListeners} listeners across ${this.listeners.size} event types`
      );
    }

    this.listeners.clear();
  }

  /**
   * Get the total number of active listeners across all event types
   */
  getListenerCount(): number {
    let count = 0;
    this.listeners.forEach(callbacks => {
      count += callbacks.size;
    });
    return count;
  }

  /**
   * Get detailed listener statistics for monitoring and debugging
   *
   * Useful for:
   * - Detecting memory leaks (high listener counts)
   * - Monitoring event system health
   * - Debugging event subscription issues
   *
   * @returns Array of event types with their listener counts, sorted by count (descending)
   */
  getListenerStats(): Array<{ eventType: string; count: number }> {
    return Array.from(this.listeners.entries())
      .map(([eventType, callbacks]) => ({
        eventType: String(eventType),
        count: callbacks.size,
      }))
      .sort((a, b) => b.count - a.count); // Sort by count descending
  }
}

/**
 * Global activity stream instance
 *
 * This can be used as a default stream, but in most cases you should
 * pass the stream through React context to enable proper scoping.
 */
export const globalActivityStream = new ActivityStream();
