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

import { useTerminalDimensions } from '../contexts/TerminalContext.js';

/** Return the shared terminal width measurement. */
export function useTerminalWidth(): number {
  return useTerminalDimensions().width;
}
