import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = resolve('scripts/ally-lab-session.py');
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
