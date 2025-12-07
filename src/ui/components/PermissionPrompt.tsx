/**
 * PermissionPrompt - Interactive permission modal with keyboard navigation
 *
 * Features:
 * - Keyboard navigation (up/down arrows, Enter to select)
 * - Visual selection indicator
 * - Sensitivity-based warning colors
 * - Operation details display
 * - Similar UX to Python/Rich implementation
 */

import React from 'react';
import { Box, Text } from 'ink';
import { PermissionChoice, SensitivityTier } from '@agent/TrustManager.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { createDivider } from '../utils/uiHelpers.js';
import { UI_COLORS } from '../constants/colors.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { TextInput } from './TextInput.js';

export interface PermissionRequest {
  /** Tool or command requesting permission */
  toolName: string;
  /** Optional path or command details */
  path?: string;
  /** Command being executed (for bash operations) */
  command?: string;
  /** Operation arguments */
  arguments?: Record<string, any>;
  /** Sensitivity level of the operation */
  sensitivity: SensitivityTier;
  /** Available permission choices */
  options: PermissionChoice[];
}

export interface PermissionPromptProps {
  /** Permission request details */
  request: PermissionRequest;
  /** Currently selected option index */
  selectedIndex: number;
  /** Whether the prompt is visible */
  visible?: boolean;
  /** Whether auto-allow mode is enabled */
  autoAllowMode?: boolean;
  /** Current instruction text for INSTRUCT option */
  instructText: string;
  /** Callback when instruction text changes */
  onInstructTextChange: (text: string) => void;
  /** Cursor position for TextInput */
  cursorPosition?: number;
  /** Cursor position change callback */
  onCursorChange?: (position: number) => void;
  /** Number of permissions in the queue */
  queueLength?: number;
}

/**
 * Get color based on sensitivity tier - always returns yellow per design system
 */
function getSensitivityColor(_tier: SensitivityTier): string {
  // Always use primary color (yellow) for permission titles regardless of sensitivity
  return UI_COLORS.PRIMARY;
}

/**
 * PermissionPrompt Component
 */
export const PermissionPrompt: React.FC<PermissionPromptProps> = ({
  request,
  selectedIndex,
  visible = true,
  autoAllowMode,
  instructText,
  onInstructTextChange,
  cursorPosition = 0,
  onCursorChange = () => {},
  queueLength,
}) => {
  if (!visible) {
    return null;
  }

  const { toolName, sensitivity, options } = request;
  const color = getSensitivityColor(sensitivity);
  const terminalWidth = useContentWidth();

  // Create divider line
  const divider = createDivider(terminalWidth);

  return (
    <Box flexDirection="column">
      {/* Top divider */}
      <Box>
        <Text dimColor>{divider}</Text>
      </Box>

      {/* Header */}
      <Box marginY={1}>
        <Text color={color} bold>
          Permission required for{' '}
        </Text>
        <Text bold color={UI_COLORS.TEXT_DEFAULT}>
          {toolName}
        </Text>
        {queueLength && queueLength > 1 && (
          <Text dimColor> (1 of {queueLength})</Text>
        )}
      </Box>

      {/* Auto-allow indicator (when enabled) */}
      {autoAllowMode && (
        <Box marginBottom={1}>
          <Text dimColor>Auto-allow mode: ON (non-destructive commands will auto-approve - toggle with Shift+Tab)</Text>
        </Box>
      )}

      {/* Options */}
      {options.map((option, idx) => {
        const isSelected = idx === selectedIndex;
        // INSTRUCT options are dynamic strings like "Tell Assistant what to do instead..."
        const isInstructOption = typeof option === 'string' && option.startsWith('Tell ') && option.endsWith('...');

        return (
          <Box key={idx} flexDirection="row">
            {/* For INSTRUCT option when selected, show chevron + TextInput */}
            {isInstructOption && isSelected ? (
              <>
                <Text color={UI_COLORS.PRIMARY}>{UI_SYMBOLS.NAVIGATION.CHEVRON_RIGHT} </Text>
                <TextInput
                  value={instructText}
                  onValueChange={onInstructTextChange}
                  cursorPosition={cursorPosition}
                  onCursorChange={onCursorChange}
                  onSubmit={() => {}}
                  isActive={true}
                  bordered={false}
                  placeholder={option}
                />
              </>
            ) : (
              /* For all other options, or INSTRUCT when not selected, show static text */
              <SelectionIndicator isSelected={isSelected}>
                {option}
              </SelectionIndicator>
            )}
          </Box>
        );
      })}

      {/* Footer */}
      <KeyboardHintFooter action="confirm" cancelText="deny" />
    </Box>
  );
};
