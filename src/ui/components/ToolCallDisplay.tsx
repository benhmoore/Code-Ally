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
import { ToolCallState, ActivityEventType } from '@shared/index.js';
import { DiffDisplay } from './DiffDisplay.js';
import { formatDuration } from '../utils/timeUtils.js';
import { getStatusColor, getStatusIcon } from '../utils/statusUtils.js';
import { formatAgentName } from '../utils/uiHelpers.js';
import { TEXT_LIMITS, AGENT_DELEGATION_TOOLS } from '@config/constants.js';
import { useActivityEvent } from '../hooks/useActivityEvent.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { UI_COLORS } from '../constants/colors.js';

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

  // Track acknowledgments for this tool call
  const [acknowledgments, setAcknowledgments] = useState<Array<{ message: string; timestamp: number }>>([]);

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

  // Subscribe to INTERJECTION_ACKNOWLEDGMENT events to capture acknowledgments for this tool call
  useActivityEvent(ActivityEventType.INTERJECTION_ACKNOWLEDGMENT, (event) => {
    // Only add acknowledgments that belong to this tool call
    if (event.parentId === toolCall.id) {
      const message = event.data?.acknowledgment || '';
      const timestamp = event.timestamp || Date.now();

      // Skip empty acknowledgments
      if (!message.trim()) return;

      setAcknowledgments((prev) => {
        // Avoid duplicates by checking if we already have this exact acknowledgment
        const exists = prev.some(
          (a) => a.message === message && Math.abs(a.timestamp - timestamp) < 100
        );
        if (exists) return prev;

        // Add new acknowledgment, sorted by timestamp
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
  const isAgentDelegation = AGENT_DELEGATION_TOOLS.includes(toolCall.toolName as any);

  // For agent tool, show formatted agent_name as the tool name
  const displayName = isAgentDelegation && toolCall.arguments?.agent_name
    ? formatAgentName(toolCall.arguments.agent_name)
    : toolCall.toolName;

  // Format arguments (filter out agent_name for agent tool)
  const argsPreview = formatArgsPreview(toolCall.arguments, toolCall.toolName);

  // Indent based on level
  const indent = '    '.repeat(level);

  // Status indicator
  const statusColor = getStatusColor(toolCall.status);
  const statusIcon = getStatusIcon(toolCall.status);

  // Prefix icon: arrow for running (flashing), status icon for completed
  const prefixIcon = isRunning ? (arrowVisible ? UI_SYMBOLS.NAVIGATION.ARROW_RIGHT : ' ') : statusIcon;

  const toolCallCount = toolCall.totalChildCount || 0;

  // Trim all leading/trailing whitespace from output and error for clean display
  const trimmedOutput = toolCall.output?.trim();
  const trimmedError = toolCall.error?.trim();

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

        {/* Duration - only show if > 5 seconds */}
        {duration > 5000 && (
          <Text dimColor> · {durationStr}</Text>
        )}
      </Box>

      {/* Diff preview (hidden if collapsed or hideOutput, unless show_full_tool_output is enabled) */}
      {!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && toolCall.diffPreview && (
        <Box flexDirection="column" paddingLeft={indent.length + 4}>
          <DiffDisplay
            oldContent={toolCall.diffPreview.oldContent}
            newContent={toolCall.diffPreview.newContent}
            filePath={toolCall.diffPreview.filePath}
            maxLines={20}
          />
        </Box>
      )}

      {/* Error output as threaded child (hidden if collapsed, but always show errors even with hideOutput) */}
      {/* Hide validation_error type - these are model-directed messages, not user errors */}
      {!toolCall.collapsed && trimmedError && toolCall.error_type !== 'validation_error' && (
        <Box flexDirection="column">
          <Box>
            <Text>{indent}    </Text>
            <Text color="red">→ </Text>
            <Text color="red" dimColor>Error</Text>
          </Box>
          <Box paddingLeft={indent.length + 8}>
            <Text color="red" dimColor>
              {config?.show_full_tool_output || trimmedError.length <= TEXT_LIMITS.CONTENT_PREVIEW_MAX
                ? trimmedError
                : `${trimmedError.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX - 3)}...`}
            </Text>
          </Box>
        </Box>
      )}

      {/* Output as threaded child (hidden if collapsed or hideOutput, unless show_full_tool_output is enabled) */}
      {!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && trimmedOutput && !toolCall.error && (
        <Box flexDirection="column">
          <Box>
            <Text>{indent}    </Text>
            <Text dimColor>→ </Text>
            <Text dimColor>Output</Text>
          </Box>
          <Box paddingLeft={indent.length + 8}>
            <Text dimColor>
              {config?.show_full_tool_output || trimmedOutput.length <= TEXT_LIMITS.CONTENT_PREVIEW_MAX
                ? trimmedOutput
                : `${trimmedOutput.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX - 3)}...`}
            </Text>
          </Box>
        </Box>
      )}

      {/* Nested content: interleaved tool calls and interjections sorted by timestamp */}
      {/* Always render if we have interjections, even if hideOutput is true */}
      {(interjections.length > 0 || ((!toolCall.collapsed || config?.show_full_tool_output) && (!toolCall.hideOutput || config?.show_full_tool_output))) && (() => {
        // Build combined list of children and interjections
        type NestedItem =
          | { type: 'toolCall'; data: ToolCallState; timestamp: number }
          | { type: 'interjection'; data: { message: string; timestamp: number }; timestamp: number };

        const items: NestedItem[] = [];

        // Check if we should show tool calls (respects hideOutput and collapsed flags)
        const shouldShowToolCalls = (!toolCall.collapsed || config?.show_full_tool_output) &&
                                     (!toolCall.hideOutput || config?.show_full_tool_output);

        // Add nested tool calls (only if not hidden)
        if (shouldShowToolCalls && toolCall.children) {
          toolCall.children.forEach(child => {
            items.push({
              type: 'toolCall',
              data: child,
              timestamp: child.startTime
            });
          });
        }

        // Always add interjections (even if hideOutput is true)
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
                // Find matching acknowledgment for this interjection
                // Match by finding the acknowledgment with timestamp > interjection timestamp
                // and before the next item's timestamp (or now if this is the last item)
                const nextItemTimestamp = items[idx + 1]?.timestamp || Date.now();
                const matchingAck = acknowledgments.find(ack =>
                  ack.timestamp > item.timestamp &&
                  ack.timestamp < nextItemTimestamp
                );

                return (
                  <React.Fragment key={`interjection-${idx}-${item.timestamp}`}>
                    {/* Interjection */}
                    <Box>
                      <Text>{indent}    </Text>
                      <Text color={UI_COLORS.PRIMARY} bold>{'> '}</Text>
                      <Text color={UI_COLORS.PRIMARY} bold>{item.data.message}</Text>
                    </Box>

                    {/* Acknowledgment (if exists) */}
                    {matchingAck && (
                      <Box>
                        <Text>{indent}    </Text>
                        <Text>{matchingAck.message}</Text>
                      </Box>
                    )}
                  </React.Fragment>
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

      {/* Truncation indicator for agent delegations with many tool calls - shown at the end */}
      {!toolCall.collapsed && (!toolCall.hideOutput || config?.show_full_tool_output) && isAgentDelegation && (() => {
        const visibleCount = toolCall.children?.length || 0;
        const hiddenCount = toolCallCount - visibleCount;
        if (hiddenCount > 0) {
          return (
            <Box>
              <Text>{indent}    </Text>
              <Text dimColor>+{hiddenCount} more tool use{hiddenCount === 1 ? '' : 's'}</Text>
            </Box>
          );
        }
        return null;
      })()}

      {/* Completion summary for finished agents - always show even when collapsed */}
      {isAgentDelegation && !isRunning && toolCallCount > 0 && toolCall.endTime && (
        <Box>
          <Text>{indent}    </Text>
          <Text dimColor>Done ({toolCallCount} tool use{toolCallCount === 1 ? '' : 's'} · {durationStr})</Text>
        </Box>
      )}
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
