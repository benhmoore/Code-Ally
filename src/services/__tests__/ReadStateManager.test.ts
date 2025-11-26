/**
 * ReadStateManager unit tests
 *
 * Tests line-level read state tracking, validation, and invalidation
 * after edits that shift line numbers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ReadStateManager } from '../ReadStateManager.js';

describe('ReadStateManager', () => {
  let manager: ReadStateManager;
  const testFile = '/path/to/test.ts';
  const otherFile = '/path/to/other.ts';

  beforeEach(() => {
    manager = new ReadStateManager();
  });

  describe('trackRead', () => {
    it('should track a single range', () => {
      manager.trackRead(testFile, 1, 10);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 1, end: 10 }]);
    });

    it('should merge overlapping ranges', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 5, 15);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 1, end: 15 }]);
    });

    it('should merge adjacent ranges', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 11, 20);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 1, end: 20 }]);
    });

    it('should keep separate non-overlapping ranges', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 20, 30);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([
        { start: 1, end: 10 },
        { start: 20, end: 30 },
      ]);
    });

    it('should merge multiple ranges when adding overlapping range', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 20, 30);
      manager.trackRead(testFile, 5, 25);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 1, end: 30 }]);
    });

    it('should throw error for startLine < 1', () => {
      expect(() => {
        manager.trackRead(testFile, 0, 10);
      }).toThrow('Invalid start line 0');
      expect(() => {
        manager.trackRead(testFile, 0, 10);
      }).toThrow('Line numbers must be >= 1');

      const state = manager.getReadState(testFile);
      expect(state).toBeNull();
    });

    it('should throw error for endLine < startLine', () => {
      expect(() => {
        manager.trackRead(testFile, 10, 5);
      }).toThrow('Invalid line range');
      expect(() => {
        manager.trackRead(testFile, 10, 5);
      }).toThrow('end line 5 is before start line 10');

      const state = manager.getReadState(testFile);
      expect(state).toBeNull();
    });

    it('should track single line range', () => {
      manager.trackRead(testFile, 5, 5);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 5, end: 5 }]);
    });

    it('should merge single line with adjacent range', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 11, 11);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 1, end: 11 }]);
    });

    it('should keep separate states for different files', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(otherFile, 20, 30);

      const state1 = manager.getReadState(testFile);
      const state2 = manager.getReadState(otherFile);

      expect(state1).toEqual([{ start: 1, end: 10 }]);
      expect(state2).toEqual([{ start: 20, end: 30 }]);
    });

    it('should insert range at beginning', () => {
      manager.trackRead(testFile, 20, 30);
      manager.trackRead(testFile, 1, 10);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([
        { start: 1, end: 10 },
        { start: 20, end: 30 },
      ]);
    });

    it('should insert range in middle', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 30, 40);
      manager.trackRead(testFile, 15, 20);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([
        { start: 1, end: 10 },
        { start: 15, end: 20 },
        { start: 30, end: 40 },
      ]);
    });

    it('should handle range that encompasses existing ranges', () => {
      manager.trackRead(testFile, 5, 10);
      manager.trackRead(testFile, 15, 20);
      manager.trackRead(testFile, 25, 30);
      manager.trackRead(testFile, 1, 35);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 1, end: 35 }]);
    });
  });

  describe('validateLinesRead', () => {
    it('should succeed when all lines have been read', () => {
      manager.trackRead(testFile, 1, 100);

      const result = manager.validateLinesRead(testFile, 10, 20);
      expect(result.success).toBe(true);
      expect(result.message).toBe('All lines have been read');
      expect(result.missingRanges).toBeUndefined();
    });

    it('should fail when file has not been read at all', () => {
      const result = manager.validateLinesRead(testFile, 1, 10);

      expect(result.success).toBe(false);
      expect(result.message).toContain('File has not been read');
      expect(result.missingRanges).toBe('1-10');
    });

    it('should fail when lines are partially read - gap at start', () => {
      manager.trackRead(testFile, 10, 20);

      const result = manager.validateLinesRead(testFile, 1, 20);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Lines not read');
      expect(result.missingRanges).toBe('1-9');
    });

    it('should fail when lines are partially read - gap at end', () => {
      manager.trackRead(testFile, 1, 10);

      const result = manager.validateLinesRead(testFile, 1, 20);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Lines not read');
      expect(result.missingRanges).toBe('11-20');
    });

    it('should fail when lines are partially read - gap in middle', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 20, 30);

      const result = manager.validateLinesRead(testFile, 1, 30);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Lines not read');
      expect(result.missingRanges).toBe('11-19');
    });

    it('should report multiple missing ranges', () => {
      manager.trackRead(testFile, 10, 20);

      const result = manager.validateLinesRead(testFile, 1, 30);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Lines not read');
      expect(result.missingRanges).toBe('1-9, 21-30');
    });

    it('should handle single line validation - success', () => {
      manager.trackRead(testFile, 1, 100);

      const result = manager.validateLinesRead(testFile, 50, 50);

      expect(result.success).toBe(true);
    });

    it('should handle single line validation - failure', () => {
      manager.trackRead(testFile, 1, 49);
      manager.trackRead(testFile, 51, 100);

      const result = manager.validateLinesRead(testFile, 50, 50);

      expect(result.success).toBe(false);
      expect(result.missingRanges).toBe('50');
    });

    it('should succeed for range exactly matching read range', () => {
      manager.trackRead(testFile, 10, 20);

      const result = manager.validateLinesRead(testFile, 10, 20);

      expect(result.success).toBe(true);
    });

    it('should succeed when multiple ranges cover requested range', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 11, 20);
      manager.trackRead(testFile, 21, 30);

      const result = manager.validateLinesRead(testFile, 5, 25);

      expect(result.success).toBe(true);
    });

    it('should report gap between ranges correctly', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 15, 20);
      manager.trackRead(testFile, 25, 30);

      const result = manager.validateLinesRead(testFile, 1, 30);

      expect(result.success).toBe(false);
      expect(result.missingRanges).toBe('11-14, 21-24');
    });

    it('should handle validation entirely before any read ranges', () => {
      manager.trackRead(testFile, 50, 100);

      const result = manager.validateLinesRead(testFile, 1, 10);

      expect(result.success).toBe(false);
      expect(result.missingRanges).toBe('1-10');
    });

    it('should handle validation entirely after all read ranges', () => {
      manager.trackRead(testFile, 1, 50);

      const result = manager.validateLinesRead(testFile, 100, 110);

      expect(result.success).toBe(false);
      expect(result.missingRanges).toBe('100-110');
    });
  });

  describe('invalidateAfterEdit', () => {
    it('should keep ranges entirely before edit line', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 20, 30);

      manager.invalidateAfterEdit(testFile, 50, 5);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([
        { start: 1, end: 10 },
        { start: 20, end: 30 },
      ]);
    });

    it('should truncate range that includes edit line', () => {
      manager.trackRead(testFile, 1, 50);

      manager.invalidateAfterEdit(testFile, 30, 5);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 1, end: 29 }]);
    });

    it('should remove ranges at or after edit line', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 30, 40);
      manager.trackRead(testFile, 50, 60);

      manager.invalidateAfterEdit(testFile, 30, 5);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 1, end: 10 }]);
    });

    it('should remove file state if all ranges invalidated', () => {
      manager.trackRead(testFile, 30, 40);
      manager.trackRead(testFile, 50, 60);

      manager.invalidateAfterEdit(testFile, 20, 5);

      const state = manager.getReadState(testFile);
      expect(state).toBeNull();
    });

    it('should do nothing if lineDelta is 0', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 20, 30);

      manager.invalidateAfterEdit(testFile, 15, 0);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([
        { start: 1, end: 10 },
        { start: 20, end: 30 },
      ]);
    });

    it('should handle negative lineDelta (lines removed)', () => {
      manager.trackRead(testFile, 1, 100);

      manager.invalidateAfterEdit(testFile, 50, -10);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 1, end: 49 }]);
    });

    it('should do nothing if file has no read state', () => {
      manager.invalidateAfterEdit(testFile, 10, 5);

      const state = manager.getReadState(testFile);
      expect(state).toBeNull();
    });

    it('should handle edit at line 1', () => {
      manager.trackRead(testFile, 1, 100);

      manager.invalidateAfterEdit(testFile, 1, 5);

      const state = manager.getReadState(testFile);
      expect(state).toBeNull();
    });

    it('should keep range ending exactly before edit line', () => {
      manager.trackRead(testFile, 1, 29);
      manager.trackRead(testFile, 30, 40);

      manager.invalidateAfterEdit(testFile, 30, 5);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 1, end: 29 }]);
    });

    it('should handle multiple ranges with mixed invalidation', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 15, 25);
      manager.trackRead(testFile, 30, 40);
      manager.trackRead(testFile, 50, 60);

      manager.invalidateAfterEdit(testFile, 20, 3);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([
        { start: 1, end: 10 },
        { start: 15, end: 19 },
      ]);
    });

    it('should not affect other files', () => {
      manager.trackRead(testFile, 1, 100);
      manager.trackRead(otherFile, 1, 100);

      manager.invalidateAfterEdit(testFile, 50, 5);

      const state1 = manager.getReadState(testFile);
      const state2 = manager.getReadState(otherFile);

      expect(state1).toEqual([{ start: 1, end: 49 }]);
      expect(state2).toEqual([{ start: 1, end: 100 }]);
    });
  });

  describe('clearFile', () => {
    it('should remove all read state for a file', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 20, 30);

      manager.clearFile(testFile);

      const state = manager.getReadState(testFile);
      expect(state).toBeNull();
    });

    it('should not affect other files', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(otherFile, 20, 30);

      manager.clearFile(testFile);

      const state1 = manager.getReadState(testFile);
      const state2 = manager.getReadState(otherFile);

      expect(state1).toBeNull();
      expect(state2).toEqual([{ start: 20, end: 30 }]);
    });

    it('should do nothing if file has no read state', () => {
      manager.clearFile(testFile);

      const state = manager.getReadState(testFile);
      expect(state).toBeNull();
    });
  });

  describe('reset', () => {
    it('should clear all read state for all files', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(otherFile, 20, 30);

      manager.reset();

      const state1 = manager.getReadState(testFile);
      const state2 = manager.getReadState(otherFile);

      expect(state1).toBeNull();
      expect(state2).toBeNull();
    });

    it('should allow tracking new reads after reset', () => {
      manager.trackRead(testFile, 1, 10);
      manager.reset();
      manager.trackRead(testFile, 20, 30);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 20, end: 30 }]);
    });
  });

  describe('getReadState', () => {
    it('should return read ranges for tracked file', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 20, 30);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([
        { start: 1, end: 10 },
        { start: 20, end: 30 },
      ]);
    });

    it('should return null for untracked file', () => {
      const state = manager.getReadState(testFile);
      expect(state).toBeNull();
    });

    it('should return a copy of the ranges array', () => {
      manager.trackRead(testFile, 1, 10);

      const state1 = manager.getReadState(testFile);
      const state2 = manager.getReadState(testFile);

      expect(state1).not.toBe(state2);
      expect(state1).toEqual(state2);
    });

    it('should not allow modification of internal state', () => {
      manager.trackRead(testFile, 1, 10);

      const state = manager.getReadState(testFile);
      state?.push({ start: 20, end: 30 });

      const actualState = manager.getReadState(testFile);
      expect(actualState).toEqual([{ start: 1, end: 10 }]);
    });
  });

  describe('edge cases and complex scenarios', () => {
    it('should throw with clear error message for negative line numbers', () => {
      expect(() => {
        manager.trackRead(testFile, -1, 10);
      }).toThrow('Invalid start line -1');
      expect(() => {
        manager.trackRead(testFile, -1, 10);
      }).toThrow('Line numbers must be >= 1');
    });

    it('should throw with clear error for endLine < startLine', () => {
      expect(() => {
        manager.trackRead(testFile, 100, 50);
      }).toThrow('Invalid line range');
      expect(() => {
        manager.trackRead(testFile, 100, 50);
      }).toThrow('end line 50 is before start line 100');
    });

    it('should handle large line numbers', () => {
      manager.trackRead(testFile, 1000000, 2000000);

      const result = manager.validateLinesRead(testFile, 1500000, 1500100);
      expect(result.success).toBe(true);
    });

    it('should handle many small ranges', () => {
      for (let i = 0; i < 100; i++) {
        manager.trackRead(testFile, i * 10 + 1, i * 10 + 5);
      }

      const state = manager.getReadState(testFile);
      expect(state).toHaveLength(100);
    });

    it('should merge many small ranges into one', () => {
      for (let i = 1; i <= 100; i++) {
        manager.trackRead(testFile, i, i);
      }

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 1, end: 100 }]);
    });

    it('should handle repeated reads of same range', () => {
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 1, 10);

      const state = manager.getReadState(testFile);
      expect(state).toEqual([{ start: 1, end: 10 }]);
    });

    it('should handle complex invalidation scenario', () => {
      // Track many ranges
      manager.trackRead(testFile, 1, 10);
      manager.trackRead(testFile, 20, 30);
      manager.trackRead(testFile, 40, 50);
      manager.trackRead(testFile, 60, 70);
      manager.trackRead(testFile, 80, 90);

      // Edit in middle
      manager.invalidateAfterEdit(testFile, 45, 10);

      // Should keep ranges before 45, truncate range including 45
      const state = manager.getReadState(testFile);
      expect(state).toEqual([
        { start: 1, end: 10 },
        { start: 20, end: 30 },
        { start: 40, end: 44 },
      ]);
    });

    it('should handle validation with many gaps', () => {
      manager.trackRead(testFile, 1, 5);
      manager.trackRead(testFile, 10, 15);
      manager.trackRead(testFile, 20, 25);
      manager.trackRead(testFile, 30, 35);

      const result = manager.validateLinesRead(testFile, 1, 35);

      expect(result.success).toBe(false);
      expect(result.missingRanges).toBe('6-9, 16-19, 26-29');
    });
  });
});
