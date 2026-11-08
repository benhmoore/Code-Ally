import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, measureElement, useInput, type DOMElement } from 'ink';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { SurfaceViewportContext } from '../contexts/SurfaceViewportContext.js';
import { UI_COLORS } from '../constants/colors.js';
import { createDivider } from '../utils/uiHelpers.js';
import { useContentWidth } from '../hooks/useContentWidth.js';

export interface InteractiveSurfaceProps {
  /** Omit only when a multi-step workflow renders its own step title. */
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  tone?: string;
  /** Extra text shown on the title row, aligned after the title. */
  meta?: React.ReactNode;
  /** Keep wizard editors and choices visible within the terminal height. */
  scrollable?: boolean;
}

/**
 * The single visual shell for modal and selector states.
 *
 * Invariants:
 * - no border or minimum height;
 * - one horizontal boundary at the top;
 * - one title row, owned either here or by a multi-step workflow;
 * - workflow-specific content owns no duplicate outer padding or divider;
 * - hints are rendered once, through `footer`.
 */
export const InteractiveSurface: React.FC<InteractiveSurfaceProps> = ({
  title,
  description,
  children,
  footer,
  tone = UI_COLORS.TEXT_DEFAULT,
  meta,
  scrollable = false,
}) => {
  const width = useContentWidth();
  const rows = Math.max(4, useTerminalRows() - 2);
  const heading = useRef<DOMElement>(null);
  const ending = useRef<DOMElement>(null);
  const body = useRef<DOMElement>(null);
  const manualScroll = useRef(false);
  const active = useRef<{ node: DOMElement; row: number } | null>(null);
  const [layout, setLayout] = useState({ height: rows, offset: 0, content: rows });
  const update = useCallback(() => {
    const headerRows = heading.current ? measureElement(heading.current).height : 0;
    const footerRows = ending.current ? measureElement(ending.current).height : 0;
    const height = Math.max(1, rows - headerRows - footerRows);
    const contentRows = body.current ? measureElement(body.current).height : 0;
    const focusHeight = active.current?.node ? measureElement(active.current.node).height : 1;
    let top = 0;
    let node = active.current?.node;
    while (node && node !== body.current) {
      top += node.yogaNode?.getComputedTop() ?? 0;
      node = node.parentNode;
    }
    const focusRow = top + (active.current?.row ?? 0);
    setLayout(previous => {
      let offset = Math.min(previous.offset, Math.max(0, contentRows - height));
      if (node === body.current && !manualScroll.current) {
        const start = focusHeight <= height ? top : focusRow;
        const end = focusHeight <= height ? top + focusHeight : focusRow + 1;
        if (start < offset) offset = start;
        if (end > offset + height) offset = end - height;
      }
      return previous.height === height && previous.offset === offset && previous.content === contentRows ? previous : { height, offset, content: contentRows };
    });
  }, [rows]);
  const focus = useCallback((node: DOMElement, row: number) => {
    active.current = { node, row };
    update();
  }, [update]);
  useLayoutEffect(update);
  useInput((_input, key) => {
    if (key.eventType === 'release') return;
    if (key.pageUp || key.pageDown) {
      manualScroll.current = true;
      setLayout(previous => ({ ...previous, offset: Math.max(0,
        Math.min(Math.max(0, previous.content - previous.height),
          previous.offset + (key.pageUp ? -previous.height : previous.height))) }));
    } else {
      manualScroll.current = false;
    }
  }, { isActive: scrollable });
  const viewport = useMemo(() => ({ inputRows: Math.max(1, layout.height - 2), focus }), [layout.height, focus]);

  if (!scrollable) return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>{createDivider(Math.max(1, width - 2))}</Text>
      {title && <Text wrap="truncate-end"><Text color={tone} bold>{title}</Text>{meta && <Text dimColor> · {meta}</Text>}</Text>}
      {description && <Text dimColor>{description}</Text>}
      <Box flexDirection="column" marginTop={description ? 1 : 0}>{children}</Box>
      {footer}
    </Box>
  );
  return (
    <Box flexDirection="column" paddingX={1} flexShrink={0}>
      <Box ref={heading} flexDirection="column" flexShrink={0}>
      <Text dimColor>{createDivider(Math.max(1, width - 2))}</Text>
      {title && (
        <Text wrap="truncate-end">
          <Text color={tone} bold>{title}</Text>
          {meta && <Text dimColor> · {meta}</Text>}
        </Text>
      )}
      {description && <Text dimColor wrap="truncate-end">{description}</Text>}
      </Box>
      <SurfaceViewportContext.Provider value={viewport}>
        <Box height={Math.min(layout.height, layout.content)} maxHeight={layout.height} overflowY="hidden" flexDirection="column" flexShrink={0}>
          <Box ref={body} position="absolute" top={-layout.offset} width="100%" flexDirection="column">
            {children}
          </Box>
        </Box>
      </SurfaceViewportContext.Provider>
      <Box ref={ending} flexDirection="column" flexShrink={0}>
        {layout.content > layout.height && <Text dimColor>pgup/pgdn inspect</Text>}
        {footer}
      </Box>
    </Box>
  );
};
