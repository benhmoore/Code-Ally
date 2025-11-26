/**
 * Performance benchmark for ActivityStream.emit() optimization
 *
 * Tests the performance impact of the emit() optimization:
 * - Single-pass iteration vs double iteration
 * - Cached mapping vs object creation on every call
 * - for-of loops vs forEach
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ActivityStream } from '../ActivityStream.js';
import { ActivityEventType } from '@shared/index.js';
import type { ActivityEvent } from '@shared/index.js';

describe('ActivityStream Performance', () => {
  let stream: ActivityStream;

  beforeEach(() => {
    stream = new ActivityStream();
  });

  it('should handle high-frequency event emissions efficiently', () => {
    // Setup: Add multiple listeners (simulating real-world usage)
    const listeners = Array.from({ length: 10 }, () => () => {});
    listeners.forEach(cb => stream.subscribe(ActivityEventType.TOOL_CALL_START, cb));

    // Add wildcard listeners
    const wildcardListeners = Array.from({ length: 5 }, () => () => {});
    wildcardListeners.forEach(cb => stream.subscribe('*', cb));

    const event: ActivityEvent = {
      id: '123',
      type: ActivityEventType.TOOL_CALL_START,
      timestamp: Date.now(),
      data: { toolName: 'test' },
    };

    // Benchmark: Emit 10,000 events
    const iterations = 10000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      stream.emit(event);
    }

    const duration = performance.now() - start;
    const avgTimePerEmit = duration / iterations;

    console.log(`\n📊 Performance Results:`);
    console.log(`   Total time: ${duration.toFixed(2)}ms`);
    console.log(`   Iterations: ${iterations}`);
    console.log(`   Avg per emit: ${avgTimePerEmit.toFixed(4)}ms`);
    console.log(`   Listeners per event: 15 (10 type-specific + 5 wildcard)`);
    console.log(`   Total listener calls: ${iterations * 15}`);

    // Performance assertion: Each emit should be fast
    // With optimization, expect < 0.01ms per emit (100 emits per ms)
    expect(avgTimePerEmit).toBeLessThan(0.02); // 20 microseconds per emit
  });

  it('should efficiently handle events with no listeners', () => {
    const event: ActivityEvent = {
      id: '123',
      type: ActivityEventType.TOOL_CALL_START,
      timestamp: Date.now(),
      data: { toolName: 'test' },
    };

    const iterations = 10000;
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      stream.emit(event);
    }

    const duration = performance.now() - start;
    const avgTimePerEmit = duration / iterations;

    console.log(`\n📊 No-listener Performance:`);
    console.log(`   Total time: ${duration.toFixed(2)}ms`);
    console.log(`   Avg per emit: ${avgTimePerEmit.toFixed(4)}ms`);

    // Should be extremely fast with no listeners
    expect(avgTimePerEmit).toBeLessThan(0.01);
  });

  it('should efficiently handle mixed event types', () => {
    // Setup diverse listeners
    stream.subscribe(ActivityEventType.TOOL_CALL_START, () => {});
    stream.subscribe(ActivityEventType.TOOL_CALL_END, () => {});
    stream.subscribe(ActivityEventType.AGENT_START, () => {});
    stream.subscribe('*', () => {});

    const events: ActivityEvent[] = [
      {
        id: '1',
        type: ActivityEventType.TOOL_CALL_START,
        timestamp: Date.now(),
        data: {},
      },
      {
        id: '2',
        type: ActivityEventType.TOOL_CALL_END,
        timestamp: Date.now(),
        data: {},
      },
      {
        id: '3',
        type: ActivityEventType.AGENT_START,
        timestamp: Date.now(),
        data: {},
      },
    ];

    const iterations = 3333; // 10k total events
    const start = performance.now();

    for (let i = 0; i < iterations; i++) {
      events.forEach(event => stream.emit(event));
    }

    const duration = performance.now() - start;
    const totalEvents = iterations * events.length;
    const avgTimePerEmit = duration / totalEvents;

    console.log(`\n📊 Mixed Event Type Performance:`);
    console.log(`   Total time: ${duration.toFixed(2)}ms`);
    console.log(`   Total events: ${totalEvents}`);
    console.log(`   Avg per emit: ${avgTimePerEmit.toFixed(4)}ms`);

    expect(avgTimePerEmit).toBeLessThan(0.02);
  });
});
