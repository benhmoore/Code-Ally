/**
 * useAgentRouting - Keep conversation ownership separate from input routing.
 *
 * `primaryAgent` owns the main conversation. `foregroundAgent` is the agent the
 * user is currently viewing and addressing. Configured-agent switches replace
 * both; fleet navigation replaces only the foreground route.
 */

import { useEffect, useState } from 'react';
import { Agent } from '@agent/Agent.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ActivityEventType } from '@shared/index.js';
import { logger } from '@services/Logger.js';

export interface AgentRouting {
  primaryAgent: Agent;
  foregroundAgent: Agent;
  foregroundAgentId: string;
}

export const useAgentRouting = (
  initialPrimaryAgent: Agent,
  activityStream: ActivityStream,
): AgentRouting => {
  const [routing, setRouting] = useState<AgentRouting>({
    primaryAgent: initialPrimaryAgent,
    foregroundAgent: initialPrimaryAgent,
    foregroundAgentId: 'main',
  });

  useEffect(() => {
    const unsubscribeAgentSwitch = activityStream.subscribe(
      ActivityEventType.AGENT_SWITCHED,
      (event) => {
        const nextPrimary = event.data?.agent as Agent | undefined;
        if (!nextPrimary) {
          logger.error('[AGENT_ROUTING_HOOK] Primary switch omitted its Agent instance');
          return;
        }

        const expectedAgentId = event.data?.agentId;
        const actualAgentId = nextPrimary.getInstanceId();
        if (expectedAgentId && actualAgentId !== expectedAgentId) {
          logger.warn('[AGENT_ROUTING_HOOK]', 'Agent ID mismatch! Expected:', expectedAgentId, 'Got:', actualAgentId);
          // Retain the existing route if the event's address and payload
          // disagree instead of binding UI input to an unrelated instance.
          return;
        }

        logger.debug('[AGENT_ROUTING_HOOK]', 'Primary agent changed:', actualAgentId);
        setRouting({ primaryAgent: nextPrimary, foregroundAgent: nextPrimary, foregroundAgentId: 'main' });
      },
    );

    const unsubscribeForegroundSwitch = activityStream.subscribe(
      ActivityEventType.FOREGROUND_AGENT_CHANGED,
      (event) => {
        const nextForeground = event.data?.agent as Agent | undefined;
        if (!nextForeground) {
          logger.error('[AGENT_ROUTING_HOOK] Foreground switch omitted its Agent instance');
          return;
        }
        const foregroundAgentId = typeof event.data?.agentId === 'string'
          ? event.data.agentId
          : event.data?.isMain ? 'main' : nextForeground.getInstanceId();
        logger.debug('[AGENT_ROUTING_HOOK]', 'Foreground agent changed:', nextForeground.getInstanceId());
        setRouting((current) => ({ ...current, foregroundAgent: nextForeground, foregroundAgentId }));
      },
    );

    return () => {
      unsubscribeAgentSwitch();
      unsubscribeForegroundSwitch();
    };
  }, [activityStream]);

  return routing;
};
