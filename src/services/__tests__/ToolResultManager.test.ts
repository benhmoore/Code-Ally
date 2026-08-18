/**
 * ToolResultManager tests - focusing on tool-specific truncation notices
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolResultManager } from '../ToolResultManager.js';
import { TokenManager } from '@agent/TokenManager.js';
import { ToolManager } from '@tools/ToolManager.js';
import { ActivityStream } from '../ActivityStream.js';
import { BashTool } from '@tools/BashTool.js';
import { ReadTool } from '@tools/ReadTool.js';
import { GrepTool } from '@tools/GrepTool.js';
import { GlobTool } from '@tools/GlobTool.js';
import { LsTool } from '@tools/LsTool.js';
import { ToolResultPersistence } from '../ToolResultPersistence.js';

describe('ToolResultManager', () => {
  let toolResultManager: ToolResultManager;
  let tokenManager: TokenManager;
  let toolManager: ToolManager;

  beforeEach(() => {
    // Create token manager with a small context for easier testing
    tokenManager = new TokenManager(2000); // 2000 tokens total

    // Create activity stream
    const activityStream = new ActivityStream();

    // Create real tools
    const tools = [
      new BashTool(activityStream),
      new ReadTool(activityStream),
      new GrepTool(activityStream),
      new GlobTool(activityStream),
      new LsTool(activityStream),
    ];

    // Create tool manager with real tools
    toolManager = new ToolManager(tools);

    // Create tool result manager with toolManager
    toolResultManager = new ToolResultManager(tokenManager, undefined, toolManager);
  });

  describe('Tool-Specific Truncation Notices', () => {
    it('should provide bash-specific guidance when truncating bash output', async () => {
      // Create a very long bash output to trigger truncation
      const longOutput = 'line\n'.repeat(1000); // ~1000 lines

      // Set high context usage to trigger aggressive truncation
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) }, // ~1500 tokens
      ]);

      const result = await toolResultManager.processToolResult('bash', longOutput);

      // Should be truncated
      expect(result.length).toBeLessThan(longOutput.length);

      // Should contain bash-specific guidance
      expect(result).toContain('truncated');
      expect(result).toContain('grep');
      expect(result).toContain('head');
      expect(result).toContain('tail');
    });

    it('should provide read-specific guidance when truncating read output', async () => {
      const longOutput = 'line\n'.repeat(1000);

      // Set high context usage
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) },
      ]);

      const result = await toolResultManager.processToolResult('read', longOutput);

      // Should be truncated
      expect(result.length).toBeLessThan(longOutput.length);

      // Should contain read-specific guidance
      expect(result).toContain('truncated');
      expect(result).toContain('limit');
      expect(result).toContain('offset');
    });

    it('should provide grep-specific guidance when truncating grep output', async () => {
      const longOutput = 'match\n'.repeat(1000);

      // Set high context usage
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) },
      ]);

      const result = await toolResultManager.processToolResult('grep', longOutput);

      // Should be truncated
      expect(result.length).toBeLessThan(longOutput.length);

      // Should contain grep-specific guidance
      expect(result).toContain('truncated');
      expect(result).toContain('pattern');
      expect(result).toContain('glob');
    });

    it('should provide glob-specific guidance when truncating glob output', async () => {
      const longOutput = 'file.txt\n'.repeat(1000);

      // Set high context usage
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) },
      ]);

      const result = await toolResultManager.processToolResult('glob', longOutput);

      // Should be truncated
      expect(result.length).toBeLessThan(longOutput.length);

      // Should contain glob-specific guidance
      expect(result).toContain('truncated');
      expect(result).toContain('specific');
      expect(result).toContain('patterns');
    });

    it('should provide ls-specific guidance when truncating ls output', async () => {
      const longOutput = 'file.txt\n'.repeat(1000);

      // Set high context usage
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) },
      ]);

      const result = await toolResultManager.processToolResult('ls', longOutput);

      // Should be truncated
      expect(result.length).toBeLessThan(longOutput.length);

      // Should contain ls-specific guidance
      expect(result).toContain('truncated');
      expect(result).toContain('specific path');
    });

    it('should provide generic guidance for unknown tools', async () => {
      const longOutput = 'data\n'.repeat(1000);

      // Set high context usage
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) },
      ]);

      const result = await toolResultManager.processToolResult('unknown_tool', longOutput);

      // Should be truncated
      expect(result.length).toBeLessThan(longOutput.length);

      // Should contain generic guidance
      expect(result).toContain('truncated');
      expect(result).toContain('narrowing');
    });

    it('should include context-aware reason in truncation notice', async () => {
      const longOutput = 'x'.repeat(10000);

      // Test with low context - should mention "length" or "context"
      const lowContextManager = new TokenManager(2000);
      const lowResultManager = new ToolResultManager(lowContextManager, undefined, toolManager);
      lowContextManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(200 * 4) }, // ~10% of 2000
      ]);

      const lowResult = await lowResultManager.processToolResult('bash', longOutput);
      if (lowResult.includes('truncated')) {
        // Should have a truncation notice with tool guidance
        expect(lowResult).toContain('truncated');
        expect(lowResult).toContain('grep');
      }

      // Test with very high context - verify truncation notice appears
      // Use a more realistic output that tokenizes normally
      const realisticOutput = 'line 1\nline 2\nline 3\n'.repeat(500); // ~1500 tokens

      const highContextManager = new TokenManager(2000);
      const highResultManager = new ToolResultManager(highContextManager, undefined, toolManager);
      highContextManager.updateTokenCount([
        { role: 'user', content: 'text content '.repeat(100) }, // Fill most of context
      ]);

      const highResult = await highResultManager.processToolResult('bash', realisticOutput);
      // Should be truncated when context is high
      expect(highResult.length).toBeLessThan(realisticOutput.length);
      // Should contain truncation notice and tool guidance
      expect(highResult).toContain('truncated');
      expect(highResult).toContain('grep');
    });

    it('should not truncate short outputs', async () => {
      const shortOutput = 'Short output';

      // Even with high context
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) },
      ]);

      const result = await toolResultManager.processToolResult('bash', shortOutput);

      // Should NOT be truncated
      expect(result).toBe(shortOutput);
      expect(result).not.toContain('truncated');
    });

    it('keeps the original when truncation metadata would make the result larger', async () => {
      const persistence = {
        persistResult: vi.fn().mockResolvedValue('/tmp/a-very-long-persisted-result-path/call-todo.txt'),
        getResultPath: vi.fn().mockReturnValue('/tmp/a-very-long-persisted-result-path/call-todo.txt'),
      } as unknown as ToolResultPersistence;
      toolResultManager.setPersistence(persistence);
      toolResultManager.setLimits({ maxContextPercent: 0.01, minTokens: 10 });
      const compactResult = 'Set 3 todos: 2 pending, 1 in progress. ' + 'next '.repeat(20);

      const result = await toolResultManager.processToolResult('todo-write', compactResult, 'call-todo');

      expect(result).toBe(compactResult);
      expect(result).not.toContain('truncated');
    });

    it('should persist plain bash output instead of the serialized tool result wrapper', async () => {
      const stdout = 'build line\n'.repeat(1000);
      const stderr = 'warning from stderr\n';
      const persistence = {
        persistResult: vi.fn().mockResolvedValue('/tmp/call-bash.txt'),
        getResultPath: vi.fn().mockReturnValue('/tmp/call-bash.txt'),
      } as unknown as ToolResultPersistence;

      toolResultManager.setPersistence(persistence);
      toolResultManager.setLimits({ maxContextPercent: 0.01, minTokens: 10 });

      const result = await toolResultManager.processToolResult(
        'bash',
        {
          success: true,
          error: '',
          content: stdout,
          stderr,
          return_code: 0,
        },
        'call-bash'
      );

      expect(persistence.persistResult).toHaveBeenCalledWith(
        'call-bash',
        `${stdout}${stderr}`
      );
      expect(result).toContain('[Full output saved to: /tmp/call-bash.txt]');
      expect(result).toContain('build line');
      expect(result).not.toContain('{"success":true');
    });

    it('honors a hard per-call ceiling assigned by a shared batch budget', async () => {
      const result = await toolResultManager.processToolResult(
        'grep',
        'matching line\n'.repeat(2_000),
        'call-grep',
        120,
      );

      expect(tokenManager.estimateTokens(result)).toBeLessThanOrEqual(120);
      expect(result).toContain('truncated');
    });
  });
});
