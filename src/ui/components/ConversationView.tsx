import React from 'react';
import { Box, Text } from 'ink';
import { Message } from '../../types/index.js';
import { MessageDisplay } from './MessageDisplay.js';

interface ConversationViewProps {
  /** Array of conversation messages to display */
  messages: Message[];
  /** Whether the assistant is currently thinking/processing */
  isThinking?: boolean;
  /** Current streaming content (if any) */
  streamingContent?: string;
}

/**
 * ConversationView Component
 *
 * Main container for displaying conversation history. Uses Ink's performance
 * optimization patterns to efficiently render messages.
 *
 * Performance Strategy:
 * - Completed messages are rendered statically (no re-renders)
 * - Only pending/streaming messages update dynamically
 * - Flexible layout adapts to terminal size
 *
 * Note: Unlike Python Rich which uses Live displays, Ink automatically
 * handles re-rendering when state changes. We don't use <Static> here
 * because Ink's reconciliation is already efficient and Static has
 * limitations with dynamic content.
 */
export const ConversationView: React.FC<ConversationViewProps> = ({
  messages,
  isThinking = false,
  streamingContent,
}) => {
  return (
    <Box flexDirection="column" gap={1}>
      {/* Render all conversation messages */}
      {messages.map((message, index) => (
        <MessageDisplay key={`msg-${index}`} message={message} />
      ))}

      {/* Show streaming content if present */}
      {streamingContent && (
        <Box flexDirection="column">
          <Text color="green">{streamingContent}</Text>
        </Box>
      )}

      {/* Show thinking indicator if waiting for response */}
      {isThinking && !streamingContent && (
        <Box>
          <Text dimColor>Thinking...</Text>
        </Box>
      )}
    </Box>
  );
};
