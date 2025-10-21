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
import { PermissionChoice, SensitivityTier } from '../../agent/TrustManager.js';

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

  const { toolName, arguments: args, sensitivity, options } = request;
  const color = getSensitivityColor(sensitivity);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box
        borderStyle="round"
        borderColor={color}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        {/* Header */}
        <Box marginBottom={1}>
          <Text color={color} bold>
            Permission Required
          </Text>
        </Box>

        {/* Tool */}
        <Box marginBottom={1}>
          <Text dimColor>Tool: </Text>
          <Text bold color="cyan">{toolName}</Text>
        </Box>

        {/* Arguments */}
        {args && Object.keys(args).length > 0 && (
          <Box marginBottom={1} flexDirection="column">
            <Text dimColor>Arguments:</Text>
            {Object.entries(args).slice(0, 3).map(([key, value]) => (
              <Box key={key} marginLeft={2}>
                <Text dimColor>{key}: </Text>
                <Text>{String(value).slice(0, 45)}</Text>
              </Box>
            ))}
            {Object.keys(args).length > 3 && (
              <Box marginLeft={2}>
                <Text dimColor>...+{Object.keys(args).length - 3} more</Text>
              </Box>
            )}
          </Box>
        )}

        {/* Select Action */}
        <Box marginBottom={1}>
          <Text dimColor>Select action:</Text>
        </Box>

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
        <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
          <Text dimColor>
            ↑↓ navigate  •  Enter confirm  •  Esc/Ctrl+C deny
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
