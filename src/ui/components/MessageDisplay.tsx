import React from 'react';
import { Box, Text } from 'ink';
import { Message } from '@shared/index.js';
import { MarkdownText } from './MarkdownText.js';
import { TEXT_LIMITS } from '@config/constants.js';
import { UI_COLORS } from '../constants/colors.js';

interface MessageDisplayProps {
  /** Message to display */
  message: Message;
  /** Configuration (for show_thinking_in_chat) */
  config?: any;
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
const MessageDisplayComponent: React.FC<MessageDisplayProps> = ({ message, config }) => {
  const { role, content, name } = message;
  const showThinking = config?.show_thinking_in_chat ?? false;

  // User messages - bold with prompt prefix
  if (role === 'user') {
    return (
      <Box flexDirection="column">
        <Text bold color={UI_COLORS.PRIMARY}>
          {`> ${content}`}
        </Text>
      </Box>
    );
  }

  // Assistant messages - markdown-formatted with syntax highlighting
  if (role === 'assistant') {
    // Handle empty or undefined content
    // Trim all leading/trailing whitespace for clean display
    const safeContent = (content || '').trim();

    // Get thinking from message field (native reasoning from model)
    // Trim all leading/trailing whitespace for clean display
    const thinking = message.thinking?.trim() || null;

    // Check if this is a command response that should be styled in yellow
    const isCommandResponse = message.metadata?.isCommandResponse === true;
    // Check if this is an error message that should be styled in red
    const isError = message.metadata?.isError === true;

    return (
      <Box flexDirection="column">
        {showThinking && thinking && (
          <Box>
            <Text dimColor italic>
              ∴ {thinking}
            </Text>
          </Box>
        )}
        {safeContent && (
          isError ? (
            <Text color={UI_COLORS.ERROR}>{safeContent}</Text>
          ) : isCommandResponse ? (
            <Text color={UI_COLORS.PRIMARY}>{safeContent}</Text>
          ) : (
            <MarkdownText content={safeContent} />
          )
        )}
        {/* Note: Tool calls are now displayed via ToolCallDisplay in ConversationView */}
      </Box>
    );
  }

  // System messages - dim gray
  if (role === 'system') {
    return (
      <Box>
        <Text dimColor color={UI_COLORS.TEXT_DIM}>
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
    const displayContent = content.length > TEXT_LIMITS.CONTENT_PREVIEW_MAX
      ? `${content.slice(0, TEXT_LIMITS.CONTENT_PREVIEW_MAX - 3)}...`
      : content;

    return (
      <Box flexDirection="column" paddingLeft={2}>
        <Text color={UI_COLORS.TEXT_DIM} dimColor>
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
