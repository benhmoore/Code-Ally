/** Pick a saved conversation with a bounded, readable preview per row. */
import React from 'react';
import { Box, Text } from 'ink';
import type { SessionInfo } from '@shared/index.js';
import { formatRelativeTime } from '../utils/timeUtils.js';
import { selectorText } from '../utils/formatters.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { Clickable } from './Clickable.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { SelectorLoadStatus, type SelectorLoadState } from './SelectorLoadStatus.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { centeredWindow, visibleItemBudget } from '../utils/layout.js';

export interface SessionSelectorProps {
  loadState?: SelectorLoadState;
  onRetry?: () => void;
  sessions: SessionInfo[];
  selectedIndex: number;
  visible?: boolean;
  maxVisible?: number;
  onOptionPress?: (index: number) => void;
}

function shortenPath(path: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
}

export function SessionSelector({
  sessions,
  selectedIndex,
  loadState,
  onRetry,
  visible = true,
  maxVisible = 10,
  onOptionPress,
}: SessionSelectorProps) {
  const rows = useTerminalRows();
  const width = Math.max(1, useContentWidth() - 4);
  if (!visible) return null;
  if (loadState) return <SelectorLoadStatus title="Resume session" state={loadState} onRetry={onRetry} />;
  if (!sessions.length)
    return (
      <InteractiveSurface
        title="Resume session"
        footer={<KeyboardHintFooter hints={[{ key: 'esc', label: 'close' }]} />}
      >
        <Text>No saved sessions in this project.</Text>
        <Text dimColor>Start a conversation to create one.</Text>
      </InteractiveSurface>
    );
  const window = centeredWindow(
    sessions,
    selectedIndex,
    visibleItemBudget(rows, { chromeRows: 9, rowsPerItem: 3, maximum: maxVisible })
  );
  const selected = Math.max(0, Math.min(sessions.length - 1, selectedIndex));
  return (
    <InteractiveSurface
      title="Resume session"
      meta={`${selected + 1} of ${sessions.length}`}
      footer={<KeyboardHintFooter action="resume" />}
    >
      {window.above > 0 && <Text dimColor>↑ {window.above} more</Text>}
      {window.items.map((session, index) => {
        const actualIndex = window.start + index;
        return (
          <Clickable
            key={session.session_id}
            flexDirection="column"
            onPress={onOptionPress && (() => onOptionPress(actualIndex))}
          >
            <SelectionIndicator isSelected={actualIndex === selected}>
              {selectorText(session.display_name || 'Untitled session', width)}
            </SelectionIndicator>
            <Box paddingLeft={2} flexDirection="column">
              <Text wrap="truncate-end">{selectorText(session.lastUserMessage || 'No message preview', width)}</Text>
              <Text dimColor wrap="truncate-end">
                {selectorText(
                  `${session.message_count} messages · ${formatRelativeTime(session.last_modified_timestamp)} · ${shortenPath(session.working_dir)}`,
                  width
                )}
              </Text>
            </Box>
          </Clickable>
        );
      })}
      {window.below > 0 && <Text dimColor>↓ {window.below} more</Text>}
    </InteractiveSurface>
  );
}
