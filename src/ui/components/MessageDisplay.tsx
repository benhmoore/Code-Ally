import React from 'react';
import { Box, Text } from 'ink';
import { Message } from '../../types/index.js';
import { MarkdownText } from './MarkdownText.js';

interface MessageDisplayProps {
  /** Message to display */
  message: Message;
}

/**
 * MessageDisplay Component
 *
 * Renders individual messages with role-appropriate styling.
 *
 * Message Types:
 * - User: Bold text with "> " prefix (similar to Python version)
 * - Assistant: Green markdown-style content (simplified for now)
 * - System: Dim gray text
 * - Tool: Cyan text with indentation
 *
 * Performance:
 * - Memoized to prevent re-renders (messages never change)
 * - Critical for smooth performance with long conversations
 */
const MessageDisplayComponent: React.FC<MessageDisplayProps> = ({ message }) => {
  const { role, content, name } = message;

  // User messages - bold with prompt prefix
  if (role === 'user') {
    return (
      <Box flexDirection="column">
        <Text bold color="white">
          {`> ${content}`}
        </Text>
      </Box>
    );
  }

  // Assistant messages - markdown-formatted with syntax highlighting
  if (role === 'assistant') {
    // Handle empty or undefined content
    const safeContent = content || '';

    // Check for thinking content (simplified extraction)
    const thinkingMatch = safeContent.match(/<think>(.*?)<\/think>/s);
    const thinking = thinkingMatch?.[1]?.trim() || null;
    const regularContent = thinking
      ? safeContent.replace(/<think>.*?<\/think>/s, '').trim()
      : safeContent;

    return (
      <Box flexDirection="column">
        {thinking && (
          <Box marginBottom={1}>
            <Text dimColor italic color="cyan">
              {thinking}
            </Text>
          </Box>
        )}
        {regularContent && (
          <MarkdownText content={regularContent} />
        )}
        {/* Note: Tool calls are now displayed via ToolCallDisplay in ConversationView */}
      </Box>
    );
  }

  // System messages - dim gray
  if (role === 'system') {
    return (
      <Box>
        <Text dimColor color="gray">
          {content}
        </Text>
      </Box>
    );
  }

  // Tool response messages - cyan with indentation
  if (role === 'tool') {
    // Format tool name if provided
    const toolName = name ? `[${name}]` : '[Tool]';

    // Truncate long content for display
    const displayContent = content.length > 200
      ? `${content.slice(0, 197)}...`
      : content;

    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color="cyan" dimColor>
          {toolName}
        </Text>
        <Text color="white" dimColor>
          {displayContent}
        </Text>
      </Box>
    );
  }

  // Fallback for unknown message types
  return (
    <Box>
      <Text>{content}</Text>
    </Box>
  );
};

/**
 * Memoized MessageDisplay
 *
 * Messages are immutable - they never change once created.
 * This prevents ALL re-renders for completed messages (huge performance win).
 */
export const MessageDisplay = React.memo(
  MessageDisplayComponent,
  (prevProps, nextProps) => {
    // Messages are immutable - if the reference is the same, content is identical
    // This allows React to skip re-rendering entirely
    return prevProps.message === nextProps.message;
  }
);
