/**
 * Custom hook to get terminal width with max content width constraint
 *
 * Provides a consistent content width across all UI components,
 * respecting the maximum content width for readability on wide screens.
 *
 * Consumes TerminalContext for efficient width access. Falls back to
 * direct measurement if context unavailable (for backwards compatibility).
 */

import { useStdout } from 'ink';
import { TEXT_LIMITS } from '@config/constants.js';
import { useTerminalContext } from '../contexts/TerminalContext.js';

/**
 * Get the effective content width for rendering
 *
 * Returns the terminal width capped at MAX_CONTENT_WIDTH for readability.
 * Falls back to TERMINAL_WIDTH_FALLBACK if terminal width unavailable.
 *
 * @returns Effective content width in columns
 */
export function useContentWidth(): number {
  // Try to use TerminalContext for efficient cached width
  let actualTerminalWidth: number;
  try {
    const { width } = useTerminalContext();
    actualTerminalWidth = width;
  } catch {
    // Fallback to direct measurement if context unavailable
    // This maintains backwards compatibility for components outside provider
    const { stdout } = useStdout();
    actualTerminalWidth = stdout?.columns || TEXT_LIMITS.TERMINAL_WIDTH_FALLBACK;
  }

  return Math.min(actualTerminalWidth, TEXT_LIMITS.MAX_CONTENT_WIDTH);
}
