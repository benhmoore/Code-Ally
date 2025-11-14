/**
 * Tests for diffUtils - unified diff creation and parsing
 */

import { describe, it, expect } from 'vitest';
import {
  createUnifiedDiff,
  parseUnifiedDiff,
  extractDiffContent,
  createPatchFileContent,
} from '../diffUtils.js';

describe('diffUtils', () => {
  describe('createUnifiedDiff', () => {
    it('should create a unified diff for text changes', () => {
      const original = 'Hello\nWorld\n';
      const modified = 'Hello\nCodeAlly\n';
      const filePath = '/test/file.txt';

      const diff = createUnifiedDiff(original, modified, filePath);

      expect(diff).toContain('--- a/file.txt');
      expect(diff).toContain('+++ b/file.txt');
      expect(diff).toContain('-World');
      expect(diff).toContain('+CodeAlly');
    });

    it('should handle empty original file (file creation)', () => {
      const original = '';
      const modified = 'New content\n';
      const filePath = '/test/new.txt';

      const diff = createUnifiedDiff(original, modified, filePath);

      expect(diff).toContain('--- a/new.txt');
      expect(diff).toContain('+++ b/new.txt');
      expect(diff).toContain('+New content');
    });

    it('should handle empty modified file (file deletion)', () => {
      const original = 'Old content\n';
      const modified = '';
      const filePath = '/test/deleted.txt';

      const diff = createUnifiedDiff(original, modified, filePath);

      expect(diff).toContain('--- a/deleted.txt');
      expect(diff).toContain('+++ b/deleted.txt');
      expect(diff).toContain('-Old content');
    });

    it('should handle both files empty', () => {
      const original = '';
      const modified = '';
      const filePath = '/test/empty.txt';

      const diff = createUnifiedDiff(original, modified, filePath);

      // Should create a valid diff even if both are empty
      expect(diff).toBeDefined();
      expect(diff).toContain('--- a/empty.txt');
      expect(diff).toContain('+++ b/empty.txt');
    });

    it('should normalize trailing newlines consistently', () => {
      const original = 'Line1\nLine2';
      const modified = 'Line1\nLine2\n';
      const filePath = '/test/trailing.txt';

      const diff = createUnifiedDiff(original, modified, filePath);

      // Both should have newlines added
      expect(diff).toBeDefined();
    });

    it('should handle multiline content', () => {
      const original = 'Line1\nLine2\nLine3\nLine4\nLine5\n';
      const modified = 'Line1\nModified2\nLine3\nLine4\nLine5\n';
      const filePath = '/test/multiline.txt';

      const diff = createUnifiedDiff(original, modified, filePath);

      expect(diff).toContain('-Line2');
      expect(diff).toContain('+Modified2');
      // Should include context lines
      expect(diff).toContain('Line1');
      expect(diff).toContain('Line3');
    });

    it('should handle special characters', () => {
      const original = 'Hello $world\n';
      const modified = 'Hello @world!\n';
      const filePath = '/test/special.txt';

      const diff = createUnifiedDiff(original, modified, filePath);

      expect(diff).toContain('-Hello $world');
      expect(diff).toContain('+Hello @world!');
    });

    it('should handle unicode characters', () => {
      const original = 'Hello 世界\n';
      const modified = 'Hello 🌍\n';
      const filePath = '/test/unicode.txt';

      const diff = createUnifiedDiff(original, modified, filePath);

      expect(diff).toContain('-Hello 世界');
      expect(diff).toContain('+Hello 🌍');
    });

    it('should handle very long lines', () => {
      const longLine = 'A'.repeat(10000);
      const original = `${longLine}\n`;
      const modified = `${longLine}B\n`;
      const filePath = '/test/long.txt';

      const diff = createUnifiedDiff(original, modified, filePath);

      expect(diff).toBeDefined();
      expect(diff.length).toBeGreaterThan(0);
    });
  });

  describe('parseUnifiedDiff', () => {
    it('should parse a valid unified diff', () => {
      const diffContent = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 Hello
-World
+CodeAlly
`;

      const parsed = parseUnifiedDiff(diffContent);

      expect(parsed).toBeDefined();
      expect(parsed?.oldFileName).toBe('a/file.txt');
      expect(parsed?.newFileName).toBe('b/file.txt');
      expect(parsed?.hunks).toBeDefined();
      expect(parsed?.hunks.length).toBeGreaterThan(0);
    });

    it('should return null for invalid diff', () => {
      const invalidDiff = 'This is not a valid diff';

      const parsed = parseUnifiedDiff(invalidDiff);

      expect(parsed).toBeNull();
    });

    it('should return null for empty diff', () => {
      const emptyDiff = '';

      const parsed = parseUnifiedDiff(emptyDiff);

      expect(parsed).toBeNull();
    });

    it('should parse diff with multiple hunks', () => {
      const diffContent = `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 Line1
-Line2
+Modified2
 Line3
@@ -10,3 +10,3 @@
 Line10
-Line11
+Modified11
 Line12
`;

      const parsed = parseUnifiedDiff(diffContent);

      expect(parsed).toBeDefined();
      expect(parsed?.hunks.length).toBe(2);
    });
  });

  describe('extractDiffContent', () => {
    it('should extract diff from patch file with metadata', () => {
      const patchContent = `# Code Ally Patch File
# Operation: edit
# File: /test/file.txt
# Timestamp: 2025-01-01T00:00:00.000Z
#
# To apply this patch in reverse: patch -R -p1 < this_file
#
===================================================================
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 Hello
-World
+CodeAlly
`;

      const extracted = extractDiffContent(patchContent);

      expect(extracted).not.toContain('# Code Ally Patch File');
      expect(extracted).not.toContain('# Operation:');
      expect(extracted).toContain('--- a/file.txt');
      expect(extracted).toContain('+++ b/file.txt');
    });

    it('should handle patch file without metadata', () => {
      const patchContent = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 Hello
-World
+CodeAlly
`;

      const extracted = extractDiffContent(patchContent);

      expect(extracted).toBe(patchContent);
    });

    it('should handle empty content', () => {
      const patchContent = '';

      const extracted = extractDiffContent(patchContent);

      expect(extracted).toBe('');
    });
  });

  describe('createPatchFileContent', () => {
    it('should create patch file with metadata and diff', () => {
      const operationType = 'edit';
      const filePath = '/test/file.txt';
      const timestamp = '2025-01-01T00:00:00.000Z';
      const diffContent = `--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 Hello
-World
+CodeAlly
`;

      const patchContent = createPatchFileContent(
        operationType,
        filePath,
        timestamp,
        diffContent
      );

      expect(patchContent).toContain('# Code Ally Patch File');
      expect(patchContent).toContain('# Operation: edit');
      expect(patchContent).toContain(`# File: ${filePath}`);
      expect(patchContent).toContain(`# Timestamp: ${timestamp}`);
      expect(patchContent).toContain('===================================================================');
      expect(patchContent).toContain(diffContent);
    });

    it('should handle different operation types', () => {
      const operationTypes = ['write', 'edit', 'line-edit', 'delete'];

      operationTypes.forEach((opType) => {
        const patchContent = createPatchFileContent(
          opType,
          '/test/file.txt',
          '2025-01-01T00:00:00.000Z',
          '--- a/test\n+++ b/test\n'
        );

        expect(patchContent).toContain(`# Operation: ${opType}`);
      });
    });
  });

  describe('round-trip consistency', () => {
    it('should create and parse diff consistently', () => {
      const original = 'Line1\nLine2\nLine3\n';
      const modified = 'Line1\nModified\nLine3\n';
      const filePath = '/test/roundtrip.txt';

      // Create diff
      const diff = createUnifiedDiff(original, modified, filePath);

      // Parse it back
      const parsed = parseUnifiedDiff(diff);

      expect(parsed).toBeDefined();
      expect(parsed?.hunks.length).toBeGreaterThan(0);
    });

    it('should create patch file and extract diff consistently', () => {
      const operationType = 'edit';
      const filePath = '/test/file.txt';
      const timestamp = '2025-01-01T00:00:00.000Z';
      const diffContent = '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n';

      // Create patch file
      const patchContent = createPatchFileContent(
        operationType,
        filePath,
        timestamp,
        diffContent
      );

      // Extract diff
      const extracted = extractDiffContent(patchContent);

      // Should match original diff
      expect(extracted).toBe(diffContent);
    });
  });
});
