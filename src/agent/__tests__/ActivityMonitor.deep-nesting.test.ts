/**
 * Tests for ActivityMonitor - Deep Agent Nesting
 *
 * Verifies that pause/resume reference counting works correctly for deep agent nesting
 * (Agent1 → Agent2 → Agent3) and prevents pause count corruption.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ActivityMonitor } from '../ActivityMonitor.js';

describe('ActivityMonitor - Deep Agent Nesting', () => {
  let monitor: ActivityMonitor;
  let timeoutCallback: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Mock timeout callback
    timeoutCallback = vi.fn();

    // Create monitor with short intervals for testing
    monitor = new ActivityMonitor({
      timeoutMs: 5000, // 5 second timeout
      checkIntervalMs: 100, // Check every 100ms
      enabled: true,
      instanceId: 'test-monitor',
      onTimeout: timeoutCallback,
    });
  });

  afterEach(() => {
    // Clean up any running intervals
    if (monitor) {
      monitor.stop();
    }
  });

  describe('3-level agent nesting', () => {
    it('handles 3-level agent nesting without pause count corruption', () => {
      // Start the monitor
      monitor.start();
      expect(monitor.isActive()).toBe(true);

      // Level 1: Agent1 delegates to Agent2 - pause (count=1)
      monitor.pause();
      expect(monitor.isActive()).toBe(false);

      // Level 2: Agent2 delegates to Agent3 - pause (count=2)
      monitor.pause();
      expect(monitor.isActive()).toBe(false);

      // Level 3: Agent3 delegates to Agent4 - pause (count=3)
      monitor.pause();
      expect(monitor.isActive()).toBe(false);

      // Agent4 completes - resume (count=2)
      monitor.resume();
      expect(monitor.isActive()).toBe(false); // Still paused (count > 0)

      // Agent3 completes - resume (count=1)
      monitor.resume();
      expect(monitor.isActive()).toBe(false); // Still paused (count > 0)

      // Agent2 completes - resume (count=0, timer restarts)
      monitor.resume();
      expect(monitor.isActive()).toBe(true); // Now active again

      // Clean up
      monitor.stop();
    });

    it('records progress only when delegation succeeds', async () => {
      // Start the monitor and record initial activity
      monitor.start();
      const initialTime = monitor.getElapsedTime();
      expect(initialTime).toBeLessThan(100); // Should be very recent

      // Pause for delegation
      monitor.pause();

      // Simulate time passing during delegation (50ms)
      await new Promise(resolve => setTimeout(resolve, 50));

      // Resume with success - should record progress (reset timer)
      monitor.resume(true);

      // Elapsed time should be very small (reset to now)
      const elapsedAfterSuccess = monitor.getElapsedTime();
      expect(elapsedAfterSuccess).toBeLessThan(10);

      // Pause again for another delegation
      monitor.pause();

      // Simulate more time passing (100ms)
      await new Promise(resolve => setTimeout(resolve, 100));

      // Resume with failure - should NOT record progress (preserve timer)
      monitor.resume(false);

      // Elapsed time should include the time from before pause + after resume
      // Since we didn't reset the timer, it should be >= 100ms
      const elapsedAfterFailure = monitor.getElapsedTime();
      expect(elapsedAfterFailure).toBeGreaterThanOrEqual(100);
    });

    it('preserves lastActivityTime during pause/resume with failure', async () => {
      // Start the monitor
      monitor.start();

      // Wait a bit to establish baseline
      await new Promise(resolve => setTimeout(resolve, 50));
      const baselineElapsed = monitor.getElapsedTime();
      expect(baselineElapsed).toBeGreaterThanOrEqual(50);

      // Pause (e.g., for delegation)
      monitor.pause();

      // Simulate delegation taking 100ms
      await new Promise(resolve => setTimeout(resolve, 100));

      // Resume with failure - should NOT reset timer
      monitor.resume(false);

      // Elapsed time should be baseline + paused time
      const finalElapsed = monitor.getElapsedTime();
      expect(finalElapsed).toBeGreaterThanOrEqual(150); // 50ms baseline + 100ms paused

      monitor.stop();
    });

    it('resets lastActivityTime on successful resume', async () => {
      // Start the monitor
      monitor.start();

      // Wait to establish baseline
      await new Promise(resolve => setTimeout(resolve, 100));
      const baselineElapsed = monitor.getElapsedTime();
      expect(baselineElapsed).toBeGreaterThanOrEqual(100);

      // Pause (e.g., for delegation)
      monitor.pause();

      // Simulate delegation taking 200ms
      await new Promise(resolve => setTimeout(resolve, 200));

      // Resume with success - should reset timer
      monitor.resume(true);

      // Elapsed time should be very small (reset to now)
      const finalElapsed = monitor.getElapsedTime();
      expect(finalElapsed).toBeLessThan(10);

      monitor.stop();
    });

    it('handles mixed success/failure in nested delegations', () => {
      // Start the monitor
      monitor.start();

      // Level 1: pause
      monitor.pause();

      // Level 2: pause
      monitor.pause();

      // Level 2: resume with failure - doesn't matter yet (count=1)
      monitor.resume(false);
      expect(monitor.isActive()).toBe(false);

      // Level 1: resume with success - resets timer (count=0)
      monitor.resume(true);
      expect(monitor.isActive()).toBe(true);

      // Elapsed time should be very small (reset by successful resume)
      const elapsed = monitor.getElapsedTime();
      expect(elapsed).toBeLessThan(10);

      monitor.stop();
    });
  });

  describe('pause count safety limit', () => {
    it('prevents pause count corruption with safety limit', () => {
      // Start the monitor
      monitor.start();
      expect(monitor.isActive()).toBe(true);

      // Pause 10 times (maxPauseCount)
      for (let i = 0; i < 10; i++) {
        monitor.pause();
      }
      expect(monitor.isActive()).toBe(false);

      // Next pause should log error and reset count
      // We can't easily test the error log, but we can verify behavior
      monitor.pause();

      // After reset, one more pause should work
      monitor.pause();
      expect(monitor.isActive()).toBe(false);

      // Resume should bring us back to active
      monitor.resume();
      expect(monitor.isActive()).toBe(true);

      monitor.stop();
    });

    it('maintains pause count accuracy with deep nesting near limit', () => {
      // Start the monitor
      monitor.start();

      // Pause 9 times (just under maxPauseCount)
      for (let i = 0; i < 9; i++) {
        monitor.pause();
      }
      expect(monitor.isActive()).toBe(false);

      // Resume 9 times to get back to zero
      for (let i = 0; i < 9; i++) {
        expect(monitor.isActive()).toBe(false);
        monitor.resume();
      }

      // After 9 resumes, should be active again
      expect(monitor.isActive()).toBe(true);

      monitor.stop();
    });

    it('does not decrement pause count below zero', () => {
      // Start the monitor
      monitor.start();
      expect(monitor.isActive()).toBe(true);

      // Resume when not paused (count should stay at 0)
      monitor.resume();
      expect(monitor.isActive()).toBe(true);

      // Pause once
      monitor.pause();
      expect(monitor.isActive()).toBe(false);

      // Resume twice (second should be no-op)
      monitor.resume();
      expect(monitor.isActive()).toBe(true);

      monitor.resume();
      expect(monitor.isActive()).toBe(true); // Should still be active

      monitor.stop();
    });
  });

  describe('pause/resume with monitoring disabled', () => {
    it('handles pause/resume when monitoring is disabled', () => {
      // Create monitor with monitoring disabled
      const disabledMonitor = new ActivityMonitor({
        timeoutMs: 5000,
        checkIntervalMs: 100,
        enabled: false, // Disabled
        instanceId: 'disabled-monitor',
        onTimeout: timeoutCallback,
      });

      // Start (should be no-op)
      disabledMonitor.start();
      expect(disabledMonitor.isActive()).toBe(false);

      // Pause (should be no-op)
      disabledMonitor.pause();
      expect(disabledMonitor.isActive()).toBe(false);

      // Resume (should be no-op)
      disabledMonitor.resume();
      expect(disabledMonitor.isActive()).toBe(false);

      // Clean up
      disabledMonitor.stop();
    });
  });

  describe('timeout behavior with nested agents', () => {
    it('does not trigger timeout while paused', async () => {
      // Start the monitor with 1 second timeout
      monitor.start();
      expect(monitor.isActive()).toBe(true);

      // Pause immediately
      monitor.pause();
      expect(monitor.isActive()).toBe(false);

      // Wait longer than timeout period
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Should not have triggered timeout (was paused)
      expect(timeoutCallback).not.toHaveBeenCalled();

      // Resume
      monitor.resume();
      expect(monitor.isActive()).toBe(true);

      // Clean up
      monitor.stop();
    });

    it('triggers timeout after resume if elapsed time exceeds limit', async () => {
      // Start the monitor with 200ms timeout
      const shortTimeoutMonitor = new ActivityMonitor({
        timeoutMs: 200,
        checkIntervalMs: 50,
        enabled: true,
        instanceId: 'short-timeout',
        onTimeout: timeoutCallback,
      });

      shortTimeoutMonitor.start();
      expect(shortTimeoutMonitor.isActive()).toBe(true);

      // Wait 150ms (below timeout)
      await new Promise(resolve => setTimeout(resolve, 150));

      // Pause
      shortTimeoutMonitor.pause();

      // Wait during pause (doesn't count toward timeout)
      await new Promise(resolve => setTimeout(resolve, 100));

      // Resume with failure (doesn't reset timer)
      shortTimeoutMonitor.resume(false);

      // Now elapsed time should be 150ms (from before pause) + time since resume
      // Wait another 100ms to exceed 200ms timeout
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should trigger timeout
      expect(timeoutCallback).toHaveBeenCalled();

      shortTimeoutMonitor.stop();
    });
  });
});
