/**
 * Custom hook to get raw terminal width without max content width constraint
 *
 * Unlike useContentWidth which caps at MAX_CONTENT_WIDTH for readability,
 * this hook returns the actual terminal width for components that should
 * expand to fill available space (e.g., input prompt, footer).
 *
 * Consumes TerminalContext for efficient width access. Falls back to
 * direct measurement if context unavailable (for backwards compatibility).
 */

import { useStdout } from 'ink';
import { TEXT_LIMITS } from '@config/constants.js';
import { useTerminalContext } from '../contexts/TerminalContext.js';

/**
 * Get the raw terminal width without max content constraint
 *
 * Returns the actual terminal width in columns.
 * Falls back to TERMINAL_WIDTH_FALLBACK if terminal width unavailable.
 *
 * @returns Terminal width in columns
 */
export function useTerminalWidth(): number {
  // Try to use TerminalContext for efficient cached width
  try {
    const { width } = useTerminalContext();
    return width;
  } catch {
    // Fallback to direct measurement if context unavailable
    // This maintains backwards compatibility for components outside provider
    const { stdout } = useStdout();
    return stdout?.columns || TEXT_LIMITS.TERMINAL_WIDTH_FALLBACK;
  }
}
