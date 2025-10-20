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
 * Get icon based on sensitivity tier
 */
function getSensitivityIcon(tier: SensitivityTier): string {
  switch (tier) {
    case SensitivityTier.EXTREMELY_SENSITIVE:
      return '!';
    case SensitivityTier.SENSITIVE:
      return '*';
    case SensitivityTier.NORMAL:
    default:
      return 'i';
  }
}

/**
 * Get choice icon
 */
function getChoiceIcon(choice: PermissionChoice): string {
  switch (choice) {
    case PermissionChoice.ALLOW:
      return '+';
    case PermissionChoice.DENY:
      return 'x';
    case PermissionChoice.ALWAYS_ALLOW:
      return '++';
    default:
      return '-';
  }
}

/**
 * Get choice color
 */
function getChoiceColor(choice: PermissionChoice): string {
  switch (choice) {
    case PermissionChoice.ALLOW:
      return 'green';
    case PermissionChoice.DENY:
      return 'red';
    case PermissionChoice.ALWAYS_ALLOW:
      return 'blue';
    default:
      return 'white';
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

  const { toolName, path, command, arguments: args, sensitivity, options } = request;
  const color = getSensitivityColor(sensitivity);
  const sensitivityLabel =
    sensitivity === SensitivityTier.EXTREMELY_SENSITIVE ? 'DANGEROUS' :
    sensitivity === SensitivityTier.SENSITIVE ? 'SENSITIVE' : 'NORMAL';

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header Box */}
      <Box
        borderStyle="round"
        borderColor={color}
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        {/* Title */}
        <Box marginBottom={1}>
          <Text color={color} bold>
            [{getSensitivityIcon(sensitivity)}] Permission Required - {sensitivityLabel}
          </Text>
        </Box>

        {/* Operation Details */}
        <Box flexDirection="column" gap={0}>
          {/* Tool name */}
          <Box>
            <Text dimColor>Tool: </Text>
            <Text bold color="cyan">{toolName}</Text>
          </Box>

          {/* Path */}
          {path && (
            <Box>
              <Text dimColor>Path: </Text>
              <Text color="yellow">{path}</Text>
            </Box>
          )}

          {/* Command */}
          {command && (
            <Box marginTop={1}>
              <Text dimColor>Command:</Text>
              <Box marginLeft={2} marginTop={0}>
                <Text color="magenta">{command}</Text>
              </Box>
            </Box>
          )}

          {/* Arguments */}
          {args && Object.keys(args).length > 0 && (
            <Box marginTop={1} flexDirection="column">
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
        </Box>

        {/* Warning for dangerous operations */}
        {sensitivity === SensitivityTier.EXTREMELY_SENSITIVE && (
          <Box marginTop={1} paddingX={1} paddingY={0}>
            <Text color="red" bold>
              ! WARNING: Potentially destructive operation
            </Text>
          </Box>
        )}
      </Box>

      {/* Options Box */}
      <Box
        borderStyle="round"
        borderColor="gray"
        paddingX={2}
        paddingY={1}
        marginTop={1}
        flexDirection="column"
      >
        <Box marginBottom={1}>
          <Text bold>Select action:</Text>
        </Box>

        {options.map((option, idx) => {
          const isSelected = idx === selectedIndex;
          const choiceColor = getChoiceColor(option);

          // Get description
          let description = '';
          if (option === PermissionChoice.ALLOW) description = 'once';
          else if (option === PermissionChoice.ALWAYS_ALLOW) description = 'session';
          else if (option === PermissionChoice.DENY) description = 'cancel';

          return (
            <Box key={idx}>
              <Text color={isSelected ? 'green' : undefined} bold={isSelected}>
                {isSelected ? '> ' : '  '}
              </Text>
              <Text color={choiceColor} bold={isSelected}>
                [{getChoiceIcon(option)}] {option}
              </Text>
              {description && (
                <Text dimColor={!isSelected}> ({description})</Text>
              )}
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
