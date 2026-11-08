import type { ConversationViewSnapshot } from './ConversationViewStore.js';
import type { ConversationInputQueue } from './ConversationInputQueue.js';
/**
 * BackgroundAgentManager - Manages backgrounded (non-blocking) agent runs
 *
 * Delegated agents always execute
 * concurrently with the main conversation instead of blocking it. This manager
 * owns their lifecycle: registration, status tracking, live token/elapsed
 * reporting, cancellation, completion-result retention, and shutdown.
 *
 * It deliberately mirrors BashProcessManager (the equivalent for backgrounded
 * shell processes): a keyed Map, a concurrency cap, removeOldestCompleted-based
 * eviction, and getStatusReminders() for surfacing state back to the model.
 * State changes are surfaced to the UI via ActivityStream events emitted by the
 * caller (AGENT_START / AGENT_END / AGENT_BACKGROUND_COMPLETE), exactly as the
 * bash tool emits BACKGROUND_PROCESS_EXIT — this manager does not emit itself.
 */

import { Agent } from '../agent/Agent.js';
import { PooledAgent } from './AgentPoolService.js';
import { BACKGROUND_AGENT } from '../config/constants.js';
import { logger } from './Logger.js';
import { formatDuration } from '../ui/utils/timeUtils.js';

export type BackgroundAgentStatus = 'running' | 'done' | 'error' | 'cancelled';

/**
 * A single asynchronous agent run.
 */
export interface BackgroundAgentTask {
  /** Unique identifier: agent-{timestamp}-{random} */
  id: string;
  /** Agent type: 'explore' | 'plan' | custom agent name */
  agentType: string;
  /** The task prompt the agent was given (for display + reminders) */
  taskPrompt: string;
  /** Optional concise, human-readable label supplied by the delegating model. */
  description?: string;
  /** Messages arriving during finalization wait for the next task lease. */
  acceptingMessages: boolean;
  cancellationRequested?: boolean;
  deliveryPending?: boolean;
  /** Agent instance that owns completion delivery. */
  ownerId?: string;
  contextGeneration?: number;
  /** Current lifecycle status */
  status: BackgroundAgentStatus;
  /** Final text result (populated when status === 'done') */
  result: string | null;
  /** Error message (populated when status === 'error') */
  error: string | null;
  /** Resource release or completion publication failure; delivery cannot discharge it. */
  finalizationError: Error | null;
  /** Unix timestamp when the run started */
  startTime: number;
  /** Unix timestamp when the run settled (null while running) */
  endTime: number | null;
  /** Whether the result has been drained into the parent conversation yet */
  consumed: boolean;
  /** Complete execution, cleanup, and publication settlement (rejects on finalization failure). */
  promise: Promise<void>;
  /** The sub-agent instance — used for cancellation, transcript + token reads */
  subAgent: Agent;
  completedView?: ConversationViewSnapshot;
  completedModel?: string;
  completedTokens?: number;
  inputQueue?: ConversationInputQueue;
  /** Pooled-agent handle so the agent is released on completion/cancel */
  pooledAgent: PooledAgent | null;
  /** The tool call id that spawned this run (event nesting / pool key) */
  callId: string;

}

/**
 * Manages a collection of backgrounded agent runs.
 */
export class BackgroundAgentManager {
  private readonly tasks: Map<string, BackgroundAgentTask> = new Map();
  private readonly maxConcurrent: number;
  private shutdownPromise?: Promise<void>;

  constructor(maxConcurrent: number = BACKGROUND_AGENT.MAX_CONCURRENT) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Generate a unique background-agent id (mirrors BashProcessManager shellId).
   */
  generateId(): string {
    return `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Register a backgrounded agent run.
   *
   * Enforces the concurrency cap by first evicting the oldest completed run.
   * If all tracked runs are still running, throws so the caller can surface a
   * clear over-limit error to the model.
   *
   * @throws Error if at capacity with no completed runs to evict
   */
  /** Create an asynchronous run; addTask owns admission before execution begins. */
  createTask(meta: {
    agentType: string;
    taskPrompt: string;
    description?: string;
    subAgent: Agent;
    pooledAgent: PooledAgent | null;
    callId: string;
  }): BackgroundAgentTask {
    this.assertAdmissionOpen();

    const task: BackgroundAgentTask = {
      id: this.generateId(),
      agentType: meta.agentType,
      taskPrompt: meta.taskPrompt,
      description: meta.description,
      status: 'running',
      acceptingMessages: true,
      result: null,
      error: null,
      finalizationError: null,
      startTime: Date.now(),
      endTime: null,
      consumed: false,
      promise: Promise.resolve(),
      subAgent: meta.subAgent,
      inputQueue: meta.subAgent.getInputQueue?.(),
      pooledAgent: meta.pooledAgent,
      callId: meta.callId,
    };
    return task;
  }

  addTask(task: BackgroundAgentTask): void {
    this.assertAdmissionOpen();
    if (this.getRunningCount() >= this.maxConcurrent) {
      throw new Error(
        `Background agent limit reached (${this.maxConcurrent} running). ` +
        `Wait for one to finish or cancel it with cancel-agent before starting another.`
      );
    }

    // Keep the overall map bounded by evicting old, already-consumed completions.
    if (this.tasks.size >= this.maxConcurrent * 2) {
      if (!this.removeOldestCompleted()) throw new Error('Agent task retention is full. Inspect or acknowledge completed tasks before starting another.');
    }

    this.tasks.set(task.id, task);
    logger.debug(`[BackgroundAgentManager] Added agent ${task.id} (${task.agentType})`);
  }

  getTask(id: string): BackgroundAgentTask | undefined {
    return this.tasks.get(id);
  }

  listTasks(): BackgroundAgentTask[] {
    return Array.from(this.tasks.values());
  }

  removeTask(id: string): void {
    const task = this.tasks.get(id);
    if (task?.status === 'running' || task?.finalizationError) {
      throw new Error(`Cannot remove agent ${id} before successful finalization`);
    }
    if (this.tasks.delete(id)) {
      logger.debug(`[BackgroundAgentManager] Removed agent ${id} from tracking`);
    }
  }

  /** Number of currently running runs (any mode). */
  getRunningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running') count++;
    }
    return count;
  }

  getCount(): number {
    return this.tasks.size;
  }

  /**
   * Cancel a specific background agent.
   *
   * Signals the sub-agent to stop (graceful cancel via InterruptionManager +
   * tool abort signal). The task remains running until its promise actually
   * settles so it cannot be drained or evicted while cleanup is still active. Pooled-agent
   * release and the completion events are owned by the detached run itself,
   * which unwinds once the interrupt takes effect — so this never double-frees.
   *
   * @returns true if the agent was found and cancellation was requested
   */
  cancelTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task) {
      logger.debug(`[BackgroundAgentManager] Background agent ${id} not found for cancel`);
      return false;
    }

    if (task.status === 'running') {
      task.cancellationRequested = true;
      task.inputQueue?.cancel();
      try {
        task.subAgent.interrupt({ kind: 'user_cancel' });
      } catch (error) {
        logger.warn(`[BackgroundAgentManager] Failed to interrupt agent ${id}:`, error);
      }
    }

    return true;
  }

  /**
   * Get completed runs whose results have not yet been delivered to the parent
   * conversation, and mark them consumed so they are delivered exactly once.
   *
   * Mirrors how backgrounded bash output is drained on the next tool turn.
   */
  drainCompletedResults(ownerId?: string): BackgroundAgentTask[] {
    const drained: BackgroundAgentTask[] = [];
    for (const task of this.tasks.values()) {
      if (!task.deliveryPending && !task.consumed && task.status !== 'running' && (ownerId === undefined || task.ownerId === ownerId)) {
        task.consumed = true;
        drained.push(task);
      }
    }
    return drained;
  }

  /** Mark specific settled background results as delivered by an explicit join. */
  acknowledgeCompletedResults(ids: Iterable<string>): void {
    for (const id of ids) {
      const task = this.tasks.get(id);
      if (task && task.status !== 'running') {
        task.consumed = true;
      }
    }
  }

  /**
   * Status reminders for the model: running agents + recently completed ones.
   * Mirrors BashProcessManager.getStatusReminders().
   */
  getStatusReminders(ownerId?: string): string[] {
    const now = Date.now();
    const recentCutoff = now - BACKGROUND_AGENT.COMPLETED_RETENTION_MS;
    const reminders: string[] = [];

    for (const task of this.tasks.values()) {
      if (ownerId !== undefined && task.ownerId !== ownerId) continue;
      const elapsed = formatDuration((task.endTime ?? now) - task.startTime);

      if (task.status === 'running') {
        reminders.push(
          `Background agent ${task.id} [running]: ${task.agentType} — "${task.taskPrompt}" (${elapsed}). ` +
          `It will report its result automatically when done; use cancel-agent(agent_id="${task.id}") to stop it.`
        );
      } else if (!task.consumed && task.endTime && task.endTime >= recentCutoff) {
        reminders.push(
          `Background agent ${task.id} [${task.status}]: ${task.agentType} — "${task.taskPrompt}" finished (${elapsed}).`
        );
      }
    }

    return reminders;
  }

  /**
   * Shutdown all running background agents — interrupt and release each.
   */
  shutdown(): Promise<void> {
    this.shutdownPromise ??= Promise.resolve().then(() => this.drainTasks());
    return this.shutdownPromise;
  }

  private assertAdmissionOpen(): void {
    if (this.shutdownPromise) throw new Error('Background agent manager is shutting down');
  }

  private async drainTasks(): Promise<void> {
    const running = Array.from(this.tasks.values()).filter(t => t.status === 'running');
    const failures: unknown[] = [];
    logger.info(`[BackgroundAgentManager] Shutting down ${running.length} background agent(s)...`);
    for (const task of running) {
      try {
        this.cancelTask(task.id);
      } catch (error) {
        failures.push(new Error(`Failed to interrupt ${task.id} on shutdown`, { cause: error }));
      }
    }
    const settled = await Promise.allSettled(Array.from(this.tasks.values(), task => task.promise));
    failures.push(...settled.filter(result => result.status === 'rejected').map(result => result.reason));
    if (failures.length) throw new AggregateError(failures, 'Background agent shutdown failed');
    this.tasks.clear();
    logger.info('[BackgroundAgentManager] Shutdown complete');
  }

  /**
   * Remove the oldest consumed run whose finalization succeeded.
   *
   * @returns true if a run was removed, false if every run still requires retention
   */
  private removeOldestCompleted(): boolean {
    let oldest: BackgroundAgentTask | null = null;
    let oldestTime = Infinity;

    for (const task of this.tasks.values()) {
      if (task.status !== 'running' && !task.finalizationError && task.consumed && task.startTime < oldestTime) {
        oldest = task;
        oldestTime = task.startTime;
      }
    }

    if (oldest) {
      this.removeTask(oldest.id);
      return true;
    }

    return false;
  }
}
