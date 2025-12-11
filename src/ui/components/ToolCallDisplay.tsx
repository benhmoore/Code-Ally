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
import { CompactionNotice } from '../contexts/AppContext.js';
import { DiffDisplay } from './DiffDisplay.js';
import { formatDuration } from '../utils/timeUtils.js';
import { getStatusColor, getStatusIcon } from '../utils/statusUtils.js';
import { formatDisplayName } from '../utils/uiHelpers.js';
import { TEXT_LIMITS, AGENT_DELEGATION_TOOLS, UI_DELAYS, BUFFER_SIZES } from '@config/constants.js';
import { useActivityEvent } from '../hooks/useActivityEvent.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { UI_COLORS } from '../constants/colors.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ToolManager } from '@tools/ToolManager.js';
import { AgentPoolService } from '@services/AgentPoolService.js';
import { getAgentType, getAgentDisplayName } from '@utils/agentTypeUtils.js';

interface ToolCallDisplayProps {
  /** Tool call to display */
  toolCall: ToolCallState & { totalChildCount?: number; children?: ToolCallState[] };
  /** Indentation level (0 = root) */
  level?: number;
  /** Config for output display preferences */
  config?: any;
  /** Whether any ancestor is an agent tool (used to hide non-agent tool outputs) */
  hasAgentAncestor?: boolean;
  /** Compaction notices to check for nested notices */
  compactionNotices?: CompactionNotice[];
}

/**
 * Format arguments for preview - shows all parameters with truncated values
 *
 * @param args Tool arguments
 * @param toolName Tool name (used to get parameter filtering from tool instance)
 */
function formatArgsPreview(args: any, toolName?: string): string {
  if (!args || typeof args !== 'object') {
    return String(args);
  }

  const keys = Object.keys(args);
  if (keys.length === 0) {
    return '';
  }

  // Get parameters to filter from tool instance
  let paramsToFilter: Set<string> = new Set(['description']); // Default fallback

  if (toolName) {
    try {
      const registry = ServiceRegistry.getInstance();
      const toolManager = registry.get<ToolManager>('tool_manager');

      if (toolManager) {
        const tool = toolManager.getTool(toolName);
        if (tool && typeof tool.getSubtextParameters === 'function') {
          const subtextParams = tool.getSubtextParameters();
          paramsToFilter = new Set(subtextParams);
        }
      }
    } catch (error) {
      // ServiceRegistry not available (e.g., in tests) - use default fallback
    }


    // Special case: agent_id is shown as part of display name for agent-ask, not in subtext
    if (toolName === 'agent-ask') {
      paramsToFilter.add('agent_id');
    }
  }

  // Filter out parameters shown in subtext or elsewhere
  const filteredKeys = keys.filter(k => !paramsToFilter.has(k));

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
      try {
        strValue = JSON.stringify(value);
      } catch {
        strValue = '[Circular]';
      }
    } else if (typeof value === 'object' && value !== null) {
      try {
        strValue = JSON.stringify(value);
      } catch {
        strValue = '[Circular]';
      }
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
 * Extract subtext for display - shown dimmed after tool name
 * Returns the most relevant contextual information for the tool call
 *
 * Uses tool's formatSubtext() method if available, otherwise falls back to description parameter.
 *
 * @param toolCall - Tool call state
 * @param toolName - Internal tool name (not display name)
 * @param isAgentTool - Whether this is an agent delegation tool (skips truncation)
 * @returns Truncated subtext string or empty string
 */
function extractSubtext(toolCall: ToolCallState, toolName: string, isAgentTool: boolean = false): string {
  const args = toolCall.arguments;
  if (!args || typeof args !== 'object') {
    return '';
  }

  let subtext = '';

  // Try to get tool instance from ToolManager and call formatSubtext()
  try {
    const registry = ServiceRegistry.getInstance();
    const toolManager = registry.get<ToolManager>('tool_manager');

    if (toolManager) {
      const tool = toolManager.getTool(toolName);
      if (tool && typeof tool.formatSubtext === 'function') {
        // Pass result to formatSubtext if available (for tools that need post-execution data)
        const formatted = tool.formatSubtext(args, toolCall.result);
        if (formatted) {
          subtext = formatted;
        }
      }
    }
  } catch (error) {
    // ServiceRegistry not available (e.g., in tests) - fall back to legacy logic
  }

  // Fallback to legacy logic if tool-based formatting didn't produce a result
  if (!subtext) {
    // Agent tools: Use task_prompt
    if (toolName === 'agent' || toolName === 'explore') {
      subtext = args.task_prompt || '';
    }
    // Plan tool: Use requirements
    else if (toolName === 'plan') {
      subtext = args.requirements || '';
    }
    // All other tools: Use description if provided
    else if (args.description) {
      subtext = args.description;
    }
  }

  // Truncate to reasonable length (80 chars) - but not for agent tools
  // Agent tools display subtext on separate lines, so they can show full text
  if (!isAgentTool && subtext.length > 80) {
    subtext = subtext.slice(0, 77) + '...';
  }

  return subtext;
}

// Agent tools are imported from constants
const AGENT_TYPE_TOOLS = new Set<string>(AGENT_DELEGATION_TOOLS);

/**
 * Determine if a child tool should be shown based on parent state and config
 * Exported for testing
 */
export function shouldShowChildTool(
  _child: ToolCallState,
  parentCollapsed: boolean | undefined,
  _parentHideOutput: boolean | undefined,
  config?: any
): boolean {
  // Override: always show if user enabled full output
  if (config?.show_full_tool_output) {
    return true;
  }

  // All child tools (agent and non-agent) are visible unless parent is collapsed
  // hideOutput only affects the output TEXT, not child tool visibility
  return !parentCollapsed;
}

/**
 * ToolCallDisplay Component (Internal)
 */
const ToolCallDisplayComponent: React.FC<ToolCallDisplayProps> = ({
  toolCall,
  level = 0,
  config,
  hasAgentAncestor = false,
  compactionNotices = [],
}) => {
  const isRunning = toolCall.status === 'executing' || toolCall.status === 'pending';

  // Check if this tool is an agent - if so, children should hide their output
  const isAgentTool = AGENT_TYPE_TOOLS.has(toolCall.toolName);
  const childrenHaveAgentAncestor = isAgentTool || hasAgentAncestor;

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
  const duration = Math.max(0, endTime - startTime);
  const durationStr = formatDuration(duration);

  // Check if this is an agent delegation
  const isAgentDelegation = AGENT_DELEGATION_TOOLS.includes(toolCall.toolName as any);

  // Determine display name:
  // 1. For agent tools: Use agent_type (foundational value) and transform to Title Case
  // 2. For agent-ask: look up agent from pool and show "Follow Up: {AgentName}"
  // 3. For tools with custom displayName: use that
  // 4. Otherwise: auto-format the tool name
  let displayName: string;
  if (isAgentDelegation) {
    // Determine agent_type from tool and transform to Title Case
    let agentType: string;

    // For 'agent' tool, check agent_type parameter (or default to 'task')
    if (toolCall.toolName === 'agent') {
      agentType = toolCall.arguments?.agent_type || 'task';
    }
    // For 'explore' and 'plan' tools, the tool name IS the agent type
    else {
      agentType = toolCall.toolName; // 'explore' or 'plan'
    }

    displayName = formatDisplayName(agentType);
  } else if (toolCall.toolName === 'agent-ask' && toolCall.arguments?.agent_id) {
    // Special handling for agent-ask: look up agent name from pool
    try {
      const registry = ServiceRegistry.getInstance();
      const agentPoolService = registry.get<AgentPoolService>('agent_pool');
      const agentId = toolCall.arguments.agent_id;

      if (agentPoolService && agentPoolService.hasAgent(agentId)) {
        const metadata = agentPoolService.getAgentMetadata(agentId);
        if (metadata) {
          const agentType = getAgentType(metadata);
          const agentName = getAgentDisplayName(agentType);
          displayName = `Follow Up: ${agentName}`;
        } else {
          displayName = 'Follow Up';
        }
      } else {
        displayName = 'Follow Up';
      }
    } catch {
      displayName = 'Follow Up';
    }
  } else {
    // Try to get custom displayName from tool instance
    try {
      const registry = ServiceRegistry.getInstance();
      const toolManager = registry.get<ToolManager>('tool_manager');
      const tool = toolManager?.getTool(toolCall.toolName);
      displayName = tool?.displayName || formatDisplayName(toolCall.toolName);
    } catch {
      displayName = formatDisplayName(toolCall.toolName);
    }
  }

  // Format arguments
  const argsPreview = formatArgsPreview(toolCall.arguments, toolCall.toolName);

  // Extract subtext for display (pass isAgentDelegation to prevent truncation in extractSubtext)
  // We'll handle truncation for completed agents separately in the rendering
  const subtext = extractSubtext(toolCall, toolCall.toolName, isAgentDelegation);

  // Extract thoroughness for agent delegation tools
  const thoroughness = isAgentDelegation ? toolCall.arguments?.thoroughness : null;

  // Indent based on level
  const indent = '    '.repeat(level);

  // Status indicator
  const statusColor = getStatusColor(toolCall.status);
  const statusIcon = getStatusIcon(toolCall.status);

  // Prefix icon: arrow for running (flashing), status icon for completed
  const prefixIcon = isRunning ? (arrowVisible ? UI_SYMBOLS.NAVIGATION.ARROW_RIGHT : ' ') : statusIcon;

  const toolCallCount = toolCall.totalChildCount || 0;

  // Trim all leading/trailing whitespace from output for clean display
  const trimmedOutput = toolCall.output?.trim();

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

        {/* Model - show for agent delegations only if different from primary */}
        {isAgentDelegation && toolCall.agentModel && config?.model && toolCall.agentModel !== config.model && (
          <Text dimColor> · {toolCall.agentModel}</Text>
        )}

        {/* Thoroughness - show for agent delegations */}
        {thoroughness && (
          <Text dimColor> · {thoroughness}</Text>
        )}

        {/* Compacting indicator - only show when agent is compacting */}
        {isAgentDelegation && toolCall.isCompacting && (
          <Text dimColor> · compacting</Text>
        )}

        {/* Subtext - contextual information (not shown inline for agents) */}
        {subtext && !isAgentDelegation && (
          <Text dimColor> · {subtext}</Text>
        )}

        {/* Arguments preview - only show if config enabled */}
        {argsPreview && config?.show_tool_parameters_in_chat && (
          <Text dimColor> ({argsPreview})</Text>
        )}

        {/* Duration - always show for agents, show for others if > 5 seconds */}
        {(isAgentDelegation || duration > UI_DELAYS.TOOL_DURATION_DISPLAY_THRESHOLD) && (
          <Text dimColor> · {durationStr}</Text>
        )}
      </Box>

      {/* Agent subtext - displayed on indented lines below header */}
      {/* Once child tool calls exist, collapse to first line only */}
      {isAgentDelegation && subtext && (
        <Box flexDirection="column">
          {(() => {
            const hasChildToolCalls = (toolCall.children?.length ?? 0) > 0;

            // After first tool call, show only first line (truncated to 80 chars)
            if (hasChildToolCalls) {
              const firstLine = subtext.split('\n')[0] ?? '';
              const truncatedLine = firstLine.length > 77
                ? firstLine.slice(0, 77) + '...'
                : firstLine;
              return (
                <Box>
                  <Text>{indent}    </Text>
                  <Text color={UI_COLORS.PRIMARY}>{'> '}</Text>
                  <Text>{truncatedLine}</Text>
                </Box>
              );
            }

            // No child tools yet - show full prompt (up to 5 lines)
            // Truncate to 80 chars (77 + "...") when agent is complete
            const displaySubtext = !isRunning && subtext.length > 80
              ? subtext.slice(0, 77) + '...'
              : subtext;

            const lines = displaySubtext.split('\n');
            const maxLines = 5;
            const truncated = lines.length > maxLines;
            const displayLines = truncated ? lines.slice(0, maxLines) : lines;

            return (
              <>
                {displayLines.map((line, idx) => (
                  <Box key={idx}>
                    <Text>{indent}    </Text>
                    {idx === 0 && <Text color={UI_COLORS.PRIMARY}>{'> '}</Text>}
                    {idx > 0 && <Text>  </Text>}
                    <Text>{line}</Text>
                  </Box>
                ))}
                {truncated && (
                  <Box>
                    <Text>{indent}    </Text>
                    <Text dimColor>  ... ({lines.length - maxLines} more line{lines.length - maxLines === 1 ? '' : 's'})</Text>
                  </Box>
                )}
              </>
            );
          })()}
        </Box>
      )}

      {/* Thinking content - displayed inline for agent delegations */}
      {/* ALWAYS show truncated form for agents, regardless of config */}
      {/* Only show after thinking completes (when thinkingEndTime is set) */}
      {isAgentDelegation && toolCall.thinking && toolCall.thinkingStartTime && toolCall.thinkingEndTime && (
        <Box>
          <Text>{indent}    </Text>
          <Text dimColor italic>
            ∴ Thought for {formatDuration(toolCall.thinkingEndTime - toolCall.thinkingStartTime)}
          </Text>
        </Box>
      )}

      {/* Diff preview (hidden only if collapsed; always shown regardless of hideOutput) */}
      {!toolCall.collapsed && toolCall.diffPreview && (
        <Box flexDirection="column" paddingLeft={indent.length + 4}>
          <DiffDisplay
            oldContent={toolCall.diffPreview.oldContent}
            newContent={toolCall.diffPreview.newContent}
            filePath={toolCall.diffPreview.filePath}
            maxLinesPerHunk={10}
            editsCount={toolCall.diffPreview.editsCount}
          />
        </Box>
      )}

      {/* Output as threaded child (hidden if collapsed, has agent ancestor, or own hideOutput, unless show_full_tool_output is enabled) */}
      {/* For linked plugins (dev mode) or alwaysShowFullOutput tools, always show output - overrides all other settings */}
      {(() => {
        const shouldShowOutput = toolCall.isLinkedPlugin || toolCall.alwaysShowFullOutput || (!hasAgentAncestor && (!toolCall.hideOutput || config?.show_full_tool_output));
        if (toolCall.collapsed || !shouldShowOutput || !trimmedOutput || toolCall.error) return null;

        // Get the output text to display
        // alwaysShowFullOutput tools never truncate
        const displayOutput = config?.show_full_tool_output || toolCall.alwaysShowFullOutput || trimmedOutput.length <= TEXT_LIMITS.CONTENT_PREVIEW_MAX
          ? trimmedOutput
          : `${trimmedOutput.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX - 3)}...`;

        // Split into lines to put first line inline with arrow
        const outputLines = displayOutput.split('\n');

        // Helper to render a line, with special handling for "Question → Answer" format
        const renderLine = (line: string, idx: number, isFirst: boolean) => {
          const arrowMatch = line.match(/^(.+?) → (.+)$/);
          if (arrowMatch) {
            // Render question dimmed, answer bold
            return (
              <Box key={idx}>
                {isFirst ? (
                  <>
                    <Text>{indent}    </Text>
                    <Text dimColor>→ </Text>
                  </>
                ) : (
                  <Text>{indent}      </Text>
                )}
                <Text dimColor>{arrowMatch[1]} → </Text>
                <Text bold>{arrowMatch[2]}</Text>
              </Box>
            );
          }
          // Default rendering
          return (
            <Box key={idx}>
              {isFirst ? (
                <>
                  <Text>{indent}    </Text>
                  <Text dimColor>→ </Text>
                </>
              ) : (
                <Text>{indent}      </Text>
              )}
              <Text dimColor>{line}</Text>
            </Box>
          );
        };

        return (
          <Box flexDirection="column">
            {outputLines.map((line, idx) => renderLine(line, idx, idx === 0))}
          </Box>
        );
      })()}

      {/* Error output - Show clean error message from error_details */}
      {/* For linked plugins (dev mode), always show errors - overrides all other settings */}
      {(() => {
        const shouldShowError = toolCall.isLinkedPlugin || !hasAgentAncestor;
        if (toolCall.collapsed || !shouldShowError || !toolCall.error || !toolCall.result?.error_details) return null;
        // Use structured error_details.message (clean error without tool call formatting)
        const errorMessage = toolCall.result.error_details.message;
        // For linked plugins, show last N lines; otherwise truncate to first line
        const isLinked = toolCall.isLinkedPlugin;
        const allLines = errorMessage.split('\n');
        const firstLine = allLines[0] || 'Unknown error';

        let displayLines: string[];
        let needsHint = false;

        if (isLinked) {
          // Show last N lines for linked plugins (dev mode)
          if (allLines.length > BUFFER_SIZES.LINKED_PLUGIN_ERROR_LINES) {
            displayLines = allLines.slice(-BUFFER_SIZES.LINKED_PLUGIN_ERROR_LINES);
            needsHint = true;
          } else {
            displayLines = allLines;
          }
        } else {
          // Truncate to first 60 chars for regular plugins
          const truncated = firstLine.slice(0, TEXT_LIMITS.ERROR_DISPLAY_MAX);
          const needsTruncation = errorMessage.length > TEXT_LIMITS.ERROR_DISPLAY_MAX;
          displayLines = [truncated + (needsTruncation ? '...' : '')];
          needsHint = needsTruncation;
        }

        return (
          <Box flexDirection="column">
            <Box paddingLeft={indent.length + 4} flexDirection="column">
              {displayLines.map((line, i) => (
                <Text key={i} color="red" dimColor>
                  {line}
                </Text>
              ))}
            </Box>
            {needsHint && (
              <Box paddingLeft={indent.length + 4}>
                <Text color="gray" dimColor>
                  {isLinked ? 'Full error: /debug dump' : 'Full error: /debug errors'}
                </Text>
              </Box>
            )}
          </Box>
        );
      })()}

      {/* Nested content: interleaved tool calls, interjections, and compaction notices sorted by timestamp */}
      {/* Render if: has interjections, has compaction notices, not collapsed, or show_full_tool_output enabled */}
      {(interjections.length > 0 || compactionNotices.some(n => n.parentId === toolCall.id) || config?.show_full_tool_output || !toolCall.collapsed) && (() => {
        // Build combined list of children, interjections, and compaction notices
        type NestedItem =
          | { type: 'toolCall'; data: ToolCallState; timestamp: number }
          | { type: 'interjection'; data: { message: string; timestamp: number }; timestamp: number }
          | { type: 'compactionNotice'; data: CompactionNotice; timestamp: number };

        const items: NestedItem[] = [];

        // Add nested tool calls with conditional visibility
        if (toolCall.children) {
          toolCall.children.forEach(child => {
            if (shouldShowChildTool(child, toolCall.collapsed, toolCall.hideOutput, config)) {
              items.push({
                type: 'toolCall',
                data: child,
                timestamp: child.startTime
              });
            }
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

        // Add compaction notices for this tool call (visibility handled by final truncation)
        if (!toolCall.collapsed || config?.show_full_tool_output) {
          compactionNotices
            .filter(notice => notice.parentId === toolCall.id)
            .forEach(notice => {
              items.push({
                type: 'compactionNotice',
                data: notice,
                timestamp: notice.timestamp
              });
            });
        }

        // Sort by timestamp
        items.sort((a, b) => a.timestamp - b.timestamp);

        // For agent delegations: limit tool calls + compaction notices
        // Linked plugin agents (dev mode) show last 10, regular agents show last 3
        // Interjections are always shown (they don't count toward the limit)
        if (isAgentDelegation && !config?.show_full_tool_output) {
          const interjectionItems = items.filter(i => i.type === 'interjection');
          const otherItems = items.filter(i => i.type !== 'interjection');

          // Use expanded limit for linked plugin agents (dev mode), otherwise default
          const isLinkedPluginAgent = toolCall.result?._isLinkedPluginAgent === true;
          const itemLimit = isLinkedPluginAgent
            ? BUFFER_SIZES.LINKED_PLUGIN_ITEMS_PREVIEW
            : BUFFER_SIZES.TOP_ITEMS_PREVIEW;

          if (otherItems.length > itemLimit) {
            const truncated = otherItems.slice(-itemLimit);
            items.length = 0;
            items.push(...truncated, ...interjectionItems);
            items.sort((a, b) => a.timestamp - b.timestamp);
          }
        }

        // Don't render anything if no items to show
        if (items.length === 0) {
          return null;
        }

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
              } else if (item.type === 'compactionNotice') {
                // Compaction notice styled like a completed tool call
                return (
                  <Box key={`compaction-${item.data.id}`}>
                    <Text>{indent}    </Text>
                    <Text>↻ </Text>
                    <Text>Compacted</Text>
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
                    hasAgentAncestor={childrenHaveAgentAncestor}
                    compactionNotices={compactionNotices}
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
