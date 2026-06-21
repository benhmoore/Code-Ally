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

/**
 * Styled segment - represents text with formatting (color, italic, strikethrough, bold, code)
 */
export interface StyledSegment {
  text: string;
  color?: string;
  italic?: boolean;
  strikethrough?: boolean;
  bold?: boolean;
  code?: boolean;
  underline?: boolean;
}

export interface ParsedNode {
  type: 'text' | 'code' | 'heading' | 'list' | 'list-item' | 'paragraph' | 'strong' | 'em' | 'codespan' | 'link' | 'table' | 'hr' | 'space' | 'blockquote';
  content?: string;
  segments?: StyledSegment[];
  language?: string;
  depth?: number;
  ordered?: boolean;
  task?: boolean;
  checked?: boolean;
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
    const result = parseMarkdownContent(content);

    // Store in cache for future renders
    markdownParseCache.set(cacheKey, result);

    return result;
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
 * Parse markdown into renderable nodes. Exported for focused renderer tests;
 * the component itself still owns caching and layout.
 */
export function parseMarkdownContent(content: string): ParsedNode[] {
  try {
    return parseTokens(marked.lexer(content));
  } catch {
    // Fallback to plain text if parsing fails. Do not cache errors; they may be
    // caused by transient parser state or unusual partial streaming content.
    return [{ type: 'text', content, segments: plainTextToSegments(content) }];
  }
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
        segments: token.tokens ? inlineTokensToSegments(token.tokens) : inlineMarkdownToSegments(token.text || ''),
        depth: token.depth,
      });
    } else if (token.type === 'table') {
      // Extract header
      const header = token.header.map((cell: any) =>
        cellToAnsi(cell)
      );

      // Extract rows
      const rows = token.rows.map((row: any) =>
        row.map((cell: any) => cellToAnsi(cell))
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
        children: token.items.map(parseListItem),
      });
    } else if (token.type === 'paragraph') {
      nodes.push({
        type: 'paragraph',
        content: token.text,
        segments: token.tokens ? inlineTokensToSegments(token.tokens) : inlineMarkdownToSegments(token.text || ''),
      });
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
          segments: inlineMarkdownToSegments((token as any).text),
        });
      } else if ((token as any).raw) {
        // Last resort - use raw content but warn about unsupported token
        logger.warn(`Unsupported markdown token type: ${(token as any).type}`);
        nodes.push({
          type: 'text',
          content: (token as any).raw,
          segments: plainTextToSegments((token as any).raw),
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
          {renderSegmentsForTerminal(node.segments ?? plainTextToSegments(node.content || ''))}
        </Text>
      </Box>
    );
  }

  if (node.type === 'list') {
    return (
      <Box flexDirection="column">
        {node.children?.map((item, idx) => {
          const bullet = getListBullet(node.ordered, idx, item);
          const itemLines = renderSegmentLinesForTerminal(item.segments ?? inlineMarkdownToSegments(item.content || ''));
          const continuationIndent = ' '.repeat(visibleLength(bullet));

          return (
            <Box key={idx} flexDirection="column" paddingLeft={2}>
              <Text>{bullet}{itemLines[0] ?? ''}</Text>
              {itemLines.slice(1).map((line, lineIdx) => (
                <Text key={lineIdx}>{continuationIndent}{line}</Text>
              ))}
              {item.children && item.children.length > 0 && (
                <Box flexDirection="column" paddingLeft={2}>
                  {item.children.map((child, childIdx) => (
                    <RenderNode key={childIdx} node={child} highlighter={highlighter} width={Math.max(1, width - 2)} />
                  ))}
                </Box>
              )}
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
    const lines = renderSegmentLinesForTerminal(node.segments ?? inlineMarkdownToSegments(node.content || ''));

    // If only one line, render as before
    if (lines.length === 1) {
      return (
        <Box>
          <Text>{lines[0] ?? ''}</Text>
        </Box>
      );
    }

    // Multiple lines - render each line separately
    return (
      <Box flexDirection="column">
        {lines.map((line, lineIdx) => {
          return (
            <Box key={lineIdx}>
              <Text>{line}</Text>
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
    return (
      <Box>
        <Text>{renderSegmentsForTerminal(node.segments ?? plainTextToSegments(node.content || ''))}</Text>
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
    const minWidths = header.map((h) => Math.max(FORMATTING.TABLE_COLUMN_MIN_WIDTH, visibleLength(h)));
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

  // Cells are normalized to ANSI strings during parsing so column measurement
  // and wrapping use the exact text that will be drawn.
  const processCellMarkdown = (text: string): string => text;

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

type SegmentStyle = Omit<StyledSegment, 'text'>;

/**
 * Parse inline markdown with marked's token stream. This is the only fallback
 * path that reparses inline text; normal block rendering receives tokens from
 * the top-level lexer and never reconstructs markdown delimiters.
 */
export function inlineMarkdownToSegments(text: string): StyledSegment[] {
  try {
    const tokens = marked.lexer(text);
    const segments: StyledSegment[] = [];

    for (const token of tokens) {
      if (token.type === 'paragraph' || token.type === 'heading') {
        segments.push(...inlineTokensToSegments((token as any).tokens ?? [{ type: 'text', text: (token as any).text ?? '' }]));
      } else if (token.type === 'space') {
        segments.push({ text: '\n' });
      } else {
        segments.push(...plainTextToSegments((token as any).text ?? (token as any).raw ?? ''));
      }
    }

    return mergeSegments(segments);
  } catch {
    return plainTextToSegments(text);
  }
}

function inlineTokensToSegments(tokens: any[], baseStyle: SegmentStyle = {}): StyledSegment[] {
  const segments: StyledSegment[] = [];
  const styleStack: SegmentStyle[] = [];
  let currentStyle: SegmentStyle = { ...baseStyle };

  for (const token of tokens) {
    const type = token.type;

    if (type === 'html') {
      const directive = parseInlineHtmlDirective(token.text ?? token.raw ?? '');
      if (directive.kind === 'line-break') {
        appendTextSegment(segments, '\n', currentStyle);
      } else if (directive.kind === 'push-style') {
        styleStack.push(currentStyle);
        currentStyle = { ...currentStyle, ...directive.style };
      } else if (directive.kind === 'pop-style') {
        currentStyle = styleStack.pop() ?? { ...baseStyle };
      } else {
        appendTextSegment(segments, token.text ?? token.raw ?? '', currentStyle);
      }
      continue;
    }

    if (type === 'text') {
      if (Array.isArray(token.tokens)) {
        segments.push(...inlineTokensToSegments(token.tokens, currentStyle));
      } else {
        appendTextSegment(segments, token.text ?? token.raw ?? '', currentStyle);
      }
      continue;
    }

    if (type === 'escape') {
      appendTextSegment(segments, token.text ?? token.raw ?? '', currentStyle);
      continue;
    }

    if (type === 'br') {
      appendTextSegment(segments, '\n', currentStyle);
      continue;
    }

    if (type === 'codespan') {
      appendTextSegment(segments, decodeCodeSpanText(token.text ?? ''), {
        ...currentStyle,
        code: true,
        color: currentStyle.color ?? UI_COLORS.PRIMARY,
      });
      continue;
    }

    if (type === 'strong') {
      segments.push(...inlineTokensToSegments(token.tokens ?? [{ type: 'text', text: token.text ?? '' }], {
        ...currentStyle,
        bold: true,
      }));
      continue;
    }

    if (type === 'em') {
      segments.push(...inlineTokensToSegments(token.tokens ?? [{ type: 'text', text: token.text ?? '' }], {
        ...currentStyle,
        italic: true,
      }));
      continue;
    }

    if (type === 'del') {
      segments.push(...inlineTokensToSegments(token.tokens ?? [{ type: 'text', text: token.text ?? '' }], {
        ...currentStyle,
        strikethrough: true,
      }));
      continue;
    }

    if (type === 'link') {
      segments.push(...inlineTokensToSegments(token.tokens ?? [{ type: 'text', text: token.text ?? token.href ?? '' }], {
        ...currentStyle,
        color: currentStyle.color ?? UI_COLORS.PRIMARY,
        underline: true,
      }));
      continue;
    }

    if (type === 'image') {
      const label = token.text ? `Image: ${token.text}` : token.href ?? 'Image';
      appendTextSegment(segments, label, { ...currentStyle, color: UI_COLORS.TEXT_DIM, italic: true });
      continue;
    }

    if (Array.isArray(token.tokens)) {
      segments.push(...inlineTokensToSegments(token.tokens, currentStyle));
    } else {
      appendTextSegment(segments, token.text ?? token.raw ?? '', currentStyle);
    }
  }

  return mergeSegments(segments);
}

function plainTextToSegments(text: string, style: SegmentStyle = {}): StyledSegment[] {
  const segments: StyledSegment[] = [];
  appendTextSegment(segments, text, style);
  return segments;
}

function appendTextSegment(segments: StyledSegment[], text: string, style: SegmentStyle): void {
  if (!text) {
    return;
  }

  segments.push({
    text: style.code ? text : processLatex(text),
    ...style,
  });
}

function renderSegmentsForTerminal(segments: StyledSegment[]): string {
  return segmentsToAnsiString(mergeSegments(segments));
}

export function renderInlineMarkdownForTerminal(text: string): string {
  return renderSegmentsForTerminal(inlineMarkdownToSegments(text));
}

export function renderInlineMarkdownLinesForTerminal(text: string): string[] {
  return renderSegmentLinesForTerminal(inlineMarkdownToSegments(text));
}

function renderSegmentLinesForTerminal(segments: StyledSegment[]): string[] {
  return splitSegmentsOnNewlines(segments).map((line) => renderSegmentsForTerminal(line));
}

function splitSegmentsOnNewlines(segments: StyledSegment[]): StyledSegment[][] {
  const lines: StyledSegment[][] = [[]];

  for (const segment of segments) {
    const parts = segment.text.split('\n');
    for (const [index, part] of parts.entries()) {
      if (index > 0) {
        lines.push([]);
      }

      if (part) {
        lines[lines.length - 1]?.push({ ...segment, text: part });
      }
    }
  }

  return lines;
}

function segmentsToPlainText(segments: StyledSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

function cellToAnsi(cell: any): string {
  const segments = cell?.tokens
    ? inlineTokensToSegments(cell.tokens)
    : inlineMarkdownToSegments(cell?.text ?? '');
  return renderSegmentsForTerminal(segments);
}

function parseListItem(item: any): ParsedNode {
  const segments: StyledSegment[] = [];
  const children: ParsedNode[] = [];

  for (const token of item.tokens ?? []) {
    if (token.type === 'text') {
      if (Array.isArray(token.tokens)) {
        segments.push(...inlineTokensToSegments(token.tokens));
      } else {
        segments.push(...inlineMarkdownToSegments(token.text ?? ''));
      }
      continue;
    }

    if (token.type === 'paragraph') {
      const paragraphSegments = token.tokens
        ? inlineTokensToSegments(token.tokens)
        : inlineMarkdownToSegments(token.text ?? '');

      if (segments.length === 0 && children.length === 0) {
        segments.push(...paragraphSegments);
      } else {
        children.push({
          type: 'paragraph',
          content: token.text,
          segments: paragraphSegments,
        });
      }
      continue;
    }

    if (token.type === 'space') {
      if (segments.length > 0) {
        appendTextSegment(segments, '\n', {});
      }
      continue;
    }

    children.push(...parseTokens([token]));
  }

  if (segments.length === 0 && item.text) {
    segments.push(...inlineMarkdownToSegments(item.text));
  }

  return {
    type: 'list-item',
    content: item.text,
    segments: mergeSegments(segments),
    task: item.task === true,
    checked: item.checked === true,
    children,
  };
}

function getListBullet(ordered: boolean | undefined, index: number, item: ParsedNode): string {
  if (item.task) {
    return `${item.checked ? UI_SYMBOLS.TODO.CHECKED : UI_SYMBOLS.TODO.UNCHECKED} `;
  }

  return ordered ? `${index + 1}. ` : `${UI_SYMBOLS.LIST.BULLET} `;
}

type InlineHtmlDirective =
  | { kind: 'line-break' }
  | { kind: 'push-style'; style: SegmentStyle }
  | { kind: 'pop-style' }
  | { kind: 'literal' };

function parseInlineHtmlDirective(rawHtml: string): InlineHtmlDirective {
  const html = rawHtml.trim();

  if (/^<br\s*\/?>$/i.test(html)) {
    return { kind: 'line-break' };
  }

  const namedOpen = html.match(/^<(red|green|yellow|cyan|blue|magenta|white|gray|grey|orange)>$/i);
  if (namedOpen?.[1]) {
    return { kind: 'push-style', style: { color: normalizeColor(namedOpen[1]) } };
  }

  const spanOpen = html.match(/^<span\s+color=["']?(red|green|yellow|cyan|blue|magenta|white|gray|grey|orange|#[0-9a-f]{6})["']?\s*>$/i);
  if (spanOpen?.[1]) {
    return { kind: 'push-style', style: { color: normalizeColor(spanOpen[1]) } };
  }

  if (/^<\/(red|green|yellow|cyan|blue|magenta|white|gray|grey|orange|span)>$/i.test(html)) {
    return { kind: 'pop-style' };
  }

  return { kind: 'literal' };
}

function normalizeColor(color: string): string {
  const normalized = color.toLowerCase();
  if (normalized === 'orange') {
    return UI_COLORS.WARNING;
  }
  if (normalized === 'grey') {
    return 'gray';
  }
  return normalized;
}

function decodeCodeSpanText(text: string): string {
  const BACKSLASH_PLACEHOLDER = '\x00BACKSLASH\x00';
  return text
    .replace(/\\\\/g, BACKSLASH_PLACEHOLDER)
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(new RegExp(BACKSLASH_PLACEHOLDER, 'g'), '\\');
}

/**
 * Convert styled segments to a single string with ANSI escape codes. This avoids
 * Ink's Text wrapping issues by pre-rendering styles into a single text node.
 */
function segmentsToAnsiString(segments: StyledSegment[]): string {
  let result = '';

  for (const segment of segments) {
    let text = segment.text;

    if (segment.color) {
      const colorCode = getAnsiColorCode(segment.color);
      if (colorCode) {
        text = `\x1b[${colorCode}m${text}\x1b[39m`;
      }
    }

    if (segment.bold) {
      text = `\x1b[1m${text}\x1b[22m`;
    }

    if (segment.italic) {
      text = `\x1b[3m${text}\x1b[23m`;
    }

    if (segment.strikethrough) {
      text = `\x1b[9m${text}\x1b[29m`;
    }

    if (segment.underline) {
      text = `\x1b[4m${text}\x1b[24m`;
    }

    result += text;
  }

  return result;
}

function getAnsiColorCode(color: string): string | null {
  const colorMap: Record<string, string> = {
    red: '31',
    green: '32',
    yellow: '33',
    blue: '34',
    magenta: '35',
    cyan: '36',
    white: '37',
    gray: '90',
    grey: '90',
  };

  if (colorMap[color]) {
    return colorMap[color];
  }

  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (!hex?.[1]) {
    return null;
  }

  const red = Number.parseInt(hex[1].slice(0, 2), 16);
  const green = Number.parseInt(hex[1].slice(2, 4), 16);
  const blue = Number.parseInt(hex[1].slice(4, 6), 16);
  return `38;2;${red};${green};${blue}`;
}

function mergeSegments(segments: StyledSegment[]): StyledSegment[] {
  if (segments.length <= 1) return segments;

  const merged: StyledSegment[] = [];
  let current: StyledSegment | null = null;

  for (const segment of segments) {
    if (!segment.text) {
      continue;
    }

    if (
      current &&
      current.color === segment.color &&
      current.bold === segment.bold &&
      current.italic === segment.italic &&
      current.strikethrough === segment.strikethrough &&
      current.code === segment.code &&
      current.underline === segment.underline
    ) {
      current.text += segment.text;
    } else {
      current = { ...segment };
      merged.push(current);
    }
  }

  return merged;
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
      parts.push(node.segments ? segmentsToPlainText(node.segments) : node.content || '');
    } else if (node.type === 'list') {
      // Lists - render with appropriate bullets
      const items = node.children?.map((item, idx) => {
        const bullet = node.ordered ? `${idx + 1}. ` : `  ${UI_SYMBOLS.LIST.BULLET} `;
        return bullet + (item.segments ? segmentsToPlainText(item.segments) : stripInlineMarkdown(item.content || ''));
      }) || [];
      parts.push(items.join('\n'));
    } else if (node.type === 'paragraph') {
      // Paragraphs - preserve inline formatting
      parts.push(node.segments ? segmentsToPlainText(node.segments) : stripInlineMarkdown(node.content || ''));
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
      parts.push(node.segments ? segmentsToPlainText(node.segments) : stripInlineMarkdown(node.content || ''));
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
  return segmentsToPlainText(inlineMarkdownToSegments(text));
}
