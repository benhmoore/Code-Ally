/**
 * BackgroundTaskRegistry - unified front door for waiting on / watching tasks
 *
 * Presents a single BackgroundTask abstraction over three kinds of long-running
 * work so the `wait` and `watch` tools (and the fleet) can target them
 * uniformly:
 *   - 'agent'   : backgrounded sub-agents (BackgroundAgentManager)
 *   - 'shell'   : backgrounded bash processes (BashProcessManager)
 *   - 'watcher' : a polled condition (file exists, HTTP 200, shell predicate)
 *
 * Agents and shells are read through adapters (no duplication of their state).
 * Watchers are owned natively here (the registry runs their poll loops).
 *
 * Tasks flagged `watched` auto-wake the main agent when they complete while it
 * is idle (handled by the UI's wake coordinator subscribing to completion
 * events). The registry only tracks the watched set + emits BACKGROUND_TASK_COMPLETE.
 */

import { BackgroundAgentManager } from './BackgroundAgentManager.js';
import { BashProcessManager, type ProcessInfo } from './BashProcessManager.js';
import { ActivityStream } from './ActivityStream.js';
import { ActivityEventType } from '../types/index.js';
import { logger } from './Logger.js';

export type BackgroundTaskKind = 'agent' | 'shell' | 'watcher';
export type BackgroundTaskStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface BackgroundTask {
  id: string;
  kind: BackgroundTaskKind;
  /** Human-readable label: agent type / shell command / watcher description */
  label: string;
  status: BackgroundTaskStatus;
  startTime: number;
  endTime: number | null;
  /** Final result/output text when settled (best-effort by kind) */
  result: string | null;
  error: string | null;
  /** Whether completion should auto-wake the idle main agent */
  watched: boolean;
  /** Whether a running task is required before a durable objective can complete */
  blocksCompletion: boolean;
}

interface WatcherTask {
  id: string;
  label: string;
  status: BackgroundTaskStatus;
  startTime: number;
  endTime: number | null;
  result: string | null;
  error: string | null;
  blocksCompletion: boolean;
  cancel: () => void;
  settled: Promise<void>;
}

export interface WatcherSpec {
  /** Human-readable description, e.g. 'file exists: /tmp/done' */
  description: string;
  intervalMs: number;
  timeoutMs: number;
  /** Auto-wake the idle main agent when satisfied */
  watched: boolean;
  /** Predicate evaluated each interval; true === condition satisfied */
  check: (signal: AbortSignal) => Promise<boolean>;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function shellStatus(process: ProcessInfo): BackgroundTaskStatus {
  if (process.status !== 'exited') return 'running';
  if (process.exitSignal || process.terminationSignal) return 'cancelled';
  return process.exitCode === 0 ? 'done' : 'error';
}

export class BackgroundTaskRegistry {
  private readonly watchers = new Map<string, WatcherTask>();
  /** Task ids whose completion should auto-wake the idle main agent. */
  private readonly watchedIds = new Set<string>();

  constructor(
    private readonly agentManager: BackgroundAgentManager,
    private readonly bashManager: BashProcessManager,
    private readonly activityStream: ActivityStream,
  ) {}

  /** Flag an existing task (agent/shell) so its completion auto-wakes the main agent. */
  markWatched(id: string): void {
    this.watchedIds.add(id);
  }

  isWatched(id: string): boolean {
    return this.watchedIds.has(id);
  }

  /** Stop auto-waking on a task (called after it has woken the main agent once). */
  clearWatched(id: string): void {
    this.watchedIds.delete(id);
  }

  /** Unified view of all known tasks (agents + shells + watchers). */
  list(): BackgroundTask[] {
    const tasks: BackgroundTask[] = [];

    for (const t of this.agentManager.listTasks()) {
      tasks.push({
        id: t.id,
        kind: 'agent',
        label: t.agentType,
        status: t.status,
        startTime: t.startTime,
        endTime: t.endTime,
        result: t.result,
        error: t.error,
        watched: this.watchedIds.has(t.id),
        blocksCompletion: true,
      });
    }

    for (const p of this.bashManager.listProcesses()) {
      tasks.push({
        id: p.id,
        kind: 'shell',
        label: p.command,
        status: shellStatus(p),
        startTime: p.startTime,
        endTime: p.exitTime,
        result: null,
        error: null,
        watched: this.watchedIds.has(p.id),
        blocksCompletion: p.blocksCompletion,
      });
    }

    for (const w of this.watchers.values()) {
      tasks.push({
        id: w.id,
        kind: 'watcher',
        label: w.label,
        status: w.status,
        startTime: w.startTime,
        endTime: w.endTime,
        result: w.result,
        error: w.error,
        watched: this.watchedIds.has(w.id),
        blocksCompletion: w.blocksCompletion,
      });
    }

    return tasks;
  }

  get(id: string): BackgroundTask | undefined {
    return this.list().find((t) => t.id === id);
  }

  /**
   * Block until the target tasks settle (status !== 'running'), the timeout
   * elapses, or the abort signal fires. Uniform across kinds via status polling.
   *
   * @returns the final BackgroundTask views for the targets
   */
  async waitFor(
    target: string[] | 'all',
    opts: { timeoutMs: number; pollMs?: number; signal?: AbortSignal },
  ): Promise<BackgroundTask[]> {
    // Completion events wake the UI immediately; this low-frequency fallback
    // covers adapters whose state changes without an event while avoiding
    // hundreds of thousands of polls during multi-day waits.
    const pollMs = opts.pollMs ?? 5000;
    const deadline = Date.now() + opts.timeoutMs;

    const targetIds = (): string[] =>
      target === 'all'
        ? this.list().filter((t) => t.status === 'running').map((t) => t.id)
        : target;

    const ids = targetIds();
    const settled = (): boolean =>
      ids.every((id) => {
        const t = this.get(id);
        return !t || t.status !== 'running';
      });

    while (!settled() && Date.now() < deadline && !opts.signal?.aborted) {
      await abortableDelay(Math.min(pollMs, Math.max(1, deadline - Date.now())), opts.signal);
    }

    return ids.map((id) => this.get(id)).filter((t): t is BackgroundTask => !!t);
  }

  /**
   * Start a condition watcher. Returns immediately with its task view; the poll
   * loop runs in the background and marks the task done when the predicate is
   * satisfied (or error on timeout). Emits BACKGROUND_TASK_COMPLETE on settle.
   */
  createWatcher(spec: WatcherSpec): BackgroundTask {
    const id = `watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let cancelled = false;
    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const task: WatcherTask = {
      id,
      label: spec.description,
      status: 'running',
      startTime: Date.now(),
      endTime: null,
      result: null,
      error: null,
      blocksCompletion: spec.watched,
      cancel: () => { cancelled = true; controller.abort(); },
      settled,
    };
    this.watchers.set(id, task);
    if (spec.watched) this.watchedIds.add(id);

    void (async () => {
      const deadline = Date.now() + spec.timeoutMs;
      while (!cancelled && Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        const checkTimeoutMs = Math.max(1_000, Math.min(30_000, spec.intervalMs, remaining));
        const checkController = new AbortController();
        const forwardAbort = () => checkController.abort();
        controller.signal.addEventListener('abort', forwardAbort, { once: true });
        const checkTimer = setTimeout(() => checkController.abort(), checkTimeoutMs);
        try {
          if (await spec.check(checkController.signal)) {
            task.status = 'done';
            task.result = `Condition satisfied: ${spec.description}`;
            break;
          }
        } catch (error) {
          // Transient check failures are non-fatal; keep polling until timeout.
          logger.debug(`[BackgroundTaskRegistry] watcher ${id} check error:`, error);
        } finally {
          clearTimeout(checkTimer);
          controller.signal.removeEventListener('abort', forwardAbort);
        }
        await abortableDelay(Math.min(spec.intervalMs, Math.max(0, deadline - Date.now())), controller.signal);
      }
      if (task.status === 'running') {
        if (cancelled) {
          task.status = 'cancelled';
          task.error = 'Watcher cancelled';
        } else {
          task.status = 'error';
          task.error = `Timed out waiting for: ${spec.description}`;
        }
      }
      task.endTime = Date.now();
      try {
        this.activityStream.emit({
          id,
          type: ActivityEventType.BACKGROUND_TASK_COMPLETE,
          timestamp: Date.now(),
          data: { taskId: id, kind: 'watcher', status: task.status, result: task.result, error: task.error, watched: spec.watched },
        });
      } finally {
        settle();
      }
    })();

    return this.get(id)!;
  }

  /** Cancel a watcher (no-op for agents/shells — use their own cancel paths). */
  cancelWatcher(id: string): boolean {
    const w = this.watchers.get(id);
    if (!w) return false;
    w.cancel();
    return true;
  }

  /** Drop settled watchers older than the retention window (housekeeping). */
  pruneWatchers(retentionMs: number): void {
    const now = Date.now();
    for (const [id, w] of this.watchers.entries()) {
      if (w.status !== 'running' && w.endTime != null && now - w.endTime > retentionMs) {
        this.watchers.delete(id);
      }
    }
  }

  /** Cancel all owned watchers and await their poll/check cleanup. */
  async shutdown(): Promise<void> {
    const running = Array.from(this.watchers.values()).filter((w) => w.status === 'running');
    for (const watcher of running) watcher.cancel();
    await Promise.allSettled(running.map((watcher) => watcher.settled));
    this.watchers.clear();
    this.watchedIds.clear();
  }
}
