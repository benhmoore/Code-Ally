/**
 * useActivityEvent - Subscribe to specific ActivityStream events
 *
 * This hook manages event subscription lifecycle, automatically cleaning up
 * when the component unmounts or dependencies change. It's the primary way
 * components should listen to activity events.
 */

import { useEffect, useRef } from 'react';
import { ActivityEventType, ActivityCallback } from '@shared/index.js';
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
  const callbackRef = useRef(callback);

  // Always keep the ref updated with the latest callback
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    // Subscribe with a wrapper that calls the ref (always gets latest callback)
    const unsubscribe = activityStream.subscribe(eventType, (...args) => {
      callbackRef.current(...args);
    });

    // Cleanup on unmount or when dependencies change
    return () => {
      unsubscribe();
    };
  }, [activityStream, eventType, ...deps]);
};
