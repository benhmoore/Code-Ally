/**
 * TerminalContext - Centralized terminal width management
 *
 * Provides a single source of truth for terminal width across all UI components.
 * Measures width once at initialization and updates on terminal resize events.
 * This eliminates redundant measurements and improves performance.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { LAYOUT, TEXT_LIMITS } from '@config/constants.js';

/**
 * Terminal context value
 *
 * Single source of truth for the horizontal space available to the UI. All
 * three widths derive from the same raw measurement so that wrapping math never
 * disagrees with what is actually drawn:
 *
 *   width       raw terminal columns        (full-bleed root box only)
 *   innerWidth  width - root padding         (full-bleed content: input, footer)
 *   contentWidth min(innerWidth, MAX)        (readable content, capped on wide screens)
 */
export interface TerminalContextValue {
  /** Raw terminal width in columns. */
  width: number;
  /** Printable width inside the root padding (uncapped). */
  innerWidth: number;
  /** Printable width inside the root padding, capped at MAX_CONTENT_WIDTH. */
  contentWidth: number;
}

/**
 * Derive the printable widths from a raw terminal column count.
 *
 * Exported so the width hooks can reuse the exact same math in their
 * out-of-provider fallback path.
 */
export function deriveWidths(rawWidth: number): TerminalContextValue {
  const innerWidth = Math.max(1, rawWidth - LAYOUT.ROOT_PADDING_X * 2);
  return {
    width: rawWidth,
    innerWidth,
    contentWidth: Math.min(innerWidth, TEXT_LIMITS.MAX_CONTENT_WIDTH),
  };
}

/**
 * Context for terminal state
 */
export const TerminalContext = createContext<TerminalContextValue | null>(null);

/**
 * Props for TerminalProvider
 */
export interface TerminalProviderProps {
  children: React.ReactNode;
}

/**
 * Provider component for terminal state
 *
 * Manages terminal width and listens for resize events.
 * Width is measured once at initialization and updated on resize.
 *
 * @example
 * ```tsx
 * <TerminalProvider>
 *   <App />
 * </TerminalProvider>
 * ```
 */
export const TerminalProvider: React.FC<TerminalProviderProps> = ({ children }) => {
  // Initialize with current terminal width
  const getTerminalWidth = useCallback((): number => {
    return process.stdout?.columns || TEXT_LIMITS.TERMINAL_WIDTH_FALLBACK;
  }, []);

  const [width, setWidth] = useState<number>(getTerminalWidth());

  // Listen for terminal resize events
  useEffect(() => {
    const handleResize = () => {
      // Only update when the column count actually changes to avoid redundant
      // re-renders during height-only resizes.
      setWidth((prev) => {
        const newWidth = getTerminalWidth();
        return newWidth === prev ? prev : newWidth;
      });
    };

    // Attach resize listener
    process.stdout?.on('resize', handleResize);

    // Cleanup on unmount
    return () => {
      process.stdout?.off('resize', handleResize);
    };
  }, [getTerminalWidth]);

  // Memoize context value to prevent unnecessary re-renders
  const value: TerminalContextValue = useMemo(() => deriveWidths(width), [width]);

  return <TerminalContext.Provider value={value}>{children}</TerminalContext.Provider>;
};

/**
 * Hook to access terminal state
 *
 * @returns Terminal context value with current width
 *
 * @example
 * ```tsx
 * const { width } = useTerminalContext();
 * console.log('Terminal width:', width);
 * ```
 */
export const useTerminalContext = (): TerminalContextValue => {
  const context = useContext(TerminalContext);
  if (!context) {
    throw new Error('useTerminalContext must be used within TerminalProvider');
  }
  return context;
};
