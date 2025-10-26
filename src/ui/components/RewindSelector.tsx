/**
 * RewindSelector - Interactive conversation rewind prompt
 *
 * Shows user messages chronologically with keyboard navigation
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Message } from '../../types/index.js';
import { TEXT_LIMITS } from '../../config/constants.js';

export interface RewindSelectorProps {
  /** User messages only (pre-filtered) */
  messages: Message[];
  /** Currently selected message index */
  selectedIndex: number;
  /** Whether the prompt is visible */
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
 * RewindSelector Component
 */
export const RewindSelector: React.FC<RewindSelectorProps> = ({
  messages,
  selectedIndex,
  visible = true,
  maxVisible = 10,
}) => {
  if (!visible) {
    return null;
  }

  // Messages are already pre-filtered to user messages only
  const userMessages = messages;

  if (userMessages.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box
          borderStyle="round"
          borderColor="cyan"
          paddingX={2}
          paddingY={1}
          flexDirection="column"
        >
          <Text color="yellow">No user messages to rewind to</Text>
        </Box>
      </Box>
    );
  }

  // Calculate windowing
  const totalMessages = userMessages.length;
  const showScrollIndicators = totalMessages > maxVisible;

  let startIdx = 0;
  let endIdx = totalMessages;

  if (showScrollIndicators) {
    // Center selected item in window
    const halfWindow = Math.floor(maxVisible / 2);
    startIdx = Math.max(0, selectedIndex - halfWindow);
    endIdx = Math.min(totalMessages, startIdx + maxVisible);

    // Adjust if we're at the end
    if (endIdx === totalMessages) {
      startIdx = Math.max(0, endIdx - maxVisible);
    }
  }

  const visibleMessages = userMessages.slice(startIdx, endIdx);
  const hasMoreAbove = startIdx > 0;
  const hasMoreBelow = endIdx < totalMessages;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        {/* Header */}
        <Box marginBottom={1}>
          <Text color="cyan" bold>
            Rewind Conversation
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>Select a prompt to rewind to ({totalMessages} messages):</Text>
        </Box>

        {/* Scroll indicator - more above */}
        {hasMoreAbove && (
          <Box>
            <Text dimColor>  ↑ {startIdx} more...</Text>
          </Box>
        )}

        {/* Message list */}
        {visibleMessages.map((msg, idx) => {
          const actualIndex = startIdx + idx;
          const isSelected = actualIndex === selectedIndex;
          const time = formatTime((msg as any).timestamp);
          const content = truncateContent(msg.content);

          return (
            <Box key={actualIndex}>
              <Text color={isSelected ? 'green' : undefined} bold={isSelected}>
                {isSelected ? '> ' : '  '}
              </Text>
              <Text color={isSelected ? 'green' : 'gray'} bold={isSelected}>
                {time}
              </Text>
              <Text color={isSelected ? 'green' : undefined} bold={isSelected}>
                {' - '}
                {content}
              </Text>
            </Box>
          );
        })}

        {/* Scroll indicator - more below */}
        {hasMoreBelow && (
          <Box>
            <Text dimColor>  ↓ {totalMessages - endIdx} more...</Text>
          </Box>
        )}

        {/* Footer */}
        <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
          <Text dimColor>
            ↑↓ navigate  •  Enter rewind  •  Esc/Ctrl+C cancel
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
