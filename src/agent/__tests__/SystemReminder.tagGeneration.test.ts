/**
 * Tests for System Reminder Tag Generation Patterns
 *
 * NOTE: These tests validate the tag generation logic and format, not the actual
 * injectSystemReminder helper in ToolOrchestrator.ts (which is a closure with side effects).
 * The actual helper behavior is tested through integration tests in SystemReminders.integration.test.ts.
 *
 * This test suite focuses on:
 * - Correct tag format generation (with and without persist attribute)
 * - Proper escaping and encoding
 * - Multiple tag accumulation
 * - Integration with cleanup mechanism
 */

import { describe, it, expect } from 'vitest';

describe('System Reminder Tag Generation', () => {
  /**
   * Pure function implementation for testing tag generation patterns
   * Simulates the tag generation logic from ToolOrchestrator.ts (lines 854-858)
   * but as a pure function for easier testing
   */
  function generateSystemReminderTag(resultStr: string, reminder: string, persist: boolean = false): string {
    const persistAttr = persist ? ' persist="true"' : '';
    const injectedStr = `${resultStr}\n\n<system-reminder${persistAttr}>${reminder}</system-reminder>`;
    return injectedStr;
  }

  describe('Basic tag generation', () => {
    it('should generate ephemeral tag when persist=false', () => {
      const result = generateSystemReminderTag('Success', 'Check the logs', false);

      expect(result).toBe('Success\n\n<system-reminder>Check the logs</system-reminder>');
      expect(result).not.toContain('persist=');
    });

    it('should generate ephemeral tag when persist is omitted (default)', () => {
      const result = generateSystemReminderTag('Success', 'Note this');

      expect(result).toBe('Success\n\n<system-reminder>Note this</system-reminder>');
      expect(result).not.toContain('persist=');
    });

    it('should generate persistent tag when persist=true', () => {
      const result = generateSystemReminderTag('Success', 'Important context', true);

      expect(result).toBe('Success\n\n<system-reminder persist="true">Important context</system-reminder>');
      expect(result).toContain('persist="true"');
    });
  });

  describe('Content handling', () => {
    it('should append tag to existing content', () => {
      const existingContent = 'Operation completed successfully';
      const result = generateSystemReminderTag(existingContent, 'Remember to verify', false);

      expect(result).toContain('Operation completed successfully');
      expect(result).toContain('<system-reminder>Remember to verify</system-reminder>');
    });

    it('should handle empty initial content', () => {
      const result = generateSystemReminderTag('', 'Just a reminder', false);

      expect(result).toBe('\n\n<system-reminder>Just a reminder</system-reminder>');
    });

    it('should handle multiline content', () => {
      const content = 'Line 1\nLine 2\nLine 3';
      const result = generateSystemReminderTag(content, 'Note about lines', false);

      expect(result).toContain('Line 1\nLine 2\nLine 3');
      expect(result).toContain('<system-reminder>Note about lines</system-reminder>');
    });

    it('should handle special characters in reminder', () => {
      const reminder = 'Use <code>foo()</code> instead of "bar" & \'baz\'';
      const result = generateSystemReminderTag('Success', reminder, false);

      expect(result).toContain(reminder);
      expect(result).toBe(`Success\n\n<system-reminder>${reminder}</system-reminder>`);
    });
  });

  describe('Multiple injections', () => {
    it('should accumulate correctly when called multiple times', () => {
      let result = 'Initial output';
      result = generateSystemReminderTag(result, 'First reminder', false);
      result = generateSystemReminderTag(result, 'Second reminder', true);
      result = generateSystemReminderTag(result, 'Third reminder', false);

      expect(result).toContain('Initial output');
      expect(result).toContain('<system-reminder>First reminder</system-reminder>');
      expect(result).toContain('<system-reminder persist="true">Second reminder</system-reminder>');
      expect(result).toContain('<system-reminder>Third reminder</system-reminder>');
    });

    it('should maintain proper spacing with multiple calls', () => {
      let result = 'Output';
      result = generateSystemReminderTag(result, 'Note 1', false);
      result = generateSystemReminderTag(result, 'Note 2', false);

      // Each call adds \n\n before the tag
      const expectedPattern = /Output\n\n<system-reminder>Note 1<\/system-reminder>\n\n<system-reminder>Note 2<\/system-reminder>/;
      expect(result).toMatch(expectedPattern);
    });
  });

  describe('Realistic tool result scenarios', () => {
    it('should work with bash tool output', () => {
      let bashOutput = '$ ls\nfile1.ts\nfile2.ts\nfile3.ts';
      bashOutput = generateSystemReminderTag(
        bashOutput,
        'You\'ve called bash 3 times with similar commands. Consider consolidating.',
        false
      );

      expect(bashOutput).toContain('$ ls');
      expect(bashOutput).toContain('file1.ts');
      expect(bashOutput).toContain('<system-reminder>You\'ve called bash 3 times');
    });

    it('should work with agent tool output', () => {
      let agentOutput = '{"success": true, "message": "Analysis complete"}';
      agentOutput = generateSystemReminderTag(
        agentOutput,
        'This agent is a code analyzer created for: "find bugs"',
        true
      );

      expect(agentOutput).toContain('"success": true');
      expect(agentOutput).toContain('<system-reminder persist="true">This agent is a code analyzer');
    });

    it('should work with read tool output', () => {
      let readOutput = '   1→function test() {\n   2→  return true;\n   3→}';
      readOutput = generateSystemReminderTag(
        readOutput,
        'File has been truncated to 1000 lines',
        false
      );

      expect(readOutput).toContain('function test()');
      expect(readOutput).toContain('<system-reminder>File has been truncated');
    });

    it('should work with grep tool output', () => {
      let grepOutput = 'src/utils/helper.ts:42:  const result = foo();\nsrc/main.ts:17:  const result = bar();';
      grepOutput = generateSystemReminderTag(
        grepOutput,
        'Found 2 matches across 2 files',
        false
      );

      expect(grepOutput).toContain('src/utils/helper.ts:42');
      expect(grepOutput).toContain('<system-reminder>Found 2 matches');
    });
  });

  describe('Whitespace and formatting', () => {
    it('should always add two newlines before tag', () => {
      const result = generateSystemReminderTag('Content', 'Note', false);

      expect(result).toMatch(/Content\n\n<system-reminder>/);
    });

    it('should preserve existing trailing whitespace in content', () => {
      const contentWithTrailing = 'Output\n\n';
      const result = generateSystemReminderTag(contentWithTrailing, 'Note', false);

      expect(result).toBe('Output\n\n\n\n<system-reminder>Note</system-reminder>');
    });

    it('should not add extra whitespace inside tags', () => {
      const result = generateSystemReminderTag('Content', 'Note', true);

      expect(result).toBe('Content\n\n<system-reminder persist="true">Note</system-reminder>');
      // No extra spaces around persist="true" or inside tag
    });
  });

  describe('Persist attribute format', () => {
    it('should use exact format persist="true" (lowercase, double quotes)', () => {
      const result = generateSystemReminderTag('Content', 'Note', true);

      expect(result).toContain('persist="true"');
      expect(result).not.toContain('persist="TRUE"');
      expect(result).not.toContain("persist='true'");
      expect(result).not.toContain('persist=true');
    });

    it('should not add persist attribute when false', () => {
      const result = generateSystemReminderTag('Content', 'Note', false);

      expect(result).not.toContain('persist');
      expect(result).toMatch(/<system-reminder>Note<\/system-reminder>$/);
    });

    it('should add persist attribute before closing bracket', () => {
      const result = generateSystemReminderTag('Content', 'Note', true);

      // Should be: <system-reminder persist="true">
      // Not: <system-reminder>persist="true"
      expect(result).toMatch(/<system-reminder persist="true">/);
    });
  });

  describe('Edge cases', () => {
    it('should handle reminder with newlines', () => {
      const multilineReminder = 'Line 1\nLine 2\nLine 3';
      const result = generateSystemReminderTag('Content', multilineReminder, false);

      expect(result).toBe(`Content\n\n<system-reminder>${multilineReminder}</system-reminder>`);
    });

    it('should handle very long reminders', () => {
      const longReminder = 'A'.repeat(1000);
      const result = generateSystemReminderTag('Content', longReminder, false);

      expect(result).toContain(longReminder);
      expect(result.length).toBeGreaterThan(1000);
    });

    it('should handle Unicode characters in reminder', () => {
      const unicodeReminder = 'Note: Use → instead of => for better results 🎯';
      const result = generateSystemReminderTag('Content', unicodeReminder, false);

      expect(result).toContain('🎯');
      expect(result).toContain('→');
    });

    it('should handle reminder that looks like XML/HTML', () => {
      const xmlReminder = '<note type="warning">Check <value>foo</value></note>';
      const result = generateSystemReminderTag('Content', xmlReminder, false);

      expect(result).toBe(`Content\n\n<system-reminder>${xmlReminder}</system-reminder>`);
    });
  });

  describe('Type coercion edge cases', () => {
    it('should handle persist as truthy non-boolean', () => {
      // TypeScript would normally catch this, but test runtime behavior
      const result = generateSystemReminderTag('Content', 'Note', 1 as any);

      expect(result).toContain('persist="true"');
    });

    it('should handle persist as falsy non-boolean', () => {
      const result = generateSystemReminderTag('Content', 'Note', 0 as any);

      expect(result).not.toContain('persist');
    });

    it('should handle persist as undefined (default behavior)', () => {
      const result = generateSystemReminderTag('Content', 'Note', undefined);

      expect(result).not.toContain('persist');
    });
  });

  describe('Return value composition', () => {
    it('should return a string', () => {
      const result = generateSystemReminderTag('Content', 'Note', false);

      expect(typeof result).toBe('string');
    });

    it('should not mutate input strings', () => {
      const originalContent = 'Immutable content';
      const originalReminder = 'Immutable reminder';

      generateSystemReminderTag(originalContent, originalReminder, false);

      expect(originalContent).toBe('Immutable content');
      expect(originalReminder).toBe('Immutable reminder');
    });

    it('should be pure (same inputs produce same output)', () => {
      const result1 = generateSystemReminderTag('Content', 'Note', true);
      const result2 = generateSystemReminderTag('Content', 'Note', true);

      expect(result1).toBe(result2);
    });
  });

  describe('Integration with cleanup process', () => {
    it('should generate tags that can be parsed by removeEphemeralSystemReminders', () => {
      // Generate an ephemeral tag
      const ephemeralResult = generateSystemReminderTag('Output', 'Ephemeral note', false);

      // Verify the regex from removeEphemeralSystemReminders would match it
      const ephemeralRegex = /<system-reminder(?![^>]*persist\s*=\s*["']true["'])[^>]*>.*?<\/system-reminder>/gis;
      expect(ephemeralRegex.test(ephemeralResult)).toBe(true);
    });

    it('should generate tags that are preserved by removeEphemeralSystemReminders', () => {
      // Generate a persistent tag
      const persistentResult = generateSystemReminderTag('Output', 'Persistent note', true);

      // Verify the regex from removeEphemeralSystemReminders would NOT match it
      const ephemeralRegex = /<system-reminder(?![^>]*persist\s*=\s*["']true["'])[^>]*>.*?<\/system-reminder>/gis;
      expect(ephemeralRegex.test(persistentResult)).toBe(false);
    });
  });
});
