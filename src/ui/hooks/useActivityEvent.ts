/**
 * useActivityEvent - Subscribe to specific ActivityStream events
 *
 * This hook manages event subscription lifecycle, automatically cleaning up
 * when the component unmounts or dependencies change. It's the primary way
 * components should listen to activity events.
 */

import { useEffect } from 'react';
import { ActivityEventType, ActivityCallback } from '../../types/index.js';
import { useActivityStream } from './useActivityStream.js';

/**
 * Subscribe to a specific activity event type
 *
 * Automatically handles subscription cleanup on unmount or when dependencies change.
 *
 * @param eventType - The type of event to listen for
 * @param callback - Function to call when event is emitted
 * @param deps - Dependency array (defaults to [eventType, callback])
 *
 * @example
 * ```tsx
 * // Listen for tool call start events
 * useActivityEvent(ActivityEventType.TOOL_CALL_START, (event) => {
 *   console.log('Tool started:', event.data.toolName);
 *   setToolStatus('executing');
 * });
 *
 * // With custom dependencies
 * useActivityEvent(
 *   ActivityEventType.TOOL_OUTPUT_CHUNK,
 *   (event) => {
 *     if (event.id === toolCallId) {
 *       setOutput(prev => prev + event.data.chunk);
 *     }
 *   },
 *   [toolCallId]
 * );
 * ```
 */
export const useActivityEvent = (
  eventType: ActivityEventType | '*',
  callback: ActivityCallback,
  deps: readonly any[] = []
): void => {
  const activityStream = useActivityStream();

  useEffect(() => {
    // Subscribe to the event
    const unsubscribe = activityStream.subscribe(eventType, callback);

    // Cleanup on unmount or when dependencies change
    return () => {
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activityStream, eventType, ...deps]);
};
