/**
 * LibraryClearConfirmation - Confirmation prompt for clearing all saved prompts
 *
 * Shows a simple confirmation dialog before clearing all saved prompts.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { SelectionIndicator } from './SelectionIndicator.js';
import { Clickable } from './Clickable.js';
import { UI_COLORS } from '../constants/colors.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';

export interface LibraryClearConfirmationProps {
  /** Number of prompts that will be cleared */
  promptCount: number;
  /** Currently selected option index (0=Confirm, 1=Cancel) */
  selectedIndex: number;
  /** Whether the prompt is visible */
  visible?: boolean;
  /** Activate the option at an index, as a click on its row does. */
  onOptionPress?: (index: number) => void;
}

/**
 * LibraryClearConfirmation Component
 */
export const LibraryClearConfirmation: React.FC<LibraryClearConfirmationProps> = ({
  promptCount,
  selectedIndex,
  visible = true,
  onOptionPress,
}) => {
  if (!visible) {
    return null;
  }

  const options = ['Confirm', 'Cancel'];

  return (
    <InteractiveSurface
      title="Clear saved prompts"
      tone={UI_COLORS.WARNING}
      description={<>Permanently delete <Text bold color={UI_COLORS.WARNING}>{promptCount} prompt{promptCount !== 1 ? 's' : ''}</Text>. This cannot be undone.</>}
      footer={<KeyboardHintFooter action="select" />}
    >
          <Box flexDirection="column">
            {options.map((option, idx) => {
              const isSelected = idx === selectedIndex;
              const color = option === 'Confirm' ? UI_COLORS.WARNING : UI_COLORS.TEXT_DEFAULT;

              return (
                <Clickable key={idx} onPress={onOptionPress && (() => onOptionPress(idx))}>
                  <SelectionIndicator isSelected={isSelected}>
                    <Text color={color} bold={isSelected}>
                      {option}
                    </Text>
                  </SelectionIndicator>
                </Clickable>
              );
            })}
          </Box>

    </InteractiveSurface>
  );
};
