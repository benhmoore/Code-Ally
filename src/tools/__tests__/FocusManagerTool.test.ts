/**
 * Tests for FocusManagerTool
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FocusManagerTool } from '../../tools/FocusManagerTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { FocusManager } from '../../services/FocusManager.js';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

describe('FocusManagerTool', () => {
  let activityStream: ActivityStream;
  let registry: ServiceRegistry;
  let focusManager: FocusManager;
  let tool: FocusManagerTool;
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    testDir = await mkdtemp(join(tmpdir(), 'focus-test-'));

    // Change to test directory
    process.chdir(testDir);

    activityStream = new ActivityStream();
    registry = ServiceRegistry.getInstance();
    focusManager = new FocusManager();
    registry.registerInstance('focus_manager', focusManager);

    tool = new FocusManagerTool(activityStream);
  });

  afterEach(async () => {
    // Clean up
    await registry.shutdown();

    // Remove test directory
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('metadata', () => {
    it('should have correct metadata', () => {
      expect(tool.name).toBe('focus');
      expect(tool.requiresConfirmation).toBe(false);
    });
  });

  describe('show action', () => {
    it('should show no focus when not set', async () => {
      const result = await tool.execute({ action: 'show' });

      expect(result.success).toBe(true);
      expect(result.focused).toBe(false);
      expect(result.message).toContain('No focus');
    });

    it('should show current focus when set', async () => {
      await focusManager.setFocus('.');

      const result = await tool.execute({ action: 'show' });

      expect(result.success).toBe(true);
      expect(result.focused).toBe(true);
      expect(result.focus_path).toBe('.');
    });
  });

  describe('set action', () => {
    it('should set focus to current directory', async () => {
      const result = await tool.execute({ action: 'set', path: '.' });

      expect(result.success).toBe(true);
      expect(result.focus_path).toBe('.');
      expect(focusManager.isFocused()).toBe(true);
    });

    it('should reject missing path parameter', async () => {
      const result = await tool.execute({ action: 'set' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('path parameter is required');
    });

    it('should reject non-existent directory', async () => {
      const result = await tool.execute({ action: 'set', path: 'nonexistent' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not accessible');
    });

    it('should reject absolute paths', async () => {
      const result = await tool.execute({ action: 'set', path: '/tmp' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('must be relative');
    });
  });

  describe('clear action', () => {
    it('should clear focus', async () => {
      await focusManager.setFocus('.');

      const result = await tool.execute({ action: 'clear' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('cleared');
      expect(focusManager.isFocused()).toBe(false);
    });

    it('should succeed even when no focus is set', async () => {
      const result = await tool.execute({ action: 'clear' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('No focus was set');
    });
  });

  describe('validation', () => {
    it('should reject missing action parameter', async () => {
      const result = await tool.execute({});

      expect(result.success).toBe(false);
      expect(result.error).toContain('action parameter is required');
    });

    it('should reject invalid action', async () => {
      const result = await tool.execute({ action: 'invalid' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid action');
    });
  });

  describe('integration', () => {
    it('should support full focus lifecycle', async () => {
      // Show initial state (no focus)
      const show1 = await tool.execute({ action: 'show' });
      expect(show1.success).toBe(true);
      expect(show1.focused).toBe(false);

      // Set focus
      const set = await tool.execute({ action: 'set', path: '.' });
      expect(set.success).toBe(true);

      // Show focus is set
      const show2 = await tool.execute({ action: 'show' });
      expect(show2.success).toBe(true);
      expect(show2.focused).toBe(true);

      // Clear focus
      const clear = await tool.execute({ action: 'clear' });
      expect(clear.success).toBe(true);

      // Verify focus is cleared
      const show3 = await tool.execute({ action: 'show' });
      expect(show3.success).toBe(true);
      expect(show3.focused).toBe(false);
    });
  });
});
