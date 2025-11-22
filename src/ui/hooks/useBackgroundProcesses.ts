/**
 * useBackgroundProcesses Hook
 *
 * Provides real-time count of running background bash processes.
 * Subscribes to activity events to update when processes start/stop.
 */

import { useState, useEffect } from 'react';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { BashProcessManager } from '@services/BashProcessManager.js';
import { useActivityStreamContext } from '../contexts/ActivityContext.js';
import { ActivityEventType, ActivityEvent } from '@shared/index.js';

/**
 * Hook to get the count of running background bash processes
 *
 * @returns Number of currently running background processes
 */
export function useBackgroundProcesses(): number {
  const [processCount, setProcessCount] = useState(0);
  const activityStream = useActivityStreamContext();

  useEffect(() => {
    // Get initial count
    const updateCount = () => {
      const registry = ServiceRegistry.getInstance();
      const processManager = registry.get<BashProcessManager>('bash_process_manager');

      if (processManager) {
        const processes = processManager.listProcesses();
        const runningCount = processes.filter(p => p.exitCode === null).length;
        setProcessCount(runningCount);
      }
    };

    // Update initial count
    updateCount();

    // Subscribe to activity events to update count when tools complete
    // TOOL_CALL_END events fire when bash commands start/complete
    const unsubscribeToolEnd = activityStream.subscribe(ActivityEventType.TOOL_CALL_END, (event: ActivityEvent) => {
      const toolName = event.data?.toolName;
      // Update count when bash-related tools execute
      if (toolName === 'bash' || toolName === 'kill-shell') {
        // Small delay to let process manager update
        setTimeout(updateCount, 50);
      }
    });

    // Subscribe to background process exit events
    // This ensures the count updates when processes exit on their own
    const unsubscribeProcessExit = activityStream.subscribe(ActivityEventType.BACKGROUND_PROCESS_EXIT, () => {
      // Update count when background process exits
      setTimeout(updateCount, 50);
    });

    return () => {
      unsubscribeToolEnd();
      unsubscribeProcessExit();
    };
  }, [activityStream]);

  return processCount;
}
