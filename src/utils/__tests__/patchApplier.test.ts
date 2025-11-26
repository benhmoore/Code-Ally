/**
 * Tests for patchApplier - applying unified diffs forward and reverse
 */

import { describe, it, expect } from 'vitest';
import { applyUnifiedDiff, simulatePatchApplication } from '../patchApplier.js';
import { createUnifiedDiff } from '../diffUtils.js';

describe('patchApplier', () => {
  describe('applyUnifiedDiff - forward', () => {
    it('should apply a simple diff forward', () => {
      const original = 'Hello\nWorld\n';
      const modified = 'Hello\nCodeAlly\n';
      const diff = createUnifiedDiff(original, modified, '/test/file.txt');

      const result = applyUnifiedDiff(diff, original, false);

      expect(result.success).toBe(true);
      expect(result.content).toBe(modified);
      expect(result.error).toBeUndefined();
    });

    it('should apply diff for file creation', () => {
      const original = '';
      const modified = 'New content\n';
      const diff = createUnifiedDiff(original, modified, '/test/new.txt');

      const result = applyUnifiedDiff(diff, original, false);

      expect(result.success).toBe(true);
      expect(result.content).toBe(modified);
    });

    it('should apply diff for file deletion', () => {
      const original = 'Old content\n';
      const modified = '';
      const diff = createUnifiedDiff(original, modified, '/test/deleted.txt');

      const result = applyUnifiedDiff(diff, original, false);

      expect(result.success).toBe(true);
      expect(result.content).toBe(modified);
    });

    it('should handle multiline changes', () => {
      const original = 'Line1\nLine2\nLine3\nLine4\nLine5\n';
      const modified = 'Line1\nModified2\nModified3\nLine4\nLine5\n';
      const diff = createUnifiedDiff(original, modified, '/test/multi.txt');

      const result = applyUnifiedDiff(diff, original, false);

      expect(result.success).toBe(true);
      expect(result.content).toBe(modified);
    });

    it('should handle additions at the beginning', () => {
      const original = 'Line2\nLine3\n';
      const modified = 'Line1\nLine2\nLine3\n';
      const diff = createUnifiedDiff(original, modified, '/test/prepend.txt');

      const result = applyUnifiedDiff(diff, original, false);

      expect(result.success).toBe(true);
      expect(result.content).toBe(modified);
    });

    it('should handle additions at the end', () => {
      const original = 'Line1\nLine2\n';
      const modified = 'Line1\nLine2\nLine3\n';
      const diff = createUnifiedDiff(original, modified, '/test/append.txt');

      const result = applyUnifiedDiff(diff, original, false);

      expect(result.success).toBe(true);
      expect(result.content).toBe(modified);
    });

    it('should fail on invalid diff', () => {
      const original = 'Hello\n';
      const invalidDiff = 'Not a valid diff';

      const result = applyUnifiedDiff(invalidDiff, original, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to parse');
    });

    it('should fail when current content does not match diff expectations', () => {
      const original = 'Hello\nWorld\n';
      const modified = 'Hello\nCodeAlly\n';
      const diff = createUnifiedDiff(original, modified, '/test/file.txt');

      // Try to apply to different content
      const wrongContent = 'Different\nContent\n';
      const result = applyUnifiedDiff(diff, wrongContent, false);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to apply patch');
    });
  });

  describe('applyUnifiedDiff - reverse', () => {
    it('should apply a simple diff in reverse', () => {
      const original = 'Hello\nWorld\n';
      const modified = 'Hello\nCodeAlly\n';
      const diff = createUnifiedDiff(original, modified, '/test/file.txt');

      // Apply in reverse to modified content should give original
      const result = applyUnifiedDiff(diff, modified, true);

      expect(result.success).toBe(true);
      expect(result.content).toBe(original);
    });

    it('should reverse file creation (deletion)', () => {
      const original = '';
      const modified = 'New content\n';
      const diff = createUnifiedDiff(original, modified, '/test/new.txt');

      const result = applyUnifiedDiff(diff, modified, true);

      expect(result.success).toBe(true);
      expect(result.content).toBe(original);
    });

    it('should reverse file deletion (creation)', () => {
      const original = 'Old content\n';
      const modified = '';
      const diff = createUnifiedDiff(original, modified, '/test/deleted.txt');

      const result = applyUnifiedDiff(diff, modified, true);

      expect(result.success).toBe(true);
      expect(result.content).toBe(original);
    });

    it('should reverse multiline changes', () => {
      const original = 'Line1\nLine2\nLine3\n';
      const modified = 'Line1\nModified\nLine3\n';
      const diff = createUnifiedDiff(original, modified, '/test/multi.txt');

      const result = applyUnifiedDiff(diff, modified, true);

      expect(result.success).toBe(true);
      expect(result.content).toBe(original);
    });

    it('should fail reverse when content does not match', () => {
      const original = 'Hello\nWorld\n';
      const modified = 'Hello\nCodeAlly\n';
      const diff = createUnifiedDiff(original, modified, '/test/file.txt');

      const wrongContent = 'Different\nContent\n';
      const result = applyUnifiedDiff(diff, wrongContent, true);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('simulatePatchApplication', () => {
    it('should simulate forward application without side effects', () => {
      const original = 'Hello\nWorld\n';
      const modified = 'Hello\nCodeAlly\n';
      const diff = createUnifiedDiff(original, modified, '/test/file.txt');

      const result = simulatePatchApplication(diff, original, false);

      expect(result).toBe(modified);
    });

    it('should simulate reverse application without side effects', () => {
      const original = 'Hello\nWorld\n';
      const modified = 'Hello\nCodeAlly\n';
      const diff = createUnifiedDiff(original, modified, '/test/file.txt');

      const result = simulatePatchApplication(diff, modified, true);

      expect(result).toBe(original);
    });

    it('should return null on simulation failure', () => {
      const original = 'Hello\nWorld\n';
      const modified = 'Hello\nCodeAlly\n';
      const diff = createUnifiedDiff(original, modified, '/test/file.txt');

      const wrongContent = 'Different\nContent\n';
      const result = simulatePatchApplication(diff, wrongContent, false);

      expect(result).toBeNull();
    });

    it('should not modify original content', () => {
      const original = 'Hello\nWorld\n';
      const modified = 'Hello\nCodeAlly\n';
      const diff = createUnifiedDiff(original, modified, '/test/file.txt');

      const originalCopy = original;
      simulatePatchApplication(diff, original, false);

      // Original should be unchanged
      expect(original).toBe(originalCopy);
    });
  });

  describe('round-trip application', () => {
    it('should apply forward then reverse to get original', () => {
      const original = 'Line1\nLine2\nLine3\n';
      const modified = 'Line1\nModified\nLine3\n';
      const diff = createUnifiedDiff(original, modified, '/test/file.txt');

      // Forward application
      const forward = applyUnifiedDiff(diff, original, false);
      expect(forward.success).toBe(true);
      expect(forward.content).toBe(modified);

      // Reverse application
      const reverse = applyUnifiedDiff(diff, forward.content!, true);
      expect(reverse.success).toBe(true);
      expect(reverse.content).toBe(original);
    });

    it('should handle complex multiline round-trip', () => {
      const original = `function test() {
  console.log('Hello');
  return true;
}
`;
      const modified = `function test() {
  console.log('World');
  console.log('Extra line');
  return true;
}
`;
      const diff = createUnifiedDiff(original, modified, '/test/code.js');

      const forward = applyUnifiedDiff(diff, original, false);
      expect(forward.success).toBe(true);

      const reverse = applyUnifiedDiff(diff, forward.content!, true);
      expect(reverse.success).toBe(true);
      expect(reverse.content).toBe(original);
    });

    it('should handle empty file round-trip', () => {
      const original = '';
      const modified = 'New content\n';
      const diff = createUnifiedDiff(original, modified, '/test/new.txt');

      const forward = applyUnifiedDiff(diff, original, false);
      expect(forward.success).toBe(true);

      const reverse = applyUnifiedDiff(diff, forward.content!, true);
      expect(reverse.success).toBe(true);
      expect(reverse.content).toBe(original);
    });
  });

  describe('edge cases', () => {
    it('should handle very large content', () => {
      const original = 'Line\n'.repeat(10000);
      const modified = 'Line\n'.repeat(5000) + 'Modified\n' + 'Line\n'.repeat(4999);
      const diff = createUnifiedDiff(original, modified, '/test/large.txt');

      const result = applyUnifiedDiff(diff, original, false);

      expect(result.success).toBe(true);
      expect(result.content).toBe(modified);
    });

    it('should handle unicode characters', () => {
      const original = 'Hello 世界\n';
      const modified = 'Hello 🌍\n';
      const diff = createUnifiedDiff(original, modified, '/test/unicode.txt');

      const result = applyUnifiedDiff(diff, original, false);

      expect(result.success).toBe(true);
      expect(result.content).toBe(modified);
    });

    it('should handle special characters', () => {
      const original = 'Hello $world\nTest @here\n';
      const modified = 'Hello $world\nTest @there!\n';
      const diff = createUnifiedDiff(original, modified, '/test/special.txt');

      const result = applyUnifiedDiff(diff, original, false);

      expect(result.success).toBe(true);
      expect(result.content).toBe(modified);
    });

    it('should handle trailing newline differences', () => {
      const original = 'Line1\nLine2';
      const modified = 'Line1\nLine2\n';
      const diff = createUnifiedDiff(original, modified, '/test/trailing.txt');

      const result = applyUnifiedDiff(diff, original, false);

      expect(result.success).toBe(true);
      // diffUtils normalizes by adding newlines
      expect(result.content).toBe(modified);
    });

    it('should handle empty lines', () => {
      const original = 'Line1\n\nLine3\n';
      const modified = 'Line1\nLine2\nLine3\n';
      const diff = createUnifiedDiff(original, modified, '/test/empty.txt');

      const result = applyUnifiedDiff(diff, original, false);

      expect(result.success).toBe(true);
      expect(result.content).toBe(modified);
    });
  });
});
