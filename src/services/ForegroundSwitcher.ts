/**
 * ForegroundSwitcher - Re-point the foreground (input-routed) agent
 *
 * Foreground navigation is a UI route, not a process-global service mutation.
 * The selected Agent is carried in the event and captured in an immutable
 * ConversationRoute by the UI. Long-running input retains that route even if
 * navigation changes while it is executing.
 */

import { Agent } from '../agent/Agent.js';
import { ActivityStream } from './ActivityStream.js';
import { ActivityEventType } from '../types/index.js';
import { logger } from './Logger.js';

/**
 * Enter a background agent: route foreground input to it.
 */
export function enterForegroundAgent(opts: {
  activityStream: ActivityStream;
  targetAgent: Agent;
  targetAgentId: string;
}): void {
  const { activityStream, targetAgent, targetAgentId } = opts;
  logger.debug('[FOREGROUND_SWITCHER] Entered background agent', targetAgentId);

  activityStream.emit({
    id: `foreground-${targetAgentId}`,
    type: ActivityEventType.FOREGROUND_AGENT_CHANGED,
    timestamp: Date.now(),
    data: {
      agentId: targetAgentId,
      agentName: targetAgent.getAgentName?.() ?? targetAgentId,
      agent: targetAgent,
      isMain: false,
    },
  });
}

/**
 * Exit back to the main agent: restore foreground input routing.
 */
export function exitForegroundAgent(opts: {
  activityStream: ActivityStream;
  mainAgent: Agent;
}): void {
  const { activityStream, mainAgent } = opts;
  logger.debug('[FOREGROUND_SWITCHER] Exited to main agent');

  activityStream.emit({
    id: 'foreground-main',
    type: ActivityEventType.FOREGROUND_AGENT_CHANGED,
    timestamp: Date.now(),
    data: {
      agentId: 'main',
      agentName: mainAgent.getAgentName?.() ?? 'ally',
      agent: mainAgent,
      isMain: true,
    },
  });
}
