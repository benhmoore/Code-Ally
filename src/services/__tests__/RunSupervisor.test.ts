import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { RunSupervisor } from '../RunSupervisor.js';
import { ServiceRegistry } from '../ServiceRegistry.js';

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
  };

  beforeEach(async () => {
    const registry = ServiceRegistry.getInstance() as any;
    registry._services.clear();
    registry._descriptors.clear();
    dir = join(tmpdir(), `ally-runs-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    for (const supervisor of supervisors.splice(0)) await supervisor.interruptForShutdown('test cleanup');
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

  it('refuses completion while a settled watched result awaits delivery', async () => {
    ServiceRegistry.getInstance().registerInstance('background_task_registry', {
      list: () => [{
        id: 'agent-review', kind: 'agent', label: 'review', status: 'done',
        startTime: 1, endTime: 2, result: 'findings', error: null, watched: true,
        blocksCompletion: true,
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
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
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
