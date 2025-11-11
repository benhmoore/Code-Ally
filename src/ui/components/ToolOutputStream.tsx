/**
 * ToolOutputStream Component
 *
 * Displays real-time tool output during execution.
 * Shows tool name, status, and streaming output lines.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { getStatusColor, type ToolStatus } from '../utils/statusUtils.js';
import { TEXT_LIMITS } from '../../config/constants.js';

export interface ToolOutputStreamProps {
  /** Name of the tool being executed */
  toolName: string;
  /** Tool output (can be partial/streaming) */
  output: string;
  /** Status of the tool */
  status?: ToolStatus;
  /** Optional error message */
  error?: string;
  /** Maximum lines to display (0 = all) */
  maxLines?: number;
}

/**
 * ToolOutputStream Component
 *
 * Renders streaming output from tool execution.
 * Supports:
 * - Real-time output display
 * - Line limiting for long outputs
 * - Status indicators
 * - Error display
 */
export const ToolOutputStream: React.FC<ToolOutputStreamProps> = ({
  toolName,
  output,
  status = 'executing',
  error,
  maxLines = 10,
}) => {
  const lines = output.split('\n').filter((line) => line.trim());
  const displayLines = maxLines > 0 ? lines.slice(-maxLines) : lines;
  const hasMore = maxLines > 0 && lines.length > maxLines;

  const statusColor = getStatusColor(status);

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {/* Tool name header */}
      <Text dimColor color={statusColor}>
        → {toolName}
      </Text>

      {/* Output lines */}
      {displayLines.length > 0 && (
        <Box flexDirection="column" paddingLeft={2}>
          {hasMore && (
            <Text dimColor italic>
              ... {lines.length - maxLines} lines omitted
            </Text>
          )}
          {displayLines.map((line, idx) => (
            <Text key={idx} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}

      {/* Error message */}
      {error && (
        <Box paddingLeft={2} marginTop={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      {/* Status indicator */}
      {status === 'executing' && (
        <Box paddingLeft={2}>
          <Text dimColor italic>
            [executing...]
          </Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * ToolOutputGroup Component
 *
 * Groups multiple tool outputs together for concurrent tool execution.
 */
export interface ToolOutputGroupProps {
  /** Array of tool outputs */
  tools: Array<{
    id: string;
    toolName: string;
    output: string;
    status?: ToolStatus;
    error?: string;
  }>;
  /** Maximum lines per tool */
  maxLinesPerTool?: number;
}

export const ToolOutputGroup: React.FC<ToolOutputGroupProps> = ({ tools, maxLinesPerTool = 5 }) => {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Executing {tools.length} tool{tools.length !== 1 ? 's' : ''}:
      </Text>
      {tools.map((tool) => (
        <Box key={tool.id} marginTop={1}>
          <ToolOutputStream
            toolName={tool.toolName}
            output={tool.output}
            status={tool.status}
            error={tool.error}
            maxLines={maxLinesPerTool}
          />
        </Box>
      ))}
    </Box>
  );
};

/**
 * StreamingToolOutput Component
 *
 * Shows tool output with a streaming animation for long-running operations.
 */
export interface StreamingToolOutputProps {
  /** Tool name */
  toolName: string;
  /** Tool description */
  description?: string;
  /** Output lines (array for easier streaming) */
  outputLines: string[];
  /** Maximum visible lines */
  maxVisibleLines?: number;
  /** Elapsed time in seconds */
  elapsedSeconds?: number;
}

export const StreamingToolOutput: React.FC<StreamingToolOutputProps> = ({
  toolName,
  description,
  outputLines,
  maxVisibleLines = 10,
  elapsedSeconds,
}) => {
  const visibleLines = outputLines.slice(-maxVisibleLines);
  const hasMore = outputLines.length > maxVisibleLines;

  // Truncate description if too long
  const truncatedDesc =
    description && description.length > TEXT_LIMITS.DESCRIPTION_MAX ? description.slice(0, TEXT_LIMITS.DESCRIPTION_MAX - 3) + '...' : description;

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box>
        <Text color="yellow">{toolName}</Text>
        {truncatedDesc && (
          <Text dimColor> {truncatedDesc}</Text>
        )}
        {elapsedSeconds !== undefined && elapsedSeconds > 5 && (
          <Text dimColor color="cyan">
            {' '}
            [{elapsedSeconds}s]
          </Text>
        )}
      </Box>

      {/* Output lines */}
      {visibleLines.length > 0 && (
        <Box flexDirection="column" paddingLeft={2} marginTop={1}>
          {hasMore && (
            <Text dimColor italic>
              ...
            </Text>
          )}
          {visibleLines.map((line, idx) => {
            // Truncate very long lines
            const displayLine = line.length > TEXT_LIMITS.LINE_DISPLAY_MAX ? line.slice(0, TEXT_LIMITS.LINE_DISPLAY_MAX - 3) + '...' : line;
            return (
              <Text key={idx} dimColor>
                {displayLine}
              </Text>
            );
          })}
        </Box>
      )}

      {/* Waiting indicator if no output yet */}
      {visibleLines.length === 0 && (
        <Box paddingLeft={2} marginTop={1}>
          <Text dimColor italic>
            [waiting for output...]
          </Text>
        </Box>
      )}
    </Box>
  );
};
