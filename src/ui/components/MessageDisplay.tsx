import React from 'react';
import { Box, Text } from 'ink';
import { Message } from '../../types/index.js';

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
 * Note: Full markdown syntax highlighting would require additional
 * libraries. For MVP, we use simple color coding that matches the
 * Python Rich version's visual hierarchy.
 */
export const MessageDisplay: React.FC<MessageDisplayProps> = ({ message }) => {
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

  // Assistant messages - green with markdown-style formatting
  if (role === 'assistant') {
    // Check for thinking content (simplified extraction)
    const thinkingMatch = content.match(/<think>(.*?)<\/think>/s);
    const thinking = thinkingMatch?.[1]?.trim() || null;
    const regularContent = thinking
      ? content.replace(/<think>.*?<\/think>/s, '').trim()
      : content;

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
          <Text color="green">{regularContent}</Text>
        )}
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
