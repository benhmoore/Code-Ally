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
import { logger } from '@services/Logger.js';

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
  type: 'text' | 'code' | 'heading' | 'list' | 'list-item' | 'paragraph' | 'strong' | 'em' | 'codespan' | 'link' | 'table' | 'hr' | 'space';
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
 * Process nested paragraph tokens to handle line breaks properly
 * Converts br tokens to newline characters
 */
function processParagraphTokens(tokens: any[]): string {
  let result = '';

  for (const token of tokens) {
    if (token.type === 'text') {
      result += token.text;
    } else if (token.type === 'strong') {
      // Handle bold text - wrap in markdown
      result += '**' + token.text + '**';
    } else if (token.type === 'em') {
      // Handle italic text - wrap in markdown
      result += '*' + token.text + '*';
    } else if (token.type === 'codespan') {
      // Handle inline code - wrap in backticks
      result += '`' + token.text + '`';
    } else if (token.type === 'br') {
      // Convert br to actual newline
      result += '\n';
    } else if (token.type === 'link') {
      // Handle links - use markdown format
      result += '[' + token.text + '](' + token.href + ')';
    } else if (token.raw) {
      // Fallback - use raw content
      result += token.raw;
    }
  }

  return result;
}

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
      // Process nested tokens to properly handle line breaks
      if (token.tokens && Array.isArray(token.tokens)) {
        const processedContent = processParagraphTokens(token.tokens);
        nodes.push({
          type: 'paragraph',
          content: processedContent,
        });
      } else {
        nodes.push({
          type: 'paragraph',
          content: token.text,
        });
      }
    } else if (token.type === 'hr') {
      nodes.push({
        type: 'hr',
      });
    } else if (token.type === 'space') {
      // Preserve space tokens as empty text nodes to maintain blank line spacing
      nodes.push({
        type: 'space',
      });
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
      <Box flexDirection="column" paddingLeft={2}>
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
      <Box>
        <Text bold color={UI_COLORS.TEXT_DEFAULT}>
          {node.content}
        </Text>
      </Box>
    );
  }

  if (node.type === 'list') {
    return (
      <Box flexDirection="column">
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
    const content = node.content || '';

    // Split content by newlines to handle hard line breaks
    const lines = content.split('\n');

    // If only one line, render as before
    if (lines.length === 1) {
      const formatted = formatInlineMarkdown(content);

      // Handle styled text segments - convert to ANSI string for proper wrapping
      if (Array.isArray(formatted)) {
        const styledText = segmentsToAnsiString(formatted);
        return (
          <Box>
            <Text>{styledText}</Text>
          </Box>
        );
      }

      // Handle plain string
      return (
        <Box>
          <Text>{formatted}</Text>
        </Box>
      );
    }

    // Multiple lines - render each line separately
    return (
      <Box flexDirection="column">
        {lines.map((line, lineIdx) => {
          const formatted = formatInlineMarkdown(line);

          // Handle styled text segments - convert to ANSI string for proper wrapping
          if (Array.isArray(formatted)) {
            const styledText = segmentsToAnsiString(formatted);
            return (
              <Box key={lineIdx}>
                <Text>{styledText}</Text>
              </Box>
            );
          }

          // Handle plain string
          return (
            <Box key={lineIdx}>
              <Text>{formatted}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  if (node.type === 'hr') {
    return (
      <Box>
        <Text dimColor>{'─'.repeat(40)}</Text>
      </Box>
    );
  }

  if (node.type === 'space') {
    // Render blank line to preserve spacing between paragraphs
    return <Box marginTop={1} />;
  }

  if (node.type === 'text') {
    const formatted = formatInlineMarkdown(node.content || '');

    // Handle styled text segments
    if (Array.isArray(formatted)) {
      return (
        <Box>
          {formatted.map((segment, idx) => (
            <Text
              key={idx}
              color={segment.color}
              bold={segment.bold}
              italic={segment.italic}
              strikethrough={segment.strikethrough}
            >
              {segment.text}
            </Text>
          ))}
        </Box>
      );
    }

    // Handle plain string
    return (
      <Box>
        <Text>{formatted}</Text>
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

  // Validate table structure
  if (!header || header.length === 0) {
    return <Text dimColor>Empty table</Text>;
  }

  // Filter rows with mismatched column counts
  const expectedCols = header.length;
  const validRows = useMemo(() => {
    return rows.filter((row) => {
      if (row.length !== expectedCols) {
        logger.warn(`Table row has ${row.length} columns, expected ${expectedCols}`);
        return false;
      }
      return true;
    });
  }, [rows, expectedCols]);

  // Calculate optimal column widths with terminal width constraints
  const columnWidths = useMemo(() => {

    // Helper to get max line length for cells with line breaks (visual length, no ANSI codes)
    const getMaxLineLength = (text: string): number => {
      // Strip ANSI codes for accurate length calculation
      const stripped = text.replace(/\x1b\[[0-9;]*m/g, '');
      const lines = stripped.split('\n');
      return Math.max(...lines.map(line => line.length));
    };

    // Calculate natural widths (what content actually needs)
    const naturalWidths = header.map((h) => getMaxLineLength(h));
    validRows.forEach((row) => {
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
  }, [header, validRows, terminalWidth]);

  // Process cell text with inline markdown and convert to ANSI
  const processCellMarkdown = (text: string): string => {
    // Parse inline markdown into styled segments
    const segments = parseStyledText(text);
    // Convert to ANSI string
    return segmentsToAnsiString(segments);
  };

  // Get visual length of text (excluding ANSI escape codes)
  const getVisualLength = (text: string): number => {
    // Remove ANSI escape codes to get actual displayed length
    // ANSI codes follow pattern: \x1b[...m
    return text.replace(/\x1b\[[0-9;]*m/g, '').length;
  };

  // Wrap text to fit within specified width (ANSI-aware)
  const wrapText = (text: string, width: number): string[] => {
    // First, split on explicit line breaks (\n)
    const explicitLines = text.split('\n');
    const wrappedLines: string[] = [];

    // Then wrap each line individually if needed
    for (const line of explicitLines) {
      const visualLen = getVisualLength(line);
      if (visualLen <= width) {
        wrappedLines.push(line);
        continue;
      }

      let remaining = line;
      while (remaining.length > 0) {
        const remainingVisualLen = getVisualLength(remaining);
        if (remainingVisualLen <= width) {
          wrappedLines.push(remaining);
          break;
        }

        // Find break point based on visual length
        // We need to iterate through the string accounting for ANSI codes
        let visualPos = 0;
        let actualPos = 0;
        let lastSpaceVisual = -1;
        let lastSpaceActual = -1;

        while (actualPos < remaining.length && visualPos <= width) {
          // Check for ANSI escape sequence
          if (remaining.substring(actualPos).startsWith('\x1b[')) {
            // Skip entire ANSI sequence
            const endPos = remaining.indexOf('m', actualPos);
            if (endPos !== -1) {
              actualPos = endPos + 1;
              continue;
            }
          }

          if (remaining[actualPos] === ' ') {
            lastSpaceVisual = visualPos;
            lastSpaceActual = actualPos;
          }

          visualPos++;
          actualPos++;
        }

        let breakPoint = actualPos;
        if (lastSpaceVisual > width * TEXT_LIMITS.WORD_BOUNDARY_THRESHOLD) {
          breakPoint = lastSpaceActual;
        }

        wrappedLines.push(remaining.substring(0, breakPoint));
        remaining = remaining.substring(breakPoint).trimStart();
      }
    }

    return wrappedLines;
  };

  // Pad a cell to the specified width (ANSI-aware)
  const padCell = (text: string, width: number): string => {
    const visualLen = getVisualLength(text);
    const paddingNeeded = Math.max(0, width - visualLen);
    return text + ' '.repeat(paddingNeeded);
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
    <Box flexDirection="column">
      {/* Top border */}
      <Text dimColor>{createTopBorder()}</Text>

      {/* Header row */}
      {(() => {
        const headerLines = header.map((h, idx) => {
          const formatted = processCellMarkdown(h);
          return wrapText(formatted, columnWidths[idx] || 0);
        });
        const maxHeaderLines = Math.max(...headerLines.map(lines => lines.length));

        return (
          <>
            {Array.from({ length: maxHeaderLines }).map((_, lineIdx) => (
              <Box key={lineIdx}>
                <Text dimColor>│ </Text>
                {headerLines.map((lines, colIdx) => (
                  <React.Fragment key={colIdx}>
                    <Text>{padCell(lines[lineIdx] || '', columnWidths[colIdx] || 0)}</Text>
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
      {validRows.map((row, rowIdx) => {
        // Process and wrap each cell in the row
        const wrappedCells = row.map((cell, colIdx) => {
          const formatted = processCellMarkdown(cell);
          return wrapText(formatted, columnWidths[colIdx] || 0);
        });
        const maxLines = Math.max(...wrappedCells.map(lines => lines.length));
        const isLastRow = rowIdx === validRows.length - 1;

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
            {/* Row separator (except after last row) */}
            {!isLastRow && <Text dimColor>{createMiddleSeparator()}</Text>}
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
/**
 * Styled segment - represents text with formatting (color, italic, strikethrough, bold, code)
 */
interface StyledSegment {
  text: string;
  color?: string;
  italic?: boolean;
  strikethrough?: boolean;
  bold?: boolean;
  code?: boolean;
}

/**
 * Parse and format inline markdown, returning segments with styling information
 */
function formatInlineMarkdown(text: string): string | StyledSegment[] {
  // Check if there are any formatting markers that require segment-based rendering
  const hasFormatting = /<(red|green|yellow|cyan|blue|magenta|white|gray|orange)>|<span\s+color=|`|~~|\*\*|\*|__|_/i.test(text);

  if (hasFormatting) {
    return parseStyledText(text);
  }

  // No formatting - return plain string with simple transformations
  let formatted = text;

  // Handle LaTeX math expressions
  formatted = processLatex(formatted);

  // Handle markdown links - just show the text
  formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, _url) => {
    return text;
  });

  return formatted;
}

/**
 * Convert styled segments to a single string with ANSI escape codes
 * This avoids Ink's Text component wrapping issues by pre-rendering styles
 */
function segmentsToAnsiString(segments: StyledSegment[]): string {
  let result = '';

  for (const segment of segments) {
    let text = segment.text;

    // Apply color
    if (segment.color) {
      const colorCode = getAnsiColorCode(segment.color);
      if (colorCode) {
        text = `\x1b[${colorCode}m${text}\x1b[39m`;
      }
    }

    // Apply bold
    if (segment.bold) {
      text = `\x1b[1m${text}\x1b[22m`;
    }

    // Apply italic
    if (segment.italic) {
      text = `\x1b[3m${text}\x1b[23m`;
    }

    // Apply strikethrough
    if (segment.strikethrough) {
      text = `\x1b[9m${text}\x1b[29m`;
    }

    result += text;
  }

  return result;
}

/**
 * Get ANSI color code for a color name
 */
function getAnsiColorCode(color: string): string | null {
  const colorMap: Record<string, string> = {
    'red': '31',
    'green': '32',
    'yellow': '33',
    'blue': '34',
    'magenta': '35',
    'cyan': '36',
    'white': '37',
    'gray': '90',
    'grey': '90',
    '#00A0E4': '36', // UI_COLORS.PRIMARY maps to cyan
  };
  return colorMap[color] || null;
}

/**
 * Merge consecutive segments with identical styling
 * This reduces the number of Text components and improves wrapping behavior
 */
function mergeSegments(segments: StyledSegment[]): StyledSegment[] {
  if (segments.length <= 1) return segments;
  if (!segments[0]?.text) return segments;

  const merged: StyledSegment[] = [];
  let currentText = segments[0].text;
  let currentStyle: Omit<StyledSegment, 'text'> = {
    color: segments[0].color,
    bold: segments[0].bold,
    italic: segments[0].italic,
    strikethrough: segments[0].strikethrough,
    code: segments[0].code,
  };

  for (let i = 1; i < segments.length; i++) {
    const next = segments[i];
    if (!next?.text) continue;

    // Check if styling is identical
    const sameStyle =
      currentStyle.color === next.color &&
      currentStyle.bold === next.bold &&
      currentStyle.italic === next.italic &&
      currentStyle.strikethrough === next.strikethrough &&
      currentStyle.code === next.code;

    if (sameStyle) {
      // Merge text into current segment
      currentText += next.text;
    } else {
      // Style changed - push current and start new segment
      merged.push({ text: currentText, ...currentStyle });
      currentText = next.text;
      currentStyle = {
        color: next.color,
        bold: next.bold,
        italic: next.italic,
        strikethrough: next.strikethrough,
        code: next.code,
      };
    }
  }

  // Push the last segment
  merged.push({ text: currentText, ...currentStyle });
  return merged;
}

/**
 * Parse text with markdown formatting into styled segments
 * Supports: colors, bold, italic, strikethrough, code, LaTeX
 */
function parseStyledText(text: string): StyledSegment[] {
  const segments: StyledSegment[] = [];

  // Tokenize the text into formatting regions
  // Priority: code > color > strikethrough > bold > italic
  const tokens = tokenizeFormatting(text);

  for (const token of tokens) {
    if (token.text) {
      // Process LaTeX in the text segment (but not in code segments)
      if (!token.code) {
        const processedText = processLatex(token.text);
        segments.push({ ...token, text: processedText });
      } else {
        segments.push(token);
      }
    }
  }

  // Merge consecutive segments with same styling
  const result = segments.length > 0 ? mergeSegments(segments) : [{ text }];
  return result;
}

/**
 * Extract color name and content from color tag match
 * Handles both <color>text</color> and <span color="color">text</span> formats
 */
function extractColorFromMatch(match: RegExpMatchArray): { color: string; content: string } | null {
  // Handle <color>text</color> format (match[2] = color, match[3] = content)
  if (match[2] && match[3]) {
    const color = match[2].toLowerCase() === 'orange' ? UI_COLORS.WARNING : match[2].toLowerCase();
    return { color, content: match[3] };
  }
  // Handle <span color="color">text</span> format (match[4] = color, match[5] = content)
  if (match[4] && match[5]) {
    const color = match[4].toLowerCase() === 'orange' ? UI_COLORS.WARNING : match[4].toLowerCase();
    return { color, content: match[5] };
  }
  return null;
}

/**
 * Tokenize text into formatted segments
 * @param text - Text to tokenize
 * @param depth - Current recursion depth (prevents stack overflow)
 */
function tokenizeFormatting(text: string, depth: number = 0): StyledSegment[] {
  const MAX_DEPTH = 10;

  // Prevent stack overflow from deeply nested formatting
  if (depth > MAX_DEPTH) {
    return [{ text }];
  }

  const segments: StyledSegment[] = [];
  let pos = 0;

  // Combined regex for all formatting types (order matters!)
  // 1. Inline code (highest priority)
  // 2. Color tags
  // 3. Strikethrough
  // 4. Bold
  // 5. Italic
  const formattingRegex = /`([^`]+)`|<(red|green|yellow|cyan|blue|magenta|white|gray|orange)>(.*?)<\/\2>|<span\s+color=["']?(red|green|yellow|cyan|blue|magenta|white|gray|orange)["']?>(.*?)<\/span>|~~(.*?)~~|\*\*([^*]+)\*\*|__([^_]+)__|(?<!\*)\*([^*]+)\*(?!\*)|(?<!_)_([^_]+)_(?!_)/g;

  let match;
  while ((match = formattingRegex.exec(text)) !== null) {
    // Add plain text before this match
    if (match.index > pos) {
      segments.push({ text: text.substring(pos, match.index) });
    }

    // Determine what was matched and create appropriate segment
    if (match[1]) {
      // Inline code: `text` - render with primary color for distinction
      // Process escape sequences in code blocks
      // Use placeholder to handle \\ correctly
      const BACKSLASH_PLACEHOLDER = '\x00BACKSLASH\x00';
      const codeText = match[1]
        .replace(/\\\\/g, BACKSLASH_PLACEHOLDER)  // Temporarily replace \\
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '\t')
        .replace(/\\r/g, '\r')
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(new RegExp(BACKSLASH_PLACEHOLDER, 'g'), '\\');  // Restore \
      segments.push({ text: codeText, code: true, color: UI_COLORS.PRIMARY });
    } else {
      // Try to extract color tag (handles both <color> and <span color="color"> formats)
      const colorMatch = extractColorFromMatch(match);
      if (colorMatch) {
        // Recursively parse nested formatting
        const nested = tokenizeFormatting(colorMatch.content, depth + 1);
        for (const seg of nested) {
          segments.push({ ...seg, color: colorMatch.color });
        }
      } else if (match[6]) {
        // Strikethrough: ~~text~~
        const nested = tokenizeFormatting(match[6], depth + 1);
        for (const seg of nested) {
          segments.push({ ...seg, strikethrough: true });
        }
      } else if (match[7]) {
        // Bold: **text**
        const nested = tokenizeFormatting(match[7], depth + 1);
        for (const seg of nested) {
          segments.push({ ...seg, bold: true });
        }
      } else if (match[8]) {
        // Bold: __text__
        const nested = tokenizeFormatting(match[8], depth + 1);
        for (const seg of nested) {
          segments.push({ ...seg, bold: true });
        }
      } else if (match[9]) {
        // Italic: *text*
        const nested = tokenizeFormatting(match[9], depth + 1);
        for (const seg of nested) {
          segments.push({ ...seg, italic: true });
        }
      } else if (match[10]) {
        // Italic: _text_
        const nested = tokenizeFormatting(match[10], depth + 1);
        for (const seg of nested) {
          segments.push({ ...seg, italic: true });
        }
      }
    }

    pos = match.index + match[0].length;
  }

  // Add any remaining plain text
  if (pos < text.length) {
    segments.push({ text: text.substring(pos) });
  }

  return segments;
}

/**
 * Process LaTeX expressions in text, converting them to Unicode
 * Handles all three LaTeX delimiter styles: \(...\), \[...\], and $$...$$
 */
function processLatex(text: string): string {
  return text
    .replace(/\\\((.+?)\\\)/g, (_match, mathContent) => convertLatexToUnicode(mathContent))
    .replace(/\\\[(.+?)\\\]/g, (_match, mathContent) => convertLatexToUnicode(mathContent))
    .replace(/\$\$(.+?)\$\$/g, (_match, mathContent) => convertLatexToUnicode(mathContent));
}

/**
 * Convert LaTeX math commands to Unicode symbols for terminal display
 */
function convertLatexToUnicode(latex: string): string {
  let converted = latex;

  // Common math operators
  const replacements: Record<string, string> = {
    '\\times': '×',
    '\\div': '÷',
    '\\cdot': '·',
    '\\pm': '±',
    '\\mp': '∓',
    '\\leq': '≤',
    '\\geq': '≥',
    '\\neq': '≠',
    '\\approx': '≈',
    '\\equiv': '≡',
    '\\propto': '∝',
    '\\infty': '∞',
    '\\partial': '∂',
    '\\nabla': '∇',
    '\\sum': '∑',
    '\\prod': '∏',
    '\\int': '∫',
    '\\sqrt': '√',
    '\\alpha': 'α',
    '\\beta': 'β',
    '\\gamma': 'γ',
    '\\delta': 'δ',
    '\\epsilon': 'ε',
    '\\theta': 'θ',
    '\\lambda': 'λ',
    '\\mu': 'μ',
    '\\pi': 'π',
    '\\sigma': 'σ',
    '\\tau': 'τ',
    '\\phi': 'φ',
    '\\omega': 'ω',
    '\\Delta': 'Δ',
    '\\Sigma': 'Σ',
    '\\Omega': 'Ω',
    '\\leftarrow': '←',
    '\\rightarrow': '→',
    '\\leftrightarrow': '↔',
    '\\Leftarrow': '⇐',
    '\\Rightarrow': '⇒',
    '\\Leftrightarrow': '⇔',
    '\\in': '∈',
    '\\notin': '∉',
    '\\subset': '⊂',
    '\\supset': '⊃',
    '\\subseteq': '⊆',
    '\\supseteq': '⊇',
    '\\cup': '∪',
    '\\cap': '∩',
    '\\emptyset': '∅',
    '\\forall': '∀',
    '\\exists': '∃',
    '\\neg': '¬',
    '\\land': '∧',
    '\\lor': '∨',
  };

  // Replace LaTeX commands with Unicode
  for (const [latex, unicode] of Object.entries(replacements)) {
    converted = converted.replace(new RegExp(latex.replace(/\\/g, '\\\\'), 'g'), unicode);
  }

  // Handle \frac{a}{b} → a/b
  converted = converted.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, '($1)/($2)');

  // Handle ^{superscript} and _{subscript} - just use parentheses for clarity
  converted = converted.replace(/\^{([^}]+)}/g, '^($1)');
  converted = converted.replace(/_{([^}]+)}/g, '_($1)');
  converted = converted.replace(/\^(\w)/g, '^$1');
  converted = converted.replace(/_(\w)/g, '_$1');

  // Strip remaining backslashes for unknown commands
  converted = converted.replace(/\\([a-zA-Z]+)/g, '$1');

  // Clean up extra spaces
  converted = converted.trim();

  return converted;
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

  // Handle LaTeX math expressions
  stripped = processLatex(stripped);

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
