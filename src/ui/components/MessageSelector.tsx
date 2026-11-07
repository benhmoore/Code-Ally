/** Pick a previous message or create an empty reusable prompt. */
import React from 'react';
import { Text } from 'ink';
import type { Message } from '@shared/index.js';
import { formatMessageTime } from '../utils/timeUtils.js';
import { selectorText } from '../utils/formatters.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { Clickable } from './Clickable.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { centeredWindow, visibleItemBudget } from '../utils/layout.js';

export interface MessageSelectorProps {
  messages: Message[];
  selectedIndex: number;
  visible?: boolean;
  maxVisible?: number;
  onOptionPress?: (index: number) => void;
}

export function MessageSelector({
  messages,
  selectedIndex,
  visible = true,
  maxVisible = 10,
  onOptionPress,
}: MessageSelectorProps) {
  const rows = useTerminalRows();
  const width = Math.max(1, useContentWidth() - 4);
  if (!visible) return null;
  const selected = Math.max(0, Math.min(messages.length - 1, selectedIndex));
  const window = centeredWindow(messages, selected, visibleItemBudget(rows, { chromeRows: 9, maximum: maxVisible }));
  const hints = messages.length
    ? [
        { key: '↑↓', label: 'move' },
        { key: 'enter', label: 'use' },
        { key: 'n', label: 'new' },
        { key: 'esc', label: 'cancel' },
      ]
    : [
        { key: 'n', label: 'new' },
        { key: 'esc', label: 'close' },
      ];
  return (
    <InteractiveSurface
      title="Create prompt from message"
      meta={messages.length ? `${selected + 1} of ${messages.length}` : undefined}
      footer={<KeyboardHintFooter hints={hints} />}
    >
      {!messages.length && <Text>No previous user messages. Press n to write a new prompt.</Text>}
      {window.above > 0 && <Text dimColor>↑ {window.above} more</Text>}
      {window.items.map((message, index) => {
        const actualIndex = window.start + index;
        return (
          <Clickable key={message.id ?? actualIndex} onPress={onOptionPress && (() => onOptionPress(actualIndex))}>
            <SelectionIndicator isSelected={actualIndex === selected}>
              {selectorText(`${formatMessageTime(message.timestamp)} · ${message.content || 'Empty message'}`, width)}
            </SelectionIndicator>
          </Clickable>
        );
      })}
      {window.below > 0 && <Text dimColor>↓ {window.below} more</Text>}
    </InteractiveSurface>
  );
}
