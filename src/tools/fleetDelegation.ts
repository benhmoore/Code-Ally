/**
 * runFleetDelegation - shared foreground/background run lifecycle for delegations
 *
 * Both AgentTool (the `agent` tool) and BaseDelegationTool (`explore`/`plan`)
 * register their runs here so every agent — foreground or background — appears
 * in the fleet, can be entered, and can be promoted to background via Ctrl+B.
 *
 * Lifecycle:
 * - Registers a task with the BackgroundAgentManager (background runs are
 *   capped; this function owns cleanup even when admission fails).
 * - One task promise covers execution, cleanup, and terminal publication.
 * - Detached completion emits AGENT_END / AGENT_BACKGROUND_COMPLETE here.
 * - Foreground callers receive the settled result and emit their own AGENT_END.
 */

import { BackgroundAgentManager, BackgroundAgentStatus, type BackgroundAgentTask } from '../services/BackgroundAgentManager.js';
import { Agent } from '../agent/Agent.js';
import { PooledAgent } from '../services/AgentPoolService.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ActivityEventType } from '../types/index.js';
import { PERMISSION_MESSAGES } from '../config/constants.js';
import { formatError } from '../utils/errorUtils.js';
import { logger } from '../services/Logger.js';

export interface FleetDelegationParams {
  manager: BackgroundAgentManager;
  activityStream: ActivityStream;
  agentType: string;
  taskPrompt: string;
  /** Optional concise label for navigation in the agent fleet. */
  description?: string;
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
  let task: BackgroundAgentTask;
  try {
    task = p.manager.createTask({
      agentType: p.agentType,
      taskPrompt: p.taskPrompt,
      description: p.description,
      mode: p.runInBackground ? 'background' : 'foreground',
      subAgent: p.subAgent,
      pooledAgent: p.pooledAgent,
      callId: p.callId,
    });
    p.manager.addTask(task);
  } catch (error) {
    try { await p.cleanup(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Delegation admission and cleanup failed'); }
    throw error;
  }

  // Defer execution until the complete settlement promise has been installed.
  task.promise = Promise.resolve().then(async () => {
    let status: BackgroundAgentStatus = 'done';
    try {
      const res = await p.run();
      task.result = res;
      const content = res?.split('\n\nIMPORTANT:')[0]?.trim();
      if (content === PERMISSION_MESSAGES.USER_FACING_INTERRUPTION) {
        status = 'cancelled';
      }
    } catch (error) {
      task.error = formatError(error);
      status = 'error';
    }
    const cleanupFailures: unknown[] = [];
    try { await p.cleanup(); }
    catch (error) {
      cleanupFailures.push(error);
      status = 'error';
      task.error = [task.error, `Delegation cleanup failed: ${formatError(error)}`].filter(Boolean).join('\n');
    }
    if (cleanupFailures.length) {
      task.finalizationError = new AggregateError(cleanupFailures, 'Delegation cleanup failed');
    }
    task.status = status;
    task.endTime = Date.now();
    try {
      if (task.mode === 'background') {
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
      }
    } catch (error) {
      task.status = 'error';
      task.error = [task.error, `Delegation publication failed: ${formatError(error)}`].filter(Boolean).join('\n');
      task.finalizationError = new AggregateError([...cleanupFailures, error], 'Delegation finalization failed');
      throw task.finalizationError;
    }
    if (task.finalizationError) throw task.finalizationError;
  });
  // Observe detached rejection without replacing the authoritative promise.
  void task.promise.catch(error => logger.error(`[fleetDelegation] Finalization failed for ${task.id}:`, error));

  if (p.runInBackground) {
    return { backgrounded: true, taskId: task.id };
  }

  // FOREGROUND: await completion, but let Ctrl+B detach the run mid-flight.
  const detached = await Promise.race([
    task.promise.then(() => false, () => false),
    task.detachPromise.then(() => true),
  ]);

  if (detached) {
    return { backgrounded: true, taskId: task.id };
  }

  // Foreground ownership may be dropped only after complete finalization.
  await task.promise;
  p.manager.removeTask(task.id);
  return { backgrounded: false, status: task.status, result: task.result ?? '', error: task.error };
}

/** Standard message returned to the model when a run is backgrounded. */
export function backgroundedMessage(taskId: string, agentType: string, verb: string): string {
  return (
    `Agent ${verb}: ${taskId} (${agentType}). Running concurrently; its result ` +
    `will be delivered to you automatically when complete — continue with other work.`
  );
}
