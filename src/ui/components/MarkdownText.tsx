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
import { SyntaxHighlighter } from '../../services/SyntaxHighlighter.js';
import path from 'path';

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
  const highlighter = useMemo(() => new SyntaxHighlighter(theme), [theme]);

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
        <Text dimColor color="cyan">
          {node.language ? `[${node.language}]` : '[code]'}
        </Text>
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
          {highlighted.split('\n').map((line, idx) => (
            <Text key={idx}>{line}</Text>
          ))}
        </Box>
      </Box>
    );
  }

  if (node.type === 'heading') {
    const color = node.depth === 1 ? 'cyan' : node.depth === 2 ? 'blue' : 'yellow';
    const prefix = '#'.repeat(node.depth || 1) + ' ';

    return (
      <Box marginY={1}>
        <Text bold color={color}>
          {prefix}
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
 */
const TableRenderer: React.FC<{ header: string[]; rows: string[][] }> = ({ header, rows }) => {
  // Calculate column widths based on content
  const columnWidths = useMemo(() => {
    const widths = header.map((h) => h.length);

    rows.forEach((row) => {
      row.forEach((cell, colIdx) => {
        widths[colIdx] = Math.max(widths[colIdx] || 0, cell.length);
      });
    });

    return widths;
  }, [header, rows]);

  // Pad a cell to the specified width
  const padCell = (text: string, width: number): string => {
    return text.padEnd(width, ' ');
  };

  // Create horizontal separator lines with proper connectors
  const createTopBorder = (): string => {
    return '┌─' + columnWidths.map((w) => '─'.repeat(w)).join('─┬─') + '─┐';
  };

  const createMiddleSeparator = (): string => {
    return '├─' + columnWidths.map((w) => '─'.repeat(w)).join('─┼─') + '─┤';
  };

  const createBottomBorder = (): string => {
    return '└─' + columnWidths.map((w) => '─'.repeat(w)).join('─┴─') + '─┘';
  };

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Top border */}
      <Text dimColor>{createTopBorder()}</Text>

      {/* Header row */}
      <Text bold>
        │ {header.map((h, idx) => padCell(h, columnWidths[idx] || 0)).join(' │ ')} │
      </Text>

      {/* Header separator */}
      <Text dimColor>{createMiddleSeparator()}</Text>

      {/* Data rows */}
      {rows.map((row, rowIdx) => (
        <Text key={rowIdx}>
          │ {row.map((cell, colIdx) => padCell(cell, columnWidths[colIdx] || 0)).join(' │ ')} │
        </Text>
      ))}

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

  // Handle markdown links - convert file:// links to clickable, show text for others
  formatted = formatted.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
    // If it's a file path, make it clickable
    if (url.startsWith('file://') || isFilePath(url)) {
      let absolutePath: string;
      if (url.startsWith('file://')) {
        absolutePath = url.slice(7);
      } else if (url.startsWith('/')) {
        absolutePath = url;
      } else if (url.startsWith('~')) {
        const homedir = process.env.HOME || process.env.USERPROFILE || '';
        absolutePath = url.replace(/^~/, homedir);
      } else {
        absolutePath = path.resolve(process.cwd(), url);
      }
      return createTerminalLink(text, `file://${absolutePath}`);
    }
    // Otherwise just show the text
    return text;
  });

  // Make standalone file paths clickable
  formatted = makeFilePathsClickable(formatted);

  return formatted;
}

/**
 * Strip inline markdown for plain text display
 */
function stripInlineMarkdown(text: string): string {
  let stripped = text;

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

/**
 * Create OSC 8 hyperlink for terminal
 */
function createTerminalLink(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * Detect if a string is a file path
 */
function isFilePath(text: string): boolean {
  // Absolute paths
  if (text.startsWith('/') || text.startsWith('~')) return true;

  // Relative paths
  if (text.startsWith('./') || text.startsWith('../')) return true;

  // Common file extensions
  const fileExtensions = /\.(ts|tsx|js|jsx|json|md|txt|py|java|cpp|c|h|css|html|xml|yaml|yml|toml|sh|bash|rs|go|rb|php|swift|kt|gradle|sql)$/i;
  if (fileExtensions.test(text)) return true;

  return false;
}

/**
 * Make file paths clickable with OSC 8 hyperlinks
 */
function makeFilePathsClickable(text: string): string {
  // Pattern to match file paths (both standalone and in common formats)
  // Matches: /path/to/file, ./path/to/file, ../path/to/file, path/to/file.ext
  const pathPattern = /(?:^|\s)((?:\.\.?\/|\/|~\/)?[\w\-./]+\.[\w]+)(?=\s|$|[,.:;)])/g;

  return text.replace(pathPattern, (match, filepath) => {
    const trimmedPath = filepath.trim();

    if (!isFilePath(trimmedPath)) {
      return match;
    }

    // Convert to absolute path for file:// URL
    let absolutePath: string;
    if (trimmedPath.startsWith('/')) {
      absolutePath = trimmedPath;
    } else if (trimmedPath.startsWith('~')) {
      const homedir = process.env.HOME || process.env.USERPROFILE || '';
      absolutePath = trimmedPath.replace(/^~/, homedir);
    } else {
      absolutePath = path.resolve(process.cwd(), trimmedPath);
    }

    const fileUrl = `file://${absolutePath}`;
    const prefix = match.startsWith(' ') ? ' ' : '';

    return prefix + createTerminalLink(trimmedPath, fileUrl);
  });
}
