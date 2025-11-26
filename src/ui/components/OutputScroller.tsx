import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

interface OutputScrollerProps {
  /** Raw output text (can be multi-line) */
  output: string;
  /** Maximum number of lines to display */
  maxLines: number;
  /** Maximum characters per line before truncation (default: 120) */
  maxCharsPerLine?: number;
}

/**
 * OutputScroller Component
 *
 * Displays the last N lines of tool output with scrolling behavior.
 * Shows "..." indicator if there are more lines than can fit.
 * Truncates long lines to prevent horizontal overflow.
 *
 * This is a key component for the concurrent tool visualization system,
 * enabling each tool to display its output within a constrained height.
 */
export const OutputScroller: React.FC<OutputScrollerProps> = ({
  output,
  maxLines,
  maxCharsPerLine = 120,
}) => {
  const { displayLines, hasMoreLines } = useMemo(() => {
    // Split output into lines
    const lines = output.split('\n');

    // Determine if we need to show truncation indicator
    const needsTruncation = lines.length > maxLines;

    // Get the last N lines (or all if fewer than maxLines)
    const lastLines = lines.slice(-maxLines);

    // Truncate each line if it exceeds max characters
    const truncatedLines = lastLines.map(line => {
      if (line.length > maxCharsPerLine) {
        return line.slice(0, maxCharsPerLine - 3) + '...';
      }
      return line;
    });

    return {
      displayLines: truncatedLines,
      hasMoreLines: needsTruncation,
    };
  }, [output, maxLines, maxCharsPerLine]);

  return (
    <Box flexDirection="column">
      {hasMoreLines && (
        <Text color="gray" dimColor>
          ... ({output.split('\n').length - maxLines} more lines)
        </Text>
      )}

      {displayLines.map((line, index) => (
        <Text key={index}>{line}</Text>
      ))}
    </Box>
  );
};
