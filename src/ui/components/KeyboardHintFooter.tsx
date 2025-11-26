/**
 * KeyboardHintFooter Component
 *
 * Standardizes keyboard navigation hints across all modal components.
 *
 * Purpose:
 * - Provides consistent footer layout with keyboard shortcuts
 * - Shows navigation hints (↑↓), action hint (Enter), and cancel hint (Esc/Ctrl+C)
 * - Maintains visual consistency with border separator and dimmed text
 *
 * Usage:
 * ```tsx
 * <KeyboardHintFooter action="select" />
 * <KeyboardHintFooter action="continue" cancelText="skip" />
 * ```
 */

import React from 'react';
import { Box, Text } from 'ink';
import { UI_SYMBOLS } from '@config/uiSymbols.js';

export interface KeyboardHintFooterProps {
  /** Action verb to display after "Enter" (e.g., "select", "continue", "confirm") */
  action: string;
  /** Cancel action text (default: "cancel") */
  cancelText?: string;
  /** Whether auto-allow mode is enabled (for permission prompts) */
  autoAllowMode?: boolean;
}

/**
 * KeyboardHintFooter Component
 *
 * Displays standardized keyboard navigation hints at the bottom of modal dialogs.
 * Format: "↑↓ navigate  •  Enter {action}  •  Esc/Ctrl+C {cancelText}"
 */
const KeyboardHintFooterComponent: React.FC<KeyboardHintFooterProps> = ({
  action,
  cancelText = 'cancel',
  autoAllowMode,
}) => {
  return (
    <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
      <Text dimColor>
        {UI_SYMBOLS.NAVIGATION.ARROW_UP}
        {UI_SYMBOLS.NAVIGATION.ARROW_DOWN} navigate {UI_SYMBOLS.SEPARATOR.BULLET} Enter {action}{' '}
        {UI_SYMBOLS.SEPARATOR.BULLET} Esc/Ctrl+C {cancelText}
        {autoAllowMode !== undefined
          ? `  ${UI_SYMBOLS.SEPARATOR.BULLET}  Shift+Tab auto-allow [${autoAllowMode ? 'ON' : 'OFF'}]`
          : ''}
      </Text>
    </Box>
  );
};

/**
 * Memoized KeyboardHintFooter
 *
 * Prevents unnecessary re-renders when props haven't changed.
 * Footer content is typically static, making memoization highly effective.
 */
export const KeyboardHintFooter = React.memo(KeyboardHintFooterComponent);
