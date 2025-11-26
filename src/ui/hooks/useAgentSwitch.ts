/**
 * useAgentSwitch - Hook to manage agent switching state
 *
 * Subscribes to AGENT_SWITCHED events and updates the current agent
 * with proper validation to prevent race conditions.
 */

import { useEffect, useState } from 'react';
import { Agent } from '@agent/Agent.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ActivityEventType } from '@shared/index.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { logger } from '@services/Logger.js';

/**
 * Subscribe to agent switches and maintain current agent state
 *
 * @param initialAgent - Initial agent instance
 * @param activityStream - Activity stream to subscribe to
 * @returns Current agent (updates when switched)
 */
export const useAgentSwitch = (
  initialAgent: Agent,
  activityStream: ActivityStream
): Agent => {
  // Track current agent (updates when agent is switched)
  const [currentAgent, setCurrentAgent] = useState<Agent>(initialAgent);

  // Listen for agent switches and update current agent
  useEffect(() => {
    const unsubscribe = activityStream.subscribe(
      ActivityEventType.AGENT_SWITCHED,
      (event) => {
        const expectedAgentId = event.data?.agentId;
        const agentName = event.data?.agentName;

        logger.debug('[AGENT_SWITCH_HOOK]', 'Received AGENT_SWITCHED event for:', agentName, 'ID:', expectedAgentId);

        // Fetch the new agent from registry
        const registry = ServiceRegistry.getInstance();
        const newAgent = registry.get<Agent>('agent');

        if (!newAgent) {
          logger.error('[AGENT_SWITCH_HOOK]', 'Failed to get new agent from registry!');
          return;
        }

        const actualAgentId = newAgent.getInstanceId();

        // Validate agent ID to prevent race conditions
        if (expectedAgentId && actualAgentId !== expectedAgentId) {
          logger.warn('[AGENT_SWITCH_HOOK]', 'Agent ID mismatch! Expected:', expectedAgentId, 'Got:', actualAgentId);
          // Wait a bit and retry once (registry update may be delayed)
          setTimeout(() => {
            const retryAgent = registry.get<Agent>('agent');
            const retryId = retryAgent?.getInstanceId();
            if (retryAgent && retryId === expectedAgentId) {
              logger.debug('[AGENT_SWITCH_HOOK]', 'Retry successful, agent ID now matches');
              setCurrentAgent(retryAgent);
            } else {
              logger.error('[AGENT_SWITCH_HOOK]', 'Retry failed, agent ID still does not match');
            }
          }, 10);
          return;
        }

        logger.debug('[AGENT_SWITCH_HOOK]', 'Updating currentAgent state to:', actualAgentId);
        setCurrentAgent(newAgent);
        logger.debug('[AGENT_SWITCH_HOOK]', 'Agent prop updated in component tree');
      }
    );

    return () => {
      unsubscribe();
    };
  }, [activityStream]);

  return currentAgent;
};
