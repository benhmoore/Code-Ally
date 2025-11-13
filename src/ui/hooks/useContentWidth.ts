/**
 * Custom hook to get terminal width with max content width constraint
 *
 * Provides a consistent content width across all UI components,
 * respecting the maximum content width for readability on wide screens.
 */

import { useStdout } from 'ink';
import { TEXT_LIMITS } from '@config/constants.js';

/**
 * Get the effective content width for rendering
 *
 * Returns the terminal width capped at MAX_CONTENT_WIDTH for readability.
 * Falls back to TERMINAL_WIDTH_FALLBACK if terminal width unavailable.
 *
 * @returns Effective content width in columns
 */
export function useContentWidth(): number {
  const { stdout } = useStdout();
  const actualTerminalWidth = stdout?.columns || TEXT_LIMITS.TERMINAL_WIDTH_FALLBACK;
  return Math.min(actualTerminalWidth, TEXT_LIMITS.MAX_CONTENT_WIDTH);
}
