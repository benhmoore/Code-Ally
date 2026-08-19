/**
 * Tests for ReadTool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ReadTool } from '@tools/ReadTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ReadCache } from '@services/ReadCache.js';
import { ReadStateManager } from '@services/ReadStateManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('ReadTool', () => {
  let activityStream: ActivityStream;
  let readTool: ReadTool;
  let tempDir: string;
  let testFile: string;
  let registry: ServiceRegistry;

  beforeEach(async () => {
    activityStream = new ActivityStream();
    readTool = new ReadTool(activityStream);
    registry = ServiceRegistry.getInstance();
    registry['_services'].clear();
    registry['_descriptors'].clear();
    registry.registerInstance('read_cache', new ReadCache());
    registry.registerInstance('read_state_manager', new ReadStateManager());

    // Create temp directory and test file
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-tool-test-'));
    testFile = path.join(tempDir, 'test.txt');
    await fs.writeFile(testFile, 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\n');
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
    registry['_services'].clear();
    registry['_descriptors'].clear();
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(readTool.name).toBe('read');
    });

    it('should not require confirmation', () => {
      expect(readTool.requiresConfirmation({})).toBe(false);
    });

    it('should have function definition', () => {
      const def = readTool.getFunctionDefinition();
      expect(def.function.name).toBe('read');
      expect(def.function.parameters.required).toContain('file_path');
    });
  });

  describe('execute', () => {
    it('should read single file', async () => {
      const result = await readTool.execute({
        file_path: testFile,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('Line 1');
      expect(result.content).toContain('Line 5');
      expect(result.files_read).toBe(1);
    });

    it('rejects multiple paths in one argument', async () => {
      const testFile2 = path.join(tempDir, 'test2.txt');
      await fs.writeFile(testFile2, 'File 2 content\n');

      const result = await readTool.execute({
        file_path: [testFile, testFile2],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('one file path');
      expect(result.suggestion).toContain('one read per path');
      expect(result.suggestion).toContain('known-small');
    });

    it('does not execute when its parallel group exceeds the shared output budget', async () => {
      const result = await readTool.execute(
        { file_path: testFile },
        'read-over-budget',
        undefined,
        false,
        false,
        {
          outputBudget: {
            limitTokens: 1_000,
            estimatedTokens: 1_600,
            rejectedCallIds: new Set(['read-over-budget']),
            maxResultTokensByCallId: new Map(),
          },
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('combined non-truncatable outputs');
      expect(result.suggestion).toContain('split the reads');
    });

    it('should include line numbers', async () => {
      const result = await readTool.execute({
        file_path: testFile,
      });

      expect(result.success).toBe(true);
      // Line numbers should be present (padded to 6 chars)
      expect(result.content).toMatch(/\s+1\t/);
      expect(result.content).toMatch(/\s+2\t/);
    });

    it('should respect limit parameter', async () => {
      const result = await readTool.execute({
        file_path: testFile,
        limit: 2,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('Line 1');
      expect(result.content).toContain('Line 2');
      expect(result.content).not.toContain('Line 3');
    });

    it('should respect offset parameter', async () => {
      const result = await readTool.execute({
        file_path: testFile,
        offset: 3, // Start from line 3
      });

      expect(result.success).toBe(true);
      expect(result.content).not.toContain('Line 1');
      expect(result.content).not.toContain('Line 2');
      expect(result.content).toContain('Line 3');
    });

    it('should handle non-existent file', async () => {
      const result = await readTool.execute({
        file_path: path.join(tempDir, 'nonexistent.txt'),
      });

      expect(result.success).toBe(false); // Tool fails when ALL files fail
      expect(result.error).toBeDefined();
      expect(result.error).toContain('Failed to read');
    });

    it('should require file_path parameter', async () => {
      const result = await readTool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('file_path');
      expect(result.error_type).toBe('validation_error');
    });

    it('should reject an array file_path', async () => {
      const result = await readTool.execute({
        file_path: [],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('one file path');
    });

    it('should detect binary files', async () => {
      const binaryFile = path.join(tempDir, 'binary.bin');
      // Write binary content with null bytes
      await fs.writeFile(binaryFile, Buffer.from([0x00, 0x01, 0x02, 0xff]));

      const result = await readTool.execute({
        file_path: binaryFile,
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('Binary file');
    });

    it('should only deduplicate unchanged reads within the same agent scope', async () => {
      const firstAgentRead = await readTool.execute(
        { file_path: testFile },
        undefined,
        undefined,
        false,
        false,
        { agentId: 'agent-a' }
      );
      expect(firstAgentRead.success).toBe(true);
      expect(firstAgentRead.content).toContain('Line 1');

      const secondAgentRead = await readTool.execute(
        { file_path: testFile },
        undefined,
        undefined,
        false,
        false,
        { agentId: 'agent-b' }
      );
      expect(secondAgentRead.success).toBe(true);
      expect(secondAgentRead.content).toContain('Line 1');
      expect(secondAgentRead.content).not.toContain('File unchanged since last read');

      const sameAgentRead = await readTool.execute(
        { file_path: testFile },
        undefined,
        undefined,
        false,
        false,
        { agentId: 'agent-b' }
      );
      expect(sameAgentRead.success).toBe(true);
      expect(sameAgentRead.content).toContain('File unchanged since last read');
    });

    it('re-reads when the cached content is no longer in the active conversation', async () => {
      // Fake owning agent: the cache stub is only truthful while the tool
      // result message that carried the content remains in active context.
      const activeMessages: Array<{
        role: string;
        tool_call_id?: string;
        content: string;
        metadata?: { contentEvicted?: boolean };
      }> = [];
      registry.registerInstance('agent', {
        getConversationManager: () => ({ getMessages: () => activeMessages }),
      } as any);

      const first = await readTool.execute(
        { file_path: testFile }, 'call-1', undefined, false, false, { agentId: 'agent-a' },
      );
      expect(first.content).toContain('Line 1');
      activeMessages.push({ role: 'tool', tool_call_id: 'call-1', content: 'carried content' });

      const second = await readTool.execute(
        { file_path: testFile }, 'call-2', undefined, false, false, { agentId: 'agent-a' },
      );
      expect(second.content).toContain('File unchanged since last read');

      // Compaction removes the carrying message from active context: the stub
      // would now lie, so the tool must serve the full content again.
      activeMessages.length = 0;
      const third = await readTool.execute(
        { file_path: testFile }, 'call-3', undefined, false, false, { agentId: 'agent-a' },
      );
      expect(third.content).toContain('Line 1');
      expect(third.content).not.toContain('File unchanged since last read');

      // The fresh read re-primes deduplication under its own tool call.
      activeMessages.push({ role: 'tool', tool_call_id: 'call-3', content: 'carried content' });
      const fourth = await readTool.execute(
        { file_path: testFile }, 'call-4', undefined, false, false, { agentId: 'agent-a' },
      );
      expect(fourth.content).toContain('File unchanged since last read');

      // Eviction stubs the carrying message in place: the content is gone even
      // though the message still exists, so the stub must not be served.
      activeMessages[0] = {
        role: 'tool',
        tool_call_id: 'call-3',
        content: '[Tool output evicted to reclaim context]',
        metadata: { contentEvicted: true },
      };
      const fifth = await readTool.execute(
        { file_path: testFile }, 'call-5', undefined, false, false, { agentId: 'agent-a' },
      );
      expect(fifth.content).toContain('Line 1');
      expect(fifth.content).not.toContain('File unchanged since last read');
    });

    it('sizes reads against usable space, not the raw context window', async () => {
      const { ContextBudgetService } = await import('@services/ContextBudgetService.js');
      const budgets = new ContextBudgetService();
      registry.registerInstance('context_budget', budgets);
      registry.registerInstance('token_manager', {
        getContextSize: () => 16_384,
        getCurrentTokenCount: () => 0,
      } as any);

      const bigFile = path.join(tempDir, 'big.txt');
      // ~2500 tokens: under the legacy 20%-of-16k cap (3276), over the
      // retained-tail ceiling (2054) that the real budget implies.
      await fs.writeFile(bigFile, 'const value = compute(input, options);\n'.repeat(250));

      // Without a published budget the legacy window fraction applies (20% of
      // 16k = 3276 tokens), so this file is allowed.
      const permissive = await readTool.execute(
        { file_path: bigFile }, 'call-1', undefined, false, false, { agentId: 'agent-a' },
      );
      expect(permissive.success).toBe(true);

      // With a realistic 16k budget most of the window is fixed overhead, so
      // the same read no longer fits the space that can actually be retained.
      // Published per agent: agent-a above keeps the fallback, proving scoping.
      budgets.publish('agent-b', {
        contextWindow: 16_384, estimatedInput: 0, outputReserve: 2_048, safetyReserve: 819,
        triggerBudget: 13_107, targetBudget: 10_800, fixedOverhead: 7_400, usableBudget: 5_707,
        domainBudget: 3_424, retainedTailBudget: 2_054, checkpointBudget: 1_370,
        maxToolResultTokens: 2_054, shouldCompact: false,
      });

      // The same file is refused with actionable guidance under the tighter
      // per-agent retained-tail budget.
      const restricted = await readTool.execute(
        { file_path: bigFile }, 'call-2', undefined, false, false, { agentId: 'agent-b' },
      );
      expect(restricted.success).toBe(false);
      expect(restricted.error).toContain('2054-token limit');
      expect(restricted.error).toContain('first locate the relevant symbol with grep');
    });

    it('redirects an oversized broad read to search and a narrow range', async () => {
      const { ContextBudgetService } = await import('@services/ContextBudgetService.js');
      const budgets = new ContextBudgetService();
      registry.registerInstance('context_budget', budgets);
      registry.registerInstance('token_manager', {
        getContextSize: () => 16_384,
        getCurrentTokenCount: () => 0,
      } as any);
      budgets.publish('agent-a', {
        contextWindow: 16_384, estimatedInput: 0, outputReserve: 2_048, safetyReserve: 819,
        triggerBudget: 13_107, targetBudget: 10_800, fixedOverhead: 3_450, usableBudget: 9_657,
        domainBudget: 5_794, retainedTailBudget: 3_476, checkpointBudget: 2_318,
        maxToolResultTokens: 1_738, shouldCompact: false,
      });

      const bigFile = path.join(tempDir, 'big.js');
      await fs.writeFile(bigFile, 'const value = compute(input, options);\n'.repeat(400));

      const result = await readTool.execute(
        { file_path: bigFile }, 'call-1', undefined, false, false, { agentId: 'agent-a' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('per-result retention limit');
      expect(result.error).toContain('does not mean the overall context is exhausted');
      expect(result.error).toContain('Do not page through the file by default');
      expect(result.error).toContain('first locate the relevant symbol with grep');
      expect(result.suggestion).toContain('smallest relevant offset/limit range');
    });

    it('should track read state in the reading agent scope only', async () => {
      const readStateManager = registry.get('read_state_manager')!;

      await readTool.execute(
        { file_path: testFile, limit: 2 },
        undefined,
        undefined,
        false,
        false,
        { agentId: 'agent-a' }
      );

      expect(readStateManager.validateLinesRead(testFile, 1, 2, 'agent-a').success).toBe(true);
      expect(readStateManager.validateLinesRead(testFile, 1, 2, 'agent-b').success).toBe(false);
    });
  });

  describe('getResultPreview', () => {
    it('should show files read count', async () => {
      const result = await readTool.execute({
        file_path: testFile,
      });

      const preview = readTool.getResultPreview(result, 3);
      expect(preview[0]).toContain('Read 1 file');
    });

    it('should show content preview', async () => {
      const result = await readTool.execute({
        file_path: testFile,
      });

      // Request more lines to get actual content in preview
      const preview = readTool.getResultPreview(result, 10);
      expect(preview.length).toBeGreaterThan(1);
      // The preview includes file header lines, line count indicator, and content lines
      expect(preview.some((line) => line.includes('Line 1'))).toBe(true);
    });
  });
});
