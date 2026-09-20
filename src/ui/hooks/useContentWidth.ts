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

import { useWindowSize } from 'ink';
import { TEXT_LIMITS } from '@config/constants.js';
import { deriveWidths, useTerminalContext } from '../contexts/TerminalContext.js';

/**
 * Get the effective content width for rendering.
 *
 * @returns Readable content width in columns (capped at MAX_CONTENT_WIDTH).
 */
export function useContentWidth(): number {
  const { columns } = useWindowSize();
  try {
    return useTerminalContext().contentWidth;
  } catch {
    // Fallback to direct measurement if used outside the provider.
    return deriveWidths(columns || TEXT_LIMITS.TERMINAL_WIDTH_FALLBACK).contentWidth;
  }
}
