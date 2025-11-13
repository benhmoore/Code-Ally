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
        <Text color={color} bold>Permission required for </Text>
        <Text bold color={UI_COLORS.TEXT_DEFAULT}>{toolName}</Text>
      </Box>

      {/* Options */}
      {options.map((option, idx) => {
        const isSelected = idx === selectedIndex;

        return (
          <Box key={idx}>
            <SelectionIndicator isSelected={isSelected}>
              {option}
            </SelectionIndicator>
          </Box>
        );
      })}

      {/* Footer */}
      <KeyboardHintFooter action="confirm" cancelText="deny" />
    </Box>
  );
};
