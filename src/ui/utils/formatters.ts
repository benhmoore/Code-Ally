/**
 * Shared formatting utilities for UI components
 *
 * This module provides common formatting functions used across multiple
 * UI components to avoid code duplication.
 */

/**
 * Format diff stats for display
 *
 * @param stats - Diff statistics with additions and deletions
 * @returns Formatted string like "(+5, -2)" or "(no changes)"
 */
export function formatDiffStats(stats: { additions: number; deletions: number }): string {
  const parts: string[] = [];
  if (stats.additions > 0) {
    parts.push(`+${stats.additions}`);
  }
  if (stats.deletions > 0) {
    parts.push(`-${stats.deletions}`);
  }
  return parts.length > 0 ? `(${parts.join(', ')})` : '(no changes)';
}

/**
 * Truncate file path to fit display width
 *
 * Keeps first and last path segments, truncating middle with "..."
 *
 * @param path - Full file path
 * @param maxLength - Maximum length (default: 60)
 * @returns Truncated path like "src/.../file.ts"
 */
export function truncatePath(path: string, maxLength: number = 60): string {
  if (path.length <= maxLength) return path;

  const parts = path.split('/');
  if (parts.length <= 2) return path;

  // Keep first and last parts, truncate middle
  const first = parts[0] || '';
  const last = parts[parts.length - 1] || '';
  const available = maxLength - first.length - last.length - 6; // 6 for "/...//"

  if (available <= 0) {
    return `${first}/.../${last}`;
  }

  // Try to fit some middle parts
  let middle = '';
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i] || '';
    if (middle.length + part.length + 1 <= available) {
      middle += `/${part}`;
    } else {
      middle = '/...';
      break;
    }
  }

  return `${first}${middle}/${last}`;
}
