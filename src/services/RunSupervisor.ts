import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getProjectRunsDir } from '../config/paths.js';
import { atomicWriteFile } from '../utils/atomicFile.js';
import type { RunPolicy } from './RunPolicyManager.js';
import { ServiceRegistry } from './ServiceRegistry.js';

export type RunStatus =
  | 'running'
  | 'waiting_retry'
  | 'completed'
  | 'blocked'
  | 'cancelled'
  | 'failed'
  | 'interrupted';

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

export interface RunJournalEvent {
  sequence: number;
  timestamp: number;
  runId: string;
  type: string;
  data?: Record<string, unknown>;
}

/**
 * Process-local owner for durable objectives. The journal survives a crash, but
 * this service never restarts work after the owning process has closed.
 */
export class RunSupervisor {
  private active?: RunSnapshot;
  private sequence = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly unknownEffects = new Set<string>();

  constructor(private readonly runsDir = getProjectRunsDir()) {}

  async initialize(): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
    // A state left running has no live owner after process startup. Reconcile it
    // to interrupted, but never execute it; only resumeRun may reactivate it.
    const entries = await fs.readdir(this.runsDir, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const statePath = path.join(this.runsDir, entry.name, 'state.json');
      try {
        const snapshot = JSON.parse(await fs.readFile(statePath, 'utf8')) as RunSnapshot;
        if (snapshot.version !== 1 || !['running', 'waiting_retry'].includes(snapshot.status)) return;
        snapshot.status = 'interrupted';
        snapshot.updatedAt = Date.now();
        snapshot.outcome = { kind: 'cancelled', reason: 'Previous Code-Ally process ended without a clean handoff' };
        await atomicWriteFile(statePath, `${JSON.stringify(snapshot, null, 2)}\n`);
      } catch { /* corrupt run state remains inspectable on disk */ }
    }));
  }

  async listInterruptedRuns(limit: number = 20): Promise<RunSnapshot[]> {
    await fs.mkdir(this.runsDir, { recursive: true });
    const entries = await fs.readdir(this.runsDir, { withFileTypes: true });
    const snapshots = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        return JSON.parse(await fs.readFile(path.join(this.runsDir, entry.name, 'state.json'), 'utf8')) as RunSnapshot;
      } catch { return null; }
    }));
    return snapshots
      .filter((snapshot): snapshot is RunSnapshot => snapshot?.version === 1 && snapshot.status === 'interrupted')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, limit));
  }

  /** Explicitly resume a journaled run. Startup never calls this automatically. */
  async resumeRun(runId: string): Promise<RunSnapshot> {
    if (this.isRunning()) throw new Error('A durable objective is already running');
    const statePath = path.join(this.runDir(runId), 'state.json');
    const snapshot = JSON.parse(await fs.readFile(statePath, 'utf8')) as RunSnapshot;
    if (snapshot.version !== 1 || snapshot.runId !== runId) throw new Error('Invalid run state');
    if (snapshot.status !== 'interrupted') throw new Error(`Run ${runId} is ${snapshot.status}, not interrupted`);
    this.active = { ...snapshot, status: 'running', outcome: undefined, updatedAt: Date.now() };
    this.unknownEffects.clear();
    this.sequence = 0;
    const inFlightNonIdempotent = new Set<string>();
    try {
      const lines = (await fs.readFile(path.join(this.runDir(runId), 'journal.jsonl'), 'utf8')).split('\n').filter(Boolean);
      for (const line of lines) {
        const event = JSON.parse(line) as RunJournalEvent;
        this.sequence = Math.max(this.sequence, event.sequence);
        const callId = event.data?.callId;
        const effect = event.data?.effect;
        if (event.type === 'tool_running' && typeof callId === 'string' && effect === 'non_idempotent') {
          inFlightNonIdempotent.add(callId);
        }
        if (event.type === 'tool_unknown' && typeof callId === 'string') this.unknownEffects.add(callId);
        if ((event.type === 'tool_succeeded' || event.type === 'tool_failed') && typeof callId === 'string') {
          this.unknownEffects.delete(callId);
          inFlightNonIdempotent.delete(callId);
        }
      }
    } catch { /* a missing journal is surfaced by the next durable state write */ }
    for (const callId of inFlightNonIdempotent) this.unknownEffects.add(callId);
    await this.record('run_resumed', { previousStatus: snapshot.status });
    return structuredClone(this.active);
  }

  getActiveRun(): Readonly<RunSnapshot> | undefined {
    return this.active ? structuredClone(this.active) : undefined;
  }

  isRunning(): boolean {
    return this.active?.status === 'running' || this.active?.status === 'waiting_retry';
  }

  getOutcome(): RunOutcome | undefined {
    return this.active?.outcome ? structuredClone(this.active.outcome) : undefined;
  }

  async startRun(objective: string, policy: RunPolicy): Promise<RunSnapshot> {
    if (this.isRunning()) return this.active!;
    const now = Date.now();
    this.sequence = 0;
    this.unknownEffects.clear();
    this.active = {
      version: 1,
      runId: randomUUID(),
      objective,
      policy: { ...policy },
      status: 'running',
      epoch: 0,
      startedAt: now,
      updatedAt: now,
    };
    await this.record('run_started', { objective });
    return this.active;
  }

  async record(type: string, data?: Record<string, unknown>): Promise<void> {
    if (!this.active) return;
    this.active.updatedAt = Date.now();
    const event: RunJournalEvent = {
      sequence: ++this.sequence,
      timestamp: this.active.updatedAt,
      runId: this.active.runId,
      type,
      ...(data ? { data } : {}),
    };
    const snapshot = structuredClone(this.active);
    this.writeQueue = this.writeQueue.then(async () => {
      await fs.mkdir(this.runDir(snapshot.runId), { recursive: true });
      const journalPath = path.join(this.runDir(snapshot.runId), 'journal.jsonl');
      const handle = await fs.open(journalPath, 'a', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await atomicWriteFile(
        path.join(this.runDir(snapshot.runId), 'state.json'),
        `${JSON.stringify(snapshot, null, 2)}\n`
      );
    });
    await this.writeQueue;
  }

  async rolloverEpoch(reason: string): Promise<void> {
    if (!this.active || !this.isRunning()) return;
    this.active.epoch += 1;
    await this.record('epoch_rolled_over', { reason, epoch: this.active.epoch });
  }

  async recordProgress(summary: string): Promise<void> {
    if (!this.active || !this.isRunning()) return;
    this.active.nextAction = 'Continue the objective or submit complete-objective when all work is verified.';
    await this.record('assistant_progress', { summary: summary.slice(0, 4000) });
  }

  async toolPrepared(callId: string, tool: string, effect: string, args: Record<string, unknown>): Promise<void> {
    let serializedArgs = '[unserializable arguments]';
    try { serializedArgs = JSON.stringify(args).slice(0, 8000); } catch { /* keep fallback */ }
    await this.record('tool_prepared', { callId, tool, effect, serializedArgs });
  }

  async toolStarted(callId: string, tool: string, effect: string): Promise<void> {
    await this.record('tool_running', { callId, tool, effect });
  }

  async toolFinished(
    callId: string,
    tool: string,
    effect: string,
    success: boolean,
    error?: string
  ): Promise<void> {
    const ambiguous = !success && effect === 'non_idempotent';
    if (ambiguous) this.unknownEffects.add(callId);
    else this.unknownEffects.delete(callId);
    await this.record(ambiguous ? 'tool_unknown' : success ? 'tool_succeeded' : 'tool_failed', {
      callId,
      tool,
      effect,
      ...(error ? { error: error.slice(0, 2000) } : {}),
    });
  }

  async reconcileToolEffect(callId: string, resolution: string, evidence: string): Promise<boolean> {
    if (!this.unknownEffects.has(callId)) return false;
    this.unknownEffects.delete(callId);
    await this.record('tool_reconciled', {
      callId,
      resolution: resolution.slice(0, 200),
      evidence: evidence.slice(0, 4000),
    });
    return true;
  }

  async claimComplete(summary: string, evidence: string[] = []): Promise<{ accepted: boolean; blockers: string[] }> {
    if (!this.active || !this.isRunning()) return { accepted: false, blockers: ['No active durable objective'] };
    const registry = ServiceRegistry.getInstance();
    const blockers: string[] = [];
    const incompleteTodos = registry.get('todo_manager')?.getTodos().filter(todo => todo.status !== 'completed') ?? [];
    if (incompleteTodos.length) blockers.push(`${incompleteTodos.length} todo item(s) remain incomplete`);
    const runningTasks = registry.get('background_task_registry')?.list().filter(task => task.status === 'running') ?? [];
    if (runningTasks.length) blockers.push(`${runningTasks.length} background dependency/dependencies are still running`);
    const undeliveredAgents = registry.get('background_agent_manager')?.listTasks()
      .filter((task) => task.mode === 'background' && task.status !== 'running' && !task.consumed) ?? [];
    if (undeliveredAgents.length) {
      blockers.push(`${undeliveredAgents.length} completed background result(s) have not yet been incorporated`);
    }
    if (this.unknownEffects.size) {
      blockers.push(`${this.unknownEffects.size} non-idempotent tool outcome(s) require reconciliation: ${Array.from(this.unknownEffects).join(', ')}`);
    }
    if (blockers.length) {
      await this.record('completion_rejected', { blockers });
      return { accepted: false, blockers };
    }
    this.active.status = 'completed';
    this.active.outcome = { kind: 'completed', summary };
    this.active.nextAction = undefined;
    await this.record('run_completed', { summary, evidence });
    return { accepted: true, blockers: [] };
  }

  async block(reason: string): Promise<void> {
    if (!this.active || !this.isRunning()) return;
    this.active.status = 'blocked';
    this.active.outcome = { kind: 'blocked', reason };
    await this.record('run_blocked', { reason });
  }

  async fail(error: string): Promise<void> {
    if (!this.active || !this.isRunning()) return;
    this.active.status = 'failed';
    this.active.outcome = { kind: 'failed', error };
    await this.record('run_failed', { error });
  }

  async cancel(reason: string): Promise<void> {
    if (!this.active || !this.isRunning()) return;
    this.active.status = 'cancelled';
    this.active.outcome = { kind: 'cancelled', reason };
    await this.record('run_cancelled', { reason });
  }

  async interruptForShutdown(reason: string): Promise<void> {
    if (!this.active || !this.isRunning()) return;
    this.active.status = 'interrupted';
    this.active.outcome = { kind: 'cancelled', reason };
    await this.record('run_interrupted', { reason });
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  private runDir(runId: string): string {
    return path.join(this.runsDir, runId);
  }
}
