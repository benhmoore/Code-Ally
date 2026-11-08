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

import React from 'react';
import { truncateAnsiToWidth } from '@utils/terminalText.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { Box, Text } from 'ink';
import { ToolCallState } from '@shared/index.js';
import type { ToolCallTreeNode } from '@shared/index.js';
import { CompactionNotice } from '../contexts/AppContext.js';
import { DiffDisplay } from './DiffDisplay.js';
import { formatDuration } from '../utils/timeUtils.js';
import { getStatusColor, getStatusIcon } from '../utils/statusUtils.js';
import { formatDisplayName } from '../utils/uiHelpers.js';
import { TEXT_LIMITS, isAgentDelegationTool, UI_DELAYS, BUFFER_SIZES } from '@config/constants.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { UI_COLORS } from '../constants/colors.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { defaultSubtextFilePath, type BaseTool } from '@tools/BaseTool.js';
import { linkFileNameIn, terminalHyperlinksEnabled } from '../utils/fileLinks.js';
import { resolveToolVisibility } from '../utils/toolVisibility.js';
import { Clickable } from './Clickable.js';
import { getToolCallTiming } from '@utils/toolTiming.js';
import { permissionDecisionText } from '../utils/permissionPresentation.js';

interface ToolCallDisplayProps {
  /** Tool call to display */
  toolCall: ToolCallTreeNode;
  /** Indentation level (0 = root) */
  level?: number;
  /** Config for output display preferences */
  config?: any;
  /** Compaction notices to check for nested notices */
  compactionNotices?: CompactionNotice[];
  /** Available width after the conversation-level indent. */
  width?: number;
  /** Open or close the call; present only while the row is in the live region. */
  onToggle?: (id: string) => void;
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
      const toolManager = registry.get('tool_manager');

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
/**
 * The registered tool instance behind a tool call, or undefined when the
 * registry is unavailable (e.g., in tests) so callers fall back to legacy logic.
 */
function lookupTool(toolName: string): BaseTool | undefined {
  try {
    return ServiceRegistry.getInstance().get('tool_manager')?.getTool(toolName);
  } catch {
    return undefined;
  }
}

/**
 * The file a tool call's subtext refers to, for linking its name.
 */
function extractSubtextFilePath(toolCall: ToolCallState, toolName: string): string | null {
  const args = toolCall.arguments;
  if (!args || typeof args !== 'object') {
    return null;
  }
  const tool = lookupTool(toolName);
  return tool ? tool.subtextFilePath(args) : defaultSubtextFilePath(args);
}

function extractSubtext(toolCall: ToolCallState, toolName: string, isAgentTool: boolean = false): string {
  const args = toolCall.arguments;
  if (!args || typeof args !== 'object') {
    return '';
  }

  let subtext = '';

  // Pass result to formatSubtext if available (for tools that need post-execution data)
  const tool = lookupTool(toolName);
  if (tool && typeof tool.formatSubtext === 'function') {
    const formatted = tool.formatSubtext(args, toolCall.result);
    if (formatted) {
      subtext = formatted;
    }
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

/** Physical prompt-preview rows shared with the live-region height budget. */
export function agentPreviewLines(toolCall: ToolCallTreeNode, width: number, level = 0): string[] {
  if (!isAgentDelegationTool(toolCall.toolName)) return [];
  const subtext = extractSubtext(toolCall, toolCall.toolName, true);
  if (!subtext) return [];
  const running = toolCall.status === 'pending' || toolCall.status === 'executing';
  const lines = subtext.split('\n');
  const limit = running && toolCall.expanded === true && !(toolCall.children?.length) ? 5 : 1;
  return lines.slice(0, limit).map((line, index) => truncateAnsiToWidth(
    index === limit - 1 && lines.length > limit ? `${line} …` : line,
    Math.max(1, width - level * 4 - 6)
  ));
}


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
  compactionNotices = [],
  width,
  onToggle,
}) => {
  const contentWidth = useContentWidth();
  const isRunning = toolCall.status === 'executing' || toolCall.status === 'pending';
  const permissionAudit = permissionDecisionText(toolCall.permissionDecision);
  const visibility = resolveToolVisibility(toolCall, config);

  const interjections = toolCall.interjections ?? [];
  const acknowledgments = toolCall.acknowledgments ?? [];

  // Calculate execution duration (no live updates - just shows duration at render time).
  // Pre-execution validation and permission time are intentionally excluded.
  const duration = getToolCallTiming(toolCall).executionMs;
  const durationStr = formatDuration(duration);

  // Check if this is an agent delegation
  const isAgentDelegation = isAgentDelegationTool(toolCall.toolName);

  // Determine display name:
  // 1. For agent tools: Use agent_type (foundational value) and transform to Title Case
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
  } else {
    // Try to get custom displayName from tool instance
    try {
      const registry = ServiceRegistry.getInstance();
      const toolManager = registry.get('tool_manager');
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

  // The file name inside the subtext opens the file when the terminal supports it
  const hyperlinks = terminalHyperlinksEnabled(config);
  const subtextFilePath = hyperlinks ? extractSubtextFilePath(toolCall, toolCall.toolName) : null;
  const linkedSubtext = subtextFilePath ? linkFileNameIn(subtext, subtextFilePath) : subtext;

  // Extract thoroughness for agent delegation tools
  const thoroughness = isAgentDelegation ? toolCall.arguments?.thoroughness : null;

  // Indent based on level
  const indent = '    '.repeat(level);

  // Status indicator - errors/cancellations always use standard styling for consistency
  const isErrorState = toolCall.status === 'error' || toolCall.status === 'cancelled';
  const statusColor = isErrorState
    ? getStatusColor(toolCall.status)
    : (toolCall.displayColor || getStatusColor(toolCall.status));
  const statusIcon = getStatusIcon(toolCall.status);

  // Prefix icon: errors always show standard icon, otherwise custom or status-based
  const prefixIcon = isErrorState
    ? statusIcon
    : toolCall.displayIcon
      ? toolCall.displayIcon
      : isRunning
        ? UI_SYMBOLS.NAVIGATION.ARROW_RIGHT
        : statusIcon;

  // Tool-use count for the collapsed agent summary. Sub-agent tool calls are
  // stream-isolated and never ingested, so for agent delegations the authoritative
  // count comes from AGENT_END (toolUseCount); non-agent tools still use child count.
  const toolCallCount = (isAgentDelegation ? toolCall.toolUseCount : undefined) ?? toolCall.totalChildCount ?? 0;

  // Trim all leading/trailing whitespace from output for clean display
  const trimmedOutput = toolCall.output?.trim();

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {/* The header row opens or closes the call when clicked */}
      <Clickable flexShrink={0} onPress={onToggle && (() => onToggle(toolCall.id))}>
        {/* Indentation */}
        <Text>{indent}</Text>

        {/* Status prefix icon */}
        <Text color={statusColor}>{prefixIcon} </Text>

        {/* Tool name (or agent name for agent tool) - hidden if hideToolName is true */}
        {!toolCall.hideToolName && (
          <Text color={statusColor} bold={level === 0}>
            {displayName}
          </Text>
        )}

        {/* When hideToolName is true, show subtext as the main content */}
        {toolCall.hideToolName && subtext && (
          <Text color={statusColor}>{linkedSubtext}</Text>
        )}

        {/* Model - show for agent delegations only if different from primary */}
        {!toolCall.hideToolName && isAgentDelegation && toolCall.agentModel && config?.model && toolCall.agentModel !== config.model && (
          <Text dimColor> · {toolCall.agentModel}</Text>
        )}

        {/* Thoroughness - show for agent delegations */}
        {!toolCall.hideToolName && thoroughness && (
          <Text dimColor> · {thoroughness}</Text>
        )}

        {/* Compacting indicator - only show when agent is compacting */}
        {!toolCall.hideToolName && isAgentDelegation && toolCall.isCompacting && (
          <Text dimColor> · compacting</Text>
        )}

        {/* Subtext - contextual information (not shown inline for agents or when hideToolName) */}
        {!toolCall.hideToolName && subtext && !isAgentDelegation && (
          <Text dimColor> · {linkedSubtext}</Text>
        )}

        {/* Arguments preview - only show if config enabled and not hideToolName */}
        {!toolCall.hideToolName && argsPreview && config?.show_tool_parameters_in_chat && (
          <Text dimColor> ({argsPreview})</Text>
        )}

        {/* Duration - always show for agents, show for others if > 5 seconds (not for hideToolName) */}
        {!toolCall.hideToolName && (isAgentDelegation || duration > UI_DELAYS.TOOL_DURATION_DISPLAY_THRESHOLD) && (
          <Text dimColor> · {durationStr}</Text>
        )}
      </Clickable>

      {permissionAudit && (
        <Box paddingLeft={indent.length + 2}>
          <Text dimColor wrap="truncate-end">{permissionAudit}</Text>
        </Box>
      )}

      {/* Prompt previews use physical rows; the live-region budget shares this projection. */}
      {isAgentDelegation && agentPreviewLines(toolCall, width ?? contentWidth, level).map((line, index) => (
        <Box key={index} flexShrink={0}>
          <Text>{indent}    </Text>
          <Text color={UI_COLORS.PRIMARY}>{index === 0 ? '> ' : '  '}</Text>
          <Text>{line}</Text>
        </Box>
      ))}

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
      {!visibility.collapsed && toolCall.diffPreview && config?.diff_display_enabled !== false && (
        <Box flexDirection="column" paddingLeft={indent.length + 4}>
          <DiffDisplay
            oldContent={toolCall.diffPreview.oldContent}
            newContent={toolCall.diffPreview.newContent}
            filePath={toolCall.diffPreview.filePath}
            maxLinesPerHunk={10}
            editsCount={toolCall.diffPreview.editsCount}
            contextLines={config?.diff_display_context_lines}
            diffTheme={config?.diff_display_theme}
            maxHighlightBytes={config?.diff_display_max_file_size}
            reservedColumns={indent.length + 6}
            addedColor={config?.diff_display_color_added}
            removedColor={config?.diff_display_color_removed}
            modifiedColor={config?.diff_display_color_modified}
            hyperlinks={hyperlinks}
            layout={config?.diff_display_layout}
          />
        </Box>
      )}

      {/* Output as threaded child (hidden if collapsed or own hideOutput, unless show_full_tool_output is enabled) */}
      {/* For linked plugins (dev mode) or alwaysShowFullOutput tools, always show output - overrides all other settings */}
      {(() => {
        if (!visibility.showOutput || !trimmedOutput) return null;

        // Get the output text to display
        const displayOutput = visibility.fullOutput || trimmedOutput.length <= TEXT_LIMITS.CONTENT_PREVIEW_MAX
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

      {/* Error output */}
      {/* For linked plugins (dev mode), always show errors - overrides all other settings */}
      {(() => {
        if (visibility.collapsed || !toolCall.error) return null;
        const errorMessage = toolCall.result?.error ?? toolCall.error;
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
      {(interjections.length > 0 || compactionNotices.some(n => n.parentId === toolCall.id) || visibility.showChildren) && (() => {
        // Build combined list of children, interjections, and compaction notices
        type NestedItem =
          | { type: 'toolCall'; data: ToolCallState; timestamp: number }
          | { type: 'interjection'; data: { message: string; timestamp: number }; timestamp: number }
          | { type: 'compactionNotice'; data: CompactionNotice; timestamp: number };

        const items: NestedItem[] = [];

        // Add nested tool calls with conditional visibility
        if (toolCall.children) {
          toolCall.children.forEach(child => {
            if (shouldShowChildTool(child, visibility.collapsed, toolCall.hideOutput, config)) {
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
        if (visibility.showChildren) {
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
                    compactionNotices={compactionNotices}
                    width={width}
                    onToggle={onToggle}
                  />
                );
              }
            })}
          </>
        );
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
