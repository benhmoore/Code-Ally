import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { AnimationTicker } from '../../services/AnimationTicker.js';

interface StatusLineProps {
  /** Context usage as percentage (0-100) */
  contextUsagePercent: number;
  /** Number of active tool calls */
  activeToolCount: number;
  /** Model name to display */
  modelName?: string;
  /** Whether to always show the status line */
  alwaysShow?: boolean;
  /** Current agent name */
  agent?: string;
  /** Active sub-agents */
  subAgents?: string[];
}

/**
 * Spinner frames for animation
 */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * StatusLine Component
 *
 * Displays context and execution status at the top of the interface.
 *
 * Display Information:
 * - Context usage: Color-coded percentage (green < 70%, yellow 70-90%, red > 90%)
 * - Active tools: Count of currently executing tools
 * - Model name: Current LLM model (truncated to 5 chars like Python version)
 * - Agent activity: Shows current agent and sub-agents with animated spinner
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
  agent,
  subAgents,
}) => {
  const [, forceUpdate] = useState({});
  const ticker = AnimationTicker.getInstance();

  // Subscribe to animation ticker when agent or tools are active
  useEffect(() => {
    if (agent || activeToolCount > 0) {
      const unsubscribe = ticker.subscribe(() => {
        forceUpdate({});
      });
      return unsubscribe;
    }
    return undefined;
  }, [agent, activeToolCount, ticker]);

  const frame = ticker.getFrame() % SPINNER_FRAMES.length;

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
    <Box justifyContent="space-between" paddingBottom={1}>
      {/* Left side: Agent activity */}
      <Box>
        {agent && (
          <Box>
            <Text color="cyan">{SPINNER_FRAMES[frame]} {agent}</Text>
            {subAgents && subAgents.length > 0 && (
              <Text dimColor> → {subAgents.join(', ')}</Text>
            )}
          </Box>
        )}
      </Box>

      {/* Right side: Context and model info */}
      <Box>
        {/* Context usage (only show if significant) */}
        {contextUsagePercent >= 70 && (
          <Box marginRight={2}>
            <Text color={contextColor}>
              Context: {remainingPercent}%
            </Text>
          </Box>
        )}

        {/* Model name */}
        {modelName && (
          <Box marginRight={2}>
            <Text dimColor color="yellow">
              {truncatedModel}
            </Text>
          </Box>
        )}

        {/* Active tool count with spinner */}
        {activeToolCount > 0 && (
          <Box>
            <Text color="cyan">
              {SPINNER_FRAMES[frame]} {activeToolCount} tool{activeToolCount !== 1 ? 's' : ''}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
};
