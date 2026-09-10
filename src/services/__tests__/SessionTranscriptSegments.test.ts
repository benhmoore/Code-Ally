import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'node:crypto';
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

  it.each(['changed', 'missing', 'invalid JSON'])('refuses a %s transcript segment without rewriting its manifest', async damage => {
    const manager = new SessionManager({ sessionsDir: dir });
    await manager.initialize();
    await manager.createSession('corrupt');
    const transcript: Message[] = Array.from({ length: 64 }, (_, index) => ({
      id: `m-${index}`, role: 'user', content: String(index), timestamp: index,
    }));
    await manager.saveSession('corrupt', transcript.slice(-1), transcript);
    const manifest = JSON.parse(await fs.readFile(join(dir, 'corrupt.json'), 'utf-8'));
    const ref = manifest.transcript_segments[0];
    const segmentPath = join(dir, 'corrupt', 'transcript-segments', `${ref.hash}.json`);
    if (damage === 'missing') await fs.unlink(segmentPath);
    else await fs.writeFile(segmentPath, damage === 'invalid JSON' ? '{' : JSON.stringify({ hash: ref.hash, messages: [] }));

    const reloaded = new SessionManager({ sessionsDir: dir });
    await expect(reloaded.loadSession('corrupt')).rejects.toThrow();
    await expect(reloaded.getTranscriptPage('corrupt')).rejects.toThrow();
    const before = await fs.readFile(join(dir, 'corrupt.json'), 'utf8');
    reloaded.setCurrentSession('corrupt');
    await reloaded.autoSave([{ role: 'user', content: 'new message' }]);
    await expect(reloaded.forceSave()).rejects.toThrow('Session autosave persistence failed');
    expect(await fs.readFile(join(dir, 'corrupt.json'), 'utf8')).toBe(before);
    // A warm read cache must not authorize replacing damaged on-disk history.
    expect(await manager.saveSession('corrupt', transcript.slice(-1), transcript)).toBe(false);
    expect(await fs.readFile(join(dir, 'corrupt.json'), 'utf8')).toBe(before);
  });

  it('restores canonical originals for active messages older than the visible tail', async () => {
    const manager = new SessionManager({ sessionsDir: dir });
    await manager.initialize();
    await manager.createSession('canonical-active');
    const transcript: Message[] = Array.from({ length: 620 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `canonical ${index}`,
      timestamp: index,
    }));
    const active: Message[] = [{
      ...transcript[10]!,
      content: '[payload evicted]',
      metadata: { contentEvicted: true },
    }];
    await manager.saveSession('canonical-active', active, transcript);

    const data = await manager.getSessionData('canonical-active');

    expect(data.transcript).toHaveLength(500);
    expect(data.transcript.some(message => message.id === 'message-10')).toBe(false);
    expect(data.canonicalMessages).toEqual([transcript[10]]);
  });

  it.each(['full', 'incremental'])('refuses corrupt existing content before a %s write references it', async mode => {
    const manager = new SessionManager({ sessionsDir: dir });
    await manager.initialize();
    await manager.createSession('reuse');
    manager.setCurrentSession('reuse');
    const transcript: Message[] = Array.from({ length: 64 }, (_, index) => ({
      id: `m-${index}`, role: 'user', content: String(index), timestamp: index,
    }));
    const hash = createHash('sha256').update(JSON.stringify(transcript)).digest('hex');
    const segmentDir = join(dir, 'reuse', 'transcript-segments');
    await fs.mkdir(segmentDir, { recursive: true });
    const segmentPath = join(segmentDir, `${hash}.json`);
    const damaged = JSON.stringify({ schema_version: 1, hash, messages: [] });
    await fs.writeFile(segmentPath, damaged);
    const manifestPath = join(dir, 'reuse.json');
    const before = await fs.readFile(manifestPath, 'utf8');
    if (mode === 'full') {
      expect(await manager.saveSession('reuse', transcript, transcript)).toBe(false);
    } else {
      await manager.autoSave(transcript);
      await expect(manager.forceSave()).rejects.toThrow('Session autosave persistence failed');
    }
    expect(await fs.readFile(manifestPath, 'utf8')).toBe(before);
    expect(await fs.readFile(segmentPath, 'utf8')).toBe(damaged);
  });

  it('permits concurrent identical segment publication without replacing content', async () => {
    const first = new SessionManager({ sessionsDir: dir });
    const second = new SessionManager({ sessionsDir: dir });
    await first.initialize();
    await first.createSession('shared-content');
    const transcript: Message[] = Array.from({ length: 64 }, (_, index) => ({
      id: `shared-${index}`, role: 'user', content: String(index),
    }));
    expect(await Promise.all([first, second].map(manager => manager.saveSession('shared-content', transcript)))).toEqual([true, true]);
    const reloaded = new SessionManager({ sessionsDir: dir });
    expect((await reloaded.loadSession('shared-content'))?.transcript).toEqual(transcript);
    const files = await fs.readdir(join(dir, 'shared-content', 'transcript-segments'));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('.tmp.');
  });
});
