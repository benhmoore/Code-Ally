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
import { LRUCache } from '@utils/LRUCache.js';
import { contentHash } from '@utils/contentHash.js';

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

/**
 * Global markdown parse cache
 *
 * Caches parsed markdown results to avoid redundant parsing on re-renders.
 * With 100+ messages in a conversation, this significantly reduces overhead
 * by eliminating repeated calls to marked.lexer() and token processing.
 *
 * Cache configuration:
 * - Capacity: 200 items (enough for large conversations)
 * - Memory: ~1-2MB for typical usage
 * - Expected hit rate: >90% in normal conversations
 * - Performance: Cache hit <1ms vs ~10ms for full parse
 */
const markdownParseCache = new LRUCache<string, ParsedNode[]>(200);

/**
 * Clear the markdown parse cache
 *
 * Useful for testing, debugging, or forcing fresh parses.
 * In production, the LRU eviction should handle cache management automatically.
 *
 * @example
 * ```typescript
 * clearMarkdownCache(); // Force all markdown to be re-parsed
 * ```
 */
export function clearMarkdownCache(): void {
  markdownParseCache.clear();
}

/**
 * Get markdown cache statistics
 *
 * Returns current cache size and capacity for monitoring/debugging.
 *
 * @returns Cache statistics object
 *
 * @example
 * ```typescript
 * const stats = getMarkdownCacheStats();
 * console.log(`Cache: ${stats.size}/${stats.capacity} items`);
 * ```
 */
export function getMarkdownCacheStats(): { size: number; capacity: number } {
  return {
    size: markdownParseCache.size,
    capacity: markdownParseCache.capacity,
  };
}

export interface MarkdownTextProps {
  /** Markdown content to render */
  content: string;
  /** Optional syntax highlighting theme */
  theme?: string;
}

interface ParsedNode {
  type: 'text' | 'code' | 'heading' | 'list' | 'list-item' | 'paragraph' | 'strong' | 'em' | 'codespan' | 'link' | 'table' | 'hr' | 'space' | 'blockquote';
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
  // Get content width for proper text wrapping in Static components
  const contentWidth = useContentWidth();

  const parsed = useMemo(() => {
    // Generate cache key from content hash
    const cacheKey = contentHash(content);

    // Check cache first
    const cached = markdownParseCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    // Cache miss - parse markdown
    try {
      // Parse markdown to tokens
      const tokens = marked.lexer(content);
      const result = parseTokens(tokens);

      // Store in cache for future renders
      markdownParseCache.set(cacheKey, result);

      return result;
    } catch (error) {
      // Fallback to plain text if parsing fails
      // Don't cache errors - they might be transient
      return [{ type: 'text' as const, content }];
    }
  }, [content]);

  return (
    <Box flexDirection="column" width={contentWidth}>
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
    } else if (token.type === 'blockquote') {
      // Parse nested tokens within the blockquote
      const nestedNodes = token.tokens ? parseTokens(token.tokens) : [];
      nodes.push({
        type: 'blockquote',
        children: nestedNodes,
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
      // Fallback for unknown token types - handle gracefully
      // Try to extract content intelligently rather than dumping raw markdown
      if ((token as any).tokens && Array.isArray((token as any).tokens)) {
        // Has nested tokens - parse them recursively
        const nestedNodes = parseTokens((token as any).tokens);
        nodes.push(...nestedNodes);
      } else if ((token as any).text) {
        // Has text content - render as paragraph
        nodes.push({
          type: 'paragraph',
          content: (token as any).text,
        });
      } else if ((token as any).raw) {
        // Last resort - use raw content but warn about unsupported token
        logger.warn(`Unsupported markdown token type: ${(token as any).type}`);
        nodes.push({
          type: 'text',
          content: (token as any).raw,
        });
      }
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
    return <CodeBlockRenderer content={node.content || ''} language={node.language} highlighter={highlighter} />;
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
        {node.children?.map((item, idx) => {
          const formatted = formatInlineMarkdown(item.content || '');
          const bullet = node.ordered ? `${idx + 1}. ` : '• ';

          // Handle styled text segments
          if (Array.isArray(formatted)) {
            const styledText = segmentsToAnsiString(formatted);
            return (
              <Box key={idx} paddingLeft={2}>
                <Text>{bullet}{styledText}</Text>
              </Box>
            );
          }

          // Handle plain string
          return (
            <Box key={idx} paddingLeft={2}>
              <Text>{bullet}{formatted}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  if (node.type === 'blockquote') {
    // Convert blockquote content to plain text and prefix each line
    // This ensures consistent formatting across all nested content
    const textContent = nodeToPlainText(node.children || []);

    return <BlockquoteRenderer content={textContent} />;
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
 * Blockquote Renderer Component
 *
 * Renders blockquote content with consistent left border prefix (│) on every line,
 * including lines that wrap due to terminal width constraints.
 */
const BlockquoteRenderer: React.FC<{ content: string }> = ({ content }) => {
  const terminalWidth = useContentWidth();

  // Account for the prefix width: "│ " = 2 characters
  const PREFIX_WIDTH = 2;
  const availableWidth = terminalWidth - PREFIX_WIDTH;

  // Wrap text to terminal width
  const wrappedLines = useMemo(() => {
    const lines: string[] = [];
    const contentLines = content.split('\n');

    for (const line of contentLines) {
      if (line.length === 0) {
        // Preserve empty lines
        lines.push('');
        continue;
      }

      if (line.length <= availableWidth) {
        // Line fits - add as-is
        lines.push(line);
        continue;
      }

      // Line is too long - wrap it
      let remaining = line;
      while (remaining.length > 0) {
        if (remaining.length <= availableWidth) {
          lines.push(remaining);
          break;
        }

        // Find a good break point (prefer breaking at spaces)
        let breakPoint = availableWidth;
        const lastSpace = remaining.lastIndexOf(' ', availableWidth);

        // Break at space if it's not too far back (within 70% of available width)
        if (lastSpace > availableWidth * TEXT_LIMITS.WORD_BOUNDARY_THRESHOLD) {
          breakPoint = lastSpace;
        }

        lines.push(remaining.substring(0, breakPoint));
        remaining = remaining.substring(breakPoint).trimStart();
      }
    }

    return lines;
  }, [content, availableWidth]);

  return (
    <Box flexDirection="column">
      {wrappedLines.map((line, idx) => (
        <Box key={idx}>
          <Text dimColor>│ </Text>
          <Text>{line}</Text>
        </Box>
      ))}
    </Box>
  );
};

/**
 * Code Block Renderer Component
 *
 * Renders code blocks with fixed-width borders that don't shift based on content.
 * Uses terminal width to ensure consistent border alignment regardless of content indentation.
 */
const CodeBlockRenderer: React.FC<{ content: string; language?: string; highlighter: SyntaxHighlighter }> = ({
  content,
  language,
  highlighter,
}) => {
  const terminalWidth = useContentWidth();

  // Account for: left padding (2) + border chars (2) + internal padding (2) + safety margin (4)
  const CODE_BLOCK_OVERHEAD = 10;
  const availableWidth = Math.max(40, terminalWidth - CODE_BLOCK_OVERHEAD);

  // Highlight the code
  const highlighted = highlighter.highlight(content, { language });
  const lines = highlighted.split('\n');

  // Helper to expand tabs to spaces (assuming 4-space tab stops)
  const expandTabs = (text: string, tabWidth: number = 4): string => {
    let result = '';
    let column = 0;

    for (let i = 0; i < text.length; i++) {
      const char = text[i];

      // Check if we're in an ANSI escape sequence
      if (char === '\x1b' && text[i + 1] === '[') {
        // Find the end of the ANSI sequence
        const endIdx = text.indexOf('m', i);
        if (endIdx !== -1) {
          // Copy the entire ANSI sequence without affecting column count
          result += text.substring(i, endIdx + 1);
          i = endIdx;
          continue;
        }
      }

      if (char === '\t') {
        // Expand tab to reach next tab stop
        const spacesToAdd = tabWidth - (column % tabWidth);
        result += ' '.repeat(spacesToAdd);
        column += spacesToAdd;
      } else {
        result += char;
        column++;
      }
    }

    return result;
  };

  // Helper to get visual length (strip ANSI codes and count expanded tabs)
  const getVisualLength = (text: string): number => {
    // First expand tabs, then strip ANSI codes
    const expanded = expandTabs(text);
    return expanded.replace(/\x1b\[[0-9;]*m/g, '').length;
  };

  // Helper to pad a line to the target width (ANSI-aware, tab-aware)
  const padLine = (line: string, width: number): string => {
    const visualLen = getVisualLength(line);
    const paddingNeeded = Math.max(0, width - visualLen);
    // Expand tabs in the display line as well
    const expanded = expandTabs(line);
    return expanded + ' '.repeat(paddingNeeded);
  };

  // Create border lines
  const topBorder = UI_SYMBOLS.BORDER.TOP_LEFT + UI_SYMBOLS.BORDER.HORIZONTAL.repeat(availableWidth + 2) + UI_SYMBOLS.BORDER.TOP_RIGHT;
  const bottomBorder = UI_SYMBOLS.BORDER.BOTTOM_LEFT + UI_SYMBOLS.BORDER.HORIZONTAL.repeat(availableWidth + 2) + UI_SYMBOLS.BORDER.BOTTOM_RIGHT;

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text dimColor color={UI_COLORS.TEXT_DIM}>
        {language ? `[${language}]` : '[code]'}
      </Text>
      <Box flexDirection="column">
        {/* Top border */}
        <Text dimColor>{topBorder}</Text>

        {/* Content lines */}
        {lines.map((line, idx) => {
          // Truncate if line is too long, otherwise pad to width
          const visualLen = getVisualLength(line);
          const displayLine = visualLen > availableWidth
            ? line.substring(0, availableWidth - 3) + '...'
            : padLine(line, availableWidth);

          return (
            <Box key={idx}>
              <Text dimColor>│ </Text>
              <Text>{displayLine}</Text>
              <Text dimColor> │</Text>
            </Box>
          );
        })}

        {/* Bottom border */}
        <Text dimColor>{bottomBorder}</Text>
      </Box>
    </Box>
  );
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
 * Convert parsed nodes to plain text representation
 * Used for blockquotes to ensure consistent line prefixing
 */
function nodeToPlainText(nodes: ParsedNode[]): string {
  const parts: string[] = [];

  for (const node of nodes) {
    if (node.type === 'code') {
      // Code blocks - preserve as-is with language indicator
      const langLabel = node.language ? `[${node.language}]` : '[code]';
      parts.push(`${langLabel}\n${node.content || ''}`);
    } else if (node.type === 'heading') {
      // Headings - render as bold text
      parts.push(node.content || '');
    } else if (node.type === 'list') {
      // Lists - render with appropriate bullets
      const items = node.children?.map((item, idx) => {
        const bullet = node.ordered ? `${idx + 1}. ` : '  • ';
        return bullet + stripInlineMarkdown(item.content || '');
      }) || [];
      parts.push(items.join('\n'));
    } else if (node.type === 'paragraph') {
      // Paragraphs - preserve inline formatting
      parts.push(stripInlineMarkdown(node.content || ''));
    } else if (node.type === 'table') {
      // Tables - simplified text representation
      parts.push('[Table content omitted in blockquote]');
    } else if (node.type === 'hr') {
      // Horizontal rules
      parts.push('─'.repeat(40));
    } else if (node.type === 'blockquote') {
      // Nested blockquotes - recursively flatten
      if (node.children) {
        parts.push(nodeToPlainText(node.children));
      }
    } else if (node.type === 'text') {
      // Plain text
      parts.push(stripInlineMarkdown(node.content || ''));
    } else if (node.type === 'space') {
      // Space nodes represent blank lines - add empty string to preserve spacing
      parts.push('');
    }
  }

  return parts.join('\n');
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
