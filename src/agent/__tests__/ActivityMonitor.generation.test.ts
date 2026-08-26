/**
 * Tests for ActivityMonitor - model generation phases
 *
 * The watchdog exists to catch an agent that has stopped making progress, not
 * one that is merely slow. These cover the two ways that distinction was lost:
 * time spent in prefill (no output on the wire yet) and time spent streaming a
 * long answer, both of which used to be counted as "stuck" because only a tool
 * call reset the clock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ActivityMonitor } from '../ActivityMonitor.js';

describe('ActivityMonitor - model generation phases', () => {
  let monitor: ActivityMonitor;
  let onTimeout: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    onTimeout = vi.fn();
    monitor = new ActivityMonitor({
      timeoutMs: 120_000,
      checkIntervalMs: 1_000,
      enabled: true,
      instanceId: 'test-monitor',
      onTimeout,
    });
  });

  afterEach(() => {
    monitor.stop();
    vi.useRealTimers();
  });

  it('does not time out while a request is still in prefill', () => {
    monitor.start();
    monitor.beginModelRequest();

    // Five minutes of prefill on a slow local backend: nothing on the wire, and
    // nothing this watchdog should act on.
    vi.advanceTimersByTime(300_000);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('does not time out while output is streaming steadily', () => {
    monitor.start();
    monitor.beginModelRequest();

    // A ten-minute answer, one chunk every 30s - well past the 120s timeout.
    for (let elapsed = 0; elapsed < 600_000; elapsed += 30_000) {
      vi.advanceTimersByTime(30_000);
      monitor.recordStreamProgress();
    }

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('does not race transport recovery when a started stream goes silent', () => {
    monitor.start();
    monitor.beginModelRequest();
    monitor.recordStreamProgress();

    // Stream progress deadlines and retries belong to the model transport. The
    // orchestration watchdog must not abort at the same deadline.
    vi.advanceTimersByTime(300_000);

    expect(onTimeout).not.toHaveBeenCalled();

    // Once the request settles, orchestration owns liveness again.
    monitor.endModelRequest();
    vi.advanceTimersByTime(121_000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('re-arms the clock once a request settles without output', () => {
    monitor.start();
    monitor.beginModelRequest();
    vi.advanceTimersByTime(300_000);
    expect(onTimeout).not.toHaveBeenCalled();

    // Empty response: the prefill exemption ends with the request, so the gap
    // that follows is measured from here rather than from the request start.
    monitor.endModelRequest();
    vi.advanceTimersByTime(119_000);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(onTimeout).toHaveBeenCalled();
  });

  it('ignores stream progress while paused for delegated work', () => {
    monitor.start();
    monitor.pause();

    monitor.recordStreamProgress();
    monitor.resume(false); // Delegation failed - must not be credited

    vi.advanceTimersByTime(121_000);

    expect(onTimeout).toHaveBeenCalled();
  });

  it('clears a stale pause when stopped, so the next turn is monitored', () => {
    monitor.start();
    monitor.pause();
    // Stopping while paused (an interrupt during tool execution) left pauseCount
    // above zero, and start() only guards on isRunning - so every later check
    // short-circuited and the watchdog never fired again.
    monitor.stop();

    monitor.start();
    vi.advanceTimersByTime(121_000);

    expect(onTimeout).toHaveBeenCalled();
  });
});
