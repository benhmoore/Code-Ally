/**
 * runFleetDelegation - shared foreground/background run lifecycle for delegations
 *
 * Both AgentTool (the `agent` tool) and BaseDelegationTool (`explore`/`plan`)
 * register their runs here so every agent — foreground or background — appears
 * in the fleet, can be entered, and can be promoted to background via Ctrl+B.
 *
 * Lifecycle:
 * - Registers a task with the BackgroundAgentManager (background runs are
 *   capped; addTask throws on overflow so the caller can release + report).
 * - Runs the agent, recording result/status on the task.
 * - Background (or a foreground run detached mid-flight): a single completion
 *   handler owns cleanup + the AGENT_END / AGENT_BACKGROUND_COMPLETE events.
 * - Foreground that completes normally: cleanup happens here and the result is
 *   returned to the caller, which emits AGENT_END itself (its existing path).
 */

import { BackgroundAgentManager, BackgroundAgentStatus } from '../services/BackgroundAgentManager.js';
import { Agent } from '../agent/Agent.js';
import { PooledAgent } from '../services/AgentPoolService.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ActivityEventType } from '../types/index.js';
import { PERMISSION_MESSAGES } from '../config/constants.js';
import { formatError } from '../utils/errorUtils.js';

export interface FleetDelegationParams {
  manager: BackgroundAgentManager;
  activityStream: ActivityStream;
  agentType: string;
  taskPrompt: string;
  callId: string;
  subAgent: Agent;
  pooledAgent: PooledAgent | null;
  runInBackground: boolean;
  /** Execute the agent and return its final response text. */
  run: () => Promise<string>;
  /** Release the agent + finalize delegation. Called exactly once when settled. */
  cleanup: () => Promise<void> | void;
  /** Extra AGENT_END data for detached completion (e.g. contextUsage). */
  buildEndData?: (result: string, durationSec: number) => Record<string, any>;
}

export type FleetDelegationOutcome =
  | { backgrounded: true; taskId: string }
  | { backgrounded: false; status: BackgroundAgentStatus; result: string; error: string | null };

export async function runFleetDelegation(p: FleetDelegationParams): Promise<FleetDelegationOutcome> {
  const task = p.manager.createTask({
    agentType: p.agentType,
    taskPrompt: p.taskPrompt,
    mode: p.runInBackground ? 'background' : 'foreground',
    subAgent: p.subAgent,
    pooledAgent: p.pooledAgent,
    callId: p.callId,
  });

  // Enforce the background cap before starting the run (throws on overflow).
  p.manager.addTask(task);

  const runOutcome = (async () => {
    try {
      const res = await p.run();
      task.result = res;
      const content = res?.split('\n\nIMPORTANT:')[0]?.trim();
      if (content === PERMISSION_MESSAGES.USER_FACING_INTERRUPTION) {
        if (task.status === 'running') task.status = 'cancelled';
      } else if (task.status === 'running') {
        task.status = 'done';
      }
    } catch (error) {
      task.error = formatError(error);
      if (task.status === 'running') task.status = 'error';
      throw error;
    }
  })();
  task.promise = runOutcome.catch(() => {});

  // Sole owner of cleanup + events for a DETACHED run (background or Ctrl+B).
  const finishDetached = () => {
    void task.promise.finally(async () => {
      task.endTime = task.endTime ?? Date.now();
      await p.cleanup();
      const duration = (task.endTime - task.startTime) / 1000;
      p.activityStream.emit({
        id: p.callId,
        type: ActivityEventType.AGENT_END,
        timestamp: Date.now(),
        data: {
          agentName: p.agentType,
          result: task.result ?? task.error ?? '',
          duration,
          ...(p.buildEndData?.(task.result ?? '', duration) ?? {}),
        },
      });
      p.activityStream.emit({
        id: task.id,
        type: ActivityEventType.AGENT_BACKGROUND_COMPLETE,
        timestamp: Date.now(),
        data: { taskId: task.id, agentType: p.agentType, status: task.status, result: task.result, error: task.error },
      });
    });
  };

  if (p.runInBackground) {
    finishDetached();
    return { backgrounded: true, taskId: task.id };
  }

  // FOREGROUND: await completion, but let Ctrl+B detach the run mid-flight.
  const detached = await Promise.race([
    runOutcome.then(() => false, () => false),
    task.detachPromise.then(() => true),
  ]);

  if (detached) {
    finishDetached();
    return { backgrounded: true, taskId: task.id };
  }

  // Foreground completed normally: own cleanup here, drop from the fleet.
  task.endTime = Date.now();
  p.manager.removeTask(task.id);
  await p.cleanup();
  return { backgrounded: false, status: task.status, result: task.result ?? '', error: task.error };
}

/** Standard message returned to the model when a run is backgrounded. */
export function backgroundedMessage(taskId: string, agentType: string, verb: string): string {
  return (
    `Agent ${verb}: ${taskId} (${agentType}). Running concurrently; its result ` +
    `will be delivered to you automatically when complete — continue with other work.`
  );
}
