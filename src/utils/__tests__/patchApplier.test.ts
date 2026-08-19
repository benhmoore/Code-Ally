/**
 * Tests for patchApplier - applying unified diffs forward and reverse
 */

import { describe, it, expect } from 'vitest';
import { applyModelPatch, applyUnifiedDiff, simulatePatchApplication } from '../patchApplier.js';
import { createUnifiedDiff } from '../diffUtils.js';

describe('patchApplier', () => {
describe('applyModelPatch', () => {
  it('explains that bare hunk markers are not valid unified-diff headers', () => {
    const result = applyModelPatch('@@\n-old\n+new', 'old\n');

    expect(result.success).toBe(false);
    expect(result.error).toContain('@@ -12,3 +12,4 @@');
    expect(result.error).toContain('bare @@ header is invalid');
  });

  it('reports surviving unique anchors when a hunk context is stale', () => {
    const source = [
      'export function buildAtlas() {',
      '  const canvas = document.createElement("canvas");',
      '  return canvas;',
      '}',
    ].join('\n');
    const result = applyModelPatch(
      '@@ -90,3 +90,3 @@\n export function buildAtlas() {\n-  stale line\n+  replacement\n   return canvas;',
      source
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('current file lines 1, 3');
    expect(result.error).toContain('retry only this hunk');
  });

    it('applies headerless unified hunks and reports their actual source ranges', () => {
      const result = applyModelPatch(
        '@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma',
        'alpha\nbeta\ngamma\n'
      );

      expect(result).toMatchObject({
        success: true,
        content: 'alpha\nBETA\ngamma\n',
        readRanges: [{ start: 1, end: 3 }],
        updatedReadRanges: [{ start: 1, end: 3 }],
        hunkCount: 1,
      });
    });

    it('locates uniquely matching context when a hunk line hint has drifted', () => {
      const result = applyModelPatch(
        '@@ -1,2 +1,2 @@\n target\n-old\n+new',
        'prefix\nprefix2\ntarget\nold\n'
      );

      expect(result.success).toBe(true);
      expect(result.content).toBe('prefix\nprefix2\ntarget\nnew\n');
      expect(result.readRanges).toEqual([{ start: 3, end: 4 }]);
    });

    it('reconciles a consistent indentation drift at a unique target', () => {
      const result = applyModelPatch(
        '@@ -40,1 +40,2 @@\n-            block = 11;\n+            block = 10;\n+            frozen = true;',
        'function generate() {\n             if (snowy) {\n             block = 11;\n}\n'
      );

      expect(result.success).toBe(true);
      expect(result.content).toBe(
        'function generate() {\n             if (snowy) {\n             block = 10;\n             frozen = true;\n}\n'
      );
      expect(result.readRanges).toEqual([{ start: 3, end: 3 }]);
    });

    it('preserves authored indentation when whitespace is the intended change', () => {
      const result = applyModelPatch(
        '@@ -2,1 +2,1 @@\n-      """doc"""\n+    """doc"""',
        'class Parser:\n     """doc"""\n'
      );

      expect(result.success).toBe(true);
      expect(result.content).toBe('class Parser:\n    """doc"""\n');
      expect(result.readRanges).toEqual([{ start: 2, end: 2 }]);
    });

    it('rejects whitespace-only matching when indentation drift is inconsistent', () => {
      const result = applyModelPatch(
        '@@ -1,2 +1,2 @@\n one\n-  two\n+  changed',
        ' one\n    two\n'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('original lines were not found');
    });

    it('derives hunk counts from the body when the model miscounts them', () => {
      const result = applyModelPatch(
        '@@ -8,7 +8,7 @@\n const ATLAS_ROWS = 3;\n\n-function createTextureAtlas() {\n+export function createTextureAtlas() {\n const canvas = document.createElement(\'canvas\');\n canvas.width = 256;',
        'prefix\nconst ATLAS_ROWS = 3;\n\nfunction createTextureAtlas() {\nconst canvas = document.createElement(\'canvas\');\ncanvas.width = 256;\n'
      );

      expect(result.success).toBe(true);
      expect(result.content).toContain('export function createTextureAtlas()');
      expect(result.readRanges).toEqual([{ start: 2, end: 6 }]);
    });

    it('repairs redundant JSON quote escapes only after exact matching fails', () => {
      const result = applyModelPatch(
        '@@ -1,2 +1,2 @@\n-parser.add_argument(\\"--strict\\")\n-print(\\"old\\")\n+parser.add_argument(\\"--strict\\", required=True)\n+print(\\"new\\")',
        'parser.add_argument("--strict")\nprint("old")\n'
      );

      expect(result).toMatchObject({
        success: true,
        content: 'parser.add_argument("--strict", required=True)\nprint("new")\n',
        readRanges: [{ start: 1, end: 2 }],
      });
    });

    it('preserves intentional escaped quotes when the exact patch matches', () => {
      const result = applyModelPatch(
        String.raw`@@ -1,1 +1,1 @@
-const quoted = '\\"old\\"';
+const quoted = '\\"new\\"';`,
        String.raw`const quoted = '\"old\"';` + '\n'
      );

      expect(result.success).toBe(true);
      expect(result.content).toBe(String.raw`const quoted = '\"new\"';` + '\n');
    });

    it('rejects ambiguous context unless the hunk line hint identifies a match', () => {
      const ambiguous = applyModelPatch(
        '@@ -2,1 +2,1 @@\n-same\n+changed',
        'same\nother\nsame\n'
      );
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('match 2 locations');

      const disambiguated = applyModelPatch(
        '@@ -3,1 +3,1 @@\n-same\n+changed',
        'same\nother\nsame\n'
      );
      expect(disambiguated.success).toBe(true);
      expect(disambiguated.content).toBe('same\nother\nchanged\n');
    });

    it('rejects context-free insertion into a non-empty file', () => {
      const result = applyModelPatch('@@ -1,0 +1,1 @@\n+surprise', 'existing\n');
      expect(result.success).toBe(false);
      expect(result.error).toContain('no original-file context');
    });

    it('rejects creation, deletion, multiple file patches, and no-op patches', () => {
      expect(applyModelPatch(
        '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,1 @@\n+new',
        ''
      ).success).toBe(false);
      expect(applyModelPatch(
        '--- a/a\n+++ b/a\n@@ -1,1 +1,1 @@\n-a\n+A\n--- a/b\n+++ b/b\n@@ -1,1 +1,1 @@\n-b\n+B',
        'a\n'
      ).success).toBe(false);
      expect(applyModelPatch('@@ -1,1 +1,1 @@\n same', 'same\n').error).toContain('no changes');
    });
  });

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
