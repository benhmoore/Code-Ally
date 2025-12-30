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

import React, { useRef, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import stringWidth from 'string-width';
import { detectFilesAndImages } from '@utils/pathUtils.js';
import { useTerminalWidth } from '../hooks/useTerminalWidth.js';

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

  // Get terminal width for proper visual line wrapping
  const terminalWidth = useTerminalWidth();

  // Calculate available content width based on container structure
  // Bordered: border (2) + paddingX (2) = 4 chars overhead, plus prompt on first line
  // Inline: marginLeft (1) = 1 char overhead
  const promptWidth = bordered ? stringWidth(promptText) : 0;
  const containerOverhead = bordered ? 4 : 1;
  const contentWidth = Math.max(10, terminalWidth - containerOverhead);

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
   * Build visual line mapping for cursor navigation
   * Returns an array of visual lines with their character offsets for navigation
   */
  const buildVisualLineMap = (
    text: string,
    width: number,
    firstLineWidth: number
  ): Array<{ charStart: number; charEnd: number; length: number }> => {
    const logicalLines = text.split('\n');
    const visualLineMap: Array<{ charStart: number; charEnd: number; length: number }> = [];
    let globalCharOffset = 0;

    for (let logicalIndex = 0; logicalIndex < logicalLines.length; logicalIndex++) {
      const logicalLine = logicalLines[logicalIndex] || '';
      const lineWidth = logicalIndex === 0 ? firstLineWidth : width;

      if (logicalLine.length === 0) {
        // Empty logical line - still one visual line
        visualLineMap.push({
          charStart: globalCharOffset,
          charEnd: globalCharOffset,
          length: 0,
        });
      } else {
        // Split into visual lines
        const visualLines = splitLineByWidth(logicalLine, lineWidth);
        let charOffset = 0;

        for (const visualLine of visualLines) {
          const visualLineLength = Array.from(visualLine).length;
          visualLineMap.push({
            charStart: globalCharOffset + charOffset,
            charEnd: globalCharOffset + charOffset + visualLineLength,
            length: visualLineLength,
          });
          charOffset += visualLineLength;
        }
      }

      // Account for newline character between logical lines (but not after the last line)
      globalCharOffset += logicalLine.length;
      if (logicalIndex < logicalLines.length - 1) {
        globalCharOffset += 1;
      }
    }

    return visualLineMap;
  };

  /**
   * Navigate cursor up/down within visual lines (handles wrapped text)
   * @param direction -1 for up, 1 for down
   * @returns new cursor position, or null if no movement possible
   */
  const navigateVisualLine = (
    text: string,
    cursor: number,
    direction: -1 | 1,
    width: number,
    firstLineWidth: number
  ): number | null => {
    const visualLineMap = buildVisualLineMap(text, width, firstLineWidth);

    if (visualLineMap.length === 0) return null;

    // Find which visual line the cursor is on
    let currentVisualLine = -1;
    let columnInVisualLine = 0;

    for (let i = 0; i < visualLineMap.length; i++) {
      const vl = visualLineMap[i];
      if (!vl) continue;

      // Cursor is on this visual line if it's within bounds
      // For non-last visual lines, cursor at charEnd means it's at start of next visual line
      const isLastVisualLine = i === visualLineMap.length - 1;
      const isOnThisLine = cursor >= vl.charStart &&
        (isLastVisualLine ? cursor <= vl.charEnd : cursor < vl.charEnd);

      // Special case: cursor exactly at charEnd of a visual line that ends a logical line
      // (i.e., next visual line starts a new logical line with a newline between)
      if (!isOnThisLine && cursor === vl.charEnd) {
        const nextVl = visualLineMap[i + 1];
        // If next visual line starts after a gap (newline), cursor belongs to current line end
        if (nextVl && nextVl.charStart > vl.charEnd) {
          currentVisualLine = i;
          columnInVisualLine = vl.length;
          break;
        }
      }

      if (isOnThisLine) {
        currentVisualLine = i;
        columnInVisualLine = cursor - vl.charStart;
        break;
      }
    }

    if (currentVisualLine < 0) {
      // Cursor position not found - defensive fallback
      currentVisualLine = visualLineMap.length - 1;
      const lastVl = visualLineMap[currentVisualLine];
      columnInVisualLine = lastVl ? lastVl.length : 0;
    }

    // Calculate target visual line
    const targetVisualLine = currentVisualLine + direction;

    // Boundary handling
    if (targetVisualLine < 0) {
      // At first visual line, moving up - go to start
      return 0;
    }
    if (targetVisualLine >= visualLineMap.length) {
      // At last visual line, moving down - go to end
      return text.length;
    }

    // Move to target visual line at same column (clamped to line length)
    const targetVl = visualLineMap[targetVisualLine];
    if (!targetVl) return null;

    const targetColumn = Math.min(columnInVisualLine, targetVl.length);
    return targetVl.charStart + targetColumn;
  };

  /**
   * Split a single line into visual lines based on available width
   * Uses string-width for proper handling of wide characters (CJK, emoji)
   *
   * @param line - The text line to split
   * @param maxWidth - Maximum visual width per line
   * @returns Array of visual line segments
   */
  const splitLineByWidth = (line: string, maxWidth: number): string[] => {
    if (maxWidth <= 0 || line.length === 0) {
      return [line];
    }

    const visualLines: string[] = [];
    let currentLine = '';
    let currentWidth = 0;

    // Use Array.from for proper Unicode grapheme handling
    const chars = Array.from(line);

    for (const char of chars) {
      const charWidth = stringWidth(char);

      if (currentWidth + charWidth > maxWidth && currentLine.length > 0) {
        // Start a new line
        visualLines.push(currentLine);
        currentLine = char;
        currentWidth = charWidth;
      } else {
        currentLine += char;
        currentWidth += charWidth;
      }
    }

    // Push the last line
    if (currentLine.length > 0 || visualLines.length === 0) {
      visualLines.push(currentLine);
    }

    return visualLines;
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

      // ===== Arrow Keys (Up/Down) for visual line navigation =====
      // Navigate between visual lines (wrapped text), not just logical lines
      if (multiline && key.upArrow) {
        const firstLineWidth = bordered ? contentWidth - promptWidth : contentWidth;
        const newPos = navigateVisualLine(currentValue, currentCursor, -1, contentWidth, firstLineWidth);
        if (newPos !== null) {
          onCursorChange(newPos);
        }
        return;
      }

      if (multiline && key.downArrow) {
        const firstLineWidth = bordered ? contentWidth - promptWidth : contentWidth;
        const newPos = navigateVisualLine(currentValue, currentCursor, 1, contentWidth, firstLineWidth);
        if (newPos !== null) {
          onCursorChange(newPos);
        }
        return;
      }

      // ===== Regular Character Input =====
      if (input && !key.ctrl && !key.meta) {
        // Normalize line endings - convert \r\n and \r to \n
        const normalizedInput = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // Detect pasted file paths, images, and directories (multi-character input without newlines)
        if (normalizedInput.length > 1 && !normalizedInput.includes('\n')) {
          const { directories, files, images } = detectFilesAndImages(normalizedInput);
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

        // Calculate new value and cursor position
        const before = currentValue.slice(0, currentCursor);
        const after = currentValue.slice(currentCursor);
        const newValue = before + normalizedInput + after;
        const newCursor = currentCursor + normalizedInput.length;

        // Multiline paste: two-phase render to help ink handle the height change
        // Phase 1 sets minimal content, Phase 2 (next tick) sets actual content
        // This prevents ink's diff algorithm from getting confused by sudden height jumps
        // Both phases update value AND cursor to maintain consistent state
        if (normalizedInput.includes('\n')) {
          onValueChange(' ');
          onCursorChange(1); // Consistent cursor for Phase 1 (at end of single space)
          setImmediate(() => {
            // Verify state hasn't changed since Phase 1 before applying Phase 2
            // If user typed between phases, valueRef/cursorRef will differ from Phase 1
            if (valueRef.current === ' ' && cursorRef.current === 1) {
              onValueChange(newValue);
              onCursorChange(newCursor);
            }
          });
          return;
        }

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

  const isEmpty = value.trim().length === 0;

  // Calculate cursor position in logical lines
  const cursorInfo = getCursorLineInfo(value, cursorPosition);
  const cursorLogicalLine = cursorInfo.line;
  const cursorPosInLogicalLine = cursorInfo.posInLine;

  // Build visual lines with cursor tracking
  // Each visual line entry tracks: text, whether it has cursor, cursor position within it
  const visualLinesData = useMemo(() => {
    const logicalLines = displayValue.split('\n');
    const result: Array<{
      text: string;
      isFirstLogicalLine: boolean;
      hasCursor: boolean;
      cursorPos: number; // position within this visual line's text
      isPlaceholder: boolean;
    }> = [];

    let globalVisualLineIndex = 0;

    for (let logicalIndex = 0; logicalIndex < logicalLines.length; logicalIndex++) {
      const logicalLine = logicalLines[logicalIndex] || '';
      const isFirstLogicalLine = logicalIndex === 0;
      const isCursorLogicalLine = logicalIndex === cursorLogicalLine;

      // Calculate available width for this line (first line has prompt overhead)
      const lineWidth = isFirstLogicalLine && bordered
        ? contentWidth - promptWidth
        : contentWidth;

      // Handle empty logical lines
      if (logicalLine.length === 0) {
        const isPlaceholder = isEmpty && isFirstLogicalLine;
        const displayText = isPlaceholder ? placeholder : ' ';

        result.push({
          text: displayText,
          isFirstLogicalLine,
          hasCursor: isCursorLogicalLine && isActive,
          cursorPos: 0, // cursor at start of empty line
          isPlaceholder,
        });
        globalVisualLineIndex++;
        continue;
      }

      // Split logical line into visual lines based on width
      const visualLines = splitLineByWidth(logicalLine, lineWidth);

      // Find which visual line has the cursor (if this is the cursor's logical line)
      let cursorVisualLineOffset = -1;
      let cursorPosInVisualLine = 0;

      if (isCursorLogicalLine) {
        // Walk through characters to find cursor position in visual lines
        let charIndex = 0;
        let visualLineOffset = 0;

        for (let vl = 0; vl < visualLines.length; vl++) {
          const visualLineText = visualLines[vl] || '';
          const visualLineChars = Array.from(visualLineText);

          for (let c = 0; c < visualLineChars.length; c++) {
            if (charIndex === cursorPosInLogicalLine) {
              cursorVisualLineOffset = visualLineOffset;
              cursorPosInVisualLine = c;
              break;
            }
            charIndex++;
          }

          if (cursorVisualLineOffset >= 0) break;

          // Check if cursor is at end of this visual line
          if (charIndex === cursorPosInLogicalLine) {
            cursorVisualLineOffset = visualLineOffset;
            cursorPosInVisualLine = visualLineChars.length;
            break;
          }

          visualLineOffset++;
        }

        // If cursor wasn't found, it's at the very end
        if (cursorVisualLineOffset < 0) {
          cursorVisualLineOffset = visualLines.length - 1;
          const lastLine = visualLines[cursorVisualLineOffset] || '';
          cursorPosInVisualLine = Array.from(lastLine).length;
        }
      }

      // Add visual lines to result
      for (let vl = 0; vl < visualLines.length; vl++) {
        const visualLineText = visualLines[vl] || '';
        const hasCursor = isCursorLogicalLine && vl === cursorVisualLineOffset && isActive;

        result.push({
          text: visualLineText,
          isFirstLogicalLine: isFirstLogicalLine && vl === 0,
          hasCursor,
          cursorPos: hasCursor ? cursorPosInVisualLine : 0,
          isPlaceholder: false,
        });
        globalVisualLineIndex++;
      }
    }

    return result;
  // Note: splitLineByWidth is a stable function (no external deps), so not included in deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayValue, cursorLogicalLine, cursorPosInLogicalLine, contentWidth, promptWidth, bordered, isEmpty, placeholder, isActive]);

  // Render the text content with proper visual line handling
  const renderContent = () => (
    <>
      {visualLinesData.map((visualLine, index) => {
        const { text, isFirstLogicalLine, hasCursor, cursorPos, isPlaceholder } = visualLine;
        const prompt = bordered && isFirstLogicalLine ? promptText : '';
        const textColor = isPlaceholder ? 'gray' : 'white';

        return (
          <Box key={`vline-${index}`}>
            {/* Prompt prefix - only show on first visual line when bordered */}
            {bordered && isFirstLogicalLine && (
              <Text color="gray">
                {prompt}
              </Text>
            )}

            {/* Non-cursor line - simple rendering */}
            {!hasCursor && (
              <Text color={textColor} dimColor={isPlaceholder}>
                {text}
              </Text>
            )}

            {/* Cursor line - render with cursor highlight */}
            {hasCursor && (
              <>
                {(() => {
                  // Use Array.from for proper Unicode handling
                  const chars = Array.from(text);
                  const before = chars.slice(0, cursorPos).join('');
                  const at = chars[cursorPos] || ' ';
                  const after = chars.slice(cursorPos + 1).join('');

                  return (
                    <>
                      {/* Text before cursor */}
                      {before && (
                        <Text color={textColor} dimColor={isPlaceholder}>
                          {before}
                        </Text>
                      )}

                      {/* Cursor (inverse color) */}
                      <Text color="black" backgroundColor="white">
                        {at}
                      </Text>

                      {/* Text after cursor */}
                      {after && (
                        <Text color={textColor} dimColor={isPlaceholder}>
                          {after}
                        </Text>
                      )}
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
