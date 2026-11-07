/** Pick a rewind point and show the files its restore review will affect. */
import React from 'react';
import { Box, Text } from 'ink';
import type { Message } from '@shared/index.js';
import type { PatchMetadata } from '@services/PatchManager.js';
import { selectorText } from '../utils/formatters.js';
import { formatMessageTime } from '../utils/timeUtils.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { Clickable } from './Clickable.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import type { SelectorLoadState } from './SelectorLoadStatus.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { centeredWindow, visibleItemBudget } from '../utils/layout.js';

export interface RewindSelectorProps {
  messages: Message[];
  selectedIndex: number;
  visible?: boolean;
  maxVisible?: number;
  patches?: PatchMetadata[];
  patchesLoadState?: SelectorLoadState;
  onOptionPress?: (index: number) => void;
}
const EMPTY_PATCHES: PatchMetadata[] = [];

export function RewindSelector({
  messages,
  selectedIndex,
  visible = true,
  maxVisible = 10,
  patches = EMPTY_PATCHES,
  patchesLoadState,
  onOptionPress,
}: RewindSelectorProps) {
  const rows = useTerminalRows();
  const width = Math.max(1, useContentWidth() - 4);
  const selected = Math.max(0, Math.min(messages.length - 1, selectedIndex));
  const window = centeredWindow(
    messages,
    selected,
    visibleItemBudget(rows, { chromeRows: 9, rowsPerItem: 2, maximum: maxVisible })
  );
  // Only visible targets need summaries. Parse each patch time once, rather
  // than scanning and parsing the full patch history for every user message.
  const changes = React.useMemo(() => {
    const targets = messages.slice(window.start, window.end);
    const files = targets.map(() => new Set<string>());
    for (const patch of patches) {
      const timestamp = new Date(patch.timestamp).getTime();
      if (!Number.isFinite(timestamp)) continue;
      for (let index = 0; index < targets.length; index++) {
        const targetTime = targets[index]?.timestamp;
        if (targetTime !== undefined && timestamp >= targetTime) files[index]!.add(patch.file_path);
      }
    }
    return files.map(paths => [...paths]);
  }, [messages, patches, window.start, window.end]);
  if (!visible) return null;
  if (!messages.length)
    return (
      <InteractiveSurface
        title="Rewind conversation"
        footer={<KeyboardHintFooter hints={[{ key: 'esc', label: 'close' }]} />}
      >
        <Text>No user messages to rewind to.</Text>
      </InteractiveSurface>
    );
  return (
    <InteractiveSurface
      title="Rewind conversation"
      meta={`${selected + 1} of ${messages.length}`}
      footer={<KeyboardHintFooter action="review" />}
    >
      {window.above > 0 && <Text dimColor>↑ {window.above} more</Text>}
      {window.items.map((message, index) => {
        const actualIndex = window.start + index;
        const paths = changes[index] ?? [];
        const summary =
          patchesLoadState?.kind === 'loading'
            ? 'Checking file changes…'
            : patchesLoadState?.kind === 'error'
              ? 'File changes unavailable · enter to retry review'
              : message.timestamp === undefined
                ? 'File changes unavailable for this timestamp'
                : paths.length === 0
                  ? 'No file changes to restore'
                  : paths.length === 1
                    ? `Review ${paths[0]}`
                    : `${paths.length} files to review`;
        return (
          <Clickable
            key={message.id ?? actualIndex}
            flexDirection="column"
            onPress={onOptionPress && (() => onOptionPress(actualIndex))}
          >
            <SelectionIndicator isSelected={actualIndex === selected}>
              {selectorText(`${formatMessageTime(message.timestamp)} · ${message.content || 'Empty message'}`, width)}
            </SelectionIndicator>
            <Box paddingLeft={2}>
              <Text dimColor wrap="truncate-end">
                {selectorText(summary, width)}
              </Text>
            </Box>
          </Clickable>
        );
      })}
      {window.below > 0 && <Text dimColor>↓ {window.below} more</Text>}
    </InteractiveSurface>
  );
}
