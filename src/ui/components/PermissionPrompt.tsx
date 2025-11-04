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
import { Box, Text, useStdout } from 'ink';
import { PermissionChoice, SensitivityTier } from '../../agent/TrustManager.js';
import { TEXT_LIMITS } from '../../config/constants.js';

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
 * Get color based on sensitivity tier
 */
function getSensitivityColor(tier: SensitivityTier): string {
  switch (tier) {
    case SensitivityTier.EXTREMELY_SENSITIVE:
      return 'red';
    case SensitivityTier.SENSITIVE:
      return 'yellow';
    case SensitivityTier.NORMAL:
    default:
      return 'cyan';
  }
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
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || TEXT_LIMITS.TERMINAL_WIDTH_FALLBACK;

  // Create divider line
  const dividerWidth = Math.max(60, terminalWidth - 4);
  const divider = '─'.repeat(dividerWidth);

  return (
    <Box flexDirection="column">
      {/* Top divider */}
      <Box>
        <Text dimColor>{divider}</Text>
      </Box>

      {/* Header */}
      <Box marginY={1}>
        <Text color={color} bold>Permission Required for </Text>
        <Text bold color="cyan">{toolName}</Text>
      </Box>

      {/* Options */}
      {options.map((option, idx) => {
        const isSelected = idx === selectedIndex;

        return (
          <Box key={idx}>
            <Text color={isSelected ? 'green' : undefined} bold={isSelected}>
              {isSelected ? '> ' : '  '}
            </Text>
            <Text color={isSelected ? 'green' : undefined} bold={isSelected}>
              {option}
            </Text>
          </Box>
        );
      })}

      {/* Footer */}
      <Box marginTop={1}>
        <Text dimColor>
          ↑↓ navigate  •  Enter confirm  •  Esc/Ctrl+C deny
        </Text>
      </Box>
    </Box>
  );
};
