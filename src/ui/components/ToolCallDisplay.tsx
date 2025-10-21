/**
 * ToolCallDisplay Component - Renders tool calls with threading
 *
 * Features:
 * - Threaded display with indentation for nested calls
 * - Real-time duration tracking
 * - Params preview
 * - Support for parallel execution
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ToolCallState } from '../../types/index.js';
import { DiffDisplay } from './DiffDisplay.js';

interface ToolCallDisplayProps {
  /** Tool call to display */
  toolCall: ToolCallState;
  /** Indentation level (0 = root) */
  level?: number;
  /** Nested tool calls */
  children?: React.ReactNode;
}

/**
 * Format duration in a human-readable way
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  } else if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
}

/**
 * Format arguments for preview
 */
function formatArgsPreview(args: any): string {
  if (!args || typeof args !== 'object') {
    return String(args);
  }

  const keys = Object.keys(args);
  if (keys.length === 0) {
    return '';
  }

  // Show first arg value
  if (keys.length === 1 && keys[0]) {
    const value = args[keys[0]];
    const strValue = typeof value === 'string' ? value : JSON.stringify(value);
    return strValue.length > 50 ? `${strValue.slice(0, 47)}...` : strValue;
  }

  // Multiple args - show first value with indicator
  const firstKey = keys[0];
  if (firstKey) {
    const firstValue = args[firstKey];
    const strValue = typeof firstValue === 'string' ? firstValue : JSON.stringify(firstValue);
    const preview = strValue.length > 30 ? `${strValue.slice(0, 27)}...` : strValue;
    return keys.length > 1 ? `${preview}, +${keys.length - 1}` : preview;
  }

  return '';
}

/**
 * Get status color
 */
function getStatusColor(status: ToolCallState['status']): string {
  switch (status) {
    case 'executing':
    case 'pending':
    case 'validating':
    case 'scheduled':
      return 'cyan';
    case 'success':
      return 'green';
    case 'error':
    case 'cancelled':
      return 'red';
    default:
      return 'white';
  }
}

/**
 * ToolCallDisplay Component
 */
export const ToolCallDisplay: React.FC<ToolCallDisplayProps> = ({
  toolCall,
  level = 0,
  children,
}) => {
  // Track current duration for live updates
  const [currentTime, setCurrentTime] = useState(Date.now());

  // Update current time for running tool calls
  useEffect(() => {
    if (toolCall.status === 'executing' || toolCall.status === 'pending') {
      const interval = setInterval(() => {
        setCurrentTime(Date.now());
      }, 1000); // Update every 1000ms (reduced from 100ms to prevent thrashing)

      return () => clearInterval(interval);
    }
    return undefined;
  }, [toolCall.status]);

  // Calculate duration
  const endTime = toolCall.endTime || currentTime;
  const duration = endTime - toolCall.startTime;
  const durationStr = formatDuration(duration);

  // Format arguments
  const argsPreview = formatArgsPreview(toolCall.arguments);

  // Indent based on level
  const indent = '    '.repeat(level);

  // Status indicator
  const statusColor = getStatusColor(toolCall.status);
  const isRunning = toolCall.status === 'executing' || toolCall.status === 'pending';
  const statusIcon = isRunning ? '...' : toolCall.status === 'success' ? '✓' : '✗';

  return (
    <Box flexDirection="column">
      <Box>
        {/* Indentation */}
        <Text>{indent}</Text>

        {/* Arrow prefix */}
        <Text color={statusColor}>→ </Text>

        {/* Tool name */}
        <Text color={statusColor} bold={level === 0}>
          {toolCall.toolName}
        </Text>

        {/* Arguments preview */}
        {argsPreview && (
          <Text dimColor> ({argsPreview})</Text>
        )}

        {/* Duration/Status */}
        <Text dimColor> [{isRunning ? durationStr : statusIcon}{!isRunning && ` ${durationStr}`}]</Text>
      </Box>

      {/* Diff preview (hidden if collapsed) */}
      {!toolCall.collapsed && toolCall.diffPreview && (
        <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={indent.length + 4}>
          <DiffDisplay
            oldContent={toolCall.diffPreview.oldContent}
            newContent={toolCall.diffPreview.newContent}
            filePath={toolCall.diffPreview.filePath}
            maxLines={20}
          />
        </Box>
      )}

      {/* Error output as threaded child (hidden if collapsed) */}
      {!toolCall.collapsed && toolCall.error && (
        <Box flexDirection="column">
          <Box>
            <Text>{indent}    </Text>
            <Text color="red">→ </Text>
            <Text color="red" dimColor>Error</Text>
          </Box>
          <Box paddingLeft={indent.length + 8}>
            <Text color="red" dimColor>
              {toolCall.error.length > 200
                ? `${toolCall.error.slice(0, 197)}...`
                : toolCall.error}
            </Text>
          </Box>
        </Box>
      )}

      {/* Output as threaded child (hidden if collapsed) */}
      {!toolCall.collapsed && toolCall.output && !toolCall.error && (
        <Box flexDirection="column">
          <Box>
            <Text>{indent}    </Text>
            <Text dimColor>→ </Text>
            <Text dimColor>Output</Text>
          </Box>
          <Box paddingLeft={indent.length + 8}>
            <Text dimColor>
              {toolCall.output.length > 200
                ? `${toolCall.output.slice(0, 197)}...`
                : toolCall.output}
            </Text>
          </Box>
        </Box>
      )}

      {/* Nested tool calls (hidden if collapsed) */}
      {!toolCall.collapsed && children}
    </Box>
  );
};
