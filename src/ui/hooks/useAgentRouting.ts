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
import { ServiceRegistry } from '@services/ServiceRegistry.js';
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
    const registryAgent = (): Agent | null => {
      const agent = ServiceRegistry.getInstance().get('agent');
      if (!agent) logger.error('[AGENT_ROUTING_HOOK] Registry has no foreground agent');
      return agent;
    };

    const unsubscribeAgentSwitch = activityStream.subscribe(
      ActivityEventType.AGENT_SWITCHED,
      (event) => {
        const nextPrimary = registryAgent();
        if (!nextPrimary) return;

        const expectedAgentId = event.data?.agentId;
        const actualAgentId = nextPrimary.getInstanceId();
        if (expectedAgentId && actualAgentId !== expectedAgentId) {
          logger.warn('[AGENT_ROUTING_HOOK]', 'Agent ID mismatch! Expected:', expectedAgentId, 'Got:', actualAgentId);
          // AgentSwitcher updates the registry before emitting. Retain the
          // existing route if that invariant is violated instead of binding UI
          // input to an unrelated instance.
          return;
        }

        logger.debug('[AGENT_ROUTING_HOOK]', 'Primary agent changed:', actualAgentId);
        setRouting({ primaryAgent: nextPrimary, foregroundAgent: nextPrimary, foregroundAgentId: 'main' });
      },
    );

    const unsubscribeForegroundSwitch = activityStream.subscribe(
      ActivityEventType.FOREGROUND_AGENT_CHANGED,
      (event) => {
        const nextForeground = registryAgent();
        if (!nextForeground) return;
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

  // The routing owner is the only place allowed to announce a primary switch.
  // A foreground child can rerender the application, but cannot reach this
  // effect's dependency unless primary ownership actually changes.
  useEffect(() => {
    const primary = routing.primaryAgent;
    activityStream.emit({
      id: `agent-primary-${Date.now()}`,
      type: ActivityEventType.AGENT_SWITCHED,
      timestamp: Date.now(),
      data: {
        agentName: primary.getAgentName() || 'ally',
        agentId: primary.getInstanceId(),
        agentModel: primary.getModelClient().modelName,
      },
    });
  }, [activityStream, routing.primaryAgent]);

  return routing;
};
