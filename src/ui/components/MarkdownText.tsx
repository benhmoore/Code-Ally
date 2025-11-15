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
    <Box flexDirection="column">
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

  // Handle LaTeX math expressions (use non-greedy matching to allow nested delimiters)
  formatted = formatted.replace(/\\\((.+?)\\\)/g, (_match, mathContent) => {
    return convertLatexToUnicode(mathContent);
  });
  formatted = formatted.replace(/\\\[(.+?)\\\]/g, (_match, mathContent) => {
    return convertLatexToUnicode(mathContent);
  });
  formatted = formatted.replace(/\$\$(.+?)\$\$/g, (_match, mathContent) => {
    return convertLatexToUnicode(mathContent);
  });

  // Handle markdown links - just show the text
  formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, _url) => {
    return text;
  });

  return formatted;
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
        let processedText = token.text;

        // Handle LaTeX math expressions
        processedText = processedText.replace(/\\\((.+?)\\\)/g, (_match, mathContent) => {
          return convertLatexToUnicode(mathContent);
        });
        processedText = processedText.replace(/\\\[(.+?)\\\]/g, (_match, mathContent) => {
          return convertLatexToUnicode(mathContent);
        });
        processedText = processedText.replace(/\$\$(.+?)\$\$/g, (_match, mathContent) => {
          return convertLatexToUnicode(mathContent);
        });

        segments.push({ ...token, text: processedText });
      } else {
        segments.push(token);
      }
    }
  }

  return segments.length > 0 ? segments : [{ text }];
}

/**
 * Tokenize text into formatted segments
 */
function tokenizeFormatting(text: string): StyledSegment[] {
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
      segments.push({ text: match[1], code: true, color: UI_COLORS.PRIMARY });
    } else if (match[2] && match[3]) {
      // Color tag: <red>text</red>
      const color = match[2].toLowerCase() === 'orange' ? UI_COLORS.WARNING : match[2].toLowerCase();
      // Recursively parse nested formatting
      const nested = tokenizeFormatting(match[3]);
      for (const seg of nested) {
        segments.push({ ...seg, color });
      }
    } else if (match[4] && match[5]) {
      // Color tag: <span color="red">text</span>
      const color = match[4].toLowerCase() === 'orange' ? UI_COLORS.WARNING : match[4].toLowerCase();
      const nested = tokenizeFormatting(match[5]);
      for (const seg of nested) {
        segments.push({ ...seg, color });
      }
    } else if (match[6]) {
      // Strikethrough: ~~text~~
      const nested = tokenizeFormatting(match[6]);
      for (const seg of nested) {
        segments.push({ ...seg, strikethrough: true });
      }
    } else if (match[7]) {
      // Bold: **text**
      const nested = tokenizeFormatting(match[7]);
      for (const seg of nested) {
        segments.push({ ...seg, bold: true });
      }
    } else if (match[8]) {
      // Bold: __text__
      const nested = tokenizeFormatting(match[8]);
      for (const seg of nested) {
        segments.push({ ...seg, bold: true });
      }
    } else if (match[9]) {
      // Italic: *text*
      const nested = tokenizeFormatting(match[9]);
      for (const seg of nested) {
        segments.push({ ...seg, italic: true });
      }
    } else if (match[10]) {
      // Italic: _text_
      const nested = tokenizeFormatting(match[10]);
      for (const seg of nested) {
        segments.push({ ...seg, italic: true });
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

  // Handle LaTeX math expressions (use non-greedy matching to allow nested delimiters)
  stripped = stripped.replace(/\\\((.+?)\\\)/g, (_match, mathContent) => {
    return convertLatexToUnicode(mathContent);
  });
  stripped = stripped.replace(/\\\[(.+?)\\\]/g, (_match, mathContent) => {
    return convertLatexToUnicode(mathContent);
  });
  stripped = stripped.replace(/\$\$(.+?)\$\$/g, (_match, mathContent) => {
    return convertLatexToUnicode(mathContent);
  });

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
