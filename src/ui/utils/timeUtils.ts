/**
 * Time formatting utilities for UI display
 */

import { TIME_UNITS } from '../../config/constants.js';

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
  if (seconds < TIME_UNITS.SECONDS_PER_MINUTE) {
    return `${seconds}s`;
  }
  const mins = Math.floor(seconds / TIME_UNITS.SECONDS_PER_MINUTE);
  const secs = seconds % TIME_UNITS.SECONDS_PER_MINUTE;
  return `${mins}m ${secs}s`;
}

/**
 * Format a timestamp to a relative time string
 *
 * @param timestamp - Date object, ISO string timestamp, or Unix timestamp in milliseconds
 * @returns Relative time string (e.g., "5d ago", "12m ago", "just now")
 */
export function formatRelativeTime(timestamp: Date | string | number): string {
  const date = typeof timestamp === 'string'
    ? new Date(timestamp)
    : typeof timestamp === 'number'
    ? new Date(timestamp)
    : timestamp;
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / TIME_UNITS.MS_PER_SECOND);

  if (diffSeconds < TIME_UNITS.SECONDS_PER_MINUTE) {
    return 'just now';
  }

  const diffMinutes = Math.floor(diffSeconds / TIME_UNITS.SECONDS_PER_MINUTE);
  if (diffMinutes < TIME_UNITS.MINUTES_PER_HOUR) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / TIME_UNITS.MINUTES_PER_HOUR);
  if (diffHours < TIME_UNITS.HOURS_PER_DAY) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / TIME_UNITS.HOURS_PER_DAY);
  if (diffDays < TIME_UNITS.DAYS_PER_MONTH) {
    return `${diffDays}d ago`;
  }

  const diffMonths = Math.floor(diffDays / TIME_UNITS.DAYS_PER_MONTH);
  if (diffMonths < TIME_UNITS.MONTHS_PER_YEAR) {
    return `${diffMonths}mo ago`;
  }

  const diffYears = Math.floor(diffMonths / TIME_UNITS.MONTHS_PER_YEAR);
  return `${diffYears}y ago`;
}
