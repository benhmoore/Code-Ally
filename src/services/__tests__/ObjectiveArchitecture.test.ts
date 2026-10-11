import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RunSupervisor } from '../RunSupervisor.js';
import { artifactHashes, updateArchitecture } from '../ObjectiveArchitecture.js';
import { ServiceRegistry } from '../ServiceRegistry.js';

let root: string;
let supervisor: RunSupervisor;
const policy = { interaction: 'none', execution: 'headless', completion: 'durable_objective', authorizationPresetId: 'test' } as const;
const criterion = { id: 'behavior', description: 'Required behavior passes its tests', command: 'npm test', artifacts: ['source.ts', 'test.ts'] };

beforeEach(async () => {
  const registry = ServiceRegistry.getInstance() as any;
  registry._services.clear(); registry._descriptors.clear();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ally-architecture-'));
  await fs.writeFile(path.join(root, 'source.ts'), 'original');
  await fs.writeFile(path.join(root, 'test.ts'), 'test');
  supervisor = new RunSupervisor(path.join(root, 'runs'), root);
  await supervisor.startRun('Implement the behavior', policy);
  await supervisor.updateArchitecture({ criteria: [criterion], constraints: ['Preserve compatibility'], decisions: [{ decision: 'Use existing runtime', rationale: 'Keep ownership consistent' }] });
});
afterEach(async () => {
  await supervisor.interruptForShutdown('test finished');
  await fs.rm(root, { recursive: true, force: true });
});

async function verify(id: string, success = true, changeDuring = false, command = 'npm test', background = false) {
  const execution = supervisor.acquireExecution()!;
  try {
    await execution.toolPrepared(id, 'bash', 'non_idempotent', { command, run_in_background: background, working_dir: root });
    await execution.toolStarted(id, 'bash', 'non_idempotent');
    if (changeDuring) await fs.writeFile(path.join(root, 'source.ts'), 'changed during check');
    await execution.toolFinished(id, 'bash', 'non_idempotent', success ? 'succeeded' : 'failed', success ? undefined : 'tests failed');
  } finally { await execution.release(); }
}

describe('durable acceptance evidence', () => {
  it('rejects unsupported completion, accepts observed checks, and invalidates evidence after edits', async () => {
    expect((await supervisor.claimComplete({ summary: 'done', evidence: ['tests passed'] })).accepted).toBe(false);
    await verify('check-1');
    expect((await supervisor.inspectArchitecture())?.criteria[0]?.status).toBe('verified');
    await fs.writeFile(path.join(root, 'source.ts'), 'changed');
    expect((await supervisor.inspectArchitecture())?.criteria[0]?.status).toBe('stale');
    expect((await supervisor.claimComplete({ summary: 'done' })).blockers[0]).toContain('stale');
    await verify('check-2');
    expect((await supervisor.claimComplete({ summary: 'verified result' })).accepted).toBe(true);
  });

  it('does not verify changed-during-check artifacts, a different command, or background admission', async () => {
    await verify('other', true, false, 'true');
    await verify('background', true, false, 'npm test', true);
    expect((await supervisor.inspectArchitecture())?.criteria[0]?.status).toBe('pending');
    await verify('changed', true, true);
    expect((await supervisor.inspectArchitecture())?.criteria[0]?.status).toBe('stale');
  });

  it('invalidates an earlier pass when a later check fails or a criterion is revised', async () => {
    await verify('pass');
    await verify('fail', false);
    expect((await supervisor.inspectArchitecture())?.criteria[0]?.status).toBe('failed');
    await verify('pass-again');
    await supervisor.updateArchitecture({ criteria: [{ ...criterion, description: 'A stronger requirement' }] });
    expect((await supervisor.inspectArchitecture())?.criteria[0]?.status).toBe('stale');
  });

  it('replays decisions, criteria and content-bound evidence when resuming', async () => {
    await verify('passed');
    const id = supervisor.getActiveRun()!.runId;
    await supervisor.interruptForShutdown('restart');
    supervisor = new RunSupervisor(path.join(root, 'runs'), root);
    await supervisor.resumeRun(id);
    const restored = await supervisor.inspectArchitecture();
    expect(restored?.criteria[0]?.status).toBe('verified');
    expect(restored?.constraints).toEqual(['Preserve compatibility']);
    expect(restored?.decisions[0]?.rationale).toBe('Keep ownership consistent');
    await fs.writeFile(path.join(root, 'test.ts'), 'changed test');
    expect((await supervisor.claimComplete({ summary: 'done' })).accepted).toBe(false);
  });
});

it('cannot remove criteria by omitting them, and validates replayable updates', () => {
  const state = updateArchitecture(undefined, { criteria: [criterion] });
  expect(updateArchitecture(state, { criteria: [] }).criteria).toEqual([criterion]);
  expect(() => updateArchitecture(state, { criteria: [{ ...criterion, artifacts: ['../outside'] }] })).toThrow('relative paths');
});

it('rejects artifact symlinks outside the workspace', async () => {
  await fs.symlink(os.tmpdir(), path.join(root, 'outside'));
  await expect(artifactHashes(root, ['outside'])).rejects.toThrow('escapes');
});
