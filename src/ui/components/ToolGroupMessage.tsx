import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { useStdout } from 'ink';
import { ToolCallState } from '@shared/index.js';
import { ToolMessage } from './ToolMessage';
import { TEXT_LIMITS } from '@config/constants.js';

interface ToolGroupMessageProps {
  /** Array of concurrent tool call states */
  toolCalls: ToolCallState[];
  /** Override terminal height (for testing) */
  terminalHeightOverride?: number;
}

// Height reserved for static UI elements (prompt, status line, etc.)
const STATIC_UI_HEIGHT = TEXT_LIMITS.STATIC_UI_HEIGHT;

// Minimum height per tool to prevent cramping
const MIN_HEIGHT_PER_TOOL = TEXT_LIMITS.MIN_HEIGHT_PER_TOOL;

/**
 * ToolGroupMessage Component
 *
 * THE KILLER FEATURE: Gemini-CLI-style concurrent tool visualization.
 *
 * This component orchestrates multiple ToolMessage components, providing:
 * - Dynamic height allocation: Each tool gets equal vertical space
 * - Aggregate status visualization: Border color reflects overall status
 * - Non-interleaving output: Each tool has its own display region
 * - Independent updates: Tools update their status independently
 *
 * Key Innovation:
 * Unlike Rich's thread-based Live displays that conflict during concurrent updates,
 * Ink's React model enables true concurrent visualization where each tool's
 * component re-renders independently without interfering with others.
 *
 * Height Allocation Strategy:
 * 1. Get terminal height from useStdout()
 * 2. Subtract static UI height (prompt, status, etc.)
 * 3. Divide remaining height equally among tools
 * 4. Each ToolMessage gets its allocated height via maxHeight prop
 *
 * Border Color State Machine:
 * - RED: At least one tool has errored
 * - GREEN: All tools completed successfully
 * - YELLOW: Tools are pending/executing
 * - GRAY: All cancelled
 */
export const ToolGroupMessage: React.FC<ToolGroupMessageProps> = ({
  toolCalls,
  terminalHeightOverride,
}) => {
  const { stdout } = useStdout();
  const terminalHeight = terminalHeightOverride || stdout?.rows || TEXT_LIMITS.TERMINAL_HEIGHT_FALLBACK;

  // Calculate available height for tools
  const { availableHeight, heightPerTool } = useMemo(() => {
    const available = Math.max(
      MIN_HEIGHT_PER_TOOL * toolCalls.length,
      terminalHeight - STATIC_UI_HEIGHT
    );

    const perTool = Math.max(
      MIN_HEIGHT_PER_TOOL,
      Math.floor(available / toolCalls.length)
    );

    return {
      availableHeight: available,
      heightPerTool: perTool,
    };
  }, [terminalHeight, toolCalls.length]);

  // Determine border color based on aggregate status
  const borderColor = useMemo(() => {
    const statuses = toolCalls.map(tc => tc.status);

    // Error takes precedence
    if (statuses.some(s => s === 'error')) {
      return 'red';
    }

    // All successful
    if (statuses.every(s => s === 'success')) {
      return 'green';
    }

    // All cancelled
    if (statuses.every(s => s === 'cancelled')) {
      return 'gray';
    }

    // Any executing/validating/pending
    if (
      statuses.some(
        s => s === 'executing' || s === 'validating' || s === 'pending'
      )
    ) {
      return 'yellow';
    }

    // Default
    return 'blue';
  }, [toolCalls]);

  // Determine border style based on status
  const borderStyle = useMemo(() => {
    const allComplete = toolCalls.every(
      tc => tc.status === 'success' || tc.status === 'error'
    );
    return allComplete ? 'round' : 'single';
  }, [toolCalls]);

  // Summary statistics
  const summary = useMemo(() => {
    const total = toolCalls.length;
    const completed = toolCalls.filter(
      tc => tc.status === 'success' || tc.status === 'error'
    ).length;
    const successful = toolCalls.filter(tc => tc.status === 'success').length;
    const errored = toolCalls.filter(tc => tc.status === 'error').length;

    return { total, completed, successful, errored };
  }, [toolCalls]);

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Summary header */}
      <Box marginBottom={1}>
        <Text bold>
          Concurrent Tools: {summary.completed}/{summary.total}
        </Text>
        {summary.successful > 0 && (
          <Text color="green">
            {' '}
            ✓{summary.successful}
          </Text>
        )}
        {summary.errored > 0 && (
          <Text color="red">
            {' '}
            ✕{summary.errored}
          </Text>
        )}
        <Text color="gray" dimColor>
          {' '}
          ({heightPerTool} lines/tool)
        </Text>
      </Box>

      {/* Tool display area with border */}
      <Box
        borderStyle={borderStyle}
        borderColor={borderColor}
        flexDirection="column"
        height={availableHeight}
      >
        {toolCalls.map(toolCall => (
          <Box key={toolCall.id} height={heightPerTool} flexDirection="column">
            <ToolMessage toolCall={toolCall} maxHeight={heightPerTool} />
          </Box>
        ))}
      </Box>
    </Box>
  );
};
