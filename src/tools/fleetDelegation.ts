/**
 * One asynchronous delegation lifecycle owns execution, queued messages, pool
 * release, immutable inspection state and exactly-once completion publication.
 * Launch returns after admission; only an explicit wait joins the child run.
 */

import { BackgroundAgentManager, BackgroundAgentStatus, type BackgroundAgentTask } from '../services/BackgroundAgentManager.js';
import { Agent } from '../agent/Agent.js';
import { PooledAgent } from '../services/AgentPoolService.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ActivityEventType } from '../types/index.js';
import { PERMISSION_MESSAGES } from '../config/constants.js';
import { formatError } from '../utils/errorUtils.js';
import type { AgentMessagingService } from '../services/AgentMessagingService.js';
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
  parentAgent?: Agent;
  agentId?: string | null;
  messaging?: AgentMessagingService;
  publishCompletion?: boolean;
  pooledAgent: PooledAgent | null;
  /** Execute the agent and return its final response text. */
  run: () => Promise<string>;
  /** Release the agent + finalize delegation. Called exactly once when settled. */
  cleanup: () => Promise<void> | void;
  /** Extra AGENT_END data for completion (e.g. contextUsage). */
  buildEndData?: (result: string, durationSec: number) => Record<string, any>;
}

export interface FleetDelegationOutcome { taskId: string; }

export async function runFleetDelegation(p: FleetDelegationParams): Promise<FleetDelegationOutcome> {
  let task: BackgroundAgentTask;
  let admittedTask: BackgroundAgentTask | undefined;
  try {
    task = p.manager.createTask({
      agentType: p.agentType,
      taskPrompt: p.taskPrompt,
      description: p.description,
      subAgent: p.subAgent,
      pooledAgent: p.pooledAgent,
      callId: p.callId,
    });
    task.ownerId = p.parentAgent?.getInstanceId();
    p.manager.addTask(task);
    admittedTask = task;
    task.contextGeneration = p.messaging?.register(p.subAgent, p.agentId ?? task.id, p.parentAgent, !!p.pooledAgent);
  } catch (error) {
    try { await p.cleanup(); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Delegation admission and cleanup failed', { cause: cleanupError }); }
    if (admittedTask) {
      admittedTask.status = 'error';
      admittedTask.acceptingMessages = false;
      admittedTask.error = formatError(error);
      admittedTask.endTime = Date.now();
      admittedTask.consumed = true;
      p.manager.removeTask(admittedTask.id);
    }
    throw error;
  }

  // Defer execution until the complete settlement promise has been installed.
  const execute = async () => { task.result = await p.run(); };
  const execution = task.inputQueue
    ? task.inputQueue.enqueue(p.taskPrompt, execute)
    : Promise.resolve().then(execute);
  task.promise = Promise.resolve().then(async () => {
    let status: BackgroundAgentStatus = 'done';
    try {
      await execution;
      const outcome = p.subAgent.getTurnSnapshot?.();
      if (outcome?.state === 'failed') {
        status = 'error';
        task.error = outcome.error || 'Agent turn failed';
      } else if (outcome?.state === 'interrupted') {
        status = 'cancelled';
      }
      const content = task.result?.split('\n\nIMPORTANT:')[0]?.trim();
      if (status === 'done' && content === PERMISSION_MESSAGES.USER_FACING_INTERRUPTION) {
        status = 'cancelled';
      }
    } catch (error) {
      task.error = formatError(error);
      status = 'error';
    }
    task.acceptingMessages = false;
    await task.inputQueue?.whenIdle();
    if (task.cancellationRequested) status = 'cancelled';
    // Freeze the completed conversation before a pooled agent can be reused.
    // Pending follow-ups remain visible as unsent and can be recalled by the user.
    const view = p.subAgent.getConversationView?.().getSnapshot();
    if (view) task.completedView = structuredClone(view);
    task.completedModel = p.subAgent.getModelClient?.().modelName;
    task.completedTokens = p.subAgent.getTokenManager?.().getCurrentTokenCount();
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
    if (p.publishCompletion !== false && p.parentAgent && p.messaging) {
      p.messaging.publishCompletion(task, p.parentAgent);
    }
    try {
      {
        const duration = (task.endTime - task.startTime) / 1000;
        p.activityStream.emit({
          id: p.callId,
          type: ActivityEventType.AGENT_END,
          timestamp: Date.now(),
          data: {
            agentName: p.agentType,
            result: task.error ?? task.result ?? '',
            duration,
            ...(p.buildEndData?.(task.result ?? '', duration) ?? {}),
            status: task.status,
            error: task.error,
            interrupted: task.status === 'cancelled',
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
  // Observe asynchronous rejection without replacing the authoritative promise.
  void task.promise.catch(error => logger.error(`[fleetDelegation] Finalization failed for ${task.id}:`, error));

  return { taskId: task.id };
}

/** Standard message returned to the model when a run is backgrounded. */
export function backgroundedMessage(taskId: string, agentType: string, verb: string): string {
  return (
    `Agent ${verb}: ${taskId} (${agentType}). Running concurrently; its result ` +
    `will be delivered to you automatically when complete — continue with other work.`
  );
}
