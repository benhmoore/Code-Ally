/**
 * Custom hook to get the full-bleed printable width.
 *
 * Returns the printable width inside the root padding, uncapped. This is the
 * width to use for elements that should span the full content area (e.g. the
 * input prompt and footer) and need an accurate character budget for their own
 * wrapping math.
 *
 * Consumes TerminalContext for efficient cached width. Falls back to direct
 * measurement (using the same derivation) if the context is unavailable.
 */

import { useTerminalDimensions } from '../contexts/TerminalContext.js';

/** Return the shared terminal innerWidth measurement. */
export function useInnerWidth(): number {
  return useTerminalDimensions().innerWidth;
}
