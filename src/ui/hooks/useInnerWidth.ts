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

import { useWindowSize } from 'ink';
import { TEXT_LIMITS } from '@config/constants.js';
import { deriveWidths, useTerminalContext } from '../contexts/TerminalContext.js';

/**
 * Get the printable width inside the root padding (uncapped).
 *
 * @returns Printable width in columns.
 */
export function useInnerWidth(): number {
  const { columns } = useWindowSize();
  try {
    return useTerminalContext().innerWidth;
  } catch {
    // Fallback to direct measurement if used outside the provider.
    return deriveWidths(columns || TEXT_LIMITS.TERMINAL_WIDTH_FALLBACK).innerWidth;
  }
}
