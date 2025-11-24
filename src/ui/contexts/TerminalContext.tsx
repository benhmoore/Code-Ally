/**
 * TerminalContext - Centralized terminal width management
 *
 * Provides a single source of truth for terminal width across all UI components.
 * Measures width once at initialization and updates on terminal resize events.
 * This eliminates redundant measurements and improves performance.
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { TEXT_LIMITS } from '@config/constants.js';

/**
 * Terminal context value
 */
export interface TerminalContextValue {
  /** Current terminal width in columns */
  width: number;
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
      const newWidth = getTerminalWidth();
      setWidth(newWidth);
    };

    // Attach resize listener
    process.stdout?.on('resize', handleResize);

    // Cleanup on unmount
    return () => {
      process.stdout?.off('resize', handleResize);
    };
  }, [getTerminalWidth]);

  // Memoize context value to prevent unnecessary re-renders
  const value: TerminalContextValue = useMemo(() => ({
    width,
  }), [width]);

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
