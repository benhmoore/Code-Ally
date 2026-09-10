import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectRunsDir } from '../config/paths.js';
import type { RunPolicy } from './RunPolicyManager.js';
import { ServiceRegistry } from './ServiceRegistry.js';
import { FileOwnership } from '../utils/FileOwnership.js';
import { InvalidRunJournalError, type RunJournalEvent } from './RunJournal.js';
import { RunJournalStore } from './RunJournalStore.js';
import { RunExecution } from './RunExecution.js';
import { isResumableRunStatus, reduceRunEvent, type RunState } from './RunState.js';
import { logger } from './Logger.js';
export type { RunJournalEvent } from './RunJournal.js';

export type RunStatus = 'running' | 'waiting_retry' | 'completed' | 'blocked' | 'cancelled' | 'failed' | 'interrupted';
export type RunOutcome =
  | { kind: 'completed'; summary: string }
  | { kind: 'retryable_failure'; error: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'cancelled'; reason: string }
  | { kind: 'failed'; error: string };

export interface RunSnapshot {
  version: 1;
  runId: string;
  objective: string;
  policy: RunPolicy;
  status: RunStatus;
  epoch: number;
  startedAt: number;
  updatedAt: number;
  nextAction?: string;
  outcome?: RunOutcome;
}

export class RunPersistenceError extends Error {
  constructor(cause: unknown) {
    super('Run journal persistence failed; recovery is required before further execution', { cause });
    this.name = 'RunPersistenceError';
  }
}

/** Stable identity for one owned journal, independent of conversation selection. */
interface OwnedRun {
  readonly runId: string;
  state?: RunState;
  ownership?: FileOwnership;
  executions: number;
  retired: boolean;
}

/** Exclusive owner of a journal-authoritative objective. Startup never executes work. */
export class RunSupervisor {
  private active?: OwnedRun;
  private transitions: Promise<unknown> = Promise.resolve();
  private persistenceFailure?: Error;

  private readonly journals: RunJournalStore;

  constructor(private readonly runsDir = getProjectRunsDir()) {
    this.journals = new RunJournalStore(runsDir);
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
    for (const entry of await fs.readdir(this.runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const ownership = await FileOwnership.acquire(path.join(this.journals.directory(entry.name), 'owner.lock'));
      if (!ownership) continue;
      try {
        let state: RunState;
        try { state = await this.journals.replay(entry.name); }
        catch (error) {
          if (!(error instanceof InvalidRunJournalError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          logger.warn('Run journal could not be recovered:', entry.name, error);
          continue;
        }
        if (this.isStateRunning(state)) {
          const event = this.event(state, 'run_interrupted', { reason: 'Previous Code-Ally process ended without a clean handoff' });
          const next = reduceRunEvent(state, event);
          await this.journals.append(event);
          state = next;
        }
        await this.journals.checkpoint(state);
      } finally { await ownership.release(); }
    }
  }

  async listResumableRuns(limit = 20): Promise<RunSnapshot[]> {
    await fs.mkdir(this.runsDir, { recursive: true });
    const snapshots: RunSnapshot[] = [];
    for (const entry of await fs.readdir(this.runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const state = await this.journals.replay(entry.name);
        if (isResumableRunStatus(state.snapshot.status)) snapshots.push(state.snapshot);
      } catch (error) {
        if (!(error instanceof InvalidRunJournalError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        logger.warn('Run journal could not be listed:', entry.name, error);
      }
    }
    return snapshots.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(1, limit));
  }

  async resumeRun(runId: string): Promise<RunSnapshot> {
    return this.serialize(async () => {
      this.assertHealthy();
      if (this.isRunning()) throw new Error('A durable objective is already running');
      await this.releaseOwnership();
      const ownership = await FileOwnership.acquire(path.join(this.journals.directory(runId), 'owner.lock'));
      if (!ownership) throw new Error(`Run ${runId} is owned by another live supervisor`);
      try {
        let state: RunState;
        try { state = await this.journals.replay(runId); }
        catch (cause) { throw new Error(`Cannot resume run ${runId}: journal recovery failed`, { cause }); }
        if (!isResumableRunStatus(state.snapshot.status)) throw new Error(`Run ${runId} is ${state.snapshot.status}, not resumable`);
        await this.journals.ensureDirectory(runId);
        this.active = { runId, ownership, state, executions: 0, retired: false };
        await this.commit('run_resumed', { previousStatus: state.snapshot.status });
        return this.getActiveRun()!;
      } catch (error) {
        this.active = undefined;
        await ownership.release();
        throw error;
      }
    });
  }

  getActiveRun(): RunSnapshot | undefined { return this.active?.state ? structuredClone(this.active.state.snapshot) : undefined; }
  isRunning(): boolean { return !!this.active?.state && this.isStateRunning(this.active.state); }
  getOutcome(): RunOutcome | undefined { return this.active?.state?.snapshot.outcome ? structuredClone(this.active.state.snapshot.outcome) : undefined; }

  async startRun(objective: string, policy: RunPolicy): Promise<RunSnapshot> {
    return this.serialize(async () => {
      this.assertHealthy();
      if (this.isRunning()) return this.getActiveRun()!;
      await this.releaseOwnership();
      const runId = randomUUID();
      await this.journals.ensureDirectory(runId);
      const ownership = await FileOwnership.acquire(path.join(this.journals.directory(runId), 'owner.lock'));
      if (!ownership) throw new Error(`Run ${runId} is owned by another live supervisor`);
      this.active = { runId, ownership, executions: 0, retired: false };
      try {
        await this.persistTransition(this.active, { runId, sequence: 1, timestamp: Date.now(), type: 'run_started', data: { objective, policy: { ...policy } } });
        return this.getActiveRun()!;
      } catch (error) {
        await this.releaseOwnership();
        throw error;
      }
    });
  }

  async record(type: string, data?: Record<string, unknown>): Promise<void> {
    return this.serialize(() => this.commit(type, data));
  }

  acquireExecution(): RunExecution | undefined {
    this.assertHealthy();
    const run = this.active;
    if (!run) return undefined;
    if (run.retired || !run.ownership || !run.state || !this.isStateRunning(run.state)) {
      throw new Error('The admitting durable objective no longer permits new execution');
    }
    run.executions += 1;
    return new RunExecution(run.runId,
      (type, data) => this.serialize(async () => {
        this.assertHealthy();
        await this.persistTransition(run, this.event(run.state!, type, data));
      }),
      () => this.serialize(async () => {
        run.executions -= 1;
        if (run.retired && run.executions === 0) await this.closeOwnedRun(run);
      }),
    );
  }
  async rolloverEpoch(reason: string): Promise<void> {
    return this.serialize(async () => {
      if (this.isRunning()) await this.commit('epoch_rolled_over', { reason, epoch: this.active!.state!.snapshot.epoch + 1 });
    });
  }
  async recordProgress(summary: string): Promise<void> {
    return this.serialize(async () => {
      if (this.isRunning()) await this.commit('assistant_progress', { summary: summary.slice(0, 4000) });
    });
  }
  async reconcileToolEffect(callId: string, resolution: string, evidence: string): Promise<boolean> {
    return this.serialize(async () => {
      this.assertHealthy();
      if (!this.active?.state?.unknownEffects.has(callId)) return false;
      await this.commit('tool_reconciled', { callId, resolution: resolution.slice(0, 200), evidence: evidence.slice(0, 4000) });
      return true;
    });
  }

  async claimComplete(summary: string, evidence: string[] = []): Promise<{ accepted: boolean; blockers: string[] }> {
    return this.serialize(async () => {
      this.assertHealthy();
      if (!this.isRunning()) return { accepted: false, blockers: ['No active durable objective'] };
      const registry = ServiceRegistry.getInstance();
      const blockers: string[] = [];
      const incompleteTodos = registry.get('todo_manager')?.getTodos().filter(todo => todo.status !== 'completed') ?? [];
      if (incompleteTodos.length) blockers.push(`${incompleteTodos.length} todo item(s) remain incomplete`);
      const backgroundTasks = registry.get('background_task_registry')?.list() ?? [];
      const runningTasks = backgroundTasks.filter(task => task.status === 'running' && task.blocksCompletion);
      if (runningTasks.length) blockers.push(`${runningTasks.length} background dependency/dependencies are still running`);
      const pendingResults = backgroundTasks.filter(task => task.blocksCompletion && task.resultPending);
      if (pendingResults.length) blockers.push(`${pendingResults.length} required background result(s) await delivery`);
      const unsettled = new Set([...this.active!.state!.unknownEffects, ...this.active!.state!.runningEffects]);
      if (unsettled.size) blockers.push(`${unsettled.size} non-idempotent tool outcome(s) require reconciliation: ${[...unsettled].join(', ')}`);
      if (blockers.length) {
        await this.commit('completion_rejected', { blockers });
        return { accepted: false, blockers };
      }
      await this.commit('run_completed', { summary, evidence });
      return { accepted: true, blockers: [] };
    });
  }

  async block(reason: string): Promise<void> { await this.finish('run_blocked', { reason }); }
  async fail(error: string): Promise<void> { await this.finish('run_failed', { error }); }
  async cancel(reason: string): Promise<void> { await this.finish('run_cancelled', { reason }); }
  private async finish(type: string, data: Record<string, unknown>): Promise<void> {
    return this.serialize(async () => { if (this.isRunning()) await this.commit(type, data); });
  }
  async interruptForShutdown(reason: string): Promise<void> {
    return this.serialize(async () => {
      try { if (this.isRunning()) await this.commit('run_interrupted', { reason }); }
      finally { await this.releaseOwnership(); }
    });
  }
  async flush(): Promise<void> { await this.transitions; this.assertHealthy(); }

  private async commit(type: string, data?: Record<string, unknown>): Promise<void> {
    this.assertHealthy();
    if (!this.active?.state) return;
    await this.persistTransition(this.active, this.event(this.active.state, type, data));
  }
  private async persistTransition(run: OwnedRun, event: RunJournalEvent): Promise<void> {
    if (!run.ownership) throw new Error('Cannot journal a run without exclusive ownership');
    if (event.runId !== run.runId) throw new Error('Run transition does not belong to its journal owner');
    const next = reduceRunEvent(run.state, event);
    try { await this.journals.append(event); }
    catch (cause) {
      this.persistenceFailure = new RunPersistenceError(cause);
      throw this.persistenceFailure;
    }
    // Journal sync is the commit point. Checkpoint failure cannot undo a
    // committed event, and recovery never interprets the cache as authority.
    run.state = next;
    await this.journals.checkpoint(next);
  }
  private event(state: RunState, type: string, data?: Record<string, unknown>): RunJournalEvent {
    return { runId: state.snapshot.runId, sequence: state.sequence + 1, timestamp: Date.now(), type, ...(data ? { data } : {}) };
  }
  private isStateRunning(state: RunState): boolean { return state.snapshot.status === 'running' || state.snapshot.status === 'waiting_retry'; }
  private assertHealthy(): void { if (this.persistenceFailure) throw this.persistenceFailure; }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitions.then(operation);
    this.transitions = result.catch(() => undefined);
    return result;
  }
  private async releaseOwnership(): Promise<void> {
    const run = this.active;
    if (!run) return;
    run.retired = true;
    // Execution capabilities retain this object and its lock until their last
    // release, even after another object becomes the active run.
    if (run.executions === 0) await this.closeOwnedRun(run);
  }

  private async closeOwnedRun(run: OwnedRun): Promise<void> {
    const ownership = run.ownership;
    run.ownership = undefined;
    await ownership?.release();
  }
}
