/**
 * ActivityStream - Event-driven activity stream for tool calls, agents, and thoughts
 *
 * This is the core event system that enables React components to subscribe to
 * tool execution events without tight coupling. Inspired by Gemini-CLI's approach.
 */

import { ActivityEvent, ActivityEventType, ActivityCallback } from '../types/index.js';
import type { EventSubscriptionManager } from '../plugins/EventSubscriptionManager.js';

export class ActivityStream {
  private listeners: Map<ActivityEventType | string, Set<ActivityCallback>>;
  private parentId?: string;
  private eventSubscriptionManager?: EventSubscriptionManager;

  constructor(parentId?: string, eventSubscriptionManager?: EventSubscriptionManager) {
    this.listeners = new Map();
    this.parentId = parentId;
    this.eventSubscriptionManager = eventSubscriptionManager;
  }

  /**
   * Emit an event to all registered listeners
   */
  emit(event: ActivityEvent): void {
    // If this is a scoped stream, ensure the event has the parent ID
    if (this.parentId && !event.parentId) {
      event.parentId = this.parentId;
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
    if (this.eventSubscriptionManager && !this.parentId) {
      // Only forward from root ActivityStream, not scoped streams
      const pluginEventType = this.mapToPluginEventType(event.type);
      if (pluginEventType) {
        this.eventSubscriptionManager.dispatch(pluginEventType, event.data);
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
   * @param eventType - The event type to listen for, or '*' for all events
   * @param callback - The callback to invoke when the event is emitted
   * @returns Unsubscribe function
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
   */
  clear(): void {
    this.listeners.clear();
  }

  /**
   * Get the number of active listeners
   */
  getListenerCount(): number {
    let count = 0;
    this.listeners.forEach(callbacks => {
      count += callbacks.size;
    });
    return count;
  }
}

/**
 * Global activity stream instance
 *
 * This can be used as a default stream, but in most cases you should
 * pass the stream through React context to enable proper scoping.
 */
export const globalActivityStream = new ActivityStream();
