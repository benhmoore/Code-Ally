/**
 * BackgroundAgentManager - Manages backgrounded (non-blocking) agent runs
 *
 * Sub-agents spawned via the `agent` tool with run_in_background=true execute
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
 * Execution mode of a tracked run.
 * - 'foreground': the spawning tool is still awaiting it (it blocks the main
 *   loop). Shown in the fleet so the user can enter it or background it.
 * - 'background': detached/non-blocking; its result is drained into the parent
 *   conversation when it completes.
 */
export type BackgroundAgentMode = 'foreground' | 'background';

/**
 * A single tracked agent run (foreground or background).
 */
export interface BackgroundAgentTask {
  /** Unique identifier: agent-{timestamp}-{random} */
  id: string;
  /** Agent type: 'explore' | 'plan' | custom agent name */
  agentType: string;
  /** The task prompt the agent was given (for display + reminders) */
  taskPrompt: string;
  /** Execution mode (may flip foreground → background via detach) */
  mode: BackgroundAgentMode;
  /** Current lifecycle status */
  status: BackgroundAgentStatus;
  /** Final text result (populated when status === 'done') */
  result: string | null;
  /** Error message (populated when status === 'error') */
  error: string | null;
  /** Unix timestamp when the run started */
  startTime: number;
  /** Unix timestamp when the run settled (null while running) */
  endTime: number | null;
  /** Whether the result has been drained into the parent conversation yet */
  consumed: boolean;
  /** The run promise (awaited by the tool for foreground; detached for background) */
  promise: Promise<void>;
  /** The sub-agent instance — used for cancellation, transcript + token reads */
  subAgent: Agent;
  /** Pooled-agent handle so the agent is released on completion/cancel */
  pooledAgent: PooledAgent | null;
  /** The tool call id that spawned this run (event nesting / pool key) */
  callId: string;
  /** Resolves when the user backgrounds a foreground run (Ctrl+B) */
  detachPromise: Promise<void>;
  /** Trigger the detach (flip foreground → background). Set internally. */
  detach: () => void;
}

/**
 * Manages a collection of backgrounded agent runs.
 */
export class BackgroundAgentManager {
  private readonly tasks: Map<string, BackgroundAgentTask> = new Map();
  private readonly maxConcurrent: number;

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
  /**
   * Build a tracked task with a detach deferred wired up. The caller fills in
   * the run `promise` and then calls addTask(). detach() flips the mode to
   * 'background' and resolves detachPromise so a foreground awaiter can stop
   * blocking the main loop while the run continues.
   */
  createTask(meta: {
    agentType: string;
    taskPrompt: string;
    mode: BackgroundAgentMode;
    subAgent: Agent;
    pooledAgent: PooledAgent | null;
    callId: string;
  }): BackgroundAgentTask {
    let detachResolve: () => void = () => {};
    const detachPromise = new Promise<void>((resolve) => { detachResolve = resolve; });

    const task: BackgroundAgentTask = {
      id: this.generateId(),
      agentType: meta.agentType,
      taskPrompt: meta.taskPrompt,
      mode: meta.mode,
      status: 'running',
      result: null,
      error: null,
      startTime: Date.now(),
      endTime: null,
      consumed: false,
      promise: Promise.resolve(),
      subAgent: meta.subAgent,
      pooledAgent: meta.pooledAgent,
      callId: meta.callId,
      detachPromise,
      detach: () => {},
    };
    task.detach = () => {
      if (task.mode === 'foreground' && task.status === 'running') {
        task.mode = 'background';
        detachResolve();
      }
    };
    return task;
  }

  addTask(task: BackgroundAgentTask): void {
    // Only background runs count against the concurrency cap; foreground runs
    // are transient (awaited by their tool) and block the main loop anyway.
    if (task.mode === 'background' && this.getBackgroundRunningCount() >= this.maxConcurrent) {
      throw new Error(
        `Background agent limit reached (${this.maxConcurrent} running). ` +
        `Wait for one to finish or cancel it with cancel-agent before starting another.`
      );
    }

    // Keep the overall map bounded by evicting old, already-consumed completions.
    if (this.tasks.size >= this.maxConcurrent * 2) {
      this.removeOldestCompleted();
    }

    this.tasks.set(task.id, task);
    logger.debug(`[BackgroundAgentManager] Added ${task.mode} agent ${task.id} (${task.agentType})`);
  }

  getTask(id: string): BackgroundAgentTask | undefined {
    return this.tasks.get(id);
  }

  listTasks(): BackgroundAgentTask[] {
    return Array.from(this.tasks.values());
  }

  removeTask(id: string): void {
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

  /** Number of currently running background runs (counts against the cap). */
  getBackgroundRunningCount(): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.status === 'running' && task.mode === 'background') count++;
    }
    return count;
  }

  /**
   * Background all currently-running foreground runs (Ctrl+B). Each flips to
   * 'background' mode and its detachPromise resolves, so the awaiting tool stops
   * blocking and the run continues, reporting its result via the normal drain.
   *
   * @returns the number of runs detached
   */
  requestDetachAll(): number {
    let detached = 0;
    for (const task of this.tasks.values()) {
      if (task.mode === 'foreground' && task.status === 'running') {
        task.detach();
        detached++;
      }
    }
    return detached;
  }

  getCount(): number {
    return this.tasks.size;
  }

  /**
   * Cancel a specific background agent.
   *
   * Signals the sub-agent to stop (graceful cancel via InterruptionManager +
   * tool abort signal) and optimistically marks it cancelled. Pooled-agent
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
      try {
        task.subAgent.interrupt({ kind: 'user_cancel' });
      } catch (error) {
        logger.warn(`[BackgroundAgentManager] Failed to interrupt agent ${id}:`, error);
      }
      task.status = 'cancelled';
    }

    return true;
  }

  /**
   * Get completed runs whose results have not yet been delivered to the parent
   * conversation, and mark them consumed so they are delivered exactly once.
   *
   * Mirrors how backgrounded bash output is drained on the next tool turn.
   */
  drainCompletedResults(): BackgroundAgentTask[] {
    const drained: BackgroundAgentTask[] = [];
    for (const task of this.tasks.values()) {
      // Only background runs deliver via the drain; foreground runs return their
      // result directly to the tool caller.
      if (task.mode === 'background' && !task.consumed && task.status !== 'running') {
        task.consumed = true;
        drained.push(task);
      }
    }
    return drained;
  }

  /**
   * Status reminders for the model: running agents + recently completed ones.
   * Mirrors BashProcessManager.getStatusReminders().
   */
  getStatusReminders(): string[] {
    const now = Date.now();
    const recentCutoff = now - BACKGROUND_AGENT.COMPLETED_RETENTION_MS;
    const reminders: string[] = [];

    for (const task of this.tasks.values()) {
      const elapsed = formatDuration((task.endTime ?? now) - task.startTime);

      if (task.status === 'running') {
        reminders.push(
          `Background agent ${task.id} [running]: ${task.agentType} — "${task.taskPrompt}" (${elapsed}). ` +
          `It will report its result automatically when done; use cancel-agent(agent_id="${task.id}") to stop it.`
        );
      } else if (task.endTime && task.endTime >= recentCutoff) {
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
  async shutdown(): Promise<void> {
    const running = Array.from(this.tasks.values()).filter(t => t.status === 'running');
    if (running.length === 0) {
      logger.debug('[BackgroundAgentManager] No running background agents to shutdown');
      return;
    }

    logger.info(`[BackgroundAgentManager] Shutting down ${running.length} background agent(s)...`);
    for (const task of running) {
      try {
        task.subAgent.interrupt({ kind: 'user_cancel' });
      } catch (error) {
        logger.warn(`[BackgroundAgentManager] Failed to interrupt ${task.id} on shutdown:`, error);
      }
      task.status = 'cancelled';
      task.endTime = Date.now();
    }

    this.tasks.clear();
    logger.info('[BackgroundAgentManager] Shutdown complete');
  }

  /**
   * Remove the oldest settled (non-running) run from tracking.
   *
   * @returns true if a run was removed, false if all runs are still running
   */
  private removeOldestCompleted(): boolean {
    let oldest: BackgroundAgentTask | null = null;
    let oldestTime = Infinity;

    for (const task of this.tasks.values()) {
      if (task.status !== 'running' && task.startTime < oldestTime) {
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
