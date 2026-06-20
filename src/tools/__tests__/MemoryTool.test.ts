/**
 * MemoryTool unit tests
 *
 * Verifies argument validation, action routing onto a real MemoryService
 * (wired through a scoped registry), graceful handling when the service is
 * absent, and subtext rendering.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MemoryTool } from '../MemoryTool.js';
import { MemoryService } from '../../services/MemoryService.js';
import { ActivityStream } from '../../services/ActivityStream.js';

function contextWith(service: MemoryService | null) {
  return {
    registryScope: {
      get: (name: string) => (name === 'memory_service' ? service : null),
    },
  } as any;
}

describe('MemoryTool', () => {
  let tool: MemoryTool;
  let service: MemoryService;
  let memoryDir: string;
  let ctx: any;

  beforeEach(async () => {
    tool = new MemoryTool(new ActivityStream());
    memoryDir = join(tmpdir(), `code-ally-memtool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    service = new MemoryService({ memoryDir, now: () => '2026-01-01T00:00:00.000Z' });
    await service.initialize();
    ctx = contextWith(service);
  });

  afterEach(async () => {
    await fs.rm(memoryDir, { recursive: true, force: true });
  });

  describe('validateArgs', () => {
    it('rejects an unknown action', () => {
      expect(tool.validateArgs({ action: 'frobnicate' })?.valid).toBe(false);
    });

    it('requires name/description/type/body for save', () => {
      expect(tool.validateArgs({ action: 'save', name: 'x' })?.valid).toBe(false);
    });

    it('rejects an invalid type for save', () => {
      const result = tool.validateArgs({ action: 'save', name: 'x', description: 'd', type: 'nope', body: 'b' });
      expect(result?.valid).toBe(false);
    });

    it('requires a name or query for recall', () => {
      expect(tool.validateArgs({ action: 'recall' })?.valid).toBe(false);
      expect(tool.validateArgs({ action: 'recall', query: 'hi' })).toBeNull();
    });

    it('accepts a well-formed save', () => {
      expect(tool.validateArgs({ action: 'save', name: 'x', description: 'd', type: 'project', body: 'b' })).toBeNull();
    });
  });

  describe('execution', () => {
    it('saves a memory and reports created', async () => {
      const result = await tool.execute(
        { action: 'save', name: 'use-npm', description: 'use npm', type: 'project', body: 'npm only' },
        undefined, undefined, false, false, ctx,
      );
      expect(result.success).toBe(true);
      expect(result.action).toBe('saved');
      expect((await service.recall({ name: 'use-npm' }))[0].body).toBe('npm only');
    });

    it('updates an existing memory (action=updated)', async () => {
      await service.save({ name: 'pref', description: 'old', type: 'user', body: 'old' });
      const result = await tool.execute(
        { action: 'update', name: 'pref', description: 'new', type: 'user', body: 'new' },
        undefined, undefined, false, false, ctx,
      );
      expect(result.action).toBe('updated');
    });

    it('recalls by relevance', async () => {
      await service.save({ name: 'npm-tooling', description: 'use npm not yarn', type: 'project', body: 'details' });
      const result = await tool.execute(
        { action: 'recall', query: 'npm' },
        undefined, undefined, false, false, ctx,
      );
      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.content).toContain('npm-tooling');
    });

    it('deletes a memory and errors when it is missing', async () => {
      await service.save({ name: 'temp', description: 'd', type: 'project', body: 'b' });
      const ok = await tool.execute({ action: 'delete', name: 'temp' }, undefined, undefined, false, false, ctx);
      expect(ok.success).toBe(true);

      const missing = await tool.execute({ action: 'delete', name: 'temp' }, undefined, undefined, false, false, ctx);
      expect(missing.success).toBe(false);
    });

    it('lists memories', async () => {
      await service.save({ name: 'a', description: 'first', type: 'project', body: 'b' });
      const result = await tool.execute({ action: 'list' }, undefined, undefined, false, false, ctx);
      expect(result.count).toBe(1);
      expect(result.content).toContain('a (project): first');
    });

    it('fails cleanly when the memory service is unavailable', async () => {
      const result = await tool.execute(
        { action: 'list' },
        undefined, undefined, false, false, contextWith(null),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Memory service is not available');
    });

    it('surfaces validation errors from the service as validation_error', async () => {
      // Bypasses validateArgs (called by the orchestrator, not execute) to hit the service guard.
      const result = await tool.execute(
        { action: 'save', name: '!!!', description: 'd', type: 'project', body: 'b' },
        undefined, undefined, false, false, ctx,
      );
      expect(result.success).toBe(false);
      expect(result.error_type).toBe('validation_error');
    });
  });

  describe('formatSubtext', () => {
    it('shows a Remembered line for saves', () => {
      expect(tool.formatSubtext({ action: 'save', name: 'use-npm' })).toBe('Remembered: use-npm');
    });
    it('shows a Recall line for recall', () => {
      expect(tool.formatSubtext({ action: 'recall', query: 'npm' })).toBe('Recall: npm');
    });
  });
});
