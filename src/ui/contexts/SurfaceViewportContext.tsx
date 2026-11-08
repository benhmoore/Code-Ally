import { createContext, useContext, useLayoutEffect, useRef } from 'react';
import type { DOMElement } from 'ink';

export interface SurfaceViewport {
  inputRows: number;
  focus: (node: DOMElement, row: number) => void;
}
export const SurfaceViewportContext = createContext<SurfaceViewport | null>(null);

/** Declare the visible cursor/selection without changing the editor's stored value. */
export function useSurfaceFocus(active: boolean, row = 0) {
  const viewport = useContext(SurfaceViewportContext);
  const ref = useRef<DOMElement>(null);
  useLayoutEffect(() => {
    if (active && ref.current) viewport?.focus(ref.current, row);
  });
  return ref;
}
export function useSurfaceInputRows() {
  return useContext(SurfaceViewportContext)?.inputRows;
}
