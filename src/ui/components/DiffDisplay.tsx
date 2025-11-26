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
import { getDisplayPath } from '@utils/pathUtils.js';

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header' | 'meta';
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
  /** Maximum lines to display per hunk/edit (0 = no limit) */
  maxLinesPerHunk?: number;
  /** Number of edits being applied */
  editsCount?: number;
}

interface DiffHunk {
  header?: DiffLine;
  lines: DiffLine[];
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
  maxLinesPerHunk = 10,
  editsCount,
}) => {
  const diffLines = generateDiffLines(oldContent, newContent, filePath);

  // Group lines into hunks
  const hunks = groupIntoHunks(diffLines);

  // Count total additions and deletions across all hunks
  const additions = diffLines.filter(l => l.type === 'add').length;
  const deletions = diffLines.filter(l => l.type === 'remove').length;

  // Build summary text
  const parts: string[] = [];
  if (editsCount && editsCount > 1) {
    parts.push(`${editsCount} edits`);
  }
  if (additions > 0) parts.push(`${additions} addition${additions !== 1 ? 's' : ''}`);
  if (deletions > 0) parts.push(`${deletions} deletion${deletions !== 1 ? 's' : ''}`);
  const summary = parts.length > 0 ? parts.join(', ') : 'no changes';

  // Convert to display-friendly path (relative to cwd when possible)
  const displayPath = getDisplayPath(filePath);

  return (
    <Box flexDirection="column">
      {/* File path header */}
      <Box>
        <Text>{displayPath}</Text>
      </Box>

      {/* Changes summary */}
      <Box>
        <Text dimColor>
          Changes ({summary}):
        </Text>
      </Box>

      {/* Render each hunk separately */}
      <Box flexDirection="column">
        {hunks.map((hunk, hunkIdx) => (
          <DiffHunkDisplay
            key={hunkIdx}
            hunk={hunk}
            maxLines={maxLinesPerHunk}
            isLast={hunkIdx === hunks.length - 1}
          />
        ))}
      </Box>
    </Box>
  );
};

/**
 * Display a single hunk with optional truncation
 */
const DiffHunkDisplay: React.FC<{ hunk: DiffHunk; maxLines: number; isLast: boolean }> = ({
  hunk,
  maxLines,
  isLast,
}) => {
  const displayLines = maxLines > 0 ? hunk.lines.slice(0, maxLines) : hunk.lines;
  const truncated = maxLines > 0 && hunk.lines.length > maxLines;
  const hiddenCount = truncated ? hunk.lines.length - maxLines : 0;

  return (
    <Box flexDirection="column">
      {displayLines.map((line, idx) => (
        <DiffLine key={idx} line={line} />
      ))}
      {truncated && (
        <Box>
          <Text dimColor>
            {' '.repeat(FORMATTING.LINE_NUMBER_WIDTH)} │   ... {hiddenCount} more line{hiddenCount !== 1 ? 's' : ''} in this region
          </Text>
        </Box>
      )}
      {!isLast && hunk.lines.length > 0 && (
        <Box>
          <Text dimColor> </Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * Render a single diff line with appropriate styling
 */
const DiffLine: React.FC<{ line: DiffLine }> = ({ line }) => {
  // Determine styling based on line type
  const isDimmed = line.type === 'header' || line.type === 'meta';

  const color = (() => {
    switch (line.type) {
      case 'add': return UI_COLORS.SUCCESS;
      case 'remove': return UI_COLORS.ERROR;
      default: return undefined; // Let dimColor handle it
    }
  })();

  const prefix = (() => {
    switch (line.type) {
      case 'add': return '+ ';
      case 'remove': return '- ';
      case 'header': return '';
      default: return '  '; // context and meta get same indent
    }
  })();

  // Line number column: show for content lines, blank placeholder for headers/meta
  const hasLineNumber = line.type !== 'header';
  const lineNum = line.type === 'add' ? line.newLineNumber : line.lineNumber;
  const lineNumDisplay = hasLineNumber
    ? (lineNum ? lineNum.toString().padStart(FORMATTING.LINE_NUMBER_WIDTH, ' ') : ' '.repeat(FORMATTING.LINE_NUMBER_WIDTH))
    : '';

  return (
    <Box>
      {hasLineNumber && (
        <Text dimColor>{lineNumDisplay} │ </Text>
      )}
      <Text color={color} dimColor={isDimmed}>
        {prefix}{line.content}
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
    // Meta line (e.g., "\ No newline at end of file")
    else if (line.startsWith('\\')) {
      diffLines.push({
        type: 'meta',
        content: line,
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
 * Group diff lines into hunks (separated by header lines)
 */
function groupIntoHunks(diffLines: DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk = { lines: [] };

  for (const line of diffLines) {
    if (line.type === 'header') {
      // Start a new hunk when we hit a header
      if (currentHunk.lines.length > 0) {
        hunks.push(currentHunk);
      }
      currentHunk = { header: line, lines: [] };
    } else {
      // Add non-header lines to current hunk
      currentHunk.lines.push(line);
    }
  }

  // Add final hunk if it has content
  if (currentHunk.lines.length > 0) {
    hunks.push(currentHunk);
  }

  return hunks;
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
        Changes: <Text color={UI_COLORS.SUCCESS}>+{additions}</Text> <Text color={UI_COLORS.ERROR}>-{deletions}</Text>
      </Text>
    </Box>
  );
};
