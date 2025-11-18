/**
 * LibraryClearConfirmation - Confirmation prompt for clearing all saved prompts
 *
 * Shows a simple confirmation dialog before clearing all saved prompts.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { SelectionIndicator } from './SelectionIndicator.js';
import { createDivider } from '../utils/uiHelpers.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { UI_COLORS } from '../constants/colors.js';

export interface LibraryClearConfirmationProps {
  /** Number of prompts that will be cleared */
  promptCount: number;
  /** Currently selected option index (0=Confirm, 1=Cancel) */
  selectedIndex: number;
  /** Whether the prompt is visible */
  visible?: boolean;
}

/**
 * LibraryClearConfirmation Component
 */
export const LibraryClearConfirmation: React.FC<LibraryClearConfirmationProps> = ({
  promptCount,
  selectedIndex,
  visible = true,
}) => {
  if (!visible) {
    return null;
  }

  const options = ['Confirm', 'Cancel'];
  const terminalWidth = useContentWidth();
  const divider = createDivider(terminalWidth);

  return (
    <Box flexDirection="column">
      {/* Top divider */}
      <Box>
        <Text dimColor>{divider}</Text>
      </Box>

      {/* Header */}
      <Box marginY={1}>
        <Text color={UI_COLORS.WARNING} bold>
          Clear Saved Prompts
        </Text>
      </Box>

      {/* Warning message */}
      <Box marginBottom={1}>
        <Text>
          This will permanently delete <Text bold color={UI_COLORS.WARNING}>{promptCount} prompt{promptCount !== 1 ? 's' : ''}</Text>.
        </Text>
      </Box>

      <Box marginBottom={1}>
        <Text dimColor>This action cannot be undone.</Text>
      </Box>

      {/* Options */}
      <Box marginBottom={1} flexDirection="column">
        {options.map((option, idx) => {
          const isSelected = idx === selectedIndex;
          const color = option === 'Confirm' ? UI_COLORS.WARNING : UI_COLORS.TEXT_DEFAULT;

          return (
            <Box key={idx}>
              <SelectionIndicator isSelected={isSelected}>
                <Text color={color} bold={isSelected}>
                  {option}
                </Text>
              </SelectionIndicator>
            </Box>
          );
        })}
      </Box>

      {/* Bottom divider */}
      <Box marginBottom={1}>
        <Text dimColor>{divider}</Text>
      </Box>

      {/* Keyboard hints */}
      <Box>
        <Text dimColor>↑↓: Navigate  Enter: Select  Esc: Cancel</Text>
      </Box>
    </Box>
  );
};
