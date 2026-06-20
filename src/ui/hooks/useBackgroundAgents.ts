/**
 * useBackgroundAgents Hook
 *
 * Provides the live list of background agents for the fleet view below the
 * prompt. List membership changes are infrequent (driven by AGENT_START /
 * AGENT_END / AGENT_BACKGROUND_COMPLETE), so re-rendering on those events is
 * cheap. Elapsed time and token counts are refreshed by a single shared 1s
 * tick read directly from each agent's manager task — never routed through
 * AppContext, so the conversation transcript is never re-rendered by it.
 */

import { useState, useEffect } from 'react';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { BackgroundAgentManager, BackgroundAgentStatus } from '@services/BackgroundAgentManager.js';
import { useActivityStreamContext } from '../contexts/ActivityContext.js';
import { ActivityEventType } from '@shared/index.js';
import { POLLING_INTERVALS, BACKGROUND_AGENT } from '@config/constants.js';

export interface BackgroundAgentInfo {
  id: string;
  agentType: string;
  status: BackgroundAgentStatus;
  startTime: number;
  endTime: number | null;
  /** Live estimated token count for the agent's conversation */
  tokens: number;
}

function readAgents(): BackgroundAgentInfo[] {
  const registry = ServiceRegistry.getInstance();
  const manager = registry.get<BackgroundAgentManager>('background_agent_manager');
  if (!manager) return [];

  const now = Date.now();
  return manager.listTasks()
    // Auto-dismiss: drop completed agents from the fleet after a short window.
    .filter((task) =>
      task.status === 'running' ||
      (task.endTime != null && now - task.endTime < BACKGROUND_AGENT.FLEET_DISMISS_MS)
    )
    .map((task) => ({
      id: task.id,
      agentType: task.agentType,
      status: task.status,
      startTime: task.startTime,
      endTime: task.endTime,
      tokens: task.subAgent?.getTokenManager?.()?.getCurrentTokenCount?.() ?? 0,
    }));
}

/**
 * Returns the current list of background agents, refreshed live.
 */
export function useBackgroundAgents(): BackgroundAgentInfo[] {
  const [agents, setAgents] = useState<BackgroundAgentInfo[]>(() => readAgents());
  const activityStream = useActivityStreamContext();

  useEffect(() => {
    const refresh = () => setAgents(readAgents());

    // Membership/status changes — small delay lets the manager settle first.
    const onChange = () => setTimeout(refresh, 50);
    const unsubStart = activityStream.subscribe(ActivityEventType.AGENT_START, onChange);
    const unsubEnd = activityStream.subscribe(ActivityEventType.AGENT_END, onChange);
    const unsubComplete = activityStream.subscribe(ActivityEventType.AGENT_BACKGROUND_COMPLETE, onChange);

    // Shared 1s tick for live elapsed + token counts.
    const interval = setInterval(refresh, POLLING_INTERVALS.STATUS_FAST);

    refresh();
    return () => {
      unsubStart();
      unsubEnd();
      unsubComplete();
      clearInterval(interval);
    };
  }, [activityStream]);

  return agents;
}
