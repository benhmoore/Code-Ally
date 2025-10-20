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
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { marked } from 'marked';
import { SyntaxHighlighter } from '../../services/SyntaxHighlighter.js';

export interface MarkdownTextProps {
  /** Markdown content to render */
  content: string;
  /** Optional syntax highlighting theme */
  theme?: string;
}

interface ParsedNode {
  type: 'text' | 'code' | 'heading' | 'list' | 'list-item' | 'paragraph' | 'strong' | 'em' | 'codespan' | 'link';
  content?: string;
  language?: string;
  depth?: number;
  ordered?: boolean;
  children?: ParsedNode[];
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

  // Handle links - show just the text
  formatted = formatted.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

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
