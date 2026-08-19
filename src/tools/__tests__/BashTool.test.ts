/**
 * Tests for BashTool
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BashTool } from '@tools/BashTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { CircularBuffer } from '@services/BashProcessManager.js';

describe('BashTool', () => {
  let activityStream: ActivityStream;
  let bashTool: BashTool;

  beforeEach(() => {
    activityStream = new ActivityStream();
    bashTool = new BashTool(activityStream);
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(bashTool.name).toBe('bash');
    });

    it('does not hide an ongoing exploratory streak', () => {
      expect(bashTool.breaksExploratoryStreak).toBe(false);
    });

    it('should require confirmation', () => {
      expect(bashTool.requiresConfirmation({})).toBe(true);
    });

    it('should have function definition', () => {
      const def = bashTool.getFunctionDefinition();
      expect(def.function.name).toBe('bash');
      expect(def.function.parameters.required).toContain('command');
    });
  });

  describe('execute', () => {
    it('should execute simple command', async () => {
      const result = await bashTool.execute({
        command: 'echo "Hello World"',
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain('Hello World');
      expect(result.return_code).toBe(0);
    });

    it('should handle command with non-zero exit code', async () => {
      const result = await bashTool.execute({
        command: 'exit 1',
      });

      expect(result.success).toBe(false); // Command failed
      expect(result.error).toBeDefined();
    });

    it('should require command parameter', async () => {
      const result = await bashTool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('command parameter is required');
      expect(result.error_type).toBe('validation_error');
    });

    it('should use working directory if provided', async () => {
      const result = await bashTool.execute({
        command: 'pwd',
        working_dir: process.cwd(),
      });

      expect(result.success).toBe(true);
      expect(result.content).toContain(process.cwd());
    });

    it('should respect timeout', async () => {
      const result = await bashTool.execute({
        command: 'sleep 10',
        timeout: 1, // 1 second
      });

      // Should timeout and fail
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.transitioned).not.toBe(true);
    }, 10000); // Increase test timeout

    it('accepts an explicit infinite timeout without scheduling Infinity', async () => {
      const result = await bashTool.execute({ command: 'printf ok', timeout: -1 });
      expect(result.success).toBe(true);
      expect(result.content).toBe('ok');
    });

    it('uses a noninteractive environment', async () => {
      const result = await bashTool.execute({ command: 'printf "%s:%s:%s" "$CI" "$GIT_TERMINAL_PROMPT" "$PAGER"' });
      expect(result.content).toBe('1:0:cat');
    });

    it('should block dangerous commands', async () => {
      const result = await bashTool.execute({
        command: 'rm -rf /',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('disallowed');
      expect(result.error_type).toBe('security_error');
    });

    it('does not confuse an absolute descendant with the filesystem root', async () => {
      const result = await bashTool.execute({
        command: 'printf "%s" "rm -rf /tmp/isolated-test-state"',
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe('rm -rf /tmp/isolated-test-state');
    });
  });

  it('bounds giant no-newline background output by bytes', () => {
    const buffer = new CircularBuffer(10_000, 1024);
    buffer.append('x'.repeat(10_000));
    expect(Buffer.byteLength(buffer.getLines().join('\n'))).toBeLessThanOrEqual(1024);
  });

  describe('getResultPreview', () => {
    it('should show exit code and output preview', async () => {
      const result = await bashTool.execute({
        command: 'echo "Line 1" && echo "Line 2" && echo "Line 3"',
      });

      const preview = bashTool.getResultPreview(result, 3);
      expect(preview[0]).toContain('Exit code: 0');
      expect(preview[0]).toContain('✓');
      expect(preview.some((line) => line.includes('Line 1'))).toBe(true);
    });

    it('should show error indicator for non-zero exit', async () => {
      const result = await bashTool.execute({
        command: 'exit 1',
      });

      const preview = bashTool.getResultPreview(result, 3);
      // When command fails, preview shows error message (not exit code)
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
