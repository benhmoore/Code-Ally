/**
 * MemoryService unit tests
 *
 * Covers CRUD + upsert, frontmatter round-trip, index derivation (files are the
 * source of truth), relevance recall, quarantine of corrupt files, and atomic
 * concurrent writes. Each test uses an isolated temp directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  MemoryService,
  MemoryValidationError,
  parseMemory,
  serializeMemory,
  slugify,
} from '../MemoryService.js';

describe('MemoryService', () => {
  let memoryDir: string;
  let service: MemoryService;
  let clock: number;

  beforeEach(async () => {
    memoryDir = join(tmpdir(), `code-ally-memory-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    clock = 0;
    service = new MemoryService({
      memoryDir,
      now: () => `2026-01-01T00:00:${String(clock++).padStart(2, '0')}.000Z`,
    });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(memoryDir, { recursive: true, force: true });
  });

  describe('save', () => {
    it('creates a new memory file and reports created=true', async () => {
      const result = await service.save({
        name: 'use-npm-not-yarn',
        description: 'Build tooling: this repo uses npm',
        type: 'project',
        body: 'The repo standardizes on npm.',
      });

      expect(result).toEqual({ name: 'use-npm-not-yarn', created: true });
      const raw = await fs.readFile(join(memoryDir, 'use-npm-not-yarn.md'), 'utf-8');
      expect(raw).toContain('name: use-npm-not-yarn');
      expect(raw).toContain('type: project');
      expect(raw).toContain('The repo standardizes on npm.');
    });

    it('upserts by name (created=false) and preserves the created timestamp', async () => {
      await service.save({ name: 'pref', description: 'first', type: 'user', body: 'one' });
      const second = await service.save({ name: 'pref', description: 'second', type: 'user', body: 'two' });

      expect(second.created).toBe(false);
      const [record] = await service.recall({ name: 'pref' });
      expect(record.description).toBe('second');
      expect(record.body).toBe('two');
      expect(record.created).toBe('2026-01-01T00:00:00.000Z'); // from first save
      expect(record.updated).not.toBe(record.created);
    });

    it('slugifies the name and collapses whitespace in the description', async () => {
      const { name } = await service.save({
        name: 'Use NPM, Not Yarn!',
        description: '  multi   space   desc  ',
        type: 'project',
        body: 'body',
      });
      expect(name).toBe('use-npm-not-yarn');
      const [record] = await service.recall({ name });
      expect(record.description).toBe('multi space desc');
    });

    it('rejects invalid type and empty body', async () => {
      await expect(
        service.save({ name: 'x', description: 'd', type: 'bogus' as any, body: 'b' }),
      ).rejects.toBeInstanceOf(MemoryValidationError);

      await expect(
        service.save({ name: 'x', description: 'd', type: 'project', body: '   ' }),
      ).rejects.toBeInstanceOf(MemoryValidationError);
    });
  });

  describe('delete', () => {
    it('removes an existing memory and returns true', async () => {
      await service.save({ name: 'temp', description: 'd', type: 'project', body: 'b' });
      expect(await service.delete('temp')).toBe(true);
      expect(await service.recall({ name: 'temp' })).toEqual([]);
    });

    it('returns false for a missing memory', async () => {
      expect(await service.delete('never-existed')).toBe(false);
    });
  });

  describe('index', () => {
    it('rebuilds MEMORY.md from the files, grouped by type', async () => {
      await service.save({ name: 'who', description: 'security researcher', type: 'user', body: 'b' });
      await service.save({ name: 'npm', description: 'use npm', type: 'project', body: 'b' });

      const index = await fs.readFile(join(memoryDir, 'MEMORY.md'), 'utf-8');
      expect(index).toContain('## User');
      expect(index).toContain('[who](who.md) — security researcher');
      expect(index).toContain('## Project');
      expect(index).toContain('[npm](npm.md) — use npm');
    });

    it('reflects the files even after the index is deleted (self-heal on read)', async () => {
      await service.save({ name: 'a', description: 'desc a', type: 'project', body: 'b' });
      await fs.rm(join(memoryDir, 'MEMORY.md'));

      const fresh = new MemoryService({ memoryDir });
      const markdown = await fresh.getIndexMarkdown();
      expect(markdown).toContain('[a](a.md) — desc a');
    });

    it('getPromptContext returns null when empty and a capped list otherwise', async () => {
      expect(await service.getPromptContext()).toBeNull();

      await service.save({ name: 'one', description: 'first', type: 'project', body: 'b' });
      await service.save({ name: 'two', description: 'second', type: 'project', body: 'b' });

      const ctx = await service.getPromptContext(1);
      expect(ctx?.total).toBe(2);
      expect(ctx?.shown).toBe(1);
      expect(ctx?.text).toContain('+1 more');
    });
  });

  describe('recall', () => {
    beforeEach(async () => {
      await service.save({ name: 'npm-tooling', description: 'use npm not yarn', type: 'project', body: 'lockfiles are gitignored' });
      await service.save({ name: 'deploy-target', description: 'ships to fly.io', type: 'project', body: 'staging and prod regions' });
    });

    it('returns an exact match by name', async () => {
      const records = await service.recall({ name: 'deploy-target' });
      expect(records).toHaveLength(1);
      expect(records[0].name).toBe('deploy-target');
    });

    it('ranks by relevance for a free-text query', async () => {
      const records = await service.recall({ query: 'npm yarn' });
      expect(records[0].name).toBe('npm-tooling');
    });

    it('returns empty when nothing matches', async () => {
      expect(await service.recall({ query: 'kubernetes helm charts' })).toEqual([]);
    });
  });

  describe('getAutoRecallContext', () => {
    beforeEach(async () => {
      await service.save({ name: 'npm-tooling', description: 'use npm not yarn', type: 'project', body: 'lockfiles are gitignored' });
      await service.save({ name: 'deploy-target', description: 'ships to fly.io', type: 'project', body: 'staging and prod regions' });
    });

    it('returns null when the query is empty or irrelevant', async () => {
      expect(await service.getAutoRecallContext('')).toBeNull();
      expect(await service.getAutoRecallContext('totally unrelated kubernetes helm')).toBeNull();
    });

    it('surfaces a strongly matching memory as background context', async () => {
      const ctx = await service.getAutoRecallContext('should I use npm or yarn here?');
      expect(ctx).toContain('npm-tooling');
      expect(ctx).toContain('background context');
      expect(ctx).not.toContain('deploy-target');
    });

    it('does not surface on a lone body-only coincidence (min score)', async () => {
      // "gitignored" appears only in npm-tooling's body (weight 1) — below the strong-match threshold.
      expect(await service.getAutoRecallContext('gitignored')).toBeNull();
    });

    it('caps the number of memories surfaced', async () => {
      for (let i = 0; i < 5; i++) {
        await service.save({ name: `npm-note-${i}`, description: `npm detail ${i}`, type: 'project', body: 'b' });
      }
      const ctx = await service.getAutoRecallContext('npm');
      const surfaced = (ctx ?? '').split('\n').filter(line => line.startsWith('- ')).length;
      expect(surfaced).toBeLessThanOrEqual(2);
    });

    it('truncates long bodies', async () => {
      await service.save({ name: 'verbose', description: 'verbose npm topic', type: 'project', body: 'x'.repeat(2000) });
      const ctx = await service.getAutoRecallContext('verbose npm topic');
      expect(ctx).toContain('…');
      expect(ctx!.length).toBeLessThan(1500);
    });
  });

  describe('resilience', () => {
    it('quarantines an unparseable file instead of crashing', async () => {
      await fs.writeFile(join(memoryDir, 'broken.md'), 'not valid frontmatter at all', 'utf-8');
      await service.save({ name: 'good', description: 'd', type: 'project', body: 'b' });

      const records = await service.list();
      expect(records.map(r => r.name)).toEqual(['good']);

      const quarantined = await fs.readdir(join(memoryDir, '.quarantine'));
      expect(quarantined.some(f => f.startsWith('broken.md'))).toBe(true);
    });

    it('handles concurrent saves to distinct names without corruption', async () => {
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          service.save({ name: `fact-${i}`, description: `desc ${i}`, type: 'project', body: `body ${i}` }),
        ),
      );

      const records = await service.list();
      expect(records).toHaveLength(10);
      const leftoverTemp = (await fs.readdir(memoryDir)).filter(f => f.includes('.tmp.'));
      expect(leftoverTemp).toEqual([]);
    });
  });
});

describe('MemoryService pure helpers', () => {
  it('serialize → parse round-trips a record', () => {
    const record = {
      name: 'sample',
      description: 'a sample memory',
      type: 'feedback' as const,
      body: 'Body line one.\nBody line two.',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-02T00:00:00.000Z',
    };
    const parsed = parseMemory(serializeMemory(record), 'sample');
    expect(parsed).toEqual(record);
  });

  it('parseMemory returns null for missing or invalid frontmatter', () => {
    expect(parseMemory('no frontmatter', 'x')).toBeNull();
    expect(parseMemory('---\nname: x\n---\nbody', 'x')).toBeNull(); // missing description/type
  });

  it('slugify produces kebab-case', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('  spaced  out  ')).toBe('spaced-out');
  });
});
