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
import { BUFFER_SIZES, TEXT_LIMITS } from '../../config/constants.js';

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
 * Format tool call arguments as a single line preview
 */
function formatToolCallPreview(toolName: string, args?: Record<string, any>): string {
  if (!args || Object.keys(args).length === 0) {
    return `${toolName}()`;
  }

  const argPairs = Object.entries(args)
    .slice(0, BUFFER_SIZES.TOP_ITEMS_PREVIEW)
    .map(([key, value]) => {
      const valueStr = String(value).slice(0, TEXT_LIMITS.TOOL_PARAM_VALUE_MAX);
      // Add ellipsis if truncated
      const truncated = String(value).length > TEXT_LIMITS.TOOL_PARAM_VALUE_MAX;
      return `${key}=${JSON.stringify(truncated ? valueStr + '...' : valueStr)}`;
    });

  const moreCount = Object.keys(args).length - BUFFER_SIZES.TOP_ITEMS_PREVIEW;
  if (moreCount > 0) {
    argPairs.push(`...+${moreCount} more`);
  }

  return `${toolName}(${argPairs.join(', ')})`;
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
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || TEXT_LIMITS.TERMINAL_WIDTH_FALLBACK;

  // Create divider line
  const dividerWidth = Math.max(60, terminalWidth - 4);
  const divider = '─'.repeat(dividerWidth);

  // Format tool call preview
  const toolPreview = formatToolCallPreview(toolName, args);

  return (
    <Box flexDirection="column">
      {/* Top divider */}
      <Box>
        <Text dimColor>{divider}</Text>
      </Box>

      {/* Tool call preview */}
      <Box marginY={1}>
        <Text color={color} bold>Permission Required: </Text>
        <Text bold color="cyan">{toolPreview}</Text>
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
