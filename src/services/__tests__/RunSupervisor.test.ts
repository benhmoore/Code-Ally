import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunSupervisor } from '../RunSupervisor.js';
import { ServiceRegistry } from '../ServiceRegistry.js';

describe('RunSupervisor', () => {
  let dir: string;
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
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

  it('journals an interrupted run and resumes only through the explicit API', async () => {
    const first = new RunSupervisor(dir);
    await first.initialize();
    const run = await first.startRun('finish the migration', policy);
    await first.recordProgress('mapped the schema');
    await first.interruptForShutdown('app closed');

    const reopened = new RunSupervisor(dir);
    await reopened.initialize();
    expect(reopened.getActiveRun()).toBeUndefined();
    expect((await reopened.listInterruptedRuns())[0]?.runId).toBe(run.runId);
    const resumed = await reopened.resumeRun(run.runId);
    expect(resumed.status).toBe('running');
    const journal = await fs.readFile(join(dir, run.runId, 'journal.jsonl'), 'utf8');
    expect(journal).toContain('run_resumed');
  });

  it('refuses completion while a non-idempotent effect is unknown', async () => {
    const supervisor = new RunSupervisor(dir);
    await supervisor.initialize();
    await supervisor.startRun('publish safely', policy);
    await supervisor.toolPrepared('call-1', 'bash', 'non_idempotent', { command: 'git push' });
    await supervisor.toolStarted('call-1', 'bash', 'non_idempotent');
    await supervisor.toolFinished('call-1', 'bash', 'non_idempotent', false, 'connection dropped');
    const result = await supervisor.claimComplete('done');
    expect(result.accepted).toBe(false);
    expect(result.blockers.join(' ')).toContain('require reconciliation');
    expect(await supervisor.reconcileToolEffect('call-1', 'failed_not_applied', 'remote ref unchanged')).toBe(true);
    expect((await supervisor.claimComplete('done')).accepted).toBe(true);
  });

  it('does not let an ordinary long-running background server hold completion open', async () => {
    ServiceRegistry.getInstance().registerInstance('background_task_registry', {
      list: () => [{
        id: 'shell-server', kind: 'shell', label: 'npm run dev', status: 'running',
        startTime: 1, endTime: null, result: null, error: null, watched: false,
        blocksCompletion: false,
      }],
    } as any);
    const supervisor = new RunSupervisor(dir);
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
    const supervisor = new RunSupervisor(dir);
    await supervisor.initialize();
    await supervisor.startRun('finish the build', policy);

    const completion = await supervisor.claimComplete('done');
    expect(completion.accepted).toBe(false);
    expect(completion.blockers.join(' ')).toContain('background dependency');
  });

  it('reconciles a crash-left running state without auto-resuming it', async () => {
    const first = new RunSupervisor(dir);
    await first.initialize();
    const run = await first.startRun('safe publish', policy);
    await first.toolPrepared('call-crash', 'bash', 'non_idempotent', { command: 'git push' });
    await first.toolStarted('call-crash', 'bash', 'non_idempotent');

    const reopened = new RunSupervisor(dir);
    await reopened.initialize();
    expect(reopened.getActiveRun()).toBeUndefined();
    expect((await reopened.listInterruptedRuns())[0]?.runId).toBe(run.runId);
    await reopened.resumeRun(run.runId);
    const completion = await reopened.claimComplete('done');
    expect(completion.accepted).toBe(false);
    expect(completion.blockers.join(' ')).toContain('call-crash');
  });
});
