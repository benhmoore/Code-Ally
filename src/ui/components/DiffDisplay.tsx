/**
 * DiffDisplay Component
 *
 * Displays file diffs with color-coded changes before applying edits.
 * Shows additions, removals, and context lines with line numbers.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { createTwoFilesPatch } from 'diff';
import { FORMATTING } from '../../config/constants.js';

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header';
  content: string;
  lineNumber?: number;
  newLineNumber?: number;
}

export interface DiffDisplayProps {
  /** Original file content */
  oldContent: string;
  /** New file content */
  newContent: string;
  /** File path for display */
  filePath?: string;
  /** Maximum lines to display (0 = no limit) */
  maxLines?: number;
}

/**
 * DiffDisplay Component
 *
 * Generates and displays a unified diff between old and new file content.
 * Uses color coding:
 * - Green: Added lines
 * - Red: Removed lines
 * - White: Context lines
 * - Cyan: Headers
 */
export const DiffDisplay: React.FC<DiffDisplayProps> = ({
  oldContent,
  newContent,
  filePath = 'file',
  maxLines = 0,
}) => {
  const diffLines = generateDiffLines(oldContent, newContent, filePath);

  // Limit display if maxLines is set
  const displayLines = maxLines > 0 ? diffLines.slice(0, maxLines) : diffLines;
  const hasMore = maxLines > 0 && diffLines.length > maxLines;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
      <Box>
        <Text bold color="yellow">
          File Changes: {filePath}
        </Text>
      </Box>

      <Box flexDirection="column">
        {displayLines.map((line, idx) => (
          <DiffLine key={idx} line={line} />
        ))}
        {hasMore && (
          <Text dimColor>
            ... {diffLines.length - maxLines} more lines
          </Text>
        )}
      </Box>
    </Box>
  );
};

/**
 * Render a single diff line with appropriate styling
 */
const DiffLine: React.FC<{ line: DiffLine }> = ({ line }) => {
  const getColor = (): string => {
    switch (line.type) {
      case 'add':
        return 'green';
      case 'remove':
        return 'red';
      case 'header':
        return 'cyan';
      default:
        return 'white';
    }
  };

  const getPrefix = (): string => {
    switch (line.type) {
      case 'add':
        return '+ ';
      case 'remove':
        return '- ';
      case 'context':
        return '  ';
      default:
        return '';
    }
  };

  const showLineNumber = line.type !== 'header';
  const lineNum = line.type === 'add' ? line.newLineNumber : line.lineNumber;
  const lineNumStr = showLineNumber && lineNum ? `${lineNum.toString().padStart(FORMATTING.LINE_NUMBER_WIDTH, ' ')} │ ` : '';

  return (
    <Box>
      {showLineNumber && (
        <Text dimColor>{lineNumStr}</Text>
      )}
      <Text color={getColor()}>
        {getPrefix()}
        {line.content}
      </Text>
    </Box>
  );
};

/**
 * Generate diff lines from old and new content
 */
function generateDiffLines(oldContent: string, newContent: string, filePath: string): DiffLine[] {
  const patch = createTwoFilesPatch(
    filePath,
    filePath,
    oldContent,
    newContent,
    '',
    '',
    { context: 3 }
  );

  const lines = patch.split('\n');
  const diffLines: DiffLine[] = [];
  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    // Skip file header lines (---, +++, Index:, ===)
    if (
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('Index:') ||
      line.startsWith('===')
    ) {
      continue;
    }

    // Parse chunk header (@@ -1,3 +1,4 @@)
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/);
      if (match && match[1] && match[2]) {
        oldLineNum = parseInt(match[1], 10) - 1;
        newLineNum = parseInt(match[2], 10) - 1;
      }

      diffLines.push({
        type: 'header',
        content: line,
      });
      continue;
    }

    // Added line
    if (line.startsWith('+')) {
      newLineNum++;
      diffLines.push({
        type: 'add',
        content: line.substring(1),
        newLineNumber: newLineNum,
      });
    }
    // Removed line
    else if (line.startsWith('-')) {
      oldLineNum++;
      diffLines.push({
        type: 'remove',
        content: line.substring(1),
        lineNumber: oldLineNum,
      });
    }
    // Context line
    else if (line.startsWith(' ')) {
      oldLineNum++;
      newLineNum++;
      diffLines.push({
        type: 'context',
        content: line.substring(1),
        lineNumber: oldLineNum,
        newLineNumber: newLineNum,
      });
    }
    // Other lines (shouldn't happen in unified diff)
    else if (line.trim()) {
      diffLines.push({
        type: 'context',
        content: line,
      });
    }
  }

  return diffLines;
}

/**
 * Simple diff display for previewing changes inline
 */
export const InlineDiff: React.FC<{ oldContent: string; newContent: string }> = ({
  oldContent,
  newContent,
}) => {
  const diffLines = generateDiffLines(oldContent, newContent, 'file');

  // Count changes
  const additions = diffLines.filter((l) => l.type === 'add').length;
  const deletions = diffLines.filter((l) => l.type === 'remove').length;

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Changes: <Text color="green">+{additions}</Text> <Text color="red">-{deletions}</Text>
      </Text>
    </Box>
  );
};
