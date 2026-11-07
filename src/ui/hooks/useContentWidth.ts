/**
 * Custom hook to get the readable content width.
 *
 * Returns the printable width inside the root padding, capped at
 * MAX_CONTENT_WIDTH for readability on wide screens. This is the width to use
 * for conversation content and modals that live inside the root App box.
 *
 * Consumes TerminalContext for efficient cached width. Falls back to direct
 * measurement (using the same derivation) if the context is unavailable.
 */

import { useTerminalDimensions } from '../contexts/TerminalContext.js';

/** Return the shared terminal contentWidth measurement. */
export function useContentWidth(): number {
  return useTerminalDimensions().contentWidth;
}
