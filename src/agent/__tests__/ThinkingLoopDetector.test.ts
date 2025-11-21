/**
 * Tests for ThinkingLoopDetector
 *
 * Comprehensive test coverage for thinking loop detection including:
 * - Chunk accumulation
 * - Timing and lifecycle management
 * - Reconstruction cycle detection
 * - Repeated question detection
 * - Repeated action detection
 * - Callback and interruption handling
 * - Edge cases and error conditions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ThinkingLoopDetector } from '../ThinkingLoopDetector.js';
import type { ThinkingLoopInfo } from '../ThinkingLoopDetector.js';

describe('ThinkingLoopDetector', () => {
  let detector: ThinkingLoopDetector;
  let mockCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockCallback = vi.fn();
    detector = new ThinkingLoopDetector({
      onLoopDetected: mockCallback,
      instanceId: 'test',
    });
  });

  afterEach(() => {
    detector.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe('Chunk Accumulation', () => {
    it('should accumulate chunks immediately', () => {
      detector.addChunk('First chunk');
      expect(detector.getAccumulatedLength()).toBe(11);

      detector.addChunk(' Second chunk');
      expect(detector.getAccumulatedLength()).toBe(24);
    });

    it('should ignore empty chunks', () => {
      detector.addChunk('');
      expect(detector.getAccumulatedLength()).toBe(0);
    });

    it('should ignore whitespace-only chunks', () => {
      detector.addChunk('   ');
      expect(detector.getAccumulatedLength()).toBe(0);

      detector.addChunk('\n\t  ');
      expect(detector.getAccumulatedLength()).toBe(0);
    });

    it('should accumulate multiple chunks correctly', () => {
      detector.addChunk('Let me think');
      detector.addChunk(' about this');
      detector.addChunk(' problem.');
      expect(detector.getAccumulatedLength()).toBe(32);
    });

    it('should handle chunks with various whitespace', () => {
      detector.addChunk('Valid content');
      expect(detector.getAccumulatedLength()).toBe(13);

      detector.addChunk('   '); // Should be ignored
      expect(detector.getAccumulatedLength()).toBe(13);

      detector.addChunk(' More content');
      expect(detector.getAccumulatedLength()).toBe(26);
    });
  });

  describe('Timing and Lifecycle', () => {
    it('should start monitoring on first chunk', () => {
      expect(detector.isActive()).toBe(false);
      detector.addChunk('First chunk');
      expect(detector.isActive()).toBe(true);
    });

    it('should not check before 20s warmup', () => {
      detector.addChunk('Let me reconsider this. Let me reconsider again.');

      // Advance time by 19 seconds (just before warmup ends)
      vi.advanceTimersByTime(19000);

      // No callback should have been triggered
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should run first check immediately after warmup', () => {
      detector.addChunk('Let me reconsider this. Let me reconsider again.');

      // Advance time by exactly 20 seconds (warmup complete)
      vi.advanceTimersByTime(20000);

      // Callback should have been triggered
      expect(mockCallback).toHaveBeenCalledOnce();
    });

    it('should run subsequent checks every 5s', () => {
      detector.addChunk('Some initial thinking');

      // Complete warmup
      vi.advanceTimersByTime(20000);

      // Add loop pattern
      detector.addChunk('Let me reconsider this. Let me reconsider again.');

      // Advance by 5 seconds
      vi.advanceTimersByTime(5000);

      // Should have detected loop
      expect(mockCallback).toHaveBeenCalled();
    });

    it('should stop and clear all timers', () => {
      detector.addChunk('Test chunk');
      expect(detector.isActive()).toBe(true);

      detector.stop();
      expect(detector.isActive()).toBe(false);

      // Advance time and verify no callbacks
      vi.advanceTimersByTime(30000);
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should reset state and timers', () => {
      detector.addChunk('Test chunk');
      vi.advanceTimersByTime(20000);

      detector.reset();

      expect(detector.isActive()).toBe(false);
      expect(detector.getAccumulatedLength()).toBe(0);
      expect(detector.hasDetected()).toBe(false);
    });

    it('should handle stop during warmup', () => {
      detector.addChunk('Test chunk');

      // Stop during warmup period
      vi.advanceTimersByTime(10000);
      detector.stop();

      // Continue advancing time
      vi.advanceTimersByTime(15000);

      // No callback should have been triggered
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should handle multiple stop calls safely', () => {
      detector.addChunk('Test chunk');
      detector.stop();
      detector.stop();
      detector.stop();

      // Should not throw or cause issues
      expect(detector.isActive()).toBe(false);
    });

    it('should handle reset at any time', () => {
      // Reset before any chunks
      detector.reset();
      expect(detector.getAccumulatedLength()).toBe(0);

      // Reset during warmup
      detector.addChunk('Test');
      vi.advanceTimersByTime(10000);
      detector.reset();
      expect(detector.getAccumulatedLength()).toBe(0);

      // Reset after detection
      detector.addChunk('Reconsider this. Reconsider again.');
      vi.advanceTimersByTime(20000);
      detector.reset();
      expect(detector.hasDetected()).toBe(false);
    });
  });

  describe('Reconstruction Cycle Detection', () => {
    it('should detect "reconsider" patterns (2+ occurrences)', () => {
      detector.addChunk('Let me reconsider this approach. After thinking, I should reconsider the solution.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.reason).toContain('Reconstruction cycle detected');
      expect(callInfo.reconstructionCount).toBeGreaterThanOrEqual(2);
    });

    it('should detect "rethink" patterns', () => {
      detector.addChunk('I need to rethink this completely. Let me rethink the approach.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.reason).toContain('Reconstruction cycle detected');
      expect(callInfo.reconstructionCount).toBeGreaterThanOrEqual(2);
    });

    it('should detect "revisit" patterns', () => {
      detector.addChunk('I should revisit this decision. Time to revisit the plan.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.reason).toContain('Reconstruction cycle detected');
    });

    it('should detect "go back to" patterns', () => {
      detector.addChunk('Let me go back to the original idea. I should go back to plan A.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.reason).toContain('Reconstruction cycle detected');
    });

    it('should be case-insensitive', () => {
      detector.addChunk('RECONSIDER this. Reconsider that. ReCONSider the other.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.reconstructionCount).toBeGreaterThanOrEqual(2);
    });

    it('should NOT trigger below threshold (1 occurrence)', () => {
      detector.addChunk('Let me reconsider this approach once. Then I will proceed.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should detect mixed reconstruction patterns', () => {
      detector.addChunk('Let me reconsider this. Actually, I should rethink it entirely.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.reconstructionCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Repeated Question Detection', () => {
    it('should detect same question asked 3+ times', () => {
      const question = 'What should I do about this problem?';
      detector.addChunk(`${question} ${question} ${question}`);
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.reason).toContain('Repeated questions detected');
      expect(callInfo.repetitionCount).toBeGreaterThanOrEqual(3);
    });

    it('should use similarity threshold (70%)', () => {
      // Use very similar questions with high word overlap
      detector.addChunk(
        'What should I do about the configuration? ' +
        'What should I do about the configuration? ' +
        'What should I do about the configuration?'
      );
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.reason).toContain('Repeated questions');
    });

    it('should filter short questions (< 10 chars)', () => {
      detector.addChunk('Why? Why? Why? Why? Why?');
      vi.advanceTimersByTime(20000);

      // Short questions should be filtered out
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should NOT trigger below threshold (2 occurrences)', () => {
      const question = 'What should I do about this problem?';
      detector.addChunk(`${question} ${question}`);
      vi.advanceTimersByTime(20000);

      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should handle questions with different punctuation', () => {
      detector.addChunk(
        'Should I proceed with this approach? ' +
        'Should I proceed with this approach! ' +
        'Should I proceed with this approach.'
      );
      vi.advanceTimersByTime(20000);

      // Only the first one is a question (ends with ?), so won't trigger
      expect(mockCallback).not.toHaveBeenCalled();
    });
  });

  describe('Repeated Action Detection', () => {
    it('should detect "I will" repeated 3+ times', () => {
      // Actions must be similar enough (70%+ word overlap) and end with punctuation
      detector.addChunk(
        'I will check the database connection. ' +
        'I will check the database connection. ' +
        'I will check the database connection.'
      );
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.reason).toContain('Repeated actions detected');
      expect(callInfo.repetitionCount).toBeGreaterThanOrEqual(3);
    });

    it('should detect "I should" repeated 3+ times', () => {
      // Actions must be similar enough (70%+ word overlap)
      detector.addChunk(
        'I should check the configuration file. ' +
        'I should check the configuration file. ' +
        'I should check the configuration file.'
      );
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.reason).toContain('Repeated actions');
    });

    it('should use similarity threshold (70%)', () => {
      // Use actions with enough word overlap to meet 70% threshold
      detector.addChunk(
        'I will analyze the database connection. ' +
        'I will analyze the database connection. ' +
        'I will analyze the database connection.'
      );
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
    });

    it('should filter short actions (< 15 chars)', () => {
      detector.addChunk('I will go. I will go. I will go. I will go.');
      vi.advanceTimersByTime(20000);

      // Short actions should be filtered out
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should NOT trigger below threshold (2 occurrences)', () => {
      detector.addChunk(
        'I will start with step one. ' +
        'I will begin with the basics.'
      );
      vi.advanceTimersByTime(20000);

      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should detect "let me" action patterns', () => {
      // Use identical "let me" statements for reliable detection
      detector.addChunk(
        'Let me analyze the requirements carefully. ' +
        'Let me analyze the requirements carefully. ' +
        'Let me analyze the requirements carefully.'
      );
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
    });
  });

  describe('Callback and Interruption', () => {
    it('should fire callback when loop detected', () => {
      detector.addChunk('Let me reconsider this. Let me reconsider again.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
    });

    it('should include correct reason in callback', () => {
      detector.addChunk('Let me rethink this. Let me rethink again.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.reason).toContain('Reconstruction cycle detected');
      expect(callInfo.reason).toContain('rethink');
    });

    it('should stop monitoring after detection', () => {
      detector.addChunk('Let me reconsider this. Let me reconsider again.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();

      // Add more loop patterns
      detector.addChunk('Let me reconsider once more. And again.');

      // Advance time for multiple check intervals
      vi.advanceTimersByTime(15000);

      // Should still only be called once (monitoring stopped)
      expect(mockCallback).toHaveBeenCalledOnce();
    });

    it('should NOT fire duplicate callbacks (hasDetectedLoop flag)', () => {
      detector.addChunk('Let me reconsider this. Let me reconsider again.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      expect(detector.hasDetected()).toBe(true);

      // Even if we somehow trigger another check, flag prevents duplicate
      vi.advanceTimersByTime(5000);
      expect(mockCallback).toHaveBeenCalledOnce();
    });

    it('should provide reconstruction count in callback', () => {
      detector.addChunk('Reconsider. Reconsider. Reconsider.');
      vi.advanceTimersByTime(20000);

      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.reconstructionCount).toBeGreaterThanOrEqual(2);
    });

    it('should provide repetition count in callback', () => {
      // Use identical statements to ensure detection
      detector.addChunk(
        'I will start the process now. ' +
        'I will start the process now. ' +
        'I will start the process now.'
      );
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalled();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      expect(callInfo.repetitionCount).toBeGreaterThanOrEqual(3);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very long thinking content', () => {
      // Generate a large chunk (10KB+)
      const largeChunk = 'Let me think about this problem. '.repeat(1000);
      detector.addChunk(largeChunk);

      expect(detector.getAccumulatedLength()).toBeGreaterThan(10000);

      vi.advanceTimersByTime(20000);

      // Should complete without errors or performance issues
      expect(detector.isActive()).toBe(true);
    });

    it('should handle rapid chunk additions', () => {
      // Add many chunks in quick succession
      for (let i = 0; i < 100; i++) {
        detector.addChunk(`Chunk ${i} `);
      }

      expect(detector.getAccumulatedLength()).toBeGreaterThan(0);
      expect(detector.isActive()).toBe(true);
    });

    it('should handle chunks with special characters', () => {
      detector.addChunk('Let me reconsider this! @#$%^&*()');
      detector.addChunk('Let me reconsider again! @#$%^&*()');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
    });

    it('should handle empty accumulated text during check', () => {
      // Start monitoring but don't add meaningful content
      detector.addChunk('x');
      detector.reset();
      detector.addChunk('');

      vi.advanceTimersByTime(20000);

      // Should not crash or throw
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it('should handle mixed loop patterns simultaneously', () => {
      detector.addChunk(
        'Let me reconsider this approach. ' +
        'What should I do about this? ' +
        'I will start over. ' +
        'Let me rethink this completely. ' +
        'What should I do about this? ' +
        'I will start over again. ' +
        'What should I do about this?'
      );
      vi.advanceTimersByTime(20000);

      // Should detect at least one loop type
      expect(mockCallback).toHaveBeenCalled();
    });

    it('should prioritize reconstruction cycles over repetitions', () => {
      detector.addChunk(
        'Let me reconsider. Let me reconsider again. ' +
        'What should I do? What should I do? What should I do?'
      );
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalledOnce();
      const callInfo = mockCallback.mock.calls[0][0] as ThinkingLoopInfo;
      // Reconstruction cycles are checked first
      expect(callInfo.reason).toContain('Reconstruction cycle');
    });

    it('should handle unicode and emoji content', () => {
      detector.addChunk('Let me reconsider 🤔 this approach. 再考してみます。');
      detector.addChunk('Let me reconsider 🤔 again. 再考してみます。');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalled();
    });

    it('should handle newlines and formatting in content', () => {
      detector.addChunk('Let me reconsider\nthis approach.\n\n');
      detector.addChunk('Let me reconsider\nagain.\n');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalled();
    });

    it('should reset properly after detection', () => {
      detector.addChunk('Let me reconsider. Let me reconsider.');
      vi.advanceTimersByTime(20000);
      expect(mockCallback).toHaveBeenCalledOnce();

      // Reset and try again
      detector.reset();
      mockCallback.mockClear();

      detector.addChunk('Let me reconsider. Let me reconsider.');
      vi.advanceTimersByTime(20000);

      // Should detect again
      expect(mockCallback).toHaveBeenCalledOnce();
    });

    it('should handle detection on the boundary of warmup period', () => {
      detector.addChunk('Let me reconsider. Let me reconsider.');

      // Advance to exactly warmup period
      vi.advanceTimersByTime(20000);

      // Should detect immediately
      expect(mockCallback).toHaveBeenCalledOnce();
    });

    it('should handle chunks added after warmup but before first check', () => {
      detector.addChunk('Initial thinking.');

      // Complete warmup
      vi.advanceTimersByTime(20000);

      // No loop yet
      expect(mockCallback).not.toHaveBeenCalled();

      // Add loop pattern after first check
      detector.addChunk('Let me reconsider. Let me reconsider.');

      // Wait for next check interval
      vi.advanceTimersByTime(5000);

      // Should now detect
      expect(mockCallback).toHaveBeenCalled();
    });
  });

  describe('State Management', () => {
    it('should track active state correctly', () => {
      expect(detector.isActive()).toBe(false);

      detector.addChunk('Test');
      expect(detector.isActive()).toBe(true);

      detector.stop();
      expect(detector.isActive()).toBe(false);
    });

    it('should track detection state correctly', () => {
      expect(detector.hasDetected()).toBe(false);

      detector.addChunk('Let me reconsider. Let me reconsider.');
      vi.advanceTimersByTime(20000);

      expect(detector.hasDetected()).toBe(true);
    });

    it('should reset detection state on reset', () => {
      detector.addChunk('Let me reconsider. Let me reconsider.');
      vi.advanceTimersByTime(20000);
      expect(detector.hasDetected()).toBe(true);

      detector.reset();
      expect(detector.hasDetected()).toBe(false);
    });

    it('should maintain accumulated length correctly', () => {
      expect(detector.getAccumulatedLength()).toBe(0);

      detector.addChunk('Test');
      expect(detector.getAccumulatedLength()).toBe(4);

      detector.addChunk(' more');
      expect(detector.getAccumulatedLength()).toBe(9);

      detector.reset();
      expect(detector.getAccumulatedLength()).toBe(0);
    });
  });

  describe('Constructor Options', () => {
    it('should use provided instance ID', () => {
      const customDetector = new ThinkingLoopDetector({
        onLoopDetected: mockCallback,
        instanceId: 'custom-123',
      });

      customDetector.addChunk('Let me reconsider. Let me reconsider.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalled();
      customDetector.stop();
    });

    it('should use default instance ID if not provided', () => {
      const defaultDetector = new ThinkingLoopDetector({
        onLoopDetected: mockCallback,
      });

      defaultDetector.addChunk('Let me reconsider. Let me reconsider.');
      vi.advanceTimersByTime(20000);

      expect(mockCallback).toHaveBeenCalled();
      defaultDetector.stop();
    });

    it('should require onLoopDetected callback', () => {
      const validDetector = new ThinkingLoopDetector({
        onLoopDetected: mockCallback,
      });

      expect(validDetector).toBeDefined();
      validDetector.stop();
    });
  });
});
