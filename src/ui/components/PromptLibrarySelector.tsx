/** Pick a reusable prompt without wrapping its preview outside the viewport. */
import React from 'react';
import { Box, Text } from 'ink';
import type { PromptInfo } from '@shared/index.js';
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

export interface PromptLibrarySelectorProps {
  loadState?: SelectorLoadState;
  onRetry?: () => void;
  prompts: PromptInfo[];
  selectedIndex: number;
  visible?: boolean;
  maxVisible?: number;
  onOptionPress?: (index: number) => void;
}

export function PromptLibrarySelector({
  prompts,
  selectedIndex,
  loadState,
  onRetry,
  visible = true,
  maxVisible = 10,
  onOptionPress,
}: PromptLibrarySelectorProps) {
  const rows = useTerminalRows();
  const width = Math.max(1, useContentWidth() - 4);
  if (!visible) return null;
  if (loadState) return <SelectorLoadStatus title="Prompt library" state={loadState} onRetry={onRetry} />;
  if (!prompts.length)
    return (
      <InteractiveSurface
        title="Prompt library"
        footer={<KeyboardHintFooter hints={[{ key: 'esc', label: 'close' }]} />}
      >
        <Text>No saved prompts.</Text>
        <Text dimColor>Use /prompt add to create one.</Text>
      </InteractiveSurface>
    );
  const selected = Math.max(0, Math.min(prompts.length - 1, selectedIndex));
  const window = centeredWindow(
    prompts,
    selected,
    visibleItemBudget(rows, { chromeRows: 9, rowsPerItem: 3, maximum: maxVisible })
  );
  return (
    <InteractiveSurface
      title="Prompt library"
      meta={`${selected + 1} of ${prompts.length}`}
      footer={<KeyboardHintFooter action="use" />}
    >
      {window.above > 0 && <Text dimColor>↑ {window.above} more</Text>}
      {window.items.map((prompt, index) => {
        const actualIndex = window.start + index;
        const tags = prompt.tags?.length ? ` · ${prompt.tags.join(', ')}` : '';
        return (
          <Clickable
            key={prompt.id}
            flexDirection="column"
            onPress={onOptionPress && (() => onOptionPress(actualIndex))}
          >
            <SelectionIndicator isSelected={actualIndex === selected}>
              {selectorText(prompt.title || 'Untitled prompt', width)}
            </SelectionIndicator>
            <Box paddingLeft={2} flexDirection="column">
              <Text wrap="truncate-end">{selectorText(prompt.content || 'Empty prompt', width)}</Text>
              <Text dimColor wrap="truncate-end">
                {selectorText(`${formatRelativeTime(prompt.createdAt)}${tags}`, width)}
              </Text>
            </Box>
          </Clickable>
        );
      })}
      {window.below > 0 && <Text dimColor>↓ {window.below} more</Text>}
    </InteractiveSurface>
  );
}
