/**
 * LibraryClearConfirmation - Confirmation prompt for clearing all saved prompts
 *
 * Shows a simple confirmation dialog before clearing all saved prompts.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { SelectionIndicator } from './SelectionIndicator.js';
import { ChickAnimation } from './ChickAnimation.js';
import { ModalContainer } from './ModalContainer.js';
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

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} width="100%">
      <ModalContainer borderColor={UI_COLORS.TEXT_DIM}>
        <Box minHeight={20} width="100%" flexDirection="column">
          {/* Header with ChickAnimation */}
          <Box marginBottom={1} flexDirection="row" gap={1}>
            <Text bold>
              <ChickAnimation />
            </Text>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Clear Saved Prompts
            </Text>
          </Box>

          {/* Warning message */}
          <Box marginBottom={1}>
            <Text>
              This will permanently delete <Text bold color={UI_COLORS.WARNING}>{promptCount} prompt{promptCount !== 1 ? 's' : ''}</Text>.
            </Text>
          </Box>

          {/* Additional warning */}
          <Box marginBottom={1}>
            <Text dimColor>This action cannot be undone.</Text>
          </Box>

          {/* Options */}
          <Box flexDirection="column" marginBottom={1}>
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

          {/* Footer separator and instructions */}
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text dimColor>↑↓: Navigate • Enter: Select • Esc: Cancel</Text>
          </Box>
        </Box>
      </ModalContainer>
    </Box>
  );
};
