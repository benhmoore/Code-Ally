/**
 * DiffDisplay Component
 *
 * Displays file diffs with color-coded changes before applying edits.
 * Shows additions, removals, and context lines with line numbers.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { createTwoFilesPatch } from 'diff';
import { FORMATTING } from '@config/constants.js';
import { UI_COLORS } from '../constants/colors.js';

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

  // Filter out header lines (@@) for display
  const contentLines = diffLines.filter(line => line.type !== 'header');

  // Count additions and deletions
  const additions = contentLines.filter(l => l.type === 'add').length;
  const deletions = contentLines.filter(l => l.type === 'remove').length;

  // Limit display if maxLines is set
  const displayLines = maxLines > 0 ? contentLines.slice(0, maxLines) : contentLines;
  const hasMore = maxLines > 0 && contentLines.length > maxLines;

  // Build summary text
  const parts: string[] = [];
  if (additions > 0) parts.push(`${additions} addition${additions !== 1 ? 's' : ''}`);
  if (deletions > 0) parts.push(`${deletions} deletion${deletions !== 1 ? 's' : ''}`);
  const summary = parts.length > 0 ? parts.join(', ') : 'no changes';

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>
          Changes ({summary}):
        </Text>
      </Box>

      <Box flexDirection="column">
        {displayLines.map((line, idx) => (
          <DiffLine key={idx} line={line} />
        ))}
        {hasMore && (
          <Text dimColor>
            ... {contentLines.length - maxLines} more lines
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
        return UI_COLORS.TEXT_DEFAULT;
      case 'remove':
        return UI_COLORS.ERROR;
      case 'header':
        return UI_COLORS.TEXT_DIM;
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
        Changes: <Text color={UI_COLORS.TEXT_DEFAULT}>+{additions}</Text> <Text color={UI_COLORS.ERROR}>-{deletions}</Text>
      </Text>
    </Box>
  );
};
