/**
 * PointerContext - Mouse clicks for the live region.
 *
 * While tracking is on, the terminal reports clicks instead of handling them
 * itself. A click is resolved against the live region: the terminal is asked
 * where its cursor is (which pins the region's first row on screen), the
 * click is mapped into region coordinates, and the innermost registered
 * target under it is activated.
 *
 * Only live-region elements can be targets. Committed history sits in the
 * terminal's scrollback where the app no longer knows where it is drawn.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef } from 'react';
import type { DOMElement } from 'ink';
import { MOUSE_TRACKING_DISABLE, MOUSE_TRACKING_ENABLE } from '@utils/terminal.js';
import type { MouseEvent, TerminalInputStream } from '@utils/terminalInput.js';
import { logger } from '@services/Logger.js';
import { absoluteLayout, hitTest, layoutRoot, liveRegionTop, type LayoutNode } from '../utils/pointer.js';

type PressHandler = () => void;

interface PointerRegistry {
  register: (ref: React.RefObject<DOMElement | null>, onPress: PressHandler) => () => void;
}

const PointerRegistryContext = createContext<PointerRegistry | null>(null);

export interface PointerProviderProps {
  /** The filtered terminal input; without it clicks are never reported. */
  input?: TerminalInputStream;
  /** Whether the terminal should report clicks right now. */
  tracking: boolean;
  /** Raw writer for control sequences; defaults to process.stdout. */
  write?: (sequence: string) => void;
  /** Terminal height, used to tell a screen-filling live region apart. */
  terminalRows?: () => number;
  children: React.ReactNode;
}

const writeToStdout = (sequence: string): void => {
  if (process.stdout.isTTY) {
    process.stdout.write(sequence);
  }
};

export const PointerProvider: React.FC<PointerProviderProps> = ({
  input,
  tracking,
  write = writeToStdout,
  terminalRows = () => process.stdout.rows || 24,
  children,
}) => {
  const targets = useRef(new Map<React.RefObject<DOMElement | null>, PressHandler>());
  const resolving = useRef(false);

  const register = useCallback((ref: React.RefObject<DOMElement | null>, onPress: PressHandler) => {
    targets.current.set(ref, onPress);
    return () => {
      targets.current.delete(ref);
    };
  }, []);

  // Tracking follows `tracking` exactly, and is always off on unmount.
  useEffect(() => {
    if (!input || !tracking) {
      return;
    }
    write(MOUSE_TRACKING_ENABLE);
    return () => write(MOUSE_TRACKING_DISABLE);
  }, [input, tracking, write]);

  useEffect(() => {
    if (!input || !tracking) {
      return;
    }

    const resolveClick = async (event: MouseEvent): Promise<void> => {
      const mounted = [...targets.current].flatMap(([ref, onPress]) => (ref.current ? [{ node: ref.current as LayoutNode, value: onPress }] : []));
      const first = mounted[0];
      if (!first) {
        return;
      }
      const region = absoluteLayout(layoutRoot(first.node));
      if (!region) {
        return;
      }
      const cursor = await input.requestCursorPosition(write);
      const top = liveRegionTop(cursor.row, region.height, terminalRows());
      const onPress = hitTest(mounted, event.row - top, event.column - 1);
      onPress?.();
    };

    return input.onMouse((event) => {
      if (event.kind !== 'press' || event.button !== 'left' || resolving.current) {
        return;
      }
      resolving.current = true;
      resolveClick(event)
        .catch((error) => logger.debug('[POINTER] Click ignored:', error))
        .finally(() => {
          resolving.current = false;
        });
    });
  }, [input, tracking, write, terminalRows]);

  const registry = useMemo(() => ({ register }), [register]);

  return <PointerRegistryContext.Provider value={registry}>{children}</PointerRegistryContext.Provider>;
};

/**
 * Make the Box behind `ref` respond to a click. Passing no handler leaves the
 * element inert, so callers can register conditionally without branching.
 */
export function useClickable(ref: React.RefObject<DOMElement | null>, onPress?: PressHandler): void {
  const registry = useContext(PointerRegistryContext);
  // The latest handler is read at press time, so registration only tracks
  // whether there is one.
  const handler = useRef(onPress);
  handler.current = onPress;
  const enabled = onPress !== undefined;

  useEffect(() => {
    if (!registry || !enabled) {
      return;
    }
    return registry.register(ref, () => handler.current?.());
  }, [registry, ref, enabled]);
}
