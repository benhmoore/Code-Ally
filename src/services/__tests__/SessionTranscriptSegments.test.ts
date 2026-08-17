import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionManager } from '../SessionManager.js';
import type { Message } from '../../types/index.js';

describe('SessionManager transcript segments', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ally-transcript-segments-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stores immutable full chunks by content hash and hydrates them transparently', async () => {
    const manager = new SessionManager({ sessionsDir: dir });
    await manager.initialize();
    await manager.createSession('segmented');
    const transcript: Message[] = Array.from({ length: 130 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `message ${index}`,
      timestamp: index,
    }));

    await manager.saveSession('segmented', transcript.slice(-10), transcript);

    const manifest = JSON.parse(await fs.readFile(join(dir, 'segmented.json'), 'utf-8'));
    expect(manifest.transcript).toBeUndefined();
    expect(manifest.transcript_segments).toHaveLength(2);
    expect(manifest.transcript_tail).toHaveLength(2);
    for (const ref of manifest.transcript_segments) {
      const segment = JSON.parse(await fs.readFile(
        join(dir, 'segmented', 'transcript-segments', `${ref.hash}.json`),
        'utf-8',
      ));
      expect(segment.hash).toBe(ref.hash);
      expect(segment.messages).toHaveLength(64);
    }

    const reloaded = new SessionManager({ sessionsDir: dir });
    const session = await reloaded.loadSession('segmented');
    expect(session?.transcript).toEqual(transcript);
    expect(session?.messages).toEqual(transcript.slice(-10));
  });

  it('refuses a transcript segment whose content no longer matches its hash', async () => {
    const manager = new SessionManager({ sessionsDir: dir });
    await manager.initialize();
    await manager.createSession('corrupt');
    const transcript: Message[] = Array.from({ length: 64 }, (_, index) => ({
      id: `m-${index}`, role: 'user', content: String(index), timestamp: index,
    }));
    await manager.saveSession('corrupt', transcript.slice(-1), transcript);
    const manifest = JSON.parse(await fs.readFile(join(dir, 'corrupt.json'), 'utf-8'));
    const ref = manifest.transcript_segments[0];
    await fs.writeFile(
      join(dir, 'corrupt', 'transcript-segments', `${ref.hash}.json`),
      JSON.stringify({ hash: ref.hash, messages: [] }),
    );

    const reloaded = new SessionManager({ sessionsDir: dir });
    expect(await reloaded.loadSession('corrupt')).toBeNull();
  });
});
