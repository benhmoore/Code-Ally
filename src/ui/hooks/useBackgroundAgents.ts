/**
 * useBackgroundAgents Hook
 *
 * Provides real-time count of running background agents.
 * Subscribes to activity events to update when agents start/complete.
 */

import { useState, useEffect } from 'react';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { BackgroundAgentManager } from '@services/BackgroundAgentManager.js';
import { useActivityStreamContext } from '../contexts/ActivityContext.js';
import { ActivityEventType } from '@shared/index.js';

/**
 * Hook to get the count of running background agents
 *
 * @returns Number of currently executing background agents
 */
export function useBackgroundAgents(): number {
  const [agentCount, setAgentCount] = useState(0);
  const activityStream = useActivityStreamContext();

  useEffect(() => {
    // Get initial count
    const updateCount = () => {
      const registry = ServiceRegistry.getInstance();
      const agentManager = registry.get<BackgroundAgentManager>('background_agent_manager');

      if (agentManager) {
        const agents = agentManager.listAgents();
        const runningCount = agents.filter(a => a.status === 'executing').length;
        setAgentCount(runningCount);
      }
    };

    // Update initial count
    updateCount();

    // Subscribe to background agent lifecycle events
    const unsubscribeStart = activityStream.subscribe(ActivityEventType.BACKGROUND_AGENT_START, () => {
      updateCount();
    });

    const unsubscribeComplete = activityStream.subscribe(ActivityEventType.BACKGROUND_AGENT_COMPLETE, () => {
      updateCount();
    });

    const unsubscribeError = activityStream.subscribe(ActivityEventType.BACKGROUND_AGENT_ERROR, () => {
      updateCount();
    });

    const unsubscribeKilled = activityStream.subscribe(ActivityEventType.BACKGROUND_AGENT_KILLED, () => {
      updateCount();
    });

    return () => {
      unsubscribeStart();
      unsubscribeComplete();
      unsubscribeError();
      unsubscribeKilled();
    };
  }, [activityStream]);

  return agentCount;
}
