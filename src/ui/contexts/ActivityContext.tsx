/**
 * ActivityContext - Provides ActivityStream to React components
 *
 * This context makes the ActivityStream available throughout the component tree,
 * enabling components to subscribe to tool execution events, agent activity,
 * and other system events without prop drilling.
 */

import React, { createContext, useContext } from 'react';
import { ActivityStream } from '../../services/ActivityStream.js';

/**
 * Context for ActivityStream
 */
export const ActivityContext = createContext<ActivityStream | null>(null);

/**
 * Props for ActivityProvider
 */
export interface ActivityProviderProps {
  activityStream: ActivityStream;
  children: React.ReactNode;
}

/**
 * Provider component for ActivityStream
 *
 * Wraps the component tree and provides access to the ActivityStream instance.
 *
 * @example
 * ```tsx
 * const stream = new ActivityStream();
 * <ActivityProvider activityStream={stream}>
 *   <App />
 * </ActivityProvider>
 * ```
 */
export const ActivityProvider: React.FC<ActivityProviderProps> = ({
  activityStream,
  children,
}) => {
  return (
    <ActivityContext.Provider value={activityStream}>
      {children}
    </ActivityContext.Provider>
  );
};

/**
 * Hook to access the ActivityStream from context
 *
 * @throws Error if used outside ActivityProvider
 * @returns The ActivityStream instance
 *
 * @example
 * ```tsx
 * const activityStream = useActivityStreamContext();
 * useEffect(() => {
 *   const unsubscribe = activityStream.subscribe(
 *     ActivityEventType.TOOL_CALL_START,
 *     (event) => console.log('Tool started:', event)
 *   );
 *   return unsubscribe;
 * }, [activityStream]);
 * ```
 */
export const useActivityStreamContext = (): ActivityStream => {
  const stream = useContext(ActivityContext);
  if (!stream) {
    throw new Error('useActivityStreamContext must be used within ActivityProvider');
  }
  return stream;
};
