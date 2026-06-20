/**
 * ForegroundSwitcher - Re-point the foreground (input-routed) agent
 *
 * When the user "enters" a background agent's conversation, the registry's
 * active 'agent' is swapped to that agent so typed input routes to it exactly
 * as it routes to the main agent today (useInputHandlers resolves 'agent' from
 * the registry on every call). Exiting restores the main agent.
 *
 * This is intentionally stateless: the caller owns the main-agent reference and
 * passes it back on exit (sibling in spirit to AgentSwitcher, which performs the
 * same registry.registerInstance('agent', ...) + token_manager swap).
 *
 * The conversation-view repaint is handled separately by AppContext
 * (enterBackgroundView / exitBackgroundView) — this only moves the registry
 * pointer and announces the change via FOREGROUND_AGENT_CHANGED.
 */

import { Agent } from '../agent/Agent.js';
import { ServiceRegistry } from './ServiceRegistry.js';
import { ActivityStream } from './ActivityStream.js';
import { ActivityEventType } from '../types/index.js';
import { logger } from './Logger.js';

/**
 * Enter a background agent: route foreground input to it.
 */
export function enterForegroundAgent(opts: {
  registry: ServiceRegistry;
  activityStream: ActivityStream;
  targetAgent: Agent;
  targetAgentId: string;
}): void {
  const { registry, activityStream, targetAgent, targetAgentId } = opts;

  registry.registerInstance('agent', targetAgent);
  registry.registerInstance('token_manager', targetAgent.getTokenManager());
  logger.debug('[FOREGROUND_SWITCHER] Entered background agent', targetAgentId);

  activityStream.emit({
    id: `foreground-${targetAgentId}`,
    type: ActivityEventType.FOREGROUND_AGENT_CHANGED,
    timestamp: Date.now(),
    data: {
      agentId: targetAgentId,
      agentName: targetAgent.getAgentName?.() ?? targetAgentId,
      isMain: false,
    },
  });
}

/**
 * Exit back to the main agent: restore foreground input routing.
 */
export function exitForegroundAgent(opts: {
  registry: ServiceRegistry;
  activityStream: ActivityStream;
  mainAgent: Agent;
}): void {
  const { registry, activityStream, mainAgent } = opts;

  registry.registerInstance('agent', mainAgent);
  registry.registerInstance('token_manager', mainAgent.getTokenManager());
  logger.debug('[FOREGROUND_SWITCHER] Exited to main agent');

  activityStream.emit({
    id: 'foreground-main',
    type: ActivityEventType.FOREGROUND_AGENT_CHANGED,
    timestamp: Date.now(),
    data: {
      agentId: 'main',
      agentName: mainAgent.getAgentName?.() ?? 'ally',
      isMain: true,
    },
  });
}
