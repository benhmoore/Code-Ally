import React, { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, measureElement, type DOMElement } from 'ink';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';

interface BottomLayoutContext {
  commitRows: (rows: number) => void;
  measure: () => void;
  liveRows: number;
}
const LayoutContext = createContext<BottomLayoutContext | null>(null);
export const useBottomLayout = () => useContext(LayoutContext);

/** Keep the interaction region at the bottom while preserving native scrollback. */
export function BottomAlignedLayout({ children, footer, historyKey }: {
  children: React.ReactNode;
  footer: React.ReactNode;
  historyKey: number;
}) {
  const rows = Math.max(1, useTerminalRows() - 1); // Ink needs a row for its trailing newline.
  const width = useTerminalWidth();
  const bodyRef = useRef<DOMElement>(null);
  const footerRef = useRef<DOMElement>(null);
  const [sizes, setSizes] = useState({ body: 0, footer: 0 });
  // Physical row counts belong to one geometry. Terminal reflow invalidates
  // them; begin a fresh live viewport while leaving prior output in scrollback.
  const geometry = `${historyKey}:${width}:${rows}`;
  const [history, setHistory] = useState({ key: geometry, rows: 0 });
  if (history.key !== geometry) setHistory({ key: geometry, rows: 0 });
  const committedRows = history.key === geometry ? history.rows : 0;
  const commitRows = useCallback((count: number) => {
    setHistory(previous => ({ key: geometry,
      rows: (previous.key === geometry ? previous.rows : 0) + count }));
  }, [geometry]);
  const measure = useCallback(() => {
    const body = bodyRef.current ? measureElement(bodyRef.current).height : 0;
    const footerHeight = footerRef.current ? measureElement(footerRef.current).height : 0;
    setSizes(previous => previous.body === body && previous.footer === footerHeight
      ? previous : { body, footer: footerHeight });
  }, []);
  useLayoutEffect(measure);
  const liveRows = Math.max(0, rows - sizes.footer);
  const context = useMemo(() => ({ commitRows, measure, liveRows }), [commitRows, measure, liveRows]);
  const height = Math.min(rows, Math.max(rows - committedRows, sizes.body + sizes.footer));

  return (
    <LayoutContext.Provider value={context}>
      <Box width={width} height={height} flexDirection="column" paddingX={1} overflowY="hidden">
        <Box flexDirection="column" flexShrink={1} height={Math.min(liveRows, sizes.body)} overflowY="hidden">
          <Box ref={bodyRef} position="absolute" width="100%" flexDirection="column">{children}</Box>
        </Box>
        <Box flexGrow={1} />
        <Box flexDirection="column" flexShrink={0} height={sizes.footer ? Math.min(rows, sizes.footer) : undefined}
          justifyContent="flex-end" overflowY="hidden">
          <Box ref={footerRef} flexDirection="column" flexShrink={0}>{footer}</Box>
        </Box>
      </Box>
    </LayoutContext.Provider>
  );
}

/** Measure a finalized batch before printing it, so padding cannot scroll it away. */
export function CommittedTranscript({ children, width }: { children: React.ReactNode; width: number }) {
  const layout = useBottomLayout();
  const ref = useRef<DOMElement>(null);
  const [ready, setReady] = useState(!layout);
  useLayoutEffect(() => {
    if (ready || !ref.current || !layout) return;
    layout.commitRows(measureElement(ref.current).height);
    setReady(true);
  }, [ready, layout]);
  if (!ready) {
    return <Box position="absolute" flexDirection="column" width={width} height={0} overflow="hidden">
      <Box ref={ref} position="absolute" flexDirection="column" width={width}>{children}</Box>
    </Box>;
  }
  return <Static items={[children]} style={{ width }}>{item => <React.Fragment key="batch">{item}</React.Fragment>}</Static>;
}
