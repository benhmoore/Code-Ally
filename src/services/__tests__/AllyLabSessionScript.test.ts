import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/ally-lab-session.py');
const labScript = resolve('scripts/ally-lab.sh');
const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ally-lab-session-'));
  temporaryDirectories.push(root);
  const sessionPath = join(root, 'sessions', 'session_test.json');
  const archived = [
    { id: 'old-1', role: 'user', content: 'archived one' },
    { id: 'old-2', role: 'assistant', content: 'archived two' },
  ];
  const encoded = JSON.stringify(archived);
  const hash = createHash('sha256').update(encoded).digest('hex');
  const segmentDir = join(root, 'sessions', 'session_test', 'transcript-segments');
  await mkdir(segmentDir, { recursive: true });
  await writeFile(join(segmentDir, `${hash}.json`), JSON.stringify({
    schema_version: 1,
    hash,
    messages: archived,
  }));
  await mkdir(dirname(sessionPath), { recursive: true });
  await writeFile(sessionPath, JSON.stringify({
    id: 'session_test',
    working_dir: '/repo',
    updated_at: '2026-08-20T00:00:00.000Z',
    messages: [{ role: 'assistant', content: 'active' }],
    transcript_segments: [{ hash, message_count: archived.length }],
    transcript_tail: [
      { id: 'new-1', role: 'tool', content: 'tail one' },
      { id: 'new-2', role: 'assistant', content: 'tail two' },
    ],
  }));
  return { sessionPath, segmentPath: join(segmentDir, `${hash}.json`) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('ally-lab segmented session diagnostics', () => {
  it('reports total transcript size separately from the live tail', async () => {
    const { sessionPath } = await fixture();
    const result = spawnSync('python3', [script, 'status', sessionPath], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('active msgs:  1   transcript: 4 (2 archived + 2 tail)');
  });

  it('reads the requested recent range across immutable segment boundaries', async () => {
    const { sessionPath } = await fixture();
    const result = spawnSync('python3', [script, 'transcript', sessionPath, '3'], { encoding: 'utf8' });

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('archived one');
    expect(result.stdout).toContain('archived two');
    expect(result.stdout).toContain('tail one');
    expect(result.stdout).toContain('tail two');
  });

  it('refuses a segment whose content does not match its manifest hash', async () => {
    const { sessionPath, segmentPath } = await fixture();
    await writeFile(segmentPath, JSON.stringify({
      hash: 'wrong',
      messages: [{ id: 'tampered', role: 'user', content: 'changed' }],
    }));

    const result = spawnSync('python3', [script, 'transcript', sessionPath, '3'], { encoding: 'utf8' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('failed integrity validation');
  });
});

describe('ally-lab session selection', () => {
  async function selectionFixture(sessionId: string) {
    const root = await mkdtemp(join(tmpdir(), 'ally-lab-selection-'));
    temporaryDirectories.push(root);
    const home = join(root, 'home');
    const stateDir = join(root, 'state', 'ally-lab');
    const workingDir = join(root, 'project');
    const sessionPath = join(home, '.ally', 'projects', 'project-key', 'sessions', `${sessionId}.json`);
    await mkdir(dirname(sessionPath), { recursive: true });
    await mkdir(stateDir, { recursive: true });
    await mkdir(workingDir, { recursive: true });
    await writeFile(sessionPath, JSON.stringify({
      id: sessionId,
      working_dir: workingDir,
      updated_at: '2026-08-20T00:00:00.000Z',
      messages: [],
    }));
    await writeFile(join(stateDir, 'test-lab.dir'), `${workingDir}\n`);
    await writeFile(join(stateDir, 'test-lab.started'), '9999999999999999999\n');
    return { home, stateRoot: join(root, 'state'), stateDir, sessionPath };
  }

  it('uses an explicit resumed session even when it predates the process', async () => {
    const { home, stateRoot, stateDir, sessionPath } = await selectionFixture('session_resumed');
    await writeFile(join(stateDir, 'test-lab.session'), 'session_resumed\n');

    const result = spawnSync('bash', [labScript, 'status'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, TMPDIR: stateRoot, ALLY_LAB_SESSION: 'test-lab' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('session:      session_resumed');
    expect(result.stdout).toContain(`file:         ${sessionPath}`);
  });

  it('does not mistake an older session for a fresh launch', async () => {
    const { home, stateRoot } = await selectionFixture('session_old');

    const result = spawnSync('bash', [labScript, 'status'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, TMPDIR: stateRoot, ALLY_LAB_SESSION: 'test-lab' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no session file found for the lab directory yet');
  });

  it.each([
    ['separate resume argument', ['--resume', 'session_resumed']],
    ['joined resume argument', ['--resume=session_resumed']],
  ])('records the explicit session identity from a %s', async (_name, resumeArgs) => {
    const root = await mkdtemp(join(tmpdir(), 'ally-lab-start-'));
    temporaryDirectories.push(root);
    const binDir = join(root, 'bin');
    const stateRoot = join(root, 'state');
    const workingDir = join(root, 'project');
    await mkdir(binDir, { recursive: true });
    await mkdir(workingDir, { recursive: true });
    const ally = join(binDir, 'ally');
    const tmux = join(binDir, 'tmux');
    await writeFile(ally, '#!/bin/sh\nexit 0\n');
    await writeFile(tmux, '#!/bin/sh\n[ "$1" = "has-session" ] && exit 1\nexit 0\n');
    await Promise.all([chmod(ally, 0o755), chmod(tmux, 0o755)]);

    const result = spawnSync(
      'bash',
      [labScript, 'start', '--dir', workingDir, '--', ...resumeArgs],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          TMPDIR: stateRoot,
          ALLY_LAB_SESSION: 'test-lab',
        },
      }
    );

    expect(result.status).toBe(0);
    await expect(readFile(join(stateRoot, 'ally-lab', 'test-lab.session'), 'utf8'))
      .resolves.toBe('session_resumed\n');
  });
});
