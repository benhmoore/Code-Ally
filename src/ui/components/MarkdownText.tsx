/**
 * MarkdownText Component
 *
 * Renders markdown content with syntax highlighting for code blocks.
 * Supports:
 * - Code blocks with language-specific syntax highlighting
 * - Inline code with backtick formatting
 * - Bold/italic text
 * - Lists (bullet and numbered)
 * - Headers with color coding
 * - Links (dimmed display)
 * - Tables with bordered formatting
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { marked } from 'marked';
import { SyntaxHighlighter } from '@services/SyntaxHighlighter.js';
import { TEXT_LIMITS, FORMATTING } from '@config/constants.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { UI_COLORS } from '../constants/colors.js';

// Table rendering constants (specific to markdown table formatting)
const TABLE_FORMATTING = {
  /** Table outer border width (2 chars for '| |') */
  BORDER_WIDTH: 2,
  /** Table column separator width (3 chars for ' | ') */
  SEPARATOR_WIDTH: 3,
  /** Table padding per column (2 chars for left/right padding) */
  PADDING_PER_COL: 2,
  /** Table safety margin for rendering */
  SAFETY_MARGIN: 4,
};

export interface MarkdownTextProps {
  /** Markdown content to render */
  content: string;
  /** Optional syntax highlighting theme */
  theme?: string;
}

interface ParsedNode {
  type: 'text' | 'code' | 'heading' | 'list' | 'list-item' | 'paragraph' | 'strong' | 'em' | 'codespan' | 'link' | 'table';
  content?: string;
  language?: string;
  depth?: number;
  ordered?: boolean;
  children?: ParsedNode[];
  // Table-specific fields
  header?: string[];
  rows?: string[][];
  align?: ('left' | 'right' | 'center' | null)[];
}

/**
 * MarkdownText Component
 *
 * Parses markdown and renders it with appropriate terminal styling.
 * Uses marked for parsing and cli-highlight for syntax highlighting.
 */
export const MarkdownText: React.FC<MarkdownTextProps> = ({ content, theme }) => {
  // Use singleton instance for better performance (avoids creating new instances)
  const highlighter = useMemo(() => SyntaxHighlighter.getInstance(theme), [theme]);

  const parsed = useMemo(() => {
    try {
      // Parse markdown to tokens
      const tokens = marked.lexer(content);
      return parseTokens(tokens);
    } catch (error) {
      // Fallback to plain text if parsing fails
      return [{ type: 'text' as const, content }];
    }
  }, [content]);

  return (
    <Box flexDirection="column">
      {parsed.map((node, idx) => (
        <RenderNode key={idx} node={node} highlighter={highlighter} />
      ))}
    </Box>
  );
};

/**
 * Parse marked tokens into our simplified node structure
 */
function parseTokens(tokens: any[]): ParsedNode[] {
  const nodes: ParsedNode[] = [];

  for (const token of tokens) {
    if (token.type === 'code') {
      nodes.push({
        type: 'code',
        content: token.text,
        language: token.lang || undefined,
      });
    } else if (token.type === 'heading') {
      nodes.push({
        type: 'heading',
        content: token.text,
        depth: token.depth,
      });
    } else if (token.type === 'table') {
      // Extract header
      const header = token.header.map((cell: any) =>
        stripInlineMarkdown(cell.text || '')
      );

      // Extract rows
      const rows = token.rows.map((row: any) =>
        row.map((cell: any) => stripInlineMarkdown(cell.text || ''))
      );

      nodes.push({
        type: 'table',
        header,
        rows,
        align: token.align || [],
      });
    } else if (token.type === 'list') {
      nodes.push({
        type: 'list',
        ordered: token.ordered,
        children: token.items.map((item: any) => ({
          type: 'list-item' as const,
          content: item.text,
        })),
      });
    } else if (token.type === 'paragraph') {
      nodes.push({
        type: 'paragraph',
        content: token.text,
      });
    } else if (token.type === 'space') {
      // Skip space tokens
      continue;
    } else {
      // Fallback for unknown token types
      nodes.push({
        type: 'text',
        content: (token as any).raw || '',
      });
    }
  }

  return nodes;
}

/**
 * Render a single parsed node
 */
const RenderNode: React.FC<{ node: ParsedNode; highlighter: SyntaxHighlighter }> = ({
  node,
  highlighter,
}) => {
  if (node.type === 'code') {
    const highlighted = highlighter.highlight(node.content || '', {
      language: node.language,
    });

    return (
      <Box flexDirection="column" paddingLeft={2} marginY={1}>
        <Text dimColor color={UI_COLORS.TEXT_DIM}>
          {node.language ? `[${node.language}]` : '[code]'}
        </Text>
        <Box flexDirection="column" borderStyle="single" borderColor={UI_COLORS.TEXT_DIM} paddingX={1}>
          {highlighted.split('\n').map((line, idx) => (
            <Text key={idx}>{line}</Text>
          ))}
        </Box>
      </Box>
    );
  }

  if (node.type === 'heading') {
    return (
      <Box marginY={1}>
        <Text bold color={UI_COLORS.TEXT_DEFAULT}>
          {node.content}
        </Text>
      </Box>
    );
  }

  if (node.type === 'list') {
    return (
      <Box flexDirection="column" marginY={1}>
        {node.children?.map((item, idx) => (
          <Box key={idx} paddingLeft={2}>
            <Text>
              {node.ordered ? `${idx + 1}. ` : '• '}
              {stripInlineMarkdown(item.content || '')}
            </Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (node.type === 'table') {
    return <TableRenderer header={node.header || []} rows={node.rows || []} />;
  }

  if (node.type === 'paragraph') {
    const formatted = formatInlineMarkdown(node.content || '');
    return (
      <Box marginY={1}>
        <Text>{formatted}</Text>
      </Box>
    );
  }

  if (node.type === 'text') {
    return (
      <Box>
        <Text>{node.content}</Text>
      </Box>
    );
  }

  return null;
};

/**
 * Table Renderer Component
 *
 * Renders markdown tables with borders and proper column width calculation
 * Automatically adjusts column widths to fit terminal width
 */
const TableRenderer: React.FC<{ header: string[]; rows: string[][] }> = ({ header, rows }) => {
  const terminalWidth = useContentWidth();

  // Calculate optimal column widths with terminal width constraints
  const columnWidths = useMemo(() => {

    // Helper to get max line length for cells with line breaks
    const getMaxLineLength = (text: string): number => {
      const lines = text.split('\n');
      return Math.max(...lines.map(line => line.length));
    };

    // Calculate natural widths (what content actually needs)
    const naturalWidths = header.map((h) => getMaxLineLength(h));
    rows.forEach((row) => {
      row.forEach((cell, colIdx) => {
        naturalWidths[colIdx] = Math.max(naturalWidths[colIdx] || 0, getMaxLineLength(cell));
      });
    });

    // Calculate table overhead: borders and padding
    // Format: │ col1 │ col2 │ col3 │
    // Overhead = 2 (outer borders) + (numCols - 1) * 3 (separators) + numCols * 2 (padding)
    const numCols = header.length;
    const borderOverhead =
      TABLE_FORMATTING.BORDER_WIDTH +
      (numCols - 1) * TABLE_FORMATTING.SEPARATOR_WIDTH +
      numCols * TABLE_FORMATTING.PADDING_PER_COL;
    const availableWidth = terminalWidth - borderOverhead - TABLE_FORMATTING.SAFETY_MARGIN;

    // Sum of natural widths
    const totalNaturalWidth = naturalWidths.reduce((sum, w) => sum + w, 0);

    // If table fits naturally, use natural widths
    if (totalNaturalWidth <= availableWidth) {
      return naturalWidths;
    }

    // Table is too wide - need to distribute space proportionally
    // Set minimum width per column (at least 10 chars or header length)
    const minWidths = header.map((h) => Math.max(FORMATTING.TABLE_COLUMN_MIN_WIDTH, h.length));
    const totalMinWidth = minWidths.reduce((sum, w) => sum + w, 0);

    // If even minimum widths don't fit, use equal distribution
    if (totalMinWidth > availableWidth) {
      const equalWidth = Math.floor(availableWidth / numCols);
      return header.map(() => Math.max(8, equalWidth));
    }

    // Distribute remaining space proportionally based on natural widths
    const remainingSpace = availableWidth - totalMinWidth;
    const excessWidths = naturalWidths.map((w, i) => Math.max(0, w - (minWidths[i] ?? 0)));
    const totalExcess = excessWidths.reduce((sum, w) => sum + w, 0);

    return minWidths.map((minWidth, i) => {
      if (totalExcess === 0) return minWidth;
      const excess = excessWidths[i] ?? 0;
      const proportionalBonus = Math.floor((excess / totalExcess) * remainingSpace);
      return minWidth + proportionalBonus;
    });
  }, [header, rows, terminalWidth]);

  // Wrap text to fit within specified width
  const wrapText = (text: string, width: number): string[] => {
    // First, split on explicit line breaks (\n)
    const explicitLines = text.split('\n');
    const wrappedLines: string[] = [];

    // Then wrap each line individually if needed
    for (const line of explicitLines) {
      if (line.length <= width) {
        wrappedLines.push(line);
        continue;
      }

      let remaining = line;
      while (remaining.length > 0) {
        if (remaining.length <= width) {
          wrappedLines.push(remaining);
          break;
        }

        // Try to break at a space
        let breakPoint = width;
        const lastSpace = remaining.lastIndexOf(' ', width);

        if (lastSpace > width * TEXT_LIMITS.WORD_BOUNDARY_THRESHOLD) {
          // Good break point found (not too early)
          breakPoint = lastSpace;
        }

        wrappedLines.push(remaining.substring(0, breakPoint));
        remaining = remaining.substring(breakPoint).trimStart();
      }
    }

    return wrappedLines;
  };

  // Pad a cell to the specified width
  const padCell = (text: string, width: number): string => {
    return text.padEnd(width, ' ');
  };

  // Create horizontal separator lines with proper connectors
  const createTopBorder = (): string => {
    return UI_SYMBOLS.BORDER.TOP_LEFT + UI_SYMBOLS.BORDER.HORIZONTAL + columnWidths.map((w) => UI_SYMBOLS.BORDER.HORIZONTAL.repeat(w)).join(UI_SYMBOLS.BORDER.HORIZONTAL + UI_SYMBOLS.BORDER.T_DOWN + UI_SYMBOLS.BORDER.HORIZONTAL) + UI_SYMBOLS.BORDER.HORIZONTAL + UI_SYMBOLS.BORDER.TOP_RIGHT;
  };

  const createMiddleSeparator = (): string => {
    return UI_SYMBOLS.BORDER.T_RIGHT + UI_SYMBOLS.BORDER.HORIZONTAL + columnWidths.map((w) => UI_SYMBOLS.BORDER.HORIZONTAL.repeat(w)).join(UI_SYMBOLS.BORDER.HORIZONTAL + UI_SYMBOLS.BORDER.CROSS + UI_SYMBOLS.BORDER.HORIZONTAL) + UI_SYMBOLS.BORDER.HORIZONTAL + UI_SYMBOLS.BORDER.T_LEFT;
  };

  const createBottomBorder = (): string => {
    return UI_SYMBOLS.BORDER.BOTTOM_LEFT + UI_SYMBOLS.BORDER.HORIZONTAL + columnWidths.map((w) => UI_SYMBOLS.BORDER.HORIZONTAL.repeat(w)).join(UI_SYMBOLS.BORDER.HORIZONTAL + UI_SYMBOLS.BORDER.T_UP + UI_SYMBOLS.BORDER.HORIZONTAL) + UI_SYMBOLS.BORDER.HORIZONTAL + UI_SYMBOLS.BORDER.BOTTOM_RIGHT;
  };

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Top border */}
      <Text dimColor>{createTopBorder()}</Text>

      {/* Header row */}
      {(() => {
        const headerLines = header.map((h, idx) => wrapText(h, columnWidths[idx] || 0));
        const maxHeaderLines = Math.max(...headerLines.map(lines => lines.length));

        return (
          <>
            {Array.from({ length: maxHeaderLines }).map((_, lineIdx) => (
              <Box key={lineIdx}>
                <Text dimColor>│ </Text>
                {headerLines.map((lines, colIdx) => (
                  <React.Fragment key={colIdx}>
                    <Text bold>{padCell(lines[lineIdx] || '', columnWidths[colIdx] || 0)}</Text>
                    <Text dimColor> │ </Text>
                  </React.Fragment>
                ))}
              </Box>
            ))}
          </>
        );
      })()}

      {/* Header separator */}
      <Text dimColor>{createMiddleSeparator()}</Text>

      {/* Data rows */}
      {rows.map((row, rowIdx) => {
        // Wrap each cell in the row
        const wrappedCells = row.map((cell, colIdx) =>
          wrapText(cell, columnWidths[colIdx] || 0)
        );
        const maxLines = Math.max(...wrappedCells.map(lines => lines.length));

        return (
          <React.Fragment key={rowIdx}>
            {Array.from({ length: maxLines }).map((_, lineIdx) => (
              <Box key={lineIdx}>
                <Text dimColor>│ </Text>
                {wrappedCells.map((lines, colIdx) => (
                  <React.Fragment key={colIdx}>
                    <Text>{padCell(lines[lineIdx] || '', columnWidths[colIdx] || 0)}</Text>
                    <Text dimColor> │ </Text>
                  </React.Fragment>
                ))}
              </Box>
            ))}
          </React.Fragment>
        );
      })}

      {/* Bottom border */}
      <Text dimColor>{createBottomBorder()}</Text>
    </Box>
  );
};

/**
 * Format inline markdown (bold, italic, inline code, links)
 */
function formatInlineMarkdown(text: string): string {
  let formatted = text;

  // Handle inline code first (to avoid conflicts)
  formatted = formatted.replace(/`([^`]+)`/g, '[$1]');

  // Handle bold
  formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '$1');
  formatted = formatted.replace(/__([^_]+)__/g, '$1');

  // Handle italic
  formatted = formatted.replace(/\*([^*]+)\*/g, '$1');
  formatted = formatted.replace(/_([^_]+)_/g, '$1');

  // Handle markdown links - just show the text (hyperlinks can corrupt Ink rendering)
  formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, _url) => {
    return text;
  });

  // Don't make file paths clickable - hyperlinks can corrupt Ink rendering
  // formatted = makeFilePathsClickable(formatted);

  return formatted;
}

/**
 * Strip inline markdown for plain text display
 */
function stripInlineMarkdown(text: string): string {
  let stripped = text;

  // Convert <br> and <br/> tags to newlines
  stripped = stripped.replace(/<br\s*\/?>/gi, '\n');

  // Remove inline code
  stripped = stripped.replace(/`([^`]+)`/g, '$1');

  // Remove bold
  stripped = stripped.replace(/\*\*([^*]+)\*\*/g, '$1');
  stripped = stripped.replace(/__([^_]+)__/g, '$1');

  // Remove italic
  stripped = stripped.replace(/\*([^*]+)\*/g, '$1');
  stripped = stripped.replace(/_([^_]+)_/g, '$1');

  // Remove links
  stripped = stripped.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  return stripped;
}

// Terminal hyperlinks (OSC 8) disabled - they corrupt Ink rendering
// The functions below are kept for reference but not used
//
// function createTerminalLink(text: string, url: string): string {
//   return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
// }
//
// function isFilePath(text: string): boolean {
//   if (text.startsWith('/') || text.startsWith('~')) return true;
//   if (text.startsWith('./') || text.startsWith('../')) return true;
//   const fileExtensions = /\.(ts|tsx|js|jsx|json|md|txt|py|java|cpp|c|h|css|html|xml|yaml|yml|toml|sh|bash|rs|go|rb|php|swift|kt|gradle|sql)$/i;
//   return fileExtensions.test(text);
// }
//
// function makeFilePathsClickable(text: string): string {
//   const pathPattern = /(?:^|\s)((?:\.\.?\/|\/|~\/)?[\w\-./]+\.[\w]+)(?=\s|$|[,.:;)])/g;
//   return text.replace(pathPattern, (match, filepath) => {
//     const trimmedPath = filepath.trim();
//     if (!isFilePath(trimmedPath)) return match;
//     let absolutePath: string;
//     if (trimmedPath.startsWith('/')) {
//       absolutePath = trimmedPath;
//     } else if (trimmedPath.startsWith('~')) {
//       const homedir = process.env.HOME || process.env.USERPROFILE || '';
//       absolutePath = trimmedPath.replace(/^~/, homedir);
//     } else {
//       absolutePath = path.resolve(process.cwd(), trimmedPath);
//     }
//     const fileUrl = `file://${absolutePath}`;
//     const prefix = match.startsWith(' ') ? ' ' : '';
//     return prefix + createTerminalLink(trimmedPath, fileUrl);
//   });
// }
