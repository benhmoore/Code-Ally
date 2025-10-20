/**
 * InputPrompt Component - Enhanced with history and completion
 *
 * Features:
 * - Command history (up/down arrows)
 * - Tab completion
 * - Advanced editing shortcuts
 * - Multiline support
 * - Context-aware completions
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp, useFocus } from 'ink';
import { CommandHistory } from '../../services/CommandHistory.js';
import { CompletionProvider, Completion } from '../../services/CompletionProvider.js';
import { CompletionDropdown } from './CompletionDropdown.js';
import { PermissionRequest } from './PermissionPrompt.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ActivityEventType } from '../../types/index.js';
import { PermissionChoice } from '../../agent/TrustManager.js';
import { Agent } from '../../agent/Agent.js';

interface InputPromptProps {
  /** Callback when user submits input */
  onSubmit: (input: string) => void;
  /** Whether input is currently active/enabled */
  isActive?: boolean;
  /** Placeholder text to show when empty */
  placeholder?: string;
  /** Command history instance */
  commandHistory?: CommandHistory;
  /** Completion provider instance */
  completionProvider?: CompletionProvider;
  /** Permission prompt data (if active) */
  permissionRequest?: PermissionRequest & { requestId: string };
  /** Selected permission option index */
  permissionSelectedIndex?: number;
  /** Callback when permission selection changes */
  onPermissionNavigate?: (newIndex: number) => void;
  /** Activity stream for emitting events */
  activityStream?: ActivityStream;
  /** Agent instance for interruption */
  agent?: Agent;
}

/**
 * Enhanced InputPrompt Component
 */
export const InputPrompt: React.FC<InputPromptProps> = ({
  onSubmit,
  isActive = true,
  placeholder = 'Type a message...',
  commandHistory,
  completionProvider,
  permissionRequest,
  permissionSelectedIndex = 0,
  onPermissionNavigate,
  activityStream,
  agent,
}) => {
  const { exit } = useApp();
  const { isFocused } = useFocus({ autoFocus: true });
  const [buffer, setBuffer] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);

  // Use ref to track current buffer for Ctrl+C handler (avoids stale closure)
  const bufferRef = useRef(buffer);
  useEffect(() => {
    bufferRef.current = buffer;
  }, [buffer]);

  // History navigation state
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyBuffer, setHistoryBuffer] = useState(''); // Store current input when navigating history
  const isNavigatingHistory = useRef(false); // Track if buffer change is from history navigation

  // Completion state
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [showCompletions, setShowCompletions] = useState(false);

  // Debounce timer for completions
  const [completionTimer, setCompletionTimer] = useState<NodeJS.Timeout | null>(null);


  /**
   * Update completions based on current input
   */
  const updateCompletions = async () => {
    if (!completionProvider || !buffer.trim()) {
      setCompletions([]);
      setShowCompletions(false);
      return;
    }

    const results = await completionProvider.getCompletions(buffer, cursorPosition);
    setCompletions(results);
    setCompletionIndex(0);
    setShowCompletions(results.length > 0);
  };

  /**
   * Debounced completion update
   */
  useEffect(() => {
    // Skip completion updates when navigating history
    if (isNavigatingHistory.current) {
      isNavigatingHistory.current = false; // Reset flag
      return;
    }

    if (completionTimer) {
      clearTimeout(completionTimer);
    }

    const timer = setTimeout(() => {
      updateCompletions();
    }, 150);

    setCompletionTimer(timer);

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [buffer, cursorPosition]);

  /**
   * Apply selected completion
   */
  const applyCompletion = () => {
    if (!showCompletions || completions.length === 0 || !completions[completionIndex]) {
      return;
    }

    const completion = completions[completionIndex];
    const insertText = completion.insertText || completion.value;

    // Find word boundaries
    let wordStart = cursorPosition;
    while (wordStart > 0) {
      const char = buffer[wordStart - 1];
      if (!char || /\s/.test(char)) break;
      wordStart--;
    }

    let wordEnd = cursorPosition;
    while (wordEnd < buffer.length) {
      const char = buffer[wordEnd];
      if (!char || /\s/.test(char)) break;
      wordEnd++;
    }

    // Replace current word with completion
    const before = buffer.slice(0, wordStart);
    const after = buffer.slice(wordEnd);
    const newBuffer = before + insertText + after;
    const newCursor = wordStart + insertText.length;

    setBuffer(newBuffer);
    setCursorPosition(newCursor);
    setShowCompletions(false);
    setCompletions([]);
  };

  /**
   * Navigate history backward (older)
   */
  const navigateHistoryPrevious = () => {
    if (!commandHistory) return;

    // First time navigating - save current buffer
    if (historyIndex === -1) {
      setHistoryBuffer(buffer);
    }

    const result = commandHistory.getPrevious(historyIndex);
    if (result) {
      isNavigatingHistory.current = true; // Prevent completion updates
      setBuffer(result.command);
      setCursorPosition(result.command.length);
      setHistoryIndex(result.index);
      setShowCompletions(false);
    }
  };

  /**
   * Navigate history forward (newer)
   */
  const navigateHistoryNext = () => {
    if (!commandHistory || historyIndex === -1) return;

    const result = commandHistory.getNext(historyIndex);
    if (result) {
      isNavigatingHistory.current = true; // Prevent completion updates
      setBuffer(result.command);
      setCursorPosition(result.command.length);
      setHistoryIndex(result.index);
    } else {
      // Reached end - restore original buffer
      isNavigatingHistory.current = true; // Prevent completion updates
      setBuffer(historyBuffer);
      setCursorPosition(historyBuffer.length);
      setHistoryIndex(-1);
    }
    setShowCompletions(false);
  };

  /**
   * Submit input
   */
  const handleSubmit = async () => {
    const trimmed = buffer.trim();
    if (!trimmed) return;

    // Add to history and save
    if (commandHistory) {
      commandHistory.addCommand(trimmed);
      // Save history to disk for persistence across restarts
      try {
        await commandHistory.save();
      } catch (error) {
        console.error('Failed to save command history:', error);
      }
    }

    // Reset state
    setBuffer('');
    setCursorPosition(0);
    setHistoryIndex(-1);
    setHistoryBuffer('');
    setShowCompletions(false);
    setCompletions([]);

    // Call callback
    onSubmit(trimmed);
  };

  /**
   * Delete word backward (Ctrl+W)
   */
  const deleteWordBackward = () => {
    if (cursorPosition === 0) return;

    // Find start of word
    let pos = cursorPosition - 1;

    // Skip whitespace
    while (pos > 0) {
      const char = buffer[pos];
      if (!char || !/\s/.test(char)) break;
      pos--;
    }

    // Delete word
    while (pos > 0) {
      const char = buffer[pos];
      if (!char || /\s/.test(char)) break;
      pos--;
    }

    if (pos > 0) pos++; // Don't delete the space before word

    const before = buffer.slice(0, pos);
    const after = buffer.slice(cursorPosition);
    setBuffer(before + after);
    setCursorPosition(pos);
  };

  /**
   * Move cursor by word
   */
  const moveCursorWordLeft = () => {
    let pos = cursorPosition - 1;

    // Skip whitespace
    while (pos > 0) {
      const char = buffer[pos];
      if (!char || !/\s/.test(char)) break;
      pos--;
    }

    // Move to start of word
    while (pos > 0) {
      const char = buffer[pos];
      if (!char || /\s/.test(char)) break;
      pos--;
    }

    if (pos > 0) pos++; // Position at start of word

    setCursorPosition(Math.max(0, pos));
  };

  const moveCursorWordRight = () => {
    let pos = cursorPosition;

    // Skip current word
    while (pos < buffer.length) {
      const char = buffer[pos];
      if (!char || /\s/.test(char)) break;
      pos++;
    }

    // Skip whitespace
    while (pos < buffer.length) {
      const char = buffer[pos];
      if (!char || !/\s/.test(char)) break;
      pos++;
    }

    setCursorPosition(pos);
  };

  // Handle keyboard input
  // Use both isActive prop and isFocused from useFocus hook
  useInput(
    (input, key) => {
      if (!isActive || !isFocused) return;

      // ===== Permission Prompt Navigation (highest priority) =====
      if (permissionRequest && onPermissionNavigate && activityStream) {
        const optionsCount = permissionRequest.options.length;

        // Up arrow - navigate to previous option
        if (key.upArrow) {
          const newIndex = Math.max(0, permissionSelectedIndex - 1);
          onPermissionNavigate(newIndex);
          return;
        }

        // Down arrow - navigate to next option
        if (key.downArrow) {
          const newIndex = Math.min(optionsCount - 1, permissionSelectedIndex + 1);
          onPermissionNavigate(newIndex);
          return;
        }

        // Enter - submit selection
        if (key.return) {
          const selectedChoice = permissionRequest.options[permissionSelectedIndex];
          if (selectedChoice) {
            // Emit permission response event
            activityStream.emit({
              id: `response_${permissionRequest.requestId}`,
              type: ActivityEventType.PERMISSION_RESPONSE,
              timestamp: Date.now(),
              data: {
                requestId: permissionRequest.requestId,
                choice: selectedChoice,
              },
            });
          }
          return;
        }

        // Ctrl+C - deny permission and cancel
        if (key.ctrl && input === 'c') {
          activityStream.emit({
            id: `response_${permissionRequest.requestId}_cancel`,
            type: ActivityEventType.PERMISSION_RESPONSE,
            timestamp: Date.now(),
            data: {
              requestId: permissionRequest.requestId,
              choice: PermissionChoice.DENY,
            },
          });
          return;
        }

        // Block all other input when permission prompt is active
        return;
      }

      // ===== History Navigation =====
      if (key.upArrow && !showCompletions) {
        // If not at beginning, move cursor to beginning first
        if (cursorPosition > 0) {
          setCursorPosition(0);
        } else {
          // Already at beginning, navigate to previous history
          navigateHistoryPrevious();
        }
        return;
      }

      if (key.downArrow && !showCompletions) {
        // If not at end, move cursor to end first
        if (cursorPosition < buffer.length) {
          setCursorPosition(buffer.length);
        } else {
          // Already at end, navigate to next history
          navigateHistoryNext();
        }
        return;
      }

      // ===== Completion Navigation =====
      if (key.upArrow && showCompletions) {
        setCompletionIndex(Math.max(0, completionIndex - 1));
        return;
      }

      if (key.downArrow && showCompletions) {
        setCompletionIndex(Math.min(completions.length - 1, completionIndex + 1));
        return;
      }

      // ===== Tab Completion =====
      if (key.tab) {
        if (showCompletions && completions.length > 0) {
          applyCompletion();
        } else {
          // Trigger completions
          updateCompletions();
        }
        return;
      }

      // ===== Escape - Dismiss Completions =====
      if (key.escape) {
        if (showCompletions) {
          setShowCompletions(false);
          setCompletions([]);
        }
        return;
      }

      // ===== Submit =====
      if (key.return) {
        if (key.ctrl) {
          // Ctrl+Enter - Insert newline
          const before = buffer.slice(0, cursorPosition);
          const after = buffer.slice(cursorPosition);
          setBuffer(before + '\n' + after);
          setCursorPosition(cursorPosition + 1);
        } else {
          handleSubmit();
        }
        return;
      }

      // ===== Clear Buffer / Quit / Interrupt (Ctrl+C) =====
      // Matches Python behavior: interrupt -> clear -> quit
      // Use ref to avoid stale closure issues
      if (key.ctrl && input === 'c') {
        // Priority 1: Interrupt ALL ongoing operations (main agent + subagents + tools)
        if (agent && agent.isProcessing()) {
          console.log('[INPUT] Ctrl+C - interrupting main agent');
          agent.interrupt();

          // Also interrupt all subagents through AgentTool
          if (activityStream) {
            activityStream.emit({
              id: `interrupt-${Date.now()}`,
              type: ActivityEventType.INTERRUPT_ALL,
              timestamp: Date.now(),
              data: {},
            });
          }
          return;
        }

        const currentBuffer = bufferRef.current;
        const hasContent = currentBuffer.trim().length > 0;

        // Priority 2: Clear buffer if it has content
        if (hasContent) {
          setBuffer('');
          setCursorPosition(0);
          setHistoryIndex(-1);
          setShowCompletions(false);
          return;
        }

        // Priority 3: Buffer is empty - quit immediately
        exit();
        return;
      }

      // ===== Move to Start (Ctrl+A) =====
      if (key.ctrl && input === 'a') {
        setCursorPosition(0);
        return;
      }

      // ===== Move to End (Ctrl+E) =====
      if (key.ctrl && input === 'e') {
        setCursorPosition(buffer.length);
        return;
      }

      // ===== Kill Line (Ctrl+K) =====
      if (key.ctrl && input === 'k') {
        const before = buffer.slice(0, cursorPosition);
        setBuffer(before);
        return;
      }

      // ===== Delete to Start (Ctrl+U) =====
      if (key.ctrl && input === 'u') {
        const after = buffer.slice(cursorPosition);
        setBuffer(after);
        setCursorPosition(0);
        return;
      }

      // ===== Delete Word Backward (Ctrl+W) =====
      // Note: Also available via Alt+Backspace or Ctrl+Backspace
      if (key.ctrl && input === 'w') {
        deleteWordBackward();
        return;
      }

      // ===== Word Movement (Alt+Left/Right and Ctrl+Left/Right) =====
      // Note: Ink has issues with Option/Alt keys on macOS - use Ctrl as fallback
      if ((key.meta || key.ctrl) && key.leftArrow) {
        moveCursorWordLeft();
        return;
      }

      if ((key.meta || key.ctrl) && key.rightArrow) {
        moveCursorWordRight();
        return;
      }

      // ===== Delete Word Backward (Ctrl+Backspace OR Alt+Backspace) =====
      // Note: Alt+Backspace sends ESC+DEL (\x1b\x7f) which Ink parses as key.meta=true, key.delete=true
      if ((key.ctrl || key.meta) && (key.backspace || key.delete)) {
        deleteWordBackward();
        return;
      }

      // ===== Backspace =====
      if (key.backspace || key.delete) {
        // Regular backspace - delete single character
        if (cursorPosition > 0) {
          const before = buffer.slice(0, cursorPosition - 1);
          const after = buffer.slice(cursorPosition);
          setBuffer(before + after);
          setCursorPosition(cursorPosition - 1);
          setHistoryIndex(-1); // Reset history when editing
        }
        return;
      }

      // ===== Left Arrow =====
      if (key.leftArrow) {
        setCursorPosition(Math.max(0, cursorPosition - 1));
        return;
      }

      // ===== Right Arrow =====
      if (key.rightArrow) {
        setCursorPosition(Math.min(buffer.length, cursorPosition + 1));
        return;
      }

      // ===== Regular Character Input =====
      if (input && !key.ctrl && !key.meta) {
        const before = buffer.slice(0, cursorPosition);
        const after = buffer.slice(cursorPosition);
        setBuffer(before + input + after);
        setCursorPosition(cursorPosition + 1);
        setHistoryIndex(-1); // Reset history when typing
      }
    },
    { isActive: isActive && isFocused }
  );

  // Split buffer into lines for multiline display
  const lines = buffer.split('\n');
  const isEmpty = buffer.trim().length === 0;

  // Calculate which line the cursor is on and position within that line
  let cursorLine = 0;
  let cursorPosInLine = cursorPosition;
  let charCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const lineLength = line.length;
    if (charCount + lineLength >= cursorPosition) {
      cursorLine = i;
      cursorPosInLine = cursorPosition - charCount;
      break;
    }
    charCount += lineLength + 1; // +1 for newline character
  }

  // Determine prompt style based on first character (command mode)
  const isCommandMode = buffer.startsWith('/');
  const isBashMode = buffer.startsWith('!');
  const isAgentMode = buffer.startsWith('@');

  let promptText = '> ';
  let promptColor = 'white';

  if (isCommandMode) {
    promptText = 'Command > ';
    promptColor = 'yellow';
  } else if (isBashMode) {
    promptText = 'Bash > ';
    promptColor = 'green';
  } else if (isAgentMode) {
    promptText = 'Agent > ';
    promptColor = 'magenta';
  }

  return (
    <Box flexDirection="column" width="100%">
      {/* Input area */}
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={promptColor}
        paddingX={1}
        width="100%"
      >
        {lines.map((line, index) => {
          const isFirstLine = index === 0;
          const prompt = isFirstLine ? promptText : '... ';
          const displayText = line || (isEmpty && isFirstLine ? placeholder : '');
          const textColor = isEmpty && isFirstLine ? 'gray' : 'white';
          const isCursorLine = index === cursorLine;

          // Split line into before cursor, at cursor, and after cursor
          let beforeCursor = '';
          let atCursor = ' ';
          let afterCursor = '';

          if (isCursorLine && displayText) {
            beforeCursor = displayText.slice(0, cursorPosInLine);
            atCursor = displayText[cursorPosInLine] || ' ';
            afterCursor = displayText.slice(cursorPosInLine + 1);
          } else if (isCursorLine) {
            // Empty line with cursor
            atCursor = ' ';
          }

          return (
            <Box key={`line-${index}`}>
              <Text color={promptColor} bold={isCommandMode || isBashMode || isAgentMode}>
                {prompt}
              </Text>
              {!isCursorLine && (
                <Text color={textColor} dimColor={isEmpty && isFirstLine}>
                  {displayText}
                </Text>
              )}
              {isCursorLine && isActive && (
                <>
                  <Text color={textColor} dimColor={isEmpty && isFirstLine}>
                    {beforeCursor}
                  </Text>
                  <Text color="black" backgroundColor="white">
                    {atCursor}
                  </Text>
                  <Text color={textColor} dimColor={isEmpty && isFirstLine}>
                    {afterCursor}
                  </Text>
                </>
              )}
              {isCursorLine && !isActive && (
                <Text color={textColor} dimColor={isEmpty && isFirstLine}>
                  {displayText}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Completion dropdown */}
      {showCompletions && (
        <CompletionDropdown
          completions={completions}
          selectedIndex={completionIndex}
          visible={showCompletions}
        />
      )}
    </Box>
  );
};
