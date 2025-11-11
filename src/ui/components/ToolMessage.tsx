import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Box, Text } from 'ink';
import { ToolCallState } from '@shared/index.js';
import { OutputScroller } from './OutputScroller';
import { AnimationTicker } from '@services/AnimationTicker.js';
import { getStatusColor, getStatusIcon } from '../utils/statusUtils.js';
import { TEXT_LIMITS } from '@config/constants.js';

// Simple text-based spinner animation
const SimpleSpinner: React.FC = () => {
  const [, forceUpdate] = useState({});
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const ticker = AnimationTicker.getInstance();

  useEffect(() => {
    const unsubscribe = ticker.subscribe(() => {
      forceUpdate({});
    });
    return unsubscribe;
  }, [ticker]);

  const frame = ticker.getFrame() % frames.length;

  return <Text color="cyan">{frames[frame]}</Text>;
};

interface ToolMessageProps {
  /** Tool call state containing status, output, etc. */
  toolCall: ToolCallState;
  /** Maximum height available for this tool's display */
  maxHeight: number;
}

/**
 * ToolMessage Component
 *
 * Displays a single tool execution with:
 * - Status icon (● validating, spinner executing, ✓ success, ✕ error)
 * - Tool name and elapsed time
 * - Scrolling output (last N lines)
 *
 * This component is the atomic unit of the concurrent tool visualization system.
 * Each tool call gets its own ToolMessage instance with independent state and rendering.
 */
export const ToolMessage: React.FC<ToolMessageProps> = ({
  toolCall,
  maxHeight,
}) => {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startTime = useRef(toolCall.startTime);

  // Update elapsed time every second for executing tools
  useEffect(() => {
    if (toolCall.status === 'executing' || toolCall.status === 'validating') {
      const interval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime.current) / 1000);
        setElapsedSeconds(elapsed);
      }, 1000);

      return () => clearInterval(interval);
    } else if (toolCall.endTime) {
      // For completed tools, show final duration
      const finalDuration = Math.floor(
        (toolCall.endTime - startTime.current) / 1000
      );
      setElapsedSeconds(finalDuration);
    }

    return undefined;
  }, [toolCall.status, toolCall.endTime]);

  // Status icon state machine - use spinner for executing, otherwise use utility
  const statusIcon = useMemo(() => {
    if (toolCall.status === 'executing') {
      return <SimpleSpinner />;
    }
    const icon = getStatusIcon(toolCall.status);
    const color = getStatusColor(toolCall.status);
    return <Text color={color}>{icon}</Text>;
  }, [toolCall.status]);

  // Tool name color based on status
  const toolNameColor = useMemo(() => {
    return getStatusColor(toolCall.status);
  }, [toolCall.status]);

  // Calculate available lines for output (maxHeight - 1 for header line)
  const outputMaxLines = Math.max(1, maxHeight - 1);

  return (
    <Box flexDirection="column" height={maxHeight}>
      {/* Header line: status icon, tool name, elapsed time */}
      <Box>
        <Box marginRight={1}>{statusIcon}</Box>
        <Text color={toolNameColor} bold>
          {toolCall.toolName}
        </Text>
        {elapsedSeconds > 5 && (
          <Text color="gray" dimColor>
            {' '}
            {elapsedSeconds}s
          </Text>
        )}
        {toolCall.status === 'error' && toolCall.error && toolCall.error_type !== 'validation_error' && (
          <Text color="red" dimColor>
            {' '}
            - {toolCall.error.split('\n')[0]?.slice(0, TEXT_LIMITS.ERROR_DISPLAY_MAX) || 'Unknown error'}
          </Text>
        )}
      </Box>

      {/* Output scrolling area */}
      {toolCall.output && toolCall.output.trim().length > 0 && (
        <Box flexDirection="column" flexGrow={1}>
          <OutputScroller
            output={toolCall.output}
            maxLines={outputMaxLines}
            maxCharsPerLine={120}
          />
        </Box>
      )}

      {/* Show arguments for validating/pending tools */}
      {!toolCall.output &&
        (toolCall.status === 'validating' || toolCall.status === 'pending') && (
          <Box paddingLeft={2}>
            <Text color="gray" dimColor>
              {JSON.stringify(toolCall.arguments, null, 2)
                .split('\n')
                .slice(0, outputMaxLines)
                .join('\n')}
            </Text>
          </Box>
        )}
    </Box>
  );
};
