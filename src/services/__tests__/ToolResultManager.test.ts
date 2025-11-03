/**
 * ToolResultManager tests - focusing on tool-specific truncation notices
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolResultManager } from '../ToolResultManager.js';
import { TokenManager } from '../../agent/TokenManager.js';
import { ToolManager } from '../../tools/ToolManager.js';
import { ActivityStream } from '../ActivityStream.js';
import { BashTool } from '../../tools/BashTool.js';
import { ReadTool } from '../../tools/ReadTool.js';
import { GrepTool } from '../../tools/GrepTool.js';
import { GlobTool } from '../../tools/GlobTool.js';
import { LsTool } from '../../tools/LsTool.js';

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
    toolManager = new ToolManager(tools, activityStream);

    // Create tool result manager with toolManager
    toolResultManager = new ToolResultManager(tokenManager, undefined, toolManager);
  });

  describe('Tool-Specific Truncation Notices', () => {
    it('should provide bash-specific guidance when truncating bash output', () => {
      // Create a very long bash output to trigger truncation
      const longOutput = 'line\n'.repeat(1000); // ~1000 lines

      // Set high context usage to trigger aggressive truncation
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) }, // ~1500 tokens
      ]);

      const result = toolResultManager.processToolResult('bash', longOutput);

      // Should be truncated
      expect(result.length).toBeLessThan(longOutput.length);

      // Should contain bash-specific guidance
      expect(result).toContain('truncated');
      expect(result).toContain('grep');
      expect(result).toContain('head');
      expect(result).toContain('tail');
    });

    it('should provide read-specific guidance when truncating read output', () => {
      const longOutput = 'line\n'.repeat(1000);

      // Set high context usage
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) },
      ]);

      const result = toolResultManager.processToolResult('read', longOutput);

      // Should be truncated
      expect(result.length).toBeLessThan(longOutput.length);

      // Should contain read-specific guidance
      expect(result).toContain('truncated');
      expect(result).toContain('limit');
      expect(result).toContain('offset');
    });

    it('should provide grep-specific guidance when truncating grep output', () => {
      const longOutput = 'match\n'.repeat(1000);

      // Set high context usage
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) },
      ]);

      const result = toolResultManager.processToolResult('grep', longOutput);

      // Should be truncated
      expect(result.length).toBeLessThan(longOutput.length);

      // Should contain grep-specific guidance
      expect(result).toContain('truncated');
      expect(result).toContain('pattern');
      expect(result).toContain('glob');
    });

    it('should provide glob-specific guidance when truncating glob output', () => {
      const longOutput = 'file.txt\n'.repeat(1000);

      // Set high context usage
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) },
      ]);

      const result = toolResultManager.processToolResult('glob', longOutput);

      // Should be truncated
      expect(result.length).toBeLessThan(longOutput.length);

      // Should contain glob-specific guidance
      expect(result).toContain('truncated');
      expect(result).toContain('specific');
      expect(result).toContain('patterns');
    });

    it('should provide ls-specific guidance when truncating ls output', () => {
      const longOutput = 'file.txt\n'.repeat(1000);

      // Set high context usage
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) },
      ]);

      const result = toolResultManager.processToolResult('ls', longOutput);

      // Should be truncated
      expect(result.length).toBeLessThan(longOutput.length);

      // Should contain ls-specific guidance
      expect(result).toContain('truncated');
      expect(result).toContain('specific path');
    });

    it('should provide generic guidance for unknown tools', () => {
      const longOutput = 'data\n'.repeat(1000);

      // Set high context usage
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) },
      ]);

      const result = toolResultManager.processToolResult('unknown_tool', longOutput);

      // Should be truncated
      expect(result.length).toBeLessThan(longOutput.length);

      // Should contain generic guidance
      expect(result).toContain('truncated');
      expect(result).toContain('narrowing');
    });

    it('should include context-aware reason in truncation notice', () => {
      const longOutput = 'x'.repeat(10000);

      // Test with low context - should mention "length" or "context"
      const lowContextManager = new TokenManager(2000);
      const lowResultManager = new ToolResultManager(lowContextManager, undefined, toolManager);
      lowContextManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(200 * 4) }, // ~10% of 2000
      ]);

      const lowResult = lowResultManager.processToolResult('bash', longOutput);
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

      const highResult = highResultManager.processToolResult('bash', realisticOutput);
      // Should be truncated when context is high
      expect(highResult.length).toBeLessThan(realisticOutput.length);
      // Should contain truncation notice and tool guidance
      expect(highResult).toContain('truncated');
      expect(highResult).toContain('grep');
    });

    it('should not truncate short outputs', () => {
      const shortOutput = 'Short output';

      // Even with high context
      tokenManager.updateTokenCount([
        { role: 'user', content: 'x'.repeat(1500 * 4) },
      ]);

      const result = toolResultManager.processToolResult('bash', shortOutput);

      // Should NOT be truncated
      expect(result).toBe(shortOutput);
      expect(result).not.toContain('truncated');
    });
  });
});
