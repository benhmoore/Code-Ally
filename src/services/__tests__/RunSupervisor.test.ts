import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { RunSupervisor, RunPersistenceError } from '../RunSupervisor.js';
import { ServiceRegistry } from '../ServiceRegistry.js';
import * as atomicFile from '../../utils/atomicFile.js';
import { FileOwnership } from '../../utils/FileOwnership.js';

describe('RunSupervisor', () => {
  let dir: string;
  const supervisors: RunSupervisor[] = [];
  function createSupervisor(): RunSupervisor {
    const supervisor = new RunSupervisor(dir);
    supervisors.push(supervisor);
    return supervisor;
  }
  const policy = {
    interaction: 'none' as const,
    execution: 'headless' as const,
    completion: 'durable_objective' as const,
    authorizationPresetId: 'auto-confirm',
  };

  beforeEach(async () => {
    const registry = ServiceRegistry.getInstance() as any;
    registry._services.clear();
    registry._descriptors.clear();
    dir = join(tmpdir(), `ally-runs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const supervisor of supervisors.splice(0)) {
      try { await supervisor.interruptForShutdown('test cleanup'); }
      catch (error) { if (!(error instanceof RunPersistenceError)) throw error; }
    }
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('journals an interrupted run and resumes only through the explicit API', async () => {
    const first = createSupervisor();
    await first.initialize();
    const run = await first.startRun('finish the migration', policy);
    await first.recordProgress('mapped the schema');
    await first.interruptForShutdown('app closed');

    const reopened = createSupervisor();
    await reopened.initialize();
    expect(reopened.getActiveRun()).toBeUndefined();
    expect((await reopened.listInterruptedRuns())[0]?.runId).toBe(run.runId);
    const resumed = await reopened.resumeRun(run.runId);
    expect(resumed.status).toBe('running');
    const journal = await fs.readFile(join(dir, run.runId, 'journal.jsonl'), 'utf8');
    expect(journal).toContain('run_resumed');
  });

  it('refuses completion while a non-idempotent effect is unknown', async () => {
    const supervisor = createSupervisor();
    await supervisor.initialize();
    await supervisor.startRun('publish safely', policy);
    await supervisor.toolPrepared('call-1', 'bash', 'non_idempotent', { command: 'git push' });
    await supervisor.toolStarted('call-1', 'bash', 'non_idempotent');
    await supervisor.toolFinished('call-1', 'bash', 'non_idempotent', 'unknown', 'connection dropped');
    const result = await supervisor.claimComplete('done');
    expect(result.accepted).toBe(false);
    expect(result.blockers.join(' ')).toContain('require reconciliation');
    expect(await supervisor.reconcileToolEffect('call-1', 'failed_not_applied', 'remote ref unchanged')).toBe(true);
    expect((await supervisor.claimComplete('done')).accepted).toBe(true);
  });

  it('settles a definitively failed non-idempotent tool without reconciliation', async () => {
    const supervisor = createSupervisor();
    await supervisor.initialize();
    await supervisor.startRun('repair the build', policy);
    await supervisor.toolPrepared('call-1', 'bash', 'non_idempotent', { command: 'npm test' });
    await supervisor.toolStarted('call-1', 'bash', 'non_idempotent');
    await supervisor.toolFinished('call-1', 'bash', 'non_idempotent', 'failed', 'tests failed');

    expect((await supervisor.claimComplete('verified after repair')).accepted).toBe(true);
  });

  it('preserves reconciled effects and objective identity across repeated restarts', async () => {
    let supervisor = createSupervisor();
    await supervisor.initialize();
    const run = await supervisor.startRun('finish the multi-day migration', policy);
    await supervisor.toolStarted('publish-verified', 'bash', 'non_idempotent');
    await supervisor.toolFinished('publish-verified', 'bash', 'non_idempotent', 'unknown');
    expect(await supervisor.reconcileToolEffect('publish-verified', 'applied', 'Verified durable destination state')).toBe(true);
    await supervisor.toolStarted('publish-ambiguous', 'bash', 'non_idempotent');

    for (let restart = 0; restart < 12; restart++) {
      await supervisor.rolloverEpoch('execution budget renewal');
      await supervisor.interruptForShutdown('scheduled process replacement');
      supervisor = createSupervisor();
      await supervisor.initialize();
      const resumed = await supervisor.resumeRun(run.runId);
      expect(resumed.objective).toBe(run.objective);
      expect(resumed.epoch).toBe(restart + 1);
      const result = await supervisor.claimComplete('not yet');
      expect(result.accepted).toBe(false);
      expect(result.blockers.join(' ')).toContain('publish-ambiguous');
      expect(result.blockers.join(' ')).not.toContain('publish-verified');
    }

    expect(await supervisor.reconcileToolEffect('publish-ambiguous', 'not_applied', 'Destination proves no effect')).toBe(true);
    await supervisor.interruptForShutdown('final restart');
    supervisor = createSupervisor();
    await supervisor.initialize();
    await supervisor.resumeRun(run.runId);
    expect((await supervisor.claimComplete('verified migration')).accepted).toBe(true);
  });

  it.each(['missing', 'torn', 'foreign', 'sequence-gap'])('does not activate or append to a run with a %s journal', async (damage) => {
    const first = createSupervisor();
    await first.initialize();
    const run = await first.startRun('recover safely', policy);
    await first.toolStarted('possibly-applied', 'bash', 'non_idempotent');
    await first.interruptForShutdown('restart');
    const journalPath = join(dir, run.runId, 'journal.jsonl');
    const statePath = join(dir, run.runId, 'state.json');
    const original = await fs.readFile(journalPath, 'utf8');
    if (damage === 'missing') await fs.unlink(journalPath);
    else if (damage === 'torn') await fs.appendFile(journalPath, '{"sequence":');
    else {
      const records = original.trimEnd().split('\n').map(line => JSON.parse(line));
      if (damage === 'foreign') records[1].runId = 'another-run';
      else records[1].sequence += 1;
      await fs.writeFile(journalPath, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    }
    const before = await fs.readFile(journalPath, 'utf8').catch(() => null);
    const stateBefore = await fs.readFile(statePath, 'utf8');
    const reopened = createSupervisor();
    await reopened.initialize();
    await expect(reopened.resumeRun(run.runId)).rejects.toThrow(/journal/i);
    // A rejected recovery must release ownership so later repairs can be retried.
    await expect(reopened.resumeRun(run.runId)).rejects.toThrow(/journal/i);
    expect(reopened.isRunning()).toBe(false);
    expect(reopened.getActiveRun()).toBeUndefined();
    expect(await fs.readFile(journalPath, 'utf8').catch(() => null)).toBe(before);
    expect(await fs.readFile(statePath, 'utf8')).toBe(stateBefore);
  });

  it('does not let an ordinary long-running background server hold completion open', async () => {
    ServiceRegistry.getInstance().registerInstance('background_task_registry', {
      list: () => [{
        id: 'shell-server', kind: 'shell', label: 'npm run dev', status: 'running',
        startTime: 1, endTime: null, result: null, error: null, watched: false,
        blocksCompletion: false,
      }],
    } as any);
    const supervisor = createSupervisor();
    await supervisor.initialize();
    await supervisor.startRun('start the development server', policy);

    expect((await supervisor.claimComplete('server is ready')).accepted).toBe(true);
  });

  it('refuses completion for an explicitly blocking background dependency', async () => {
    ServiceRegistry.getInstance().registerInstance('background_task_registry', {
      list: () => [{
        id: 'shell-build', kind: 'shell', label: 'npm run build', status: 'running',
        startTime: 1, endTime: null, result: null, error: null, watched: false,
        blocksCompletion: true,
      }],
    } as any);
    const supervisor = createSupervisor();
    await supervisor.initialize();
    await supervisor.startRun('finish the build', policy);

    const completion = await supervisor.claimComplete('done');
    expect(completion.accepted).toBe(false);
    expect(completion.blockers.join(' ')).toContain('background dependency');
  });

  it.each([false, true])('refuses completion while a settled result awaits delivery (watched=%s)', async watched => {
    let resultPending = true;
    ServiceRegistry.getInstance().registerInstance('background_task_registry', {
      list: () => [{
        id: 'agent-review', kind: 'agent', label: 'review', status: 'done',
        startTime: 1, endTime: 2, result: 'findings', error: null, watched,
        blocksCompletion: true, resultPending,
      }],
    } as any);
    ServiceRegistry.getInstance().registerInstance('background_agent_manager', {
      listTasks: () => [{ mode: 'background', status: 'done', consumed: true }],
    } as any);
    const supervisor = createSupervisor();
    await supervisor.initialize();
    await supervisor.startRun('finish after review', policy);

    const completion = await supervisor.claimComplete('done');
    expect(completion.accepted).toBe(false);
    expect(completion.blockers.join(' ')).toContain('await delivery');
    resultPending = false;
    expect((await supervisor.claimComplete('review incorporated')).accepted).toBe(true);
  });

  it('reconciles a crash-left running state without auto-resuming it', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { RunSupervisor } from ${JSON.stringify(new URL('../RunSupervisor.ts', import.meta.url).href)};
      const supervisor = new RunSupervisor(${JSON.stringify(dir)});
      await supervisor.initialize();
      const run = await supervisor.startRun('safe publish', ${JSON.stringify(policy)});
      await supervisor.toolStarted('call-crash', 'bash', 'non_idempotent');
      process.send(run);
      setInterval(() => {}, 1000);
    `], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    let run: { runId: string };
    try {
      [run] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
      const observer = createSupervisor();
      await observer.initialize();
      expect(await observer.listInterruptedRuns()).toEqual([]);
      await expect(observer.resumeRun(run.runId)).rejects.toThrow(/owned/);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
    const reopened = createSupervisor();
    await reopened.initialize();
    expect(reopened.getActiveRun()).toBeUndefined();
    expect((await reopened.listInterruptedRuns())[0]?.runId).toBe(run.runId);
    await reopened.resumeRun(run.runId);
    const completion = await reopened.claimComplete('done');
    expect(completion.accepted).toBe(false);
    expect(completion.blockers.join(' ')).toContain('call-crash');
  }, 15000);

  it('leaves a live owner untouched and serializes competing resumes', async () => {
    const first = createSupervisor();
    await first.initialize();
    const run = await first.startRun('keep working', policy);
    const statePath = join(dir, run.runId, 'state.json');
    const before = await fs.readFile(statePath, 'utf8');
    const second = createSupervisor();
    await second.initialize();
    expect(await fs.readFile(statePath, 'utf8')).toBe(before);
    await expect(second.resumeRun(run.runId)).rejects.toThrow(/owned/);
    await first.interruptForShutdown('handoff');
    const third = createSupervisor();
    const attempts = await Promise.allSettled([second.resumeRun(run.runId), third.resumeRun(run.runId)]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
  });

  it('serializes concurrent starts within one supervisor', async () => {
    const supervisor = createSupervisor();
    await supervisor.initialize();
    const runs = await Promise.all([supervisor.startRun('first', policy), supervisor.startRun('second', policy)]);
    expect(runs[0].runId).toBe(runs[1].runId);
    expect(await fs.readdir(dir)).toHaveLength(1);
  });

  it('rebuilds a failed checkpoint from the authoritative journal', async () => {
    const supervisor = createSupervisor();
    const run = await supervisor.startRun('recover after disk pressure', policy);
    await supervisor.interruptForShutdown('stop');
    const statePath = join(dir, run.runId, 'state.json');
    const snapshot = JSON.parse(await fs.readFile(statePath, 'utf8'));
    snapshot.status = 'running';
    await fs.writeFile(statePath, JSON.stringify(snapshot));
    const failure = Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    const write = vi.spyOn(atomicFile, 'atomicWriteFile').mockRejectedValueOnce(failure);
    const reopened = createSupervisor();
    await reopened.initialize();
    expect(JSON.parse(await fs.readFile(statePath, 'utf8')).status).toBe('running');
    expect((await reopened.listInterruptedRuns())[0]?.runId).toBe(run.runId);
    write.mockRestore();
    await reopened.initialize();
    expect((await reopened.listInterruptedRuns())[0]?.runId).toBe(run.runId);
  });

  it('does not publish completion before journal sync finishes', async () => {
    const supervisor = createSupervisor();
    const run = await supervisor.startRun('durable commit', policy);
    const handle = await fs.open(join(dir, run.runId, 'journal.jsonl'), 'a');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const originalSync = handle.sync.bind(handle);
    const sync = vi.spyOn(handle, 'sync').mockImplementation(async () => { await gate; await originalSync(); });
    vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);
    const completion = supervisor.claimComplete('verified');
    await vi.waitFor(() => expect(sync).toHaveBeenCalled());
    expect(supervisor.getOutcome()).toBeUndefined();
    expect(supervisor.getActiveRun()?.status).toBe('running');
    release();
    expect((await completion).accepted).toBe(true);
    expect(supervisor.getOutcome()).toEqual({ kind: 'completed', summary: 'verified' });
  });

  it('does not recreate a missing active journal and execute against lost history', async () => {
    const supervisor = createSupervisor();
    const run = await supervisor.startRun('preserve history', policy);
    const journalPath = join(dir, run.runId, 'journal.jsonl');
    await fs.rename(journalPath, `${journalPath}.saved`);
    await expect(supervisor.toolStarted('publish', 'bash', 'non_idempotent')).rejects.toBeInstanceOf(RunPersistenceError);
    await expect(fs.stat(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(supervisor.getOutcome()).toBeUndefined();
  });

  it('retains committed completion when checkpoint replacement fails and never resurrects it', async () => {
    const supervisor = createSupervisor();
    const run = await supervisor.startRun('commit once', policy);
    const statePath = join(dir, run.runId, 'state.json');
    vi.spyOn(atomicFile, 'atomicWriteFile').mockRejectedValueOnce(new Error('checkpoint unavailable'));
    expect((await supervisor.claimComplete('verified')).accepted).toBe(true);
    expect(supervisor.getOutcome()?.kind).toBe('completed');
    expect(JSON.parse(await fs.readFile(statePath, 'utf8')).status).toBe('running');
    await supervisor.interruptForShutdown('restart');
    const reopened = createSupervisor();
    await reopened.initialize();
    expect(JSON.parse(await fs.readFile(statePath, 'utf8')).status).toBe('completed');
    expect(await reopened.listInterruptedRuns()).toEqual([]);
    await expect(reopened.resumeRun(run.runId)).rejects.toThrow(/completed/);
  });

  it.each(['open', 'write', 'sync', 'close'])('fails closed after journal %s failure without publishing completion', async boundary => {
    const supervisor = createSupervisor();
    const run = await supervisor.startRun('recover commit failure', policy);
    const journalPath = join(dir, run.runId, 'journal.jsonl');
    if (boundary === 'open') vi.spyOn(fs, 'open').mockRejectedValueOnce(new Error('disk unavailable'));
    else {
      const handle = await fs.open(journalPath, 'a');
      if (boundary === 'write') {
        vi.spyOn(handle, 'writeFile').mockImplementationOnce(async data => {
          await handle.write(String(data).slice(0, 16));
          throw new Error('partial append failed');
        });
      } else if (boundary === 'sync') {
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(new Error('sync failed'));
      } else {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          await close();
          throw new Error('close reported failure');
        });
      }
      vi.spyOn(fs, 'open').mockResolvedValueOnce(handle);
    }
    await expect(supervisor.claimComplete('unpublished')).rejects.toBeInstanceOf(RunPersistenceError);
    expect(supervisor.getOutcome()).toBeUndefined();
    const journal = await fs.readFile(journalPath, 'utf8');
    await expect(supervisor.recordProgress('must not append')).rejects.toBeInstanceOf(RunPersistenceError);
    expect(await fs.readFile(journalPath, 'utf8')).toBe(journal);
    await expect(supervisor.interruptForShutdown('restart')).rejects.toBeInstanceOf(RunPersistenceError);
    const reopened = createSupervisor();
    await reopened.initialize();
    if (boundary === 'open') {
      await reopened.resumeRun(run.runId);
      expect((await reopened.claimComplete('verified after recovery')).accepted).toBe(true);
    } else if (boundary === 'write') {
      await expect(reopened.resumeRun(run.runId)).rejects.toThrow(/journal/);
      expect(await fs.readFile(journalPath, 'utf8')).toBe(journal);
    } else {
      // The complete append survived this injected sync failure. Recovery must
      // honor that evidence rather than blindly attempting completion again.
      await expect(reopened.resumeRun(run.runId)).rejects.toThrow(/completed/);
    }
  });

  it('serializes conflicting terminal transitions and blocks running external effects', async () => {
    const supervisor = createSupervisor();
    const run = await supervisor.startRun('finish exactly once', policy);
    await supervisor.toolStarted('publish', 'bash', 'non_idempotent');
    expect((await supervisor.claimComplete('too early')).accepted).toBe(false);
    await supervisor.toolFinished('publish', 'bash', 'non_idempotent', 'succeeded');
    const [completion] = await Promise.all([supervisor.claimComplete('verified'), supervisor.cancel('late cancellation')]);
    expect(completion.accepted).toBe(true);
    const records = (await fs.readFile(join(dir, run.runId, 'journal.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line));
    expect(records.filter(event => ['run_completed', 'run_cancelled'].includes(event.type))).toHaveLength(1);
    expect(supervisor.getOutcome()).toEqual({ kind: 'completed', summary: 'verified' });
  });

  it('bounds ownership handles while scanning accumulated history', async () => {
    for (let index = 0; index < 24; index++) {
      const runDir = join(dir, `history-${index}`);
      await fs.mkdir(runDir);
      await fs.writeFile(join(runDir, 'state.json'), 'null');
    }
    const acquire = FileOwnership.acquire.bind(FileOwnership);
    let pending = 0;
    let peak = 0;
    vi.spyOn(FileOwnership, 'acquire').mockImplementation(async filePath => {
      pending++;
      peak = Math.max(peak, pending);
      const ownership = await acquire(filePath);
      if (!ownership) {
        pending--;
        return undefined;
      }
      const release = ownership.release.bind(ownership);
      vi.spyOn(ownership, 'release').mockImplementation(async () => {
        try { await release(); } finally { pending--; }
      });
      return ownership;
    });
    await createSupervisor().initialize();
    expect(peak).toBe(1);
    expect(pending).toBe(0);
  });

  it('retains ownership through terminal bookkeeping and retires it on replacement', async () => {
    const supervisor = createSupervisor();
    const run = await supervisor.startRun('first', policy);
    expect((await supervisor.claimComplete('done')).accepted).toBe(true);
    await supervisor.toolFinished('completion', 'complete-objective', 'idempotent', 'succeeded');
    const journal = await fs.readFile(join(dir, run.runId, 'journal.jsonl'), 'utf8');
    expect(JSON.parse(journal.trimEnd().split('\n').at(-1)!).type).toBe('tool_succeeded');
    const next = await supervisor.startRun('second', policy);
    expect(next.runId).not.toBe(run.runId);
    await supervisor.interruptForShutdown('stop');
    await expect(supervisor.recordProgress('must not write')).resolves.toBeUndefined();
    await expect(supervisor.record('late_event')).rejects.toThrow(/ownership/);
  });
});
