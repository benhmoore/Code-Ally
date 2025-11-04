/**
 * Time formatting utilities for UI display and agent duration management
 */

import { TIME_UNITS } from '../../config/constants.js';

/**
 * Valid thoroughness levels for agent execution
 */
export type ThoroughnessLevel = 'quick' | 'medium' | 'very thorough' | 'uncapped';

/**
 * Duration constants for thoroughness levels (in minutes)
 */
export const THOROUGHNESS_DURATIONS = {
  QUICK_MINUTES: 1,
  MEDIUM_MINUTES: 5,
  VERY_THOROUGH_MINUTES: 10,
} as const;

/**
 * Map thoroughness level to maximum duration in minutes
 *
 * @param thoroughness - Thoroughness level
 * @returns Duration in minutes, or undefined for uncapped
 */
export function getThoroughnessDuration(thoroughness: ThoroughnessLevel): number | undefined {
  switch (thoroughness) {
    case 'quick':
      return THOROUGHNESS_DURATIONS.QUICK_MINUTES;
    case 'medium':
      return THOROUGHNESS_DURATIONS.MEDIUM_MINUTES;
    case 'very thorough':
      return THOROUGHNESS_DURATIONS.VERY_THOROUGH_MINUTES;
    case 'uncapped':
      return undefined;
  }
}

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
 * Format minutes (as decimal) to human-readable full words
 *
 * @param minutes - Duration in minutes (can be fractional)
 * @returns Formatted string (e.g., "2 minutes 30 seconds", "45 seconds")
 */
export function formatMinutesSeconds(minutes: number): string {
  const mins = Math.floor(Math.abs(minutes));
  const secs = Math.round((Math.abs(minutes) - mins) * 60);

  if (mins > 0) {
    const minStr = `${mins} minute${mins !== 1 ? 's' : ''}`;
    if (secs > 0) {
      return `${minStr} ${secs} second${secs !== 1 ? 's' : ''}`;
    }
    return minStr;
  }
  return `${secs} second${secs !== 1 ? 's' : ''}`;
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
