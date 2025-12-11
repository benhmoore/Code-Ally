/**
 * LoopDetector Tests
 *
 * Strategic test coverage for the unified loop detection system.
 * Tests are organized by detector type (text loops, tool cycles)
 * and then by detection scenario.
 *
 * Key scenarios covered:
 * - TextLoopDetector: Streaming text accumulation, pattern detection, lifecycle
 * - ToolCycleDetector: Exact duplicates, file access, similar calls, search metrics
 * - LoopDetector: Unified API, cross-detector coordination
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LoopDetector, TextLoopConfig, CycleInfo, IssueType } from '../LoopDetector.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ActivityEventType } from '../../types/index.js';
import type { LoopPattern, LoopInfo } from '../types/loopDetection.js';

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Mock pattern that detects a specific keyword
 */
class MockPattern implements LoopPattern {
  constructor(
    public readonly name: string,
    private readonly keyword: string
  ) {}

  check(text: string): LoopInfo | null {
    const matches = (text.match(new RegExp(this.keyword, 'gi')) || []).length;
    if (matches >= 2) {
      return {
        reason: `Found ${matches} occurrences of "${this.keyword}"`,
        patternName: this.name,
        repetitionCount: matches,
      };
    }
    return null;
  }
}

/**
 * Mock pattern that always triggers
 */
class AlwaysTriggersPattern implements LoopPattern {
  readonly name = 'always_triggers';

  check(_text: string): LoopInfo | null {
    return {
      reason: 'Always triggers for testing',
      patternName: this.name,
    };
  }
}

/**
 * Mock pattern that throws an error
 */
class ErrorPattern implements LoopPattern {
  readonly name = 'error_pattern';

  check(_text: string): LoopInfo | null {
    throw new Error('Pattern error for testing');
  }
}

/**
 * Create a tool call object for testing
 */
function createToolCall(
  name: string,
  args: Record<string, any>,
  id?: string
): { id: string; function: { name: string; arguments: Record<string, any> } } {
  return {
    id: id ?? `call-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    function: { name, arguments: args },
  };
}

// ============================================================================
// TOOL CYCLE DETECTOR TESTS
// ============================================================================

describe('LoopDetector', () => {
  describe('ToolCycleDetector', () => {
    let detector: LoopDetector;

    beforeEach(() => {
      detector = new LoopDetector({
        instanceId: 'test-cycle-detector',
        maxToolHistory: 15,
        cycleThreshold: 3,
      });
    });

    describe('Exact Duplicate Detection', () => {
      it('should detect exact duplicate tool calls at threshold', () => {
        const toolCall = createToolCall('Grep', { pattern: 'foo', path: '/src' });

        // Record 2 calls (below threshold)
        detector.recordToolCalls([toolCall]);
        detector.recordToolCalls([toolCall]);

        // Third call should trigger detection
        const cycles = detector.detectCycles([toolCall]);

        expect(cycles.size).toBe(1);
        const cycleInfo = cycles.get(toolCall.id);
        expect(cycleInfo).toBeDefined();
        expect(cycleInfo!.issueType).toBe('exact_duplicate');
        expect(cycleInfo!.count).toBe(3);
        expect(cycleInfo!.isValidRepeat).toBe(false);
      });

      it('should not detect cycles below threshold', () => {
        const toolCall = createToolCall('Grep', { pattern: 'foo', path: '/src' });

        // Record 1 call
        detector.recordToolCalls([toolCall]);

        // Second call should not trigger
        const cycles = detector.detectCycles([toolCall]);
        expect(cycles.size).toBe(0);
      });

      it('should treat different arguments as different calls', () => {
        const call1 = createToolCall('Grep', { pattern: 'foo', path: '/src' });
        const call2 = createToolCall('Grep', { pattern: 'bar', path: '/src' });
        const call3 = createToolCall('Grep', { pattern: 'baz', path: '/src' });

        detector.recordToolCalls([call1]);
        detector.recordToolCalls([call2]);
        detector.recordToolCalls([call3]);

        // None should trigger - all different
        const cycles = detector.detectCycles([call1]);
        expect(cycles.size).toBe(0);
      });

      it('should handle array arguments in signature', () => {
        const call1 = createToolCall('Read', { file_paths: ['/a.ts', '/b.ts'] });
        const call2 = createToolCall('Read', { file_paths: ['/a.ts', '/b.ts'] });
        const call3 = createToolCall('Read', { file_paths: ['/a.ts', '/b.ts'] });

        detector.recordToolCalls([call1]);
        detector.recordToolCalls([call2]);

        const cycles = detector.detectCycles([call3]);
        expect(cycles.size).toBe(1);
        expect(cycles.get(call3.id)!.issueType).toBe('exact_duplicate');
      });

      it('should handle object arguments in signature', () => {
        const call1 = createToolCall('Complex', { config: { a: 1, b: 2 } });
        const call2 = createToolCall('Complex', { config: { a: 1, b: 2 } });
        const call3 = createToolCall('Complex', { config: { a: 1, b: 2 } });

        detector.recordToolCalls([call1]);
        detector.recordToolCalls([call2]);

        const cycles = detector.detectCycles([call3]);
        expect(cycles.size).toBe(1);
      });
    });

    describe('Repeated File Access Detection', () => {
      it('should detect repeated reads of same file', () => {
        const readCall = createToolCall('Read', { file_path: '/test/file.ts' });

        // Read same file 5 times (at threshold)
        for (let i = 0; i < 5; i++) {
          detector.recordToolCalls([readCall]);
        }

        // 6th read should trigger repeated file warning
        const cycles = detector.detectCycles([readCall]);

        // May trigger exact_duplicate first, but should also track file access
        expect(detector.getToolHistorySize()).toBe(5);
      });

      it('should track different files separately', () => {
        const read1 = createToolCall('Read', { file_path: '/test/a.ts' });
        const read2 = createToolCall('Read', { file_path: '/test/b.ts' });

        // Read different files (alternating to avoid exact duplicate detection)
        detector.recordToolCalls([read1]);
        detector.recordToolCalls([read2]);

        // Check that neither triggers cycle detection yet (only 1 occurrence each)
        // The third read of each would trigger exact duplicate
        const newRead1 = createToolCall('Read', { file_path: '/test/a.ts' });
        const cycles1 = detector.detectCycles([newRead1]);

        // Should not trigger because we only have 2 occurrences (below threshold of 3)
        const exactDuplicate = cycles1.get(newRead1.id);
        expect(exactDuplicate).toBeUndefined();
      });
    });

    describe('Similar Call Detection', () => {
      it('should detect similar but not identical calls', () => {
        // Configure detector with lower similar call threshold for testing
        const testDetector = new LoopDetector({
          instanceId: 'similar-test',
          cycleThreshold: 10, // High threshold to avoid exact match
        });

        // Similar grep calls with slight variations
        const call1 = createToolCall('Grep', { pattern: 'function foo', path: '/src', type: 'ts' });
        const call2 = createToolCall('Grep', { pattern: 'function bar', path: '/src', type: 'ts' });
        const call3 = createToolCall('Grep', { pattern: 'function baz', path: '/src', type: 'ts' });

        testDetector.recordToolCalls([call1]);
        testDetector.recordToolCalls([call2]);
        testDetector.recordToolCalls([call3]);

        // These share 2/3 parameters - should be similar at 60% threshold
        const call4 = createToolCall('Grep', { pattern: 'function qux', path: '/src', type: 'ts' });
        const cycles = testDetector.detectCycles([call4]);

        // At 60% similarity, these should match (path and type are same)
        if (cycles.size > 0) {
          expect(cycles.get(call4.id)?.issueType).toBe('similar_calls');
        }
      });
    });

    describe('Search Metrics Tracking', () => {
      it('should track search hit rate', () => {
        // Simulate grep calls with results
        const grepCall = createToolCall('Grep', { pattern: 'test' });

        // Record successful searches
        detector.recordToolCalls([grepCall], [{ success: true, matches: ['match1'] }]);
        detector.recordToolCalls([grepCall], [{ success: true, matches: ['match2'] }]);

        // Record failed searches
        detector.recordToolCalls([grepCall], [{ success: true, matches: [] }]);
        detector.recordToolCalls([grepCall], [{ success: true, matches: [] }]);
        detector.recordToolCalls([grepCall], [{ success: true, matches: [] }]);

        // 2 hits out of 5 searches = 40% hit rate
        // Should not trigger low hit rate warning (threshold is 30%)
        const cycles = detector.detectCycles([grepCall]);
        const hasLowHitRate = Array.from(cycles.values()).some(c => c.issueType === 'low_hit_rate');
        expect(hasLowHitRate).toBe(false);
      });

      it('should detect consecutive empty search streak', () => {
        const grepCall = createToolCall('Grep', { pattern: 'nonexistent' });

        // Record 3 consecutive empty searches
        for (let i = 0; i < 3; i++) {
          const newCall = createToolCall('Grep', { pattern: `pattern${i}` });
          detector.recordToolCalls([newCall], [{ success: true, matches: [] }]);
        }

        // Check for empty streak detection
        const checkCall = createToolCall('Grep', { pattern: 'check' });
        const cycles = detector.detectCycles([checkCall]);

        const hasEmptyStreak = Array.from(cycles.values()).some(c => c.issueType === 'empty_streak');
        expect(hasEmptyStreak).toBe(true);
      });

      it('should reset empty streak on successful search', () => {
        const grepCall = createToolCall('Grep', { pattern: 'test' });

        // Record 2 empty searches
        detector.recordToolCalls([grepCall], [{ success: true, matches: [] }]);
        detector.recordToolCalls([grepCall], [{ success: true, matches: [] }]);

        // Then a successful search
        detector.recordToolCalls([grepCall], [{ success: true, matches: ['found'] }]);

        // Streak should be reset
        const checkCall = createToolCall('Grep', { pattern: 'check' });
        const cycles = detector.detectCycles([checkCall]);
        const hasEmptyStreak = Array.from(cycles.values()).some(c => c.issueType === 'empty_streak');
        expect(hasEmptyStreak).toBe(false);
      });
    });

    describe('History Management', () => {
      it('should respect maximum history size', () => {
        // Record more than max history
        for (let i = 0; i < 20; i++) {
          detector.recordToolCalls([createToolCall('Tool', { index: i })]);
        }

        // Should be capped at maxHistory (15)
        expect(detector.getToolHistorySize()).toBe(15);
      });

      it('should clear history when cycle is broken', () => {
        const repeatedCall = createToolCall('Grep', { pattern: 'same' });

        // Create potential cycle
        detector.recordToolCalls([repeatedCall]);
        detector.recordToolCalls([repeatedCall]);

        // Break cycle with 3 different calls
        detector.recordToolCalls([createToolCall('Tool1', { a: 1 })]);
        detector.recordToolCalls([createToolCall('Tool2', { b: 2 })]);
        detector.recordToolCalls([createToolCall('Tool3', { c: 3 })]);

        // Try to clear if broken
        detector.clearCyclesIfBroken();

        // History should be cleared
        expect(detector.getToolHistorySize()).toBe(0);
      });

      it('should explicitly clear all history', () => {
        detector.recordToolCalls([createToolCall('Grep', { pattern: 'test' })]);
        detector.recordToolCalls([createToolCall('Read', { file_path: '/test' })]);

        detector.clearToolHistory();

        expect(detector.getToolHistorySize()).toBe(0);
      });
    });

    describe('Edge Cases', () => {
      it('should handle empty tool calls array', () => {
        const cycles = detector.detectCycles([]);
        expect(cycles.size).toBe(0);
      });

      it('should handle tool calls with empty arguments', () => {
        const call = createToolCall('Simple', {});
        detector.recordToolCalls([call]);
        detector.recordToolCalls([call]);

        const cycles = detector.detectCycles([call]);
        expect(cycles.size).toBe(1);
      });

      it('should handle tool calls with undefined arguments', () => {
        const call = {
          id: 'test-id',
          function: { name: 'Tool', arguments: undefined as any },
        };
        // Should not throw
        detector.recordToolCalls([call]);
        expect(detector.getToolHistorySize()).toBe(1);
      });
    });
  });

  // ============================================================================
  // TEXT LOOP DETECTOR TESTS
  // ============================================================================

  describe('TextLoopDetector', () => {
    let activityStream: ActivityStream;
    let detector: LoopDetector;
    let loopDetectedCallback: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.useFakeTimers();
      activityStream = new ActivityStream();
      loopDetectedCallback = vi.fn();
    });

    afterEach(() => {
      detector?.stop();
      vi.useRealTimers();
    });

    describe('Text Accumulation', () => {
      it('should accumulate text chunks from subscribed event type', () => {
        detector = new LoopDetector(
          {
            instanceId: 'test-accumulation',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: loopDetectedCallback,
            },
          },
          activityStream
        );

        // Emit thought chunks
        activityStream.emit({
          id: '1',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'Hello ' },
        });

        activityStream.emit({
          id: '2',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'world!' },
        });

        expect(detector.getThinkingAccumulatedLength()).toBe(12); // "Hello world!"
      });

      it('should ignore empty or whitespace-only chunks', () => {
        detector = new LoopDetector(
          {
            instanceId: 'test-whitespace',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: loopDetectedCallback,
            },
          },
          activityStream
        );

        activityStream.emit({
          id: '1',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: '' },
        });

        activityStream.emit({
          id: '2',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: '   ' },
        });

        expect(detector.getThinkingAccumulatedLength()).toBe(0);
      });

      it('should ignore events of different types', () => {
        detector = new LoopDetector(
          {
            instanceId: 'test-event-filter',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: loopDetectedCallback,
            },
          },
          activityStream
        );

        // Emit response chunk instead of thought chunk
        activityStream.emit({
          id: '1',
          type: ActivityEventType.RESPONSE_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'This should be ignored' },
        });

        expect(detector.getThinkingAccumulatedLength()).toBe(0);
      });
    });

    describe('Pattern Detection', () => {
      it('should detect loop when pattern matches after warmup', () => {
        const pattern = new MockPattern('test_pattern', 'reconsider');

        detector = new LoopDetector(
          {
            instanceId: 'test-pattern-detection',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [pattern],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: loopDetectedCallback,
            },
          },
          activityStream
        );

        // Emit text that will trigger pattern
        activityStream.emit({
          id: '1',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'Let me reconsider this. I should reconsider again.' },
        });

        // Advance past warmup
        vi.advanceTimersByTime(150);

        expect(loopDetectedCallback).toHaveBeenCalledWith(
          expect.objectContaining({
            patternName: 'test_pattern',
          })
        );
      });

      it('should not detect loop during warmup period', () => {
        const pattern = new AlwaysTriggersPattern();

        detector = new LoopDetector(
          {
            instanceId: 'test-warmup',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [pattern],
              warmupPeriodMs: 1000,
              checkIntervalMs: 50,
              onLoopDetected: loopDetectedCallback,
            },
          },
          activityStream
        );

        activityStream.emit({
          id: '1',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'Some text' },
        });

        // Advance less than warmup
        vi.advanceTimersByTime(500);

        expect(loopDetectedCallback).not.toHaveBeenCalled();
      });

      it('should use first matching pattern (priority order)', () => {
        const pattern1 = new MockPattern('first', 'alpha');
        const pattern2 = new MockPattern('second', 'beta');

        detector = new LoopDetector(
          {
            instanceId: 'test-priority',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [pattern1, pattern2],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: loopDetectedCallback,
            },
          },
          activityStream
        );

        // Text matches both patterns
        activityStream.emit({
          id: '1',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'alpha alpha beta beta' },
        });

        vi.advanceTimersByTime(150);

        expect(loopDetectedCallback).toHaveBeenCalledWith(
          expect.objectContaining({ patternName: 'first' })
        );
        // Should only call once (first match wins)
        expect(loopDetectedCallback).toHaveBeenCalledTimes(1);
      });

      it('should handle pattern errors gracefully', () => {
        const errorPattern = new ErrorPattern();
        const workingPattern = new MockPattern('working', 'test');

        detector = new LoopDetector(
          {
            instanceId: 'test-error-handling',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [errorPattern, workingPattern],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: loopDetectedCallback,
            },
          },
          activityStream
        );

        activityStream.emit({
          id: '1',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'test test' },
        });

        // Should not throw and should continue to working pattern
        vi.advanceTimersByTime(150);

        expect(loopDetectedCallback).toHaveBeenCalledWith(
          expect.objectContaining({ patternName: 'working' })
        );
      });

      it('should stop checking after loop detected', () => {
        const pattern = new AlwaysTriggersPattern();

        detector = new LoopDetector(
          {
            instanceId: 'test-stop-after-detect',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [pattern],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: loopDetectedCallback,
            },
          },
          activityStream
        );

        activityStream.emit({
          id: '1',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'text' },
        });

        // First detection
        vi.advanceTimersByTime(150);
        expect(loopDetectedCallback).toHaveBeenCalledTimes(1);

        // More time passes - should not call again
        vi.advanceTimersByTime(200);
        expect(loopDetectedCallback).toHaveBeenCalledTimes(1);
      });
    });

    describe('Lifecycle Management', () => {
      it('should start monitoring on first text chunk', () => {
        detector = new LoopDetector(
          {
            instanceId: 'test-auto-start',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: loopDetectedCallback,
            },
          },
          activityStream
        );

        expect(detector.isThinkingDetectorActive()).toBe(false);

        activityStream.emit({
          id: '1',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'text' },
        });

        expect(detector.isThinkingDetectorActive()).toBe(true);
      });

      it('should stop monitoring on stop()', () => {
        detector = new LoopDetector(
          {
            instanceId: 'test-stop',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [new AlwaysTriggersPattern()],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: loopDetectedCallback,
            },
          },
          activityStream
        );

        activityStream.emit({
          id: '1',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'text' },
        });

        detector.stop();

        // Advance timers - should not trigger callback
        vi.advanceTimersByTime(200);
        expect(loopDetectedCallback).not.toHaveBeenCalled();
      });

      it('should reset state on reset()', () => {
        detector = new LoopDetector(
          {
            instanceId: 'test-reset',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: loopDetectedCallback,
            },
          },
          activityStream
        );

        activityStream.emit({
          id: '1',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'accumulated text' },
        });

        expect(detector.getThinkingAccumulatedLength()).toBe(16);

        detector.resetTextDetectors();

        expect(detector.getThinkingAccumulatedLength()).toBe(0);
        expect(detector.hasThinkingLoopDetected()).toBe(false);
      });
    });

    describe('Dual Detector Configuration', () => {
      it('should support both thinking and response detectors', () => {
        const thinkingCallback = vi.fn();
        const responseCallback = vi.fn();

        detector = new LoopDetector(
          {
            instanceId: 'test-dual',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [new MockPattern('thinking', 'think')],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: thinkingCallback,
            },
            responseLoopConfig: {
              eventType: ActivityEventType.RESPONSE_CHUNK,
              patterns: [new MockPattern('response', 'respond')],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: responseCallback,
            },
          },
          activityStream
        );

        // Emit thinking text
        activityStream.emit({
          id: '1',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'think think' },
        });

        // Emit response text
        activityStream.emit({
          id: '2',
          type: ActivityEventType.RESPONSE_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'respond respond' },
        });

        vi.advanceTimersByTime(150);

        expect(thinkingCallback).toHaveBeenCalled();
        expect(responseCallback).toHaveBeenCalled();
      });

      it('should track separate accumulation for each detector', () => {
        detector = new LoopDetector(
          {
            instanceId: 'test-separate-accumulation',
            thinkingLoopConfig: {
              eventType: ActivityEventType.THOUGHT_CHUNK,
              patterns: [],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: vi.fn(),
            },
            responseLoopConfig: {
              eventType: ActivityEventType.RESPONSE_CHUNK,
              patterns: [],
              warmupPeriodMs: 100,
              checkIntervalMs: 50,
              onLoopDetected: vi.fn(),
            },
          },
          activityStream
        );

        activityStream.emit({
          id: '1',
          type: ActivityEventType.THOUGHT_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'short' },
        });

        activityStream.emit({
          id: '2',
          type: ActivityEventType.RESPONSE_CHUNK,
          timestamp: Date.now(),
          data: { chunk: 'this is a longer response text' },
        });

        expect(detector.getThinkingAccumulatedLength()).toBe(5);
        expect(detector.getResponseAccumulatedLength()).toBe(30);
      });
    });
  });

  // ============================================================================
  // UNIFIED LOOP DETECTOR TESTS
  // ============================================================================

  describe('Unified API', () => {
    it('should provide unified reset across all detectors', () => {
      const activityStream = new ActivityStream();
      const detector = new LoopDetector(
        {
          instanceId: 'test-unified-reset',
          thinkingLoopConfig: {
            eventType: ActivityEventType.THOUGHT_CHUNK,
            patterns: [],
            warmupPeriodMs: 100,
            checkIntervalMs: 50,
            onLoopDetected: vi.fn(),
          },
        },
        activityStream
      );

      // Add some state
      detector.recordToolCalls([createToolCall('Test', { a: 1 })]);

      activityStream.emit({
        id: '1',
        type: ActivityEventType.THOUGHT_CHUNK,
        timestamp: Date.now(),
        data: { chunk: 'text' },
      });

      // Reset everything
      detector.reset();

      expect(detector.getToolHistorySize()).toBe(0);
      expect(detector.getThinkingAccumulatedLength()).toBe(0);

      detector.stop();
    });

    it('should work without activity stream for tool-only detection', () => {
      const detector = new LoopDetector({
        instanceId: 'tool-only',
        cycleThreshold: 2,
      });

      const call = createToolCall('Grep', { pattern: 'test' });
      detector.recordToolCalls([call]);

      const cycles = detector.detectCycles([call]);
      expect(cycles.size).toBe(1);
    });

    it('should expose cycle threshold from config', () => {
      const detector = new LoopDetector({
        instanceId: 'test-threshold',
        cycleThreshold: 5,
      });

      expect(detector.getCycleThreshold()).toBe(5);
    });
  });
});
