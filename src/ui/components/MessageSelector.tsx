/**
 * MessageSelector - Select a previous user message for prompt content
 *
 * Shows user messages chronologically with keyboard navigation.
 * Used when creating prompts to pre-fill content from conversation history.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Message } from '@shared/index.js';
import { TEXT_LIMITS } from '@config/constants.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { UI_COLORS } from '../constants/colors.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { centeredWindow, visibleItemBudget } from '../utils/layout.js';

export interface MessageSelectorProps {
  /** User messages only (pre-filtered) */
  messages: Message[];
  /** Currently selected message index */
  selectedIndex: number;
  /** Whether the selector is visible */
  visible?: boolean;
  /** Maximum visible items before windowing */
  maxVisible?: number;
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp?: number): string {
  if (!timestamp) return '??:??';
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Truncate message content for display
 */
function truncateContent(content: string, maxLength: number = TEXT_LIMITS.DESCRIPTION_MAX): string {
  const firstLine = content.split('\n')[0] || '';
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.slice(0, maxLength - 3) + '...';
}

/**
 * MessageSelector Component
 */
export const MessageSelector: React.FC<MessageSelectorProps> = ({
  messages,
  selectedIndex,
  visible = true,
  maxVisible = 10,
}) => {
  const terminalRows = useTerminalRows();
  const visibleCount = Math.min(
    maxVisible,
    visibleItemBudget(terminalRows, { chromeRows: 9, maximum: maxVisible })
  );

  if (!visible) {
    return null;
  }

  const totalMessages = messages.length;
  const window = centeredWindow(messages, selectedIndex, visibleCount);

  return (
    <InteractiveSurface
      title="Create prompt from message"
      meta={`${totalMessages}`}
      footer={<KeyboardHintFooter hints={[{ key: '↑↓', label: 'move' }, { key: 'enter', label: 'use' }, { key: 'n', label: 'new' }, { key: 'esc', label: 'cancel' }]} />}
    >
      {window.above > 0 && <Text dimColor>  ↑ {window.above} more</Text>}
      {window.items.map((msg, idx) => {
        const actualIndex = window.start + idx;
        const isSelected = actualIndex === selectedIndex;
        const timestamp = formatTime(msg.timestamp);
        const preview = truncateContent(msg.content, 80);

        return (
          <Box key={actualIndex} marginBottom={0}>
            <SelectionIndicator isSelected={isSelected}>
              <Text color={UI_COLORS.TEXT_DIM} bold={isSelected}>{timestamp}</Text>
              <Text bold={isSelected}> - {preview}</Text>
            </SelectionIndicator>
          </Box>
        );
      })}

      {window.below > 0 && <Text dimColor>  ↓ {window.below} more</Text>}
    </InteractiveSurface>
  );
};
