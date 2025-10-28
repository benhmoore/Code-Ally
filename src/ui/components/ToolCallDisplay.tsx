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
import { formatDuration } from '../utils/timeUtils.js';
import { getStatusColor, getStatusIcon } from '../utils/statusUtils.js';
import { TEXT_LIMITS } from '../../config/constants.js';

interface ToolCallDisplayProps {
  /** Tool call to display */
  toolCall: ToolCallState & { totalChildCount?: number };
  /** Indentation level (0 = root) */
  level?: number;
  /** Nested tool calls */
  children?: React.ReactNode;
}

/**
 * Format arguments for preview - shows all parameters with truncated values
 *
 * @param args Tool arguments
 * @param toolName Tool name (used to filter agent_name from agent tool)
 */
function formatArgsPreview(args: any, toolName?: string): string {
  if (!args || typeof args !== 'object') {
    return String(args);
  }

  const keys = Object.keys(args);
  if (keys.length === 0) {
    return '';
  }

  // For agent tool, filter out agent_name since it's shown as the tool name
  const filteredKeys = toolName === 'agent'
    ? keys.filter(k => k !== 'agent_name')
    : keys;

  if (filteredKeys.length === 0) {
    return '';
  }

  // Format each parameter as "key=value", truncating long values
  const formattedArgs = filteredKeys.map(key => {
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

    // Truncate if too long
    if (strValue.length > TEXT_LIMITS.TOOL_PARAM_VALUE_MAX) {
      strValue = `${strValue.slice(0, TEXT_LIMITS.TOOL_PARAM_VALUE_MAX - TEXT_LIMITS.ELLIPSIS_LENGTH)}...`;
    }

    return `${key}=${strValue}`;
  });

  return formattedArgs.join(', ');
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

  // Check if this is an agent delegation
  const isAgentDelegation = toolCall.toolName === 'agent';

  // For agent tool, show agent_name as the tool name
  const displayName = isAgentDelegation && toolCall.arguments?.agent_name
    ? toolCall.arguments.agent_name
    : toolCall.toolName;

  // Format arguments (filter out agent_name for agent tool)
  const argsPreview = formatArgsPreview(toolCall.arguments, toolCall.toolName);

  // Indent based on level
  const indent = '    '.repeat(level);

  // Status indicator
  const statusColor = getStatusColor(toolCall.status);
  const statusIcon = isRunning ? '...' : getStatusIcon(toolCall.status);

  const toolCallCount = toolCall.totalChildCount || 0;

  return (
    <Box flexDirection="column">
      <Box>
        {/* Indentation */}
        <Text>{indent}</Text>

        {/* Arrow prefix */}
        <Text color={statusColor}>→ </Text>

        {/* Tool name (or agent name for agent tool) */}
        <Text color={statusColor} bold={level === 0}>
          {displayName}
        </Text>

        {/* Arguments preview */}
        {argsPreview && (
          <Text dimColor> ({argsPreview})</Text>
        )}

        {/* Duration/Status */}
        <Text dimColor> [{isRunning ? durationStr : statusIcon}{!isRunning && ` ${durationStr}`}]</Text>
      </Box>

      {/* Diff preview (hidden if collapsed or hideOutput) */}
      {!toolCall.collapsed && !toolCall.hideOutput && toolCall.diffPreview && (
        <Box flexDirection="column" marginTop={1} marginBottom={1} paddingLeft={indent.length + 4}>
          <DiffDisplay
            oldContent={toolCall.diffPreview.oldContent}
            newContent={toolCall.diffPreview.newContent}
            filePath={toolCall.diffPreview.filePath}
            maxLines={20}
          />
        </Box>
      )}

      {/* Error output as threaded child (hidden if collapsed, but always show errors even with hideOutput) */}
      {!toolCall.collapsed && toolCall.error && (
        <Box flexDirection="column">
          <Box>
            <Text>{indent}    </Text>
            <Text color="red">→ </Text>
            <Text color="red" dimColor>Error</Text>
          </Box>
          <Box paddingLeft={indent.length + 8}>
            <Text color="red" dimColor>
              {toolCall.error.length > TEXT_LIMITS.CONTENT_PREVIEW_MAX
                ? `${toolCall.error.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX - 3)}...`
                : toolCall.error}
            </Text>
          </Box>
        </Box>
      )}

      {/* Output as threaded child (hidden if collapsed or hideOutput) */}
      {!toolCall.collapsed && !toolCall.hideOutput && toolCall.output && !toolCall.error && (
        <Box flexDirection="column">
          <Box>
            <Text>{indent}    </Text>
            <Text dimColor>→ </Text>
            <Text dimColor>Output</Text>
          </Box>
          <Box paddingLeft={indent.length + 8}>
            <Text dimColor>
              {toolCall.toolName === 'bash' && toolCall.userInitiated
                ? toolCall.output
                : toolCall.output.length > TEXT_LIMITS.CONTENT_PREVIEW_MAX
                ? `${toolCall.output.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX - 3)}...`
                : toolCall.output}
            </Text>
          </Box>
        </Box>
      )}

      {/* Truncation indicator for agent delegations with many tool calls (hidden if collapsed or hideOutput) */}
      {!toolCall.collapsed && !toolCall.hideOutput && isAgentDelegation && toolCallCount > 3 && (
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
