/**
 * Reflow the committed conversation history when the terminal width changes.
 *
 * Ink's <Static> writes the transcript to the terminal once and never re-renders
 * it, so on resize the already-committed lines keep the width they were drawn
 * at. Repainting them at the new width means clearing the screen + scrollback
 * and re-emitting everything (the atomic clear + Static-remount path that
 * compaction and rewind already use via `resetConversationView`).
 *
 * That repaint is only safe when the whole transcript fits the viewport. If the
 * re-emitted history is taller than the screen, the overflow scrolls past the
 * top and — because the scrollback was just cleared — becomes unreachable. So
 * this hook is LOSSLESS by construction: it reflows in either direction, but
 * only when a conservative height estimate confirms the transcript still fits.
 * When it does not fit, the committed history is left untouched and remains in
 * the terminal's native scrollback (wrapped at its original width, but
 * scrollable) rather than being clipped out of reach.
 *
 * The repaint is O(n) over the history, so it is debounced to coalesce the burst
 * of resize events fired while dragging a window edge.
 *
 * Scope: the main conversation only. It depends solely on pre-existing context
 * APIs and is intentionally agnostic to any background/alternate transcript
 * view, which owns its own repaint lifecycle.
 */

import { useEffect, useRef } from 'react';
import type { Message } from '@shared/index.js';
import { LAYOUT, TEXT_LIMITS } from '@config/constants.js';
import { wrapAnsiText } from '@utils/terminalText.js';
import { useTerminalContext } from '../contexts/TerminalContext.js';
import { useAppContext } from '../contexts/AppContext.js';

/** How long to wait after the last resize event before repainting. */
const REFLOW_DEBOUNCE_MS = 150;

/**
 * Rows reserved below the transcript for the live region (status indicator,
 * input prompt, footer, and the root padding). Kept generous so the fit check
 * stays conservative — over-reserving only skips a borderline reflow, it never
 * risks clipping history.
 */
const DYNAMIC_REGION_RESERVE = 8;

/**
 * Per-message slack added to the height estimate to cover markdown decorations
 * the raw-text wrap can't see (code-block borders/labels, table rule rows,
 * inter-paragraph blank lines).
 */
const MESSAGE_DECORATION_SLACK = 2;

/**
 * Conservatively decide whether the transcript, re-rendered at `contentWidth`,
 * fits within `budget` rendered rows. Over-estimates height and bails out as
 * soon as the budget is exceeded, so rejecting a tall transcript is cheap.
 */
function transcriptFits(messages: Message[], contentWidth: number, budget: number): boolean {
  let rows = 0;

  for (const message of messages) {
    const indent = message.role === 'user' ? 0 : LAYOUT.MESSAGE_INDENT;
    const width = Math.max(1, contentWidth - indent);
    const body = message.role === 'user' ? `> ${message.content ?? ''}` : message.content ?? '';

    // 1 row for the inter-item margin, plus decoration slack, plus the thinking
    // line when present, plus the wrapped body.
    rows += 1 + MESSAGE_DECORATION_SLACK;
    if (message.thinking) {
      rows += 1;
    }
    rows += wrapAnsiText(body, width).length;

    if (rows > budget) {
      return false;
    }
  }

  return rows <= budget;
}

export function useReflowOnResize(): void {
  const { contentWidth } = useTerminalContext();
  const { state, actions } = useAppContext();
  const { messages } = state;
  const { resetConversationView } = actions;

  // Latest values read at debounce-fire time, kept in refs so they don't
  // re-arm the timer on every message append.
  const widthRef = useRef(contentWidth);
  const messagesRef = useRef(messages);
  const resetRef = useRef(resetConversationView);

  // Width the committed transcript was last drawn at; used to skip a repaint
  // when a resize wiggle ends back at the current width.
  const lastReflowedWidthRef = useRef(contentWidth);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  widthRef.current = contentWidth;
  messagesRef.current = messages;
  resetRef.current = resetConversationView;

  useEffect(() => {
    // Re-arm a single debounce timer on every width change. The decision is made
    // at fire time using the latest width, so a wiggle back to the original
    // width performs no repaint.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const width = widthRef.current;

      // No net width change since the last paint → nothing to do.
      if (width === lastReflowedWidthRef.current) {
        return;
      }

      const msgs = messagesRef.current;
      if (msgs.length === 0) {
        lastReflowedWidthRef.current = width;
        return;
      }

      // Only reflow when the repaint is lossless. Otherwise leave the committed
      // history in native scrollback rather than clipping it out of reach.
      const terminalRows = process.stdout.rows || TEXT_LIMITS.TERMINAL_HEIGHT_FALLBACK;
      const budget = terminalRows - DYNAMIC_REGION_RESERVE;
      if (!transcriptFits(msgs, width, budget)) {
        return;
      }

      lastReflowedWidthRef.current = width;
      resetRef.current(msgs);
    }, REFLOW_DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [contentWidth]);
}
