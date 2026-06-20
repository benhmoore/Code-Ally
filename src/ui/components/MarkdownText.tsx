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
import { FORMATTING } from '@config/constants.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { expandTabsAnsiAware, padAnsiToWidth, truncateAnsiToWidth, visibleLength, wrapAnsiText } from '@utils/terminalText.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { UI_COLORS } from '../constants/colors.js';
import { logger } from '@services/Logger.js';
import { LRUCache } from '@utils/LRUCache.js';
import { contentHash } from '@utils/contentHash.js';

// Non-cell horizontal chrome for a rendered table row, derived so that a data
// row is exactly as wide as the border lines:
//   row = "│ " + Σ(cell) + per-column " │ " (last column closes with " │")
//       = Σ(cell) + 3 * numCols + 1
// => per-column chrome = 3, fixed chrome = 1.
const TABLE_CHROME_PER_COL = 3;
const TABLE_CHROME_FIXED = 1;

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
  /**
   * Available content width in columns. Provided by the layout owner (which
   * knows its own padding) so wrapping math matches what is actually drawn.
   * Falls back to the conversation content width when omitted.
   */
  width?: number;
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
export const MarkdownText: React.FC<MarkdownTextProps> = ({ content, theme, width }) => {
  // Use singleton instance for better performance (avoids creating new instances)
  const highlighter = useMemo(() => SyntaxHighlighter.getInstance(theme), [theme]);
  // Width flows from the layout owner; fall back to the conversation content width.
  const fallbackWidth = useContentWidth();
  const contentWidth = width ?? fallbackWidth;

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
        <RenderNode key={idx} node={node} highlighter={highlighter} width={contentWidth} />
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
const RenderNode: React.FC<{ node: ParsedNode; highlighter: SyntaxHighlighter; width: number }> = ({
  node,
  highlighter,
  width,
}) => {
  if (node.type === 'code') {
    return <CodeBlockRenderer content={node.content || ''} language={node.language} highlighter={highlighter} width={width} />;
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

    return <BlockquoteRenderer content={textContent} width={width} />;
  }

  if (node.type === 'table') {
    return <TableRenderer header={node.header || []} rows={node.rows || []} width={width} />;
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
const BlockquoteRenderer: React.FC<{ content: string; width: number }> = ({ content, width }) => {
  // Account for the prefix width: "│ " = 2 characters
  const PREFIX_WIDTH = 2;
  const availableWidth = Math.max(1, width - PREFIX_WIDTH);

  const wrappedLines = useMemo(
    () => wrapAnsiText(content, availableWidth),
    [content, availableWidth]
  );

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
const CodeBlockRenderer: React.FC<{ content: string; language?: string; highlighter: SyntaxHighlighter; width: number }> = ({
  content,
  language,
  highlighter,
  width,
}) => {
  // Chrome around code content: left padding (2) + border + space (2) + space + border (2).
  const CODE_BLOCK_OVERHEAD = 6;
  const availableWidth = Math.max(20, width - CODE_BLOCK_OVERHEAD);

  // Highlight the code
  const highlighted = highlighter.highlight(content, { language });
  const lines = highlighted.split('\n');

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
          // Truncate over-long lines, otherwise pad to a fixed width so the
          // right border stays aligned regardless of content.
          const expanded = expandTabsAnsiAware(line);
          const displayLine = visibleLength(expanded) > availableWidth
            ? truncateAnsiToWidth(expanded, availableWidth)
            : padAnsiToWidth(expanded, availableWidth);

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
const TableRenderer: React.FC<{ header: string[]; rows: string[][]; width: number }> = ({ header, rows, width }) => {
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

    // Helper to get max visual line length for cells with line breaks.
    const getMaxLineLength = (text: string): number =>
      Math.max(...text.split('\n').map((line) => visibleLength(line)));

    // Calculate natural widths (what content actually needs)
    const naturalWidths = header.map((h) => getMaxLineLength(h));
    validRows.forEach((row) => {
      row.forEach((cell, colIdx) => {
        naturalWidths[colIdx] = Math.max(naturalWidths[colIdx] || 0, getMaxLineLength(cell));
      });
    });

    // Non-cell chrome consumed by a rendered row, which must equal the border
    // width exactly. Layout: "│ " (2) + per-column " │ " separators with the
    // last column closing with " │" (2) instead of " │ " (3):
    //   chrome = 2 + (numCols - 1) * 3 + 2 = 3 * numCols + 1
    const numCols = header.length;
    const availableWidth = width - TABLE_CHROME_PER_COL * numCols - TABLE_CHROME_FIXED;

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
  }, [header, validRows, width]);

  // Process cell text with inline markdown and convert to ANSI
  const processCellMarkdown = (text: string): string => {
    // Parse inline markdown into styled segments
    const segments = parseStyledText(text);
    // Convert to ANSI string
    return segmentsToAnsiString(segments);
  };

  // Wrap and pad cell content using the shared, ANSI/wide-char-aware engine.
  const wrapCell = (text: string, cellWidth: number): string[] => wrapAnsiText(text, cellWidth);
  const padCell = (text: string, cellWidth: number): string => padAnsiToWidth(text, cellWidth);

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
          return wrapCell(formatted, columnWidths[idx] || 0);
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
                    <Text dimColor>{colIdx === headerLines.length - 1 ? ' │' : ' │ '}</Text>
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
          return wrapCell(formatted, columnWidths[colIdx] || 0);
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
                    <Text dimColor>{colIdx === wrappedCells.length - 1 ? ' │' : ' │ '}</Text>
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
