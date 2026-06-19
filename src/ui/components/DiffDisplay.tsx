/**
 * DiffDisplay Component
 *
 * Displays file diffs with color-coded changes before applying edits.
 * Shows additions, removals, and context lines with line numbers.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { createTwoFilesPatch } from 'diff';
import { FORMATTING } from '@config/constants.js';
import { SyntaxHighlighter } from '@services/SyntaxHighlighter.js';
import { UI_COLORS } from '../constants/colors.js';
import { getDisplayPath } from '@utils/pathUtils.js';
import { padAnsiToWidth, stripAnsi, truncateAnsiToWidth } from '@utils/terminalText.js';
import { useContentWidth } from '../hooks/useContentWidth.js';

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'header' | 'meta';
  content: string;
  highlightedContent?: string;
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
  /** Number of unchanged context lines around edits */
  contextLines?: number;
  /** Enable syntax highlighting for code lines */
  syntaxHighlight?: boolean;
  /** Diff display theme from config: auto, dark, light, minimal, or a cli-highlight theme */
  diffTheme?: string;
  /** Optional direct syntax highlighting theme override */
  syntaxTheme?: string;
  /** Maximum combined old/new content size to syntax-highlight */
  maxHighlightBytes?: number;
  /** Configured style for added lines, e.g. "green" or "on rgb(20,50,20)" */
  addedColor?: string;
  /** Configured style for removed lines, e.g. "red" or "on rgb(50,20,20)" */
  removedColor?: string;
  /** Configured style for hunk headers, e.g. "yellow" or "on rgb(50,50,20)" */
  modifiedColor?: string;
}

export interface DiffHunk {
  header?: DiffLine;
  lines: DiffLine[];
}

interface DiffLineStyle {
  gutterColor?: string;
  contentColor?: string;
  backgroundColor?: string;
}

interface DiffStyles {
  add: DiffLineStyle;
  remove: DiffLineStyle;
  context: DiffLineStyle;
  header: DiffLineStyle;
  meta: DiffLineStyle;
}

// Line number column width: "     1 │ " = LINE_NUMBER_WIDTH + 3 (space, pipe, space)
const LINE_NUMBER_COLUMN_WIDTH = FORMATTING.LINE_NUMBER_WIDTH + 3;
// Prefix width: "+ " or "- " or "  " = 2 chars
const PREFIX_WIDTH = 2;
const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_HIGHLIGHT_BYTES = 200_000;
const DEFAULT_ADDED_COLOR = 'on rgb(20,50,20)';
const DEFAULT_REMOVED_COLOR = 'on rgb(50,20,20)';
const DEFAULT_MODIFIED_COLOR = 'on rgb(50,50,20)';

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
  contextLines = DEFAULT_CONTEXT_LINES,
  syntaxHighlight = true,
  diffTheme = 'auto',
  syntaxTheme,
  maxHighlightBytes = DEFAULT_MAX_HIGHLIGHT_BYTES,
  addedColor = DEFAULT_ADDED_COLOR,
  removedColor = DEFAULT_REMOVED_COLOR,
  modifiedColor = DEFAULT_MODIFIED_COLOR,
}) => {
  const contentWidth = useContentWidth();
  const resolvedSyntaxTheme = syntaxTheme ?? resolveDiffSyntaxTheme(diffTheme);
  const syntaxHighlightEnabled = syntaxHighlight && diffTheme !== 'minimal';

  const diffLines = useMemo(() => {
    const generatedLines = generateDiffLines(oldContent, newContent, filePath, contextLines);

    return applySyntaxHighlightingToDiffLines(generatedLines, oldContent, newContent, filePath, {
      enabled: syntaxHighlightEnabled,
      theme: resolvedSyntaxTheme,
      maxBytes: maxHighlightBytes,
    });
  }, [oldContent, newContent, filePath, contextLines, syntaxHighlightEnabled, resolvedSyntaxTheme, maxHighlightBytes]);

  // Group lines into hunks
  const hunks = useMemo(() => groupIntoHunks(diffLines), [diffLines]);
  const styles = useMemo(
    () => createDiffStyles(addedColor, removedColor, modifiedColor),
    [addedColor, removedColor, modifiedColor]
  );

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
        <Text dimColor>Changes ({summary}):</Text>
      </Box>

      {/* Render each hunk separately */}
      <Box flexDirection="column">
        {hunks.map((hunk, hunkIdx) => (
          <DiffHunkDisplay
            key={hunkIdx}
            hunk={hunk}
            maxLines={maxLinesPerHunk}
            isLast={hunkIdx === hunks.length - 1}
            contentWidth={contentWidth}
            styles={styles}
          />
        ))}
      </Box>
    </Box>
  );
};

/**
 * Display a single hunk with optional truncation
 */
const DiffHunkDisplay: React.FC<{
  hunk: DiffHunk;
  maxLines: number;
  isLast: boolean;
  contentWidth: number;
  styles: DiffStyles;
}> = ({ hunk, maxLines, isLast, contentWidth, styles }) => {
  const displayLines = maxLines > 0 ? hunk.lines.slice(0, maxLines) : hunk.lines;
  const truncated = maxLines > 0 && hunk.lines.length > maxLines;
  const hiddenCount = truncated ? hunk.lines.length - maxLines : 0;

  return (
    <Box flexDirection="column">
      {hunk.header && <DiffLineComponent line={hunk.header} contentWidth={contentWidth} styles={styles} />}
      {displayLines.map((line, idx) => (
        <DiffLineComponent key={idx} line={line} contentWidth={contentWidth} styles={styles} />
      ))}
      {truncated && (
        <Box>
          <Text dimColor>
            {' '.repeat(FORMATTING.LINE_NUMBER_WIDTH)} │ ... {hiddenCount} more line{hiddenCount !== 1 ? 's' : ''} in
            this region
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
 * Render a single diff line with appropriate styling and truncation for long lines
 */
const DiffLineComponent: React.FC<{
  line: DiffLine;
  contentWidth: number;
  styles: DiffStyles;
}> = ({ line, contentWidth, styles }) => {
  const isDimmed = line.type === 'header' || line.type === 'meta';
  const style = styles[line.type];

  const prefix = (() => {
    switch (line.type) {
      case 'add':
        return '+ ';
      case 'remove':
        return '- ';
      case 'header':
        return '';
      default:
        return '  '; // context and meta get same indent
    }
  })();

  // Line number column: show for content lines, blank placeholder for headers/meta
  const hasLineNumber = line.type !== 'header';
  const lineNum = line.type === 'add' ? line.newLineNumber : line.lineNumber;
  const lineNumDisplay = hasLineNumber
    ? lineNum
      ? lineNum.toString().padStart(FORMATTING.LINE_NUMBER_WIDTH, ' ')
      : ' '.repeat(FORMATTING.LINE_NUMBER_WIDTH)
    : '';

  // Calculate available width for line content (terminal width - line number column - prefix)
  const availableWidth =
    line.type === 'header'
      ? Math.max(20, contentWidth)
      : Math.max(20, contentWidth - LINE_NUMBER_COLUMN_WIDTH - PREFIX_WIDTH);
  const rawContent = line.highlightedContent ?? line.content;
  const displayContent = padAnsiToWidth(truncateAnsiToWidth(rawContent, availableWidth), availableWidth);
  const hasSyntaxAnsi = rawContent !== stripAnsi(rawContent);
  const contentColor = hasSyntaxAnsi ? undefined : style.contentColor;

  return (
    <Box>
      {hasLineNumber && (
        <Text dimColor color={style.gutterColor}>
          {lineNumDisplay} │{' '}
        </Text>
      )}
      {prefix && (
        <Text color={style.gutterColor} backgroundColor={style.backgroundColor}>
          {prefix}
        </Text>
      )}
      <Box width={availableWidth}>
        <Text color={contentColor} backgroundColor={style.backgroundColor} dimColor={isDimmed} wrap="truncate">
          {displayContent}
        </Text>
      </Box>
    </Box>
  );
};

/**
 * Generate diff lines from old and new content
 */
export function generateDiffLines(
  oldContent: string,
  newContent: string,
  filePath: string,
  contextLines: number = DEFAULT_CONTEXT_LINES
): DiffLine[] {
  const patch = createTwoFilesPatch(filePath, filePath, oldContent, newContent, '', '', {
    context: Math.max(0, contextLines),
  });

  const lines = patch.split('\n');
  const diffLines: DiffLine[] = [];
  let oldLineNum = 0;
  let newLineNum = 0;

  for (const line of lines) {
    // Skip file header lines (---, +++, Index:, ===)
    if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('Index:') || line.startsWith('===')) {
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
export function groupIntoHunks(diffLines: DiffLine[]): DiffHunk[] {
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

interface SyntaxDiffOptions {
  enabled: boolean;
  theme?: string;
  maxBytes: number;
}

export function applySyntaxHighlightingToDiffLines(
  diffLines: DiffLine[],
  oldContent: string,
  newContent: string,
  filePath: string,
  options: SyntaxDiffOptions
): DiffLine[] {
  if (!options.enabled || oldContent.length + newContent.length > options.maxBytes) {
    return diffLines;
  }

  const highlighter = SyntaxHighlighter.getInstance(options.theme);
  const language = highlighter.detectLanguage(newContent || oldContent, filePath);

  if (language === 'text') {
    return diffLines;
  }

  const oldHighlightedLines = splitHighlightedLines(
    highlighter.highlight(oldContent, { language, theme: options.theme })
  );
  const newHighlightedLines = splitHighlightedLines(
    highlighter.highlight(newContent, { language, theme: options.theme })
  );

  return diffLines.map(line => ({
    ...line,
    highlightedContent: getHighlightedContent(line, oldHighlightedLines, newHighlightedLines),
  }));
}

export function resolveDiffSyntaxTheme(diffTheme?: string): string | undefined {
  switch (diffTheme) {
    case undefined:
    case 'auto':
    case 'dark':
      return 'monokai';
    case 'light':
      return 'github';
    case 'minimal':
      return undefined;
    default:
      return diffTheme;
  }
}

function splitHighlightedLines(content: string): string[] {
  return content.split('\n');
}

function getHighlightedContent(line: DiffLine, oldHighlightedLines: string[], newHighlightedLines: string[]): string {
  if (line.type === 'remove') {
    return getOneBasedLine(oldHighlightedLines, line.lineNumber) ?? line.content;
  }

  if (line.type === 'add') {
    return getOneBasedLine(newHighlightedLines, line.newLineNumber) ?? line.content;
  }

  if (line.type === 'context') {
    return (
      getOneBasedLine(newHighlightedLines, line.newLineNumber) ??
      getOneBasedLine(oldHighlightedLines, line.lineNumber) ??
      line.content
    );
  }

  return line.content;
}

function getOneBasedLine(lines: string[], lineNumber?: number): string | undefined {
  if (!lineNumber || lineNumber < 1) {
    return undefined;
  }

  return lines[lineNumber - 1];
}

function createDiffStyles(addedColor: string, removedColor: string, modifiedColor: string): DiffStyles {
  return {
    add: parseConfiguredDiffColor(addedColor, UI_COLORS.SUCCESS),
    remove: parseConfiguredDiffColor(removedColor, UI_COLORS.ERROR),
    context: {},
    header: parseConfiguredDiffColor(modifiedColor, UI_COLORS.WARNING),
    meta: { contentColor: UI_COLORS.TEXT_DIM, gutterColor: UI_COLORS.TEXT_DIM },
  };
}

function parseConfiguredDiffColor(configuredColor: string | undefined, fallbackColor: string): DiffLineStyle {
  const color = configuredColor?.trim();
  if (!color) {
    return { gutterColor: fallbackColor, contentColor: fallbackColor };
  }

  const backgroundMatch = color.match(/^on\s+(.+)$/i);
  if (backgroundMatch?.[1]) {
    return {
      gutterColor: fallbackColor,
      contentColor: undefined,
      backgroundColor: backgroundMatch[1].trim(),
    };
  }

  return {
    gutterColor: color,
    contentColor: color,
  };
}

/**
 * Simple diff display for previewing changes inline
 */
export const InlineDiff: React.FC<{ oldContent: string; newContent: string }> = ({ oldContent, newContent }) => {
  const diffLines = generateDiffLines(oldContent, newContent, 'file');

  // Count changes
  const additions = diffLines.filter(l => l.type === 'add').length;
  const deletions = diffLines.filter(l => l.type === 'remove').length;

  return (
    <Box flexDirection="column">
      <Text dimColor>
        Changes: <Text color={UI_COLORS.SUCCESS}>+{additions}</Text> <Text color={UI_COLORS.ERROR}>-{deletions}</Text>
      </Text>
    </Box>
  );
};
