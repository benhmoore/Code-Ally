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
import { createDivider } from '../utils/uiHelpers.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { UI_COLORS } from '../constants/colors.js';

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
  const contentWidth = useContentWidth();

  if (!visible) {
    return null;
  }

  // Windowing logic (identical to RewindSelector)
  const totalMessages = messages.length;
  const showScrollIndicators = totalMessages > maxVisible;

  // Calculate visible window
  let startIdx = 0;
  let endIdx = totalMessages;

  if (showScrollIndicators) {
    // Keep selected item in middle of window when possible
    const halfWindow = Math.floor(maxVisible / 2);
    startIdx = Math.max(0, selectedIndex - halfWindow);
    endIdx = Math.min(totalMessages, startIdx + maxVisible);

    // Adjust start if we're near the end
    if (endIdx === totalMessages && totalMessages > maxVisible) {
      startIdx = Math.max(0, totalMessages - maxVisible);
    }
  }

  const visibleMessages = messages.slice(startIdx, endIdx);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color={UI_COLORS.TEXT_DEFAULT}>
          Create Prompt from Message
        </Text>
      </Box>

      {/* Divider */}
      <Box marginBottom={1}>
        <Text dimColor>{createDivider(contentWidth)}</Text>
      </Box>

      {/* Instructions */}
      <Box marginBottom={1}>
        <Text dimColor>
          Select a message to use as prompt content ({totalMessages} message{totalMessages !== 1 ? 's' : ''}):
        </Text>
      </Box>

      {/* Scroll indicator (top) */}
      {showScrollIndicators && startIdx > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>... {startIdx} more above ...</Text>
        </Box>
      )}

      {/* Message list */}
      {visibleMessages.map((msg, idx) => {
        const actualIndex = startIdx + idx;
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

      {/* Scroll indicator (bottom) */}
      {showScrollIndicators && endIdx < totalMessages && (
        <Box marginTop={1}>
          <Text dimColor>... {totalMessages - endIdx} more below ...</Text>
        </Box>
      )}

      {/* Divider */}
      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>{createDivider(contentWidth)}</Text>
      </Box>

      {/* Keyboard hints */}
      <Box flexDirection="column">
        <Text dimColor>↑↓: Navigate  Enter: Select  N: New prompt  Esc: Cancel</Text>
      </Box>
    </Box>
  );
};
