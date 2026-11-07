/**
 * TerminalContext - Centralized terminal width management
 *
 * Provides a single source of truth for terminal width across all UI components.
 * Measures width once at initialization and updates on terminal resize events.
 * This eliminates redundant measurements and improves performance.
 */

import React, { createContext, useContext, useSyncExternalStore } from 'react';
import { useStdout } from 'ink';
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
  /** Raw terminal height in rows. */
  rows: number;
}

/**
 * Derive the printable widths from a raw terminal column count.
 *
 * Exported so the width hooks can reuse the exact same math in their
 * out-of-provider fallback path.
 */
export function deriveWidths(
  rawWidth: number,
  rawRows: number = TEXT_LIMITS.TERMINAL_HEIGHT_FALLBACK
): TerminalContextValue {
  const innerWidth = Math.max(1, rawWidth - LAYOUT.ROOT_PADDING_X * 2);
  return {
    width: rawWidth,
    innerWidth,
    contentWidth: Math.min(innerWidth, TEXT_LIMITS.MAX_CONTENT_WIDTH),
    rows: Math.max(1, rawRows),
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
  const { stdout } = useStdout();
  const store = measurementStore(stdout);
  const value = useSyncExternalStore(store.subscribe, store.getSnapshot);

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

interface TerminalMeasurementStore {
  getSnapshot: () => TerminalContextValue;
  subscribe: (listener: () => void) => () => void;
}

// Output streams own their measurement stores, so detached renderers are collectible.
const measurementStores = new WeakMap<NodeJS.WritableStream, TerminalMeasurementStore>();
const subscribeToNothing = () => () => {};

function measurementStore(stdout: NodeJS.WritableStream): TerminalMeasurementStore {
  const existing = measurementStores.get(stdout);
  if (existing) return existing;
  const measure = () => deriveWidths(
    (stdout as Partial<NodeJS.WriteStream>).columns || TEXT_LIMITS.TERMINAL_WIDTH_FALLBACK,
    (stdout as Partial<NodeJS.WriteStream>).rows || TEXT_LIMITS.TERMINAL_HEIGHT_FALLBACK,
  );
  let snapshot = measure();
  const listeners = new Set<() => void>();
  const resize = () => {
    const next = measure();
    if (snapshot.width === next.width && snapshot.rows === next.rows) return;
    snapshot = next;
    listeners.forEach(listener => listener());
  };
  const store: TerminalMeasurementStore = {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      // Update React before Ink compares the old frame with a resized terminal;
      // a late layout update on shrink can otherwise clear terminal scrollback.
      if (listeners.size === 0) stdout.prependListener('resize', resize);
      listeners.add(listener);
      // Catch dimensions changed while this stream had no mounted consumers.
      resize();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stdout.off('resize', resize);
      };
    },
  };
  measurementStores.set(stdout, store);
  return store;
}

/** Use shared measurements with one fallback subscription per Ink output. */
export function useTerminalDimensions(): TerminalContextValue {
  const context = useContext(TerminalContext);
  const { stdout } = useStdout();
  const store = measurementStore(stdout);
  const fallback = useSyncExternalStore(context ? subscribeToNothing : store.subscribe, store.getSnapshot);
  return context ?? fallback;
}
