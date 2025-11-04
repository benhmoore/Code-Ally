/**
 * ToolCallDisplay Component - Renders tool calls with threading
 *
 * Features:
 * - Threaded display with indentation for nested calls
 * - Real-time duration tracking
 * - Params preview
 * - Support for parallel execution
 * - Displays user interjections nested under running tool calls
 */

import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { ToolCallState, ActivityEventType } from '../../types/index.js';
import { DiffDisplay } from './DiffDisplay.js';
import { formatDuration } from '../utils/timeUtils.js';
import { getStatusColor, getStatusIcon } from '../utils/statusUtils.js';
import { TEXT_LIMITS } from '../../config/constants.js';
import { useActivityEvent } from '../hooks/useActivityEvent.js';

interface ToolCallDisplayProps {
  /** Tool call to display */
  toolCall: ToolCallState & { totalChildCount?: number; children?: ToolCallState[] };
  /** Indentation level (0 = root) */
  level?: number;
  /** Config for output display preferences */
  config?: any;
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
  config,
}) => {
  const isRunning = toolCall.status === 'executing' || toolCall.status === 'pending';

  // Track interjections for this tool call
  const [interjections, setInterjections] = useState<Array<{ message: string; timestamp: number }>>([]);

  // Flashing arrow for in-progress tool calls
  const [arrowVisible, setArrowVisible] = useState(true);

  useEffect(() => {
    if (!isRunning) {
      setArrowVisible(true);
      return;
    }

    // Flash the arrow every 500ms
    const interval = setInterval(() => {
      setArrowVisible(prev => !prev);
    }, 500);

    return () => clearInterval(interval);
  }, [isRunning]);

  // Subscribe to USER_INTERJECTION events to capture interjections for this tool call
  useActivityEvent(ActivityEventType.USER_INTERJECTION, (event) => {
    // Only add interjections that belong to this tool call
    if (event.parentId === toolCall.id) {
      const message = event.data?.message || '';
      const timestamp = event.timestamp || Date.now();

      setInterjections((prev) => {
        // Avoid duplicates by checking if we already have this exact interjection
        const exists = prev.some(
          (i) => i.message === message && Math.abs(i.timestamp - timestamp) < 100
        );
        if (exists) return prev;

        // Add new interjection, sorted by timestamp
        return [...prev, { message, timestamp }].sort((a, b) => a.timestamp - b.timestamp);
      });
    }
  }, [toolCall.id]);

  // Calculate duration (no live updates - just shows duration at render time)
  // Use executionStartTime if available (excludes user permission deliberation time)
  // Fall back to startTime for tools that don't require permission
  const startTime = toolCall.executionStartTime || toolCall.startTime;
  const endTime = toolCall.endTime || Date.now();
  const duration = Math.max(0, endTime - startTime); // Ensure non-negative
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
  const statusIcon = getStatusIcon(toolCall.status);

  // Prefix icon: arrow for running (flashing), status icon for completed
  const prefixIcon = isRunning ? (arrowVisible ? '→' : ' ') : statusIcon;

  const toolCallCount = toolCall.totalChildCount || 0;

  return (
    <Box flexDirection="column">
      <Box>
        {/* Indentation */}
        <Text>{indent}</Text>

        {/* Status prefix icon */}
        <Text color={statusColor}>{prefixIcon} </Text>

        {/* Tool name (or agent name for agent tool) */}
        <Text color={statusColor} bold={level === 0}>
          {displayName}
        </Text>

        {/* Arguments preview */}
        {argsPreview && (
          <Text dimColor> ({argsPreview})</Text>
        )}

        {/* Duration */}
        <Text dimColor> [{isRunning ? '...' : ''}{isRunning ? ' ' : ''}{durationStr}]</Text>
      </Box>

      {/* Diff preview (hidden if collapsed or hideOutput, unless show_full_tool_output is enabled) */}
      {!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && toolCall.diffPreview && (
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
              {config?.show_full_tool_output || toolCall.error.length <= TEXT_LIMITS.CONTENT_PREVIEW_MAX
                ? toolCall.error
                : `${toolCall.error.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX - 3)}...`}
            </Text>
          </Box>
        </Box>
      )}

      {/* Output as threaded child (hidden if collapsed or hideOutput, unless show_full_tool_output is enabled) */}
      {!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && toolCall.output && !toolCall.error && (
        <Box flexDirection="column">
          <Box>
            <Text>{indent}    </Text>
            <Text dimColor>→ </Text>
            <Text dimColor>Output</Text>
          </Box>
          <Box paddingLeft={indent.length + 8}>
            <Text dimColor>
              {config?.show_full_tool_output || toolCall.output.length <= TEXT_LIMITS.CONTENT_PREVIEW_MAX
                ? toolCall.output
                : `${toolCall.output.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX - 3)}...`}
            </Text>
          </Box>
        </Box>
      )}

      {/* Truncation indicator for agent delegations with many tool calls (hidden if collapsed or hideOutput, unless show_full_tool_output is enabled) */}
      {!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && isAgentDelegation && toolCallCount > 3 && (
        <Box>
          <Text>{indent}    </Text>
          <Text dimColor>... (showing last 3 of {toolCallCount} tool calls)</Text>
        </Box>
      )}

      {/* Nested content: interleaved tool calls and interjections sorted by timestamp */}
      {(!toolCall.collapsed || config?.show_full_tool_output) && (!toolCall.hideOutput || config?.show_full_tool_output) && (() => {
        // Build combined list of children and interjections
        type NestedItem =
          | { type: 'toolCall'; data: ToolCallState; timestamp: number }
          | { type: 'interjection'; data: { message: string; timestamp: number }; timestamp: number };

        const items: NestedItem[] = [];

        // Add nested tool calls
        if (toolCall.children) {
          toolCall.children.forEach(child => {
            items.push({
              type: 'toolCall',
              data: child,
              timestamp: child.startTime
            });
          });
        }

        // Add interjections
        interjections.forEach(interjection => {
          items.push({
            type: 'interjection',
            data: interjection,
            timestamp: interjection.timestamp
          });
        });

        // Sort by timestamp
        items.sort((a, b) => a.timestamp - b.timestamp);

        // Render items in order
        return (
          <>
            {items.map((item, idx) => {
              if (item.type === 'interjection') {
                return (
                  <Box key={`interjection-${idx}-${item.timestamp}`}>
                    <Text>{indent}    </Text>
                    <Text color="yellow" bold>{'> '}</Text>
                    <Text color="yellow" bold>{item.data.message}</Text>
                  </Box>
                );
              } else {
                // Recursively render nested tool call
                return (
                  <ToolCallDisplay
                    key={item.data.id}
                    toolCall={item.data}
                    level={level + 1}
                    config={config}
                  />
                );
              }
            })}
          </>
        );
      })()}
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
