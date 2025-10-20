import React from 'react';
import { Box, Text } from 'ink';

interface StatusLineProps {
  /** Context usage as percentage (0-100) */
  contextUsagePercent: number;
  /** Number of active tool calls */
  activeToolCount: number;
  /** Model name to display */
  modelName?: string;
  /** Whether to always show the status line */
  alwaysShow?: boolean;
}

/**
 * StatusLine Component
 *
 * Displays context and execution status at the top of the interface.
 *
 * Display Information:
 * - Context usage: Color-coded percentage (green < 70%, yellow 70-90%, red > 90%)
 * - Active tools: Count of currently executing tools
 * - Model name: Current LLM model (truncated to 5 chars like Python version)
 *
 * Layout: Single line, right-aligned, minimal and non-intrusive
 *
 * Color Coding (matches Python UIManager thresholds):
 * - Green: 0-69% context used
 * - Yellow: 70-89% context used
 * - Red: 90-100% context used
 */
export const StatusLine: React.FC<StatusLineProps> = ({
  contextUsagePercent,
  activeToolCount,
  modelName,
  alwaysShow = false,
}) => {
  // Determine context color based on usage
  const getContextColor = (): string => {
    if (contextUsagePercent >= 90) return 'red';
    if (contextUsagePercent >= 70) return 'yellow';
    return 'green';
  };

  // Truncate model name to 5 chars (matching Python behavior)
  const truncatedModel = modelName
    ? modelName.slice(0, 5)
    : 'model';

  // Calculate remaining percentage (user-facing)
  const remainingPercent = 100 - contextUsagePercent;

  // Only show status if context is significant or alwaysShow is true
  const shouldShow = alwaysShow || contextUsagePercent >= 50;

  if (!shouldShow) {
    return null;
  }

  const contextColor = getContextColor();

  return (
    <Box justifyContent="flex-end" paddingBottom={1}>
      {/* Model name */}
      {modelName && (
        <Box marginRight={2}>
          <Text dimColor color="yellow">
            {truncatedModel}
          </Text>
        </Box>
      )}

      {/* Context usage */}
      <Box marginRight={2}>
        <Text color={contextColor}>
          ({remainingPercent}% remaining)
        </Text>
      </Box>

      {/* Active tool count */}
      {activeToolCount > 0 && (
        <Box>
          <Text color="cyan" dimColor>
            {activeToolCount} tool{activeToolCount !== 1 ? 's' : ''} active
          </Text>
        </Box>
      )}
    </Box>
  );
};
