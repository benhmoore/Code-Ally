/**
 * Custom hook to get the raw terminal width in columns.
 *
 * This is the full physical terminal width, used only by the root App box which
 * fills the screen. Components that render *inside* the root padding should use
 * useInnerWidth (full-bleed) or useContentWidth (readable, capped) instead.
 *
 * Consumes TerminalContext for efficient cached width. Falls back to direct
 * measurement if the context is unavailable.
 */

import { useStdout } from 'ink';
import { TEXT_LIMITS } from '@config/constants.js';
import { useTerminalContext } from '../contexts/TerminalContext.js';

/**
 * Get the raw terminal width without any padding adjustment.
 *
 * @returns Raw terminal width in columns.
 */
export function useTerminalWidth(): number {
  try {
    return useTerminalContext().width;
  } catch {
    // Fallback to direct measurement if used outside the provider.
    const { stdout } = useStdout();
    return stdout?.columns || TEXT_LIMITS.TERMINAL_WIDTH_FALLBACK;
  }
}
