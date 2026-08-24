/**
 * useAgentRouting - Keep conversation ownership separate from input routing.
 *
 * `primaryAgent` owns the main conversation. `foregroundAgent` is the agent the
 * user is currently viewing and addressing. Configured-agent switches replace
 * both; fleet navigation replaces only the foreground route.
 */

import { useCallback, useEffect, useState } from 'react';
import { Agent } from '@agent/Agent.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ActivityEventType } from '@shared/index.js';
import { logger } from '@services/Logger.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';

interface AgentRoutingState {
  primaryAgent: Agent;
  foregroundAgent: Agent;
  foregroundAgentId: string;
}

export interface AgentRouting extends AgentRoutingState {
  selectForegroundConversation: (agent: Agent, agentId: string) => void;
  returnToPrimaryConversation: () => void;
}

export const useAgentRouting = (
  initialPrimaryAgent: Agent,
  activityStream: ActivityStream,
): AgentRouting => {
  const [routing, setRouting] = useState<AgentRoutingState>({
    primaryAgent: initialPrimaryAgent,
    foregroundAgent: initialPrimaryAgent,
    foregroundAgentId: 'main',
  });

  useEffect(() => {
    const unsubscribeAgentSwitch = activityStream.subscribe(
      ActivityEventType.AGENT_SWITCHED,
      (event) => {
        const nextPrimary = ServiceRegistry.getInstance().get('agent');
        if (!nextPrimary) {
          logger.error('[AGENT_ROUTING_HOOK] Primary switch has no registered Agent');
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

    return unsubscribeAgentSwitch;
  }, [activityStream]);

  const selectForegroundConversation = useCallback((agent: Agent, agentId: string) => {
    logger.debug('[AGENT_ROUTING_HOOK]', 'Foreground agent changed:', agent.getInstanceId());
    setRouting((current) => ({ ...current, foregroundAgent: agent, foregroundAgentId: agentId }));
  }, []);

  const returnToPrimaryConversation = useCallback(() => {
    setRouting((current) => ({
      ...current,
      foregroundAgent: current.primaryAgent,
      foregroundAgentId: 'main',
    }));
  }, []);

  return {
    ...routing,
    selectForegroundConversation,
    returnToPrimaryConversation,
  };
};
