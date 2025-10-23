/**
 * Time formatting utilities for UI display
 */

/**
 * Format a duration in milliseconds to a human-readable string
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted duration string (e.g., "1m 23s", "456ms")
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = Math.round(ms / 1000);
  return formatElapsed(seconds);
}

/**
 * Format elapsed time in seconds to a human-readable string
 *
 * @param seconds - Elapsed time in seconds
 * @returns Formatted time string (e.g., "1m 23s", "5s")
 */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}
