import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

interface InputPromptProps {
  /** Callback when user submits input */
  onSubmit: (input: string) => void;
  /** Whether input is currently active/enabled */
  isActive?: boolean;
  /** Placeholder text to show when empty */
  placeholder?: string;
}

/**
 * InputPrompt Component
 *
 * User input component with multiline support and keyboard handling.
 *
 * Features:
 * - Enter: Submit input (if not empty)
 * - Ctrl+J: Insert newline (multiline support)
 * - Backspace: Delete character
 * - Ctrl+C: Clear input buffer
 *
 * Display:
 * - Primary prompt: "> "
 * - Continuation lines: "... "
 *
 * Note: Ink's useInput() hook provides raw keyboard events. We build
 * the input buffer manually to match Python prompt_toolkit behavior.
 */
export const InputPrompt: React.FC<InputPromptProps> = ({
  onSubmit,
  isActive = true,
  placeholder = 'Type a message...',
}) => {
  const [buffer, setBuffer] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);

  // Handle keyboard input
  useInput(
    (input, key) => {
      if (!isActive) return;

      // Ctrl+C - Clear buffer
      if (key.ctrl && input === 'c') {
        setBuffer('');
        setCursorPosition(0);
        return;
      }

      // Enter - Submit (or add newline with Ctrl)
      if (key.return) {
        if (key.ctrl) {
          // Ctrl+Enter - Insert newline
          const before = buffer.slice(0, cursorPosition);
          const after = buffer.slice(cursorPosition);
          setBuffer(before + '\n' + after);
          setCursorPosition(cursorPosition + 1);
        } else {
          // Regular Enter - Submit if buffer not empty
          if (buffer.trim()) {
            onSubmit(buffer);
            setBuffer('');
            setCursorPosition(0);
          }
        }
        return;
      }

      // Backspace
      if (key.backspace || key.delete) {
        if (cursorPosition > 0) {
          const before = buffer.slice(0, cursorPosition - 1);
          const after = buffer.slice(cursorPosition);
          setBuffer(before + after);
          setCursorPosition(cursorPosition - 1);
        }
        return;
      }

      // Left arrow
      if (key.leftArrow) {
        setCursorPosition(Math.max(0, cursorPosition - 1));
        return;
      }

      // Right arrow
      if (key.rightArrow) {
        setCursorPosition(Math.min(buffer.length, cursorPosition + 1));
        return;
      }

      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        const before = buffer.slice(0, cursorPosition);
        const after = buffer.slice(cursorPosition);
        setBuffer(before + input + after);
        setCursorPosition(cursorPosition + 1);
      }
    },
    { isActive }
  );

  // Split buffer into lines for multiline display
  const lines = buffer.split('\n');
  const isEmpty = buffer.trim().length === 0;

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => {
        const isFirstLine = index === 0;
        const prompt = isFirstLine ? '> ' : '... ';
        const displayText = line || (isEmpty && isFirstLine ? placeholder : '');
        const textColor = isEmpty && isFirstLine ? 'gray' : 'white';

        return (
          <Box key={`line-${index}`}>
            <Text color="cyan">{prompt}</Text>
            <Text color={textColor} dimColor={isEmpty && isFirstLine}>
              {displayText}
            </Text>
            {/* Simple cursor indicator on current line */}
            {index === lines.length - 1 && isActive && (
              <Text color="white">_</Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
