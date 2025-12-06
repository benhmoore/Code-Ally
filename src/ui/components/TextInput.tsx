/**
 * TextInput Component - Pure text editing primitives
 *
 * A clean, reusable text input component with advanced editing features:
 * - Buffer state management with cursor tracking
 * - Character insertion/deletion at cursor position
 * - Arrow key navigation (left/right)
 * - Word navigation (Ctrl+Arrow, Alt+Arrow)
 * - Line navigation (Ctrl+A start, Ctrl+E end)
 * - Kill line operations (Ctrl+K forward, Ctrl+U backward)
 * - Word deletion (Ctrl+W, Alt+Backspace)
 * - Multiline support with Ctrl+Enter
 * - Clear buffer (Ctrl+C)
 * - Visual cursor rendering with inverse colors
 */

import React, { useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { detectFilesAndImages } from '@utils/pathUtils.js';

export interface TextInputProps {
  /** Current text value */
  value: string;
  /** Callback when value changes */
  onValueChange: (value: string) => void;
  /** Current cursor position (0-indexed character position) */
  cursorPosition: number;
  /** Callback when cursor position changes */
  onCursorChange: (position: number) => void;
  /** Callback when user submits (Enter key) */
  onSubmit: (value: string) => void;
  /** Callback when user presses Escape key */
  onEscape?: () => void;
  /** Callback when file paths are pasted */
  onFilesPasted?: (files: string[]) => void;
  /** Callback when image paths are pasted */
  onImagesPasted?: (images: string[]) => void;
  /** Callback when directory paths are pasted */
  onDirectoriesPasted?: (directories: string[]) => void;
  /** Callback when Ctrl+C is pressed on empty buffer (for parent to handle exit/cancel) */
  onCtrlC?: () => void;
  /** Whether input is currently active/enabled */
  isActive?: boolean;
  /** Enable multiline mode (Ctrl+Enter for newline, Enter submits) */
  multiline?: boolean;
  /** Placeholder text when empty */
  placeholder?: string;
  /** Whether to render with border (default: false for clean inline) */
  bordered?: boolean;
  /** Border color (hex or color name) - only used when bordered={true} */
  borderColor?: string;
  /** Optional prompt prefix (e.g., "> " or "ally> ") - only used when bordered={true} */
  promptText?: string;
  /**
   * Mask character for hidden input (e.g., passwords).
   * When set, displays this character for each character in the value,
   * but the actual value is preserved for all callbacks.
   * Example: mask="*" will display "****" for value "test"
   */
  mask?: string;
  /**
   * Optional label displayed above the input.
   * When provided, renders in a vertical layout with the label on its own line.
   * This ensures consistent layout regardless of terminal width.
   */
  label?: string;
  /**
   * Color for the label text.
   * @default 'cyan' (UI_COLORS.PRIMARY)
   */
  labelColor?: string;
}

/**
 * Pure text input component with advanced editing capabilities
 */
export const TextInput: React.FC<TextInputProps> = ({
  value,
  onValueChange,
  cursorPosition,
  onCursorChange,
  onSubmit,
  onEscape,
  onFilesPasted,
  onImagesPasted,
  onDirectoriesPasted,
  onCtrlC,
  isActive = true,
  multiline = false,
  placeholder = 'Type here...',
  bordered = false,
  borderColor = 'gray',
  promptText = '> ',
  mask,
  label,
  labelColor = 'cyan',
}) => {
  // Use refs to avoid stale closure issues with rapid input events
  const valueRef = useRef(value);
  const cursorRef = useRef(cursorPosition);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    cursorRef.current = cursorPosition;
  }, [cursorPosition]);

  /**
   * Calculate cursor line and position within that line
   * Returns line number, position in line, and character offset to line start
   */
  const getCursorLineInfo = (
    text: string,
    cursor: number
  ): { line: number; posInLine: number; charsBeforeLine: number } => {
    // Clamp cursor to valid range
    const clampedCursor = Math.max(0, Math.min(cursor, text.length));
    const lines = text.split('\n');
    let charCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLength = (lines[i] || '').length;
      // Check if cursor is on this line (including end of line position)
      if (charCount + lineLength >= clampedCursor) {
        return {
          line: i,
          posInLine: Math.min(clampedCursor - charCount, lineLength),
          charsBeforeLine: charCount,
        };
      }
      charCount += lineLength + 1; // +1 for newline character
    }

    // Cursor beyond text (defensive - shouldn't happen)
    // Place at end of last line
    const lastLineIndex = Math.max(0, lines.length - 1);
    const lastLineLength = (lines[lastLineIndex] || '').length;
    const charsBeforeLastLine = Math.max(0, text.length - lastLineLength);

    return {
      line: lastLineIndex,
      posInLine: lastLineLength,
      charsBeforeLine: charsBeforeLastLine,
    };
  };

  /**
   * Delete word backward from cursor (Ctrl+W, Alt+Backspace)
   * Deletes from cursor back to start of previous word
   */
  const deleteWordBackward = () => {
    const cursor = cursorRef.current;
    if (cursor === 0) return;

    const text = valueRef.current;
    let pos = cursor - 1;

    // Skip trailing whitespace
    while (pos > 0) {
      const char = text[pos];
      if (!char || !/\s/.test(char)) break;
      pos--;
    }

    // Delete word characters
    while (pos > 0) {
      const char = text[pos];
      if (!char || /\s/.test(char)) break;
      pos--;
    }

    // Don't delete the space before the word
    if (pos > 0) pos++;

    const before = text.slice(0, pos);
    const after = text.slice(cursor);
    onValueChange(before + after);
    onCursorChange(pos);
  };

  /**
   * Move cursor left by one word
   * Jumps to start of previous word
   */
  const moveCursorWordLeft = () => {
    const text = valueRef.current;
    let pos = cursorRef.current - 1;

    // Skip trailing whitespace
    while (pos > 0) {
      const char = text[pos];
      if (!char || !/\s/.test(char)) break;
      pos--;
    }

    // Move to start of word
    while (pos > 0) {
      const char = text[pos];
      if (!char || /\s/.test(char)) break;
      pos--;
    }

    // Position at start of word (not on the space before)
    if (pos > 0) pos++;

    onCursorChange(Math.max(0, pos));
  };

  /**
   * Move cursor right by one word
   * Jumps to start of next word
   */
  const moveCursorWordRight = () => {
    const text = valueRef.current;
    let pos = cursorRef.current;

    // Skip current word
    while (pos < text.length) {
      const char = text[pos];
      if (!char || /\s/.test(char)) break;
      pos++;
    }

    // Skip whitespace to next word
    while (pos < text.length) {
      const char = text[pos];
      if (!char || !/\s/.test(char)) break;
      pos++;
    }

    onCursorChange(pos);
  };

  /**
   * Handle keyboard input
   */
  useInput(
    (input, key) => {
      if (!isActive) return;

      const currentValue = valueRef.current;
      const currentCursor = cursorRef.current;

      // ===== Submit (Enter) =====
      if (key.return) {
        if (multiline && key.ctrl) {
          // Ctrl+Enter in multiline mode - insert newline
          const before = currentValue.slice(0, currentCursor);
          const after = currentValue.slice(currentCursor);
          onValueChange(before + '\n' + after);
          onCursorChange(currentCursor + 1);
        } else if (!multiline || !key.ctrl) {
          // Plain Enter - submit
          onSubmit(currentValue);
        }
        return;
      }

      // ===== Escape =====
      if (key.escape) {
        if (onEscape) {
          onEscape();
        }
        return;
      }

      // ===== Clear Buffer (Ctrl+C) =====
      // Clears buffer if content exists, otherwise notifies parent
      if (key.ctrl && input === 'c') {
        if (currentValue.trim().length > 0) {
          onValueChange('');
          onCursorChange(0);
        } else {
          onCtrlC?.();
        }
        return;
      }

      // ===== Move to Start (Ctrl+A) =====
      if (key.ctrl && input === 'a') {
        onCursorChange(0);
        return;
      }

      // ===== Move to End (Ctrl+E) =====
      if (key.ctrl && input === 'e') {
        onCursorChange(currentValue.length);
        return;
      }

      // ===== Kill to End (Ctrl+K) =====
      if (key.ctrl && input === 'k') {
        const before = currentValue.slice(0, currentCursor);
        onValueChange(before);
        return;
      }

      // ===== Kill to Start (Ctrl+U) =====
      if (key.ctrl && input === 'u') {
        const after = currentValue.slice(currentCursor);
        onValueChange(after);
        onCursorChange(0);
        return;
      }

      // ===== Delete Word Backward (Ctrl+W) =====
      if (key.ctrl && input === 'w') {
        deleteWordBackward();
        return;
      }

      // ===== Word Movement (Ctrl+Arrow, Alt+Arrow) =====
      if ((key.meta || key.ctrl) && key.leftArrow) {
        moveCursorWordLeft();
        return;
      }

      if ((key.meta || key.ctrl) && key.rightArrow) {
        moveCursorWordRight();
        return;
      }

      // ===== Delete Word Backward (Ctrl+Backspace, Alt+Backspace) =====
      if ((key.ctrl || key.meta) && (key.backspace || key.delete)) {
        deleteWordBackward();
        return;
      }

      // ===== Backspace =====
      if (key.backspace || key.delete) {
        if (currentCursor > 0) {
          const before = currentValue.slice(0, currentCursor - 1);
          const after = currentValue.slice(currentCursor);
          onValueChange(before + after);
          onCursorChange(currentCursor - 1);
        }
        return;
      }

      // ===== Arrow Keys (Left/Right) =====
      if (key.leftArrow) {
        onCursorChange(Math.max(0, currentCursor - 1));
        return;
      }

      if (key.rightArrow) {
        onCursorChange(Math.min(currentValue.length, currentCursor + 1));
        return;
      }

      // ===== Arrow Keys (Up/Down) for multiline navigation =====
      if (multiline && key.upArrow) {
        const lines = currentValue.split('\n');
        const cursorInfo = getCursorLineInfo(currentValue, currentCursor);

        if (cursorInfo.line > 0) {
          // Move to previous line at same column or end of line
          const prevLineStart = cursorInfo.charsBeforeLine - (lines[cursorInfo.line - 1] || '').length - 1;
          const prevLineLength = (lines[cursorInfo.line - 1] || '').length;
          const newPos = prevLineStart + Math.min(cursorInfo.posInLine, prevLineLength);
          onCursorChange(newPos);
        } else {
          // Already on first line - move to start
          onCursorChange(0);
        }
        return;
      }

      if (multiline && key.downArrow) {
        const lines = currentValue.split('\n');
        const cursorInfo = getCursorLineInfo(currentValue, currentCursor);

        if (cursorInfo.line < lines.length - 1) {
          // Move to next line at same column or end of line
          const nextLineStart = cursorInfo.charsBeforeLine + (lines[cursorInfo.line] || '').length + 1;
          const nextLineLength = (lines[cursorInfo.line + 1] || '').length;
          const newPos = nextLineStart + Math.min(cursorInfo.posInLine, nextLineLength);
          onCursorChange(newPos);
        } else {
          // Already on last line - move to end
          onCursorChange(currentValue.length);
        }
        return;
      }

      // ===== Regular Character Input =====
      if (input && !key.ctrl && !key.meta) {
        // Normalize line endings - convert \r\n and \r to \n
        const normalizedInput = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // Detect pasted file paths, images, and directories (multi-character input without newlines)
        if (input.length > 1 && !normalizedInput.includes('\n')) {
          const { directories, files, images } = detectFilesAndImages(input);
          const hasDirectories = directories.length > 0;
          const hasFiles = files.length > 0;
          const hasImages = images.length > 0;

          if (hasDirectories || hasFiles || hasImages) {
            // Notify parent of detected paths
            if (hasDirectories) onDirectoriesPasted?.(directories);
            if (hasFiles) onFilesPasted?.(files);
            if (hasImages) onImagesPasted?.(images);

            // Insert all with @ prefix (quote paths with spaces)
            const allPaths = [...directories, ...files, ...images];
            const pathsWithPrefix = allPaths.map(p => {
              // Quote paths that contain spaces
              if (p.includes(' ')) {
                return `@"${p}"`;
              }
              return `@${p}`;
            }).join(' ');
            const before = currentValue.slice(0, currentCursor);
            const after = currentValue.slice(currentCursor);
            const newValue = before + pathsWithPrefix + after;
            const newCursor = currentCursor + pathsWithPrefix.length;

            onValueChange(newValue);
            onCursorChange(newCursor);
            return;
          }
        }

        // Regular insertion (no paths detected or single character)
        const before = currentValue.slice(0, currentCursor);
        const after = currentValue.slice(currentCursor);
        const newValue = before + normalizedInput + after;
        const newCursor = currentCursor + normalizedInput.length;

        onValueChange(newValue);
        onCursorChange(newCursor);
      }
    },
    { isActive }
  );

  // Apply mask for display if specified (e.g., password fields)
  // The actual value is preserved in all callbacks - mask only affects rendering
  // Preserve newlines in masked content so multiline still works correctly
  // Use Array.from() for proper Unicode grapheme handling (emoji, combining chars)
  const displayValue = mask
    ? Array.from(value).map(char => char === '\n' ? '\n' : mask).join('')
    : value;

  // Split display value into lines for rendering
  const lines = displayValue.split('\n');
  const isEmpty = value.trim().length === 0;

  // Calculate cursor line info
  const cursorInfo = getCursorLineInfo(value, cursorPosition);
  const cursorLine = cursorInfo.line;
  const cursorPosInLine = cursorInfo.posInLine;

  // Render the text content (shared by both variants)
  const renderContent = () => (
    <>
      {lines.map((line, index) => {
        const isFirstLine = index === 0;
        const prompt = bordered && isFirstLine ? promptText : '';
        // Display placeholder on first line if empty, otherwise show space for empty lines
        const displayText = line !== '' ? line : isEmpty && isFirstLine ? placeholder : ' ';
        const textColor = isEmpty && isFirstLine ? 'gray' : 'white';
        const isCursorLine = index === cursorLine;

        return (
          <Box key={`line-${index}`}>
            {/* Prompt prefix - only show when bordered */}
            {bordered && (
              <Text wrap="wrap" color="gray">
                {prompt}
              </Text>
            )}

            {/* Non-cursor line or inactive - simple rendering */}
            {(!isCursorLine || !isActive) && (
              <Text wrap="wrap" color={textColor} dimColor={isEmpty && isFirstLine}>
                {displayText}
              </Text>
            )}

            {/* Cursor line with active input - render cursor */}
            {isCursorLine && isActive && (
              <>
                {(() => {
                  // Adjust cursor position for empty lines
                  const adjustedCursorPos = line === '' && displayText === ' ' && cursorPosInLine === 0 ? 0 : cursorPosInLine;

                  const before = displayText.slice(0, adjustedCursorPos);
                  const at = displayText[adjustedCursorPos] || ' ';
                  const after = displayText.slice(adjustedCursorPos + 1);

                  return (
                    <>
                      {/* Text before cursor */}
                      <Text wrap="wrap" color={textColor} dimColor={isEmpty && isFirstLine}>
                        {before}
                      </Text>

                      {/* Cursor (inverse color) */}
                      <Text wrap="wrap" color="black" backgroundColor="white">
                        {at}
                      </Text>

                      {/* Text after cursor */}
                      <Text wrap="wrap" color={textColor} dimColor={isEmpty && isFirstLine}>
                        {after}
                      </Text>
                    </>
                  );
                })()}
              </>
            )}
          </Box>
        );
      })}
    </>
  );

  // Render the input field (bordered or inline)
  const renderInput = () => (
    bordered ? (
      <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} width="100%">
        {renderContent()}
      </Box>
    ) : (
      <Box flexDirection="column" width="100%" marginLeft={1}>
        {renderContent()}
      </Box>
    )
  );

  return (
    <Box flexDirection="column" width="100%">
      {label && <Text color={labelColor}>{label}</Text>}
      {renderInput()}
    </Box>
  );
};
