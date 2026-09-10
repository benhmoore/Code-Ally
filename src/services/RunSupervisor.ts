import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectRunsDir } from '../config/paths.js';
import { atomicWriteFile } from '../utils/atomicFile.js';
import type { RunPolicy } from './RunPolicyManager.js';
import { ServiceRegistry } from './ServiceRegistry.js';
import { FileOwnership } from '../utils/FileOwnership.js';
import { readRunJournal, InvalidRunJournalError, type RunJournalEvent } from './RunJournal.js';
import { reduceRunEvent, type RunState } from './RunState.js';
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

/** Exclusive owner of a journal-authoritative objective. Startup never executes work. */
export class RunSupervisor {
  private state?: RunState;
  private ownership?: FileOwnership;
  private transitions: Promise<unknown> = Promise.resolve();
  private persistenceFailure?: Error;

  constructor(private readonly runsDir = getProjectRunsDir()) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
    for (const entry of await fs.readdir(this.runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const ownership = await FileOwnership.acquire(path.join(this.runDir(entry.name), 'owner.lock'));
      if (!ownership) continue;
      try {
        let state: RunState;
        try { state = await this.replay(entry.name); }
        catch (error) {
          if (!(error instanceof InvalidRunJournalError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          logger.warn('Run journal could not be recovered:', entry.name, error);
          continue;
        }
        if (this.isStateRunning(state)) {
          const event = this.event(state, 'run_interrupted', { reason: 'Previous Code-Ally process ended without a clean handoff' });
          const next = reduceRunEvent(state, event);
          await this.append(event);
          state = next;
        }
        await this.checkpoint(state);
      } finally { await ownership.release(); }
    }
  }

  async listInterruptedRuns(limit = 20): Promise<RunSnapshot[]> {
    await fs.mkdir(this.runsDir, { recursive: true });
    const snapshots: RunSnapshot[] = [];
    for (const entry of await fs.readdir(this.runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const state = await this.replay(entry.name);
        if (state.snapshot.status === 'interrupted') snapshots.push(state.snapshot);
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
      const ownership = await FileOwnership.acquire(path.join(this.runDir(runId), 'owner.lock'));
      if (!ownership) throw new Error(`Run ${runId} is owned by another live supervisor`);
      try {
        let state: RunState;
        try { state = await this.replay(runId); }
        catch (cause) { throw new Error(`Cannot resume run ${runId}: journal recovery failed`, { cause }); }
        if (state.snapshot.status !== 'interrupted') throw new Error(`Run ${runId} is ${state.snapshot.status}, not interrupted`);
        this.ownership = ownership;
        this.state = state;
        await this.commit('run_resumed', { previousStatus: state.snapshot.status });
        return this.getActiveRun()!;
      } catch (error) {
        this.state = undefined;
        this.ownership = undefined;
        await ownership.release();
        throw error;
      }
    });
  }

  getActiveRun(): RunSnapshot | undefined { return this.state ? structuredClone(this.state.snapshot) : undefined; }
  isRunning(): boolean { return !!this.state && this.isStateRunning(this.state); }
  getOutcome(): RunOutcome | undefined { return this.state?.snapshot.outcome ? structuredClone(this.state.snapshot.outcome) : undefined; }

  async startRun(objective: string, policy: RunPolicy): Promise<RunSnapshot> {
    return this.serialize(async () => {
      this.assertHealthy();
      if (this.isRunning()) return this.getActiveRun()!;
      await this.releaseOwnership();
      const runId = randomUUID();
      await fs.mkdir(this.runDir(runId), { recursive: true });
      const ownership = await FileOwnership.acquire(path.join(this.runDir(runId), 'owner.lock'));
      if (!ownership) throw new Error(`Run ${runId} is owned by another live supervisor`);
      this.ownership = ownership;
      this.state = undefined;
      try {
        await this.persistTransition({ runId, sequence: 1, timestamp: Date.now(), type: 'run_started', data: { objective, policy: { ...policy } } });
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
  async rolloverEpoch(reason: string): Promise<void> {
    return this.serialize(async () => {
      if (this.isRunning()) await this.commit('epoch_rolled_over', { reason, epoch: this.state!.snapshot.epoch + 1 });
    });
  }
  async recordProgress(summary: string): Promise<void> {
    return this.serialize(async () => {
      if (this.isRunning()) await this.commit('assistant_progress', { summary: summary.slice(0, 4000) });
    });
  }
  async toolPrepared(callId: string, tool: string, effect: string, args: Record<string, unknown>): Promise<void> {
    let serializedArgs = '[unserializable arguments]';
    try { serializedArgs = JSON.stringify(args).slice(0, 8000); } catch { /* retain diagnostic */ }
    await this.record('tool_prepared', { callId, tool, effect, serializedArgs });
  }
  async toolStarted(callId: string, tool: string, effect: string): Promise<void> {
    await this.record('tool_running', { callId, tool, effect });
  }
  async toolFinished(callId: string, tool: string, effect: string, outcome: 'succeeded' | 'failed' | 'unknown', error?: string): Promise<void> {
    const ambiguous = outcome === 'unknown' && effect === 'non_idempotent';
    await this.record(ambiguous ? 'tool_unknown' : outcome === 'succeeded' ? 'tool_succeeded' : 'tool_failed', {
      callId, tool, effect, ...(error ? { error: error.slice(0, 2000) } : {}),
    });
  }
  async reconcileToolEffect(callId: string, resolution: string, evidence: string): Promise<boolean> {
    return this.serialize(async () => {
      this.assertHealthy();
      if (!this.state?.unknownEffects.has(callId)) return false;
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
      const pendingWatchedResults = backgroundTasks.filter(task => task.status !== 'running' && task.blocksCompletion && task.watched);
      if (pendingWatchedResults.length) blockers.push(`${pendingWatchedResults.length} watched background result(s) await delivery`);
      const undeliveredAgents = registry.get('background_agent_manager')?.listTasks()
        .filter(task => task.mode === 'background' && task.status !== 'running' && !task.consumed) ?? [];
      if (undeliveredAgents.length) blockers.push(`${undeliveredAgents.length} completed background result(s) have not yet been incorporated`);
      const unsettled = new Set([...this.state!.unknownEffects, ...this.state!.runningEffects]);
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
    if (!this.state) return;
    if (!this.ownership) throw new Error('Cannot journal a run without exclusive ownership');
    await this.persistTransition(this.event(this.state, type, data));
  }
  private async persistTransition(event: RunJournalEvent): Promise<void> {
    const next = reduceRunEvent(this.state, event);
    try { await this.append(event); }
    catch (cause) {
      this.persistenceFailure = new RunPersistenceError(cause);
      throw this.persistenceFailure;
    }
    // Journal sync is the commit point. Checkpoint failure cannot undo a
    // committed event, and recovery never interprets the cache as authority.
    this.state = next;
    await this.checkpoint(next);
  }
  private async append(event: RunJournalEvent): Promise<void> {
    const handle = await fs.open(path.join(this.runDir(event.runId), 'journal.jsonl'), 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
  }
  private async checkpoint(state: RunState): Promise<void> {
    try {
      await atomicWriteFile(path.join(this.runDir(state.snapshot.runId), 'state.json'),
        `${JSON.stringify({ ...state.snapshot, journalSequence: state.sequence }, null, 2)}\n`);
    } catch (error) { logger.warn('Run journal committed, but checkpoint refresh failed:', state.snapshot.runId, error); }
  }
  private async replay(runId: string): Promise<RunState> {
    let state: RunState | undefined;
    for await (const event of readRunJournal(path.join(this.runDir(runId), 'journal.jsonl'), runId)) {
      try { state = reduceRunEvent(state, event); }
      catch (cause) { throw new InvalidRunJournalError(`Invalid run transition at sequence ${event.sequence}`, cause); }
    }
    if (!state) throw new InvalidRunJournalError('Empty run journal');
    return state;
  }
  private event(state: RunState, type: string, data?: Record<string, unknown>): RunJournalEvent {
    return { runId: state.snapshot.runId, sequence: state.sequence + 1, timestamp: Date.now(), type, ...(data ? { data } : {}) };
  }
  private isStateRunning(state: RunState): boolean { return state.snapshot.status === 'running' || state.snapshot.status === 'waiting_retry'; }
  private assertHealthy(): void { if (this.persistenceFailure) throw this.persistenceFailure; }
  private runDir(runId: string): string {
    if (!runId || runId === '.' || runId === '..' || /[/\\]/.test(runId)) throw new Error('Invalid run identifier');
    return path.join(this.runsDir, runId);
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.transitions.then(operation);
    this.transitions = result.catch(() => undefined);
    return result;
  }
  private async releaseOwnership(): Promise<void> {
    const ownership = this.ownership;
    this.ownership = undefined;
    await ownership?.release();
  }
}
