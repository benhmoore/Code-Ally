/**
 * ToolCallDisplay Component - Renders tool calls with threading
 *
 * Features:
 * - Threaded display with indentation for nested calls
 * - Real-time duration tracking
 * - Params preview
 * - Support for parallel execution
 */

import React from 'react';
import { Box, Text } from 'ink';
import { ToolCallState } from '../../types/index.js';
import { DiffDisplay } from './DiffDisplay.js';

interface ToolCallDisplayProps {
  /** Tool call to display */
  toolCall: ToolCallState & { totalChildCount?: number };
  /** Indentation level (0 = root) */
  level?: number;
  /** Nested tool calls */
  children?: React.ReactNode;
}

/**
 * Format duration in a human-readable way (no sub-second precision)
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  } else if (ms < 60000) {
    return `${Math.round(ms / 1000)}s`;
  } else {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.round((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
  }
}

/**
 * Format arguments for preview - shows all parameters with truncated values
 */
function formatArgsPreview(args: any): string {
  if (!args || typeof args !== 'object') {
    return String(args);
  }

  const keys = Object.keys(args);
  if (keys.length === 0) {
    return '';
  }

  // Format each parameter as "key=value", truncating long values
  const formattedArgs = keys.map(key => {
    const value = args[key];
    let strValue: string;

    // Format the value based on type
    if (typeof value === 'string') {
      strValue = `"${value}"`;
    } else if (Array.isArray(value)) {
      strValue = JSON.stringify(value);
    } else if (typeof value === 'object' && value !== null) {
      strValue = JSON.stringify(value);
    } else {
      strValue = String(value);
    }

    // Truncate if too long (max 40 chars per value)
    if (strValue.length > 40) {
      strValue = `${strValue.slice(0, 37)}...`;
    }

    return `${key}=${strValue}`;
  });

  return formattedArgs.join(', ');
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
 * ToolCallDisplay Component (Internal)
 */
const ToolCallDisplayComponent: React.FC<ToolCallDisplayProps> = ({
  toolCall,
  level = 0,
  children,
}) => {
  const isRunning = toolCall.status === 'executing' || toolCall.status === 'pending';

  // Calculate duration (no live updates - just shows duration at render time)
  const endTime = toolCall.endTime || Date.now();
  const duration = endTime - toolCall.startTime;
  const durationStr = formatDuration(duration);

  // Format arguments
  const argsPreview = formatArgsPreview(toolCall.arguments);

  // Indent based on level
  const indent = '    '.repeat(level);

  // Status indicator
  const statusColor = getStatusColor(toolCall.status);
  const statusIcon = isRunning ? '...' : toolCall.status === 'success' ? '✓' : '✗';

  // Check if this is an agent delegation
  const isAgentDelegation = toolCall.toolName === 'agent';
  const toolCallCount = toolCall.totalChildCount || 0;

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

      {/* Truncation indicator for agent delegations with many tool calls */}
      {!toolCall.collapsed && isAgentDelegation && toolCallCount > 3 && (
        <Box>
          <Text>{indent}    </Text>
          <Text dimColor>... (showing last 3 of {toolCallCount} tool calls)</Text>
        </Box>
      )}

      {/* Nested tool calls (hidden if collapsed) */}
      {!toolCall.collapsed && children}
    </Box>
  );
};

/**
 * Memoized ToolCallDisplay
 *
 * Simplified memoization - Static component now handles completed tools.
 * Only active tools in the dynamic section benefit from this check.
 */
export const ToolCallDisplay = React.memo(ToolCallDisplayComponent);
