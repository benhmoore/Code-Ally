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
import { Box, Text, useInput, useApp } from 'ink';
import { CommandHistory } from '@services/CommandHistory.js';
import { CompletionProvider, Completion } from '@services/CompletionProvider.js';
import { CompletionDropdown } from './CompletionDropdown.js';
import { PermissionRequest } from './PermissionPrompt.js';
import { ModelOption } from './ModelSelector.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ActivityEventType } from '@shared/index.js';
import { logger } from '@services/Logger.js';
import { PermissionChoice } from '@agent/TrustManager.js';
import { Agent } from '@agent/Agent.js';
import { UI_DELAYS } from '@config/constants.js';
import { UI_COLORS } from '../constants/colors.js';

interface InputPromptProps {
  /** Callback when user submits input */
  onSubmit: (input: string, mentions?: { files?: string[] }) => void;
  /** Callback when user interjections (submits mid-response) */
  onInterjection?: (message: string) => void;
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
  /** Model selector data (if active) */
  modelSelectRequest?: { requestId: string; models: ModelOption[]; currentModel?: string; modelType?: 'ally' | 'service'; typeName?: string };
  /** Selected model index */
  modelSelectedIndex?: number;
  /** Callback when model selection changes */
  onModelNavigate?: (newIndex: number) => void;
  /** Whether config viewer is open */
  configViewerOpen?: boolean;
  /** Session selector data (if active) */
  sessionSelectRequest?: { requestId: string; sessions: import('@shared/index.js').SessionInfo[]; selectedIndex: number };
  /** Callback when session selection changes */
  onSessionNavigate?: (newIndex: number) => void;
  /** Rewind selector data (if active) */
  rewindRequest?: { requestId: string; userMessagesCount: number; selectedIndex: number };
  /** Callback when rewind selection changes */
  onRewindNavigate?: (newIndex: number) => void;
  /** Callback when rewind Enter pressed (to show options) */
  onRewindEnter?: (selectedIndex: number) => void;
  /** Undo prompt data (if active) */
  undoRequest?: { requestId: string; count: number; patches: any[]; previewData: any[] };
  /** Selected undo option index */
  undoSelectedIndex?: number;
  /** Callback when undo selection changes */
  onUndoNavigate?: (newIndex: number) => void;
  /** Undo file list (two-stage flow) */
  undoFileListRequest?: { requestId: string; fileList: any[]; selectedIndex: number };
  /** Callback when undo file list selection changes */
  onUndoFileListNavigate?: (newIndex: number) => void;
  /** Activity stream for emitting events */
  activityStream?: ActivityStream;
  /** Agent instance for interruption */
  agent?: Agent;
  /** Text to pre-fill the input buffer (e.g., after rewind) */
  prefillText?: string;
  /** Callback when prefill is consumed */
  onPrefillConsumed?: () => void;
  /** Callback when exit confirmation state changes */
  onExitConfirmationChange?: (isWaitingForConfirmation: boolean) => void;
  /** External buffer value (for preserving across renders) */
  bufferValue?: string;
  /** Callback when buffer changes */
  onBufferChange?: (value: string) => void;
}

/**
 * Enhanced InputPrompt Component
 */
export const InputPrompt: React.FC<InputPromptProps> = ({
  onSubmit,
  onInterjection,
  isActive = true,
  placeholder = 'Type a message...',
  commandHistory,
  completionProvider,
  permissionRequest,
  permissionSelectedIndex = 0,
  onPermissionNavigate,
  modelSelectRequest,
  modelSelectedIndex = 0,
  onModelNavigate,
  sessionSelectRequest,
  onSessionNavigate,
  configViewerOpen = false,
  rewindRequest,
  onRewindNavigate,
  onRewindEnter,
  undoRequest,
  undoSelectedIndex = 0,
  onUndoNavigate,
  undoFileListRequest,
  onUndoFileListNavigate,
  activityStream,
  agent,
  prefillText,
  onPrefillConsumed,
  onExitConfirmationChange,
  bufferValue,
  onBufferChange,
}) => {
  const { exit } = useApp();
  const [buffer, setBuffer] = useState(bufferValue || '');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [mentionedFiles, setMentionedFiles] = useState<string[]>([]);
  const [mentionedPlugins, setMentionedPlugins] = useState<string[]>([]);

  // Handle prefill text
  useEffect(() => {
    if (prefillText !== undefined && prefillText !== '') {
      setBuffer(prefillText);
      setCursorPosition(prefillText.length);
      onPrefillConsumed?.();
    }
  }, [prefillText, onPrefillConsumed]);

  // Use refs to track current buffer and cursor position (avoids stale closure issues with paste)
  const bufferRef = useRef(buffer);
  const cursorPositionRef = useRef(cursorPosition);
  useEffect(() => {
    bufferRef.current = buffer;
  }, [buffer]);
  useEffect(() => {
    cursorPositionRef.current = cursorPosition;
  }, [cursorPosition]);

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

  // Force-quit mechanism (3x Ctrl+C within 2s)
  const [ctrlCCount, setCtrlCCount] = useState(0);
  const ctrlCTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Double-escape mechanism for rewind (2x Esc within 500ms)
  const [escCount, setEscCount] = useState(0);
  const escTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Exit confirmation mechanism (Ctrl+C on empty buffer - 1s to confirm)
  const [isWaitingForExitConfirmation, setIsWaitingForExitConfirmation] = useState(false);
  const exitConfirmationTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Track last cancelled request IDs to prevent duplicates
  const lastCancelledIdRef = useRef<string | null>(null);

  // Prevent re-entry during escape key processing
  const processingEscapeRef = useRef(false);

  // Notify parent when exit confirmation state changes
  useEffect(() => {
    onExitConfirmationChange?.(isWaitingForExitConfirmation);
  }, [isWaitingForExitConfirmation, onExitConfirmationChange]);

  // Sync with external buffer value (when parent changes it)
  useEffect(() => {
    if (bufferValue !== undefined && bufferValue !== buffer) {
      setBuffer(bufferValue);
      setCursorPosition(bufferValue.length);
    }
  }, [bufferValue]);

  // Notify parent when buffer changes
  useEffect(() => {
    onBufferChange?.(buffer);
  }, [buffer, onBufferChange]);

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
    }, UI_DELAYS.COMPLETION_DEBOUNCE);

    setCompletionTimer(timer);

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [buffer, cursorPosition]);

  /**
   * Calculate cursor line and position within that line
   */
  const getCursorLineInfo = (text: string, cursorPos: number): { line: number; posInLine: number; charsBeforeLine: number } => {
    // Clamp cursor position to valid range
    const clampedPos = Math.max(0, Math.min(cursorPos, text.length));
    const lines = text.split('\n');
    let charCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLength = (lines[i] || '').length;
      // Check if cursor is on this line (including end of line position)
      if (charCount + lineLength >= clampedPos) {
        return {
          line: i,
          posInLine: Math.min(clampedPos - charCount, lineLength),
          charsBeforeLine: charCount,
        };
      }
      charCount += lineLength + 1; // +1 for newline
    }

    // Cursor is beyond buffer (shouldn't happen, but handle defensively)
    // Place it at end of last line
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

    // For file completions, preserve directory prefix by breaking at path separators
    if (completion.type === 'file') {
      while (wordStart > 0) {
        const char = buffer[wordStart - 1];
        // Break at whitespace OR path separator
        if (!char || /[\s/]/.test(char)) break;
        wordStart--;
      }
    } else {
      // For non-file completions, use standard word boundaries (whitespace only)
      while (wordStart > 0) {
        const char = buffer[wordStart - 1];
        if (!char || /\s/.test(char)) break;
        wordStart--;
      }
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

    // Track file mentions (avoid duplicates)
    if (completion.type === 'file' && !mentionedFiles.includes(insertText)) {
      setMentionedFiles([...mentionedFiles, insertText]);
    }

    // Track plugin mentions (avoid duplicates) - plugin names include the +/- prefix in insertText
    if (completion.type === 'plugin' && !mentionedPlugins.includes(insertText)) {
      setMentionedPlugins([...mentionedPlugins, insertText]);
    }
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

    // Call callback with mentions if any
    onSubmit(trimmed, mentionedFiles.length > 0 ? { files: mentionedFiles } : undefined);

    // Reset state
    setBuffer('');
    setCursorPosition(0);
    setHistoryIndex(-1);
    setHistoryBuffer('');
    setShowCompletions(false);
    setCompletions([]);
    setMentionedFiles([]);
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
  useInput(
    (input, key) => {
      if (!isActive) return;

      // ===== Force Quit (3x Ctrl+C within 2s) - Highest Priority =====
      if (key.ctrl && input === 'c') {
        const newCount = ctrlCCount + 1;
        setCtrlCCount(newCount);

        // Reset counter after configured delay
        if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
        ctrlCTimerRef.current = setTimeout(() => setCtrlCCount(0), UI_DELAYS.CTRL_C_RESET);

        // Force quit on 3rd press
        if (newCount >= 3) {
          logger.debug('[InputPrompt] Force quit - 3x Ctrl+C');
          exit();
          return;
        }
      }

      // ===== Config Viewer (second priority after force-quit) =====
      if (configViewerOpen && activityStream) {
        // Escape or Ctrl+C - close config viewer
        if (key.escape || (key.ctrl && input === 'c')) {
          try {
            activityStream.emit({
              id: `config_view_toggle_${Date.now()}`,
              type: ActivityEventType.CONFIG_VIEW_REQUEST,
              timestamp: Date.now(),
              data: {},
            });
          } catch (error) {
            console.error('[InputPrompt] Failed to emit config view toggle:', error);
          }
          return;
        }
        // Don't consume other keys - let user interact normally
      }

      // ===== Model Selector Navigation (third priority after force-quit and config viewer) =====
      if (modelSelectRequest && onModelNavigate && activityStream) {
        const modelsCount = modelSelectRequest.models.length;

        // Up arrow - navigate to previous model
        if (key.upArrow) {
          const newIndex = Math.max(0, modelSelectedIndex - 1);
          onModelNavigate(newIndex);
          return;
        }

        // Down arrow - navigate to next model
        if (key.downArrow) {
          const newIndex = Math.min(modelsCount - 1, modelSelectedIndex + 1);
          onModelNavigate(newIndex);
          return;
        }

        // Enter - submit selection
        if (key.return) {
          const selectedModel = modelSelectRequest.models[modelSelectedIndex];
          if (selectedModel) {
            try {
              activityStream.emit({
                id: `response_${modelSelectRequest.requestId}`,
                type: ActivityEventType.MODEL_SELECT_RESPONSE,
                timestamp: Date.now(),
                data: {
                  requestId: modelSelectRequest.requestId,
                  modelName: selectedModel.name,
                  modelType: modelSelectRequest.modelType, // Pass through model type
                },
              });
            } catch (error) {
              console.error('[InputPrompt] Failed to emit model selection:', error);
            }
          }
          return;
        }

        // Escape or Ctrl+C - cancel selection
        if (key.escape || (key.ctrl && input === 'c')) {
          // Prevent duplicate cancellations for same request
          if (lastCancelledIdRef.current === modelSelectRequest.requestId) return;
          lastCancelledIdRef.current = modelSelectRequest.requestId;

          try {
            activityStream.emit({
              id: `response_${modelSelectRequest.requestId}_cancel`,
              type: ActivityEventType.MODEL_SELECT_RESPONSE,
              timestamp: Date.now(),
              data: {
                requestId: modelSelectRequest.requestId,
                modelName: null, // null = cancelled
                modelType: modelSelectRequest.modelType, // Pass through model type
              },
            });
          } catch (error) {
            console.error('[InputPrompt] Failed to emit model cancellation:', error);
          }
          return;
        }

        // Block all other input when model selector is active
        return;
      }

      // ===== Session Selector Navigation =====
      if (sessionSelectRequest && onSessionNavigate && activityStream) {
        const sessionsCount = sessionSelectRequest.sessions.length;
        const currentIndex = sessionSelectRequest.selectedIndex;

        // Up arrow - navigate to previous session
        if (key.upArrow) {
          const newIndex = Math.max(0, currentIndex - 1);
          onSessionNavigate(newIndex);
          return;
        }

        // Down arrow - navigate to next session
        if (key.downArrow) {
          const newIndex = Math.min(sessionsCount - 1, currentIndex + 1);
          onSessionNavigate(newIndex);
          return;
        }

        // Enter - submit selection (load session)
        if (key.return) {
          try {
            const selectedSession = sessionSelectRequest.sessions[currentIndex];
            if (selectedSession) {
              activityStream.emit({
                id: `response_${sessionSelectRequest.requestId}`,
                type: ActivityEventType.SESSION_SELECT_RESPONSE,
                timestamp: Date.now(),
                data: {
                  requestId: sessionSelectRequest.requestId,
                  sessionId: selectedSession.session_id,
                  cancelled: false,
                },
              });
            }
          } catch (error) {
            console.error('[InputPrompt] Failed to emit session selection:', error);
          }
          return;
        }

        // Escape or Ctrl+C - cancel session selection
        if (key.escape || (input === 'c' && key.ctrl)) {
          // Prevent duplicate cancellation
          if (lastCancelledIdRef.current === sessionSelectRequest.requestId) return;
          lastCancelledIdRef.current = sessionSelectRequest.requestId;

          try {
            activityStream.emit({
              id: `response_${sessionSelectRequest.requestId}_cancel`,
              type: ActivityEventType.SESSION_SELECT_RESPONSE,
              timestamp: Date.now(),
              data: {
                requestId: sessionSelectRequest.requestId,
                sessionId: null,
                cancelled: true,
              },
            });
          } catch (error) {
            console.error('[InputPrompt] Failed to emit session cancellation:', error);
          }
          return;
        }

        // Block all other input when session selector is active
        return;
      }

      // ===== Rewind Selector Navigation =====
      if (rewindRequest && onRewindNavigate) {
        const messagesCount = rewindRequest.userMessagesCount;
        const currentIndex = rewindRequest.selectedIndex;

        // Up arrow - navigate to previous message (older)
        if (key.upArrow) {
          const newIndex = Math.max(0, currentIndex - 1);
          onRewindNavigate(newIndex);
          return;
        }

        // Down arrow - navigate to next message (newer)
        if (key.downArrow) {
          const newIndex = Math.min(messagesCount - 1, currentIndex + 1);
          onRewindNavigate(newIndex);
          return;
        }

        // Enter - show options modal (don't submit yet)
        if (key.return) {
          if (onRewindEnter) {
            onRewindEnter(currentIndex);
          }
          return;
        }

        // Escape or Ctrl+C - cancel rewind
        if (key.escape || (key.ctrl && input === 'c')) {
          // Prevent duplicate cancellations for same request
          if (lastCancelledIdRef.current === rewindRequest.requestId) return;
          lastCancelledIdRef.current = rewindRequest.requestId;

          if (activityStream) {
            try {
              activityStream.emit({
                id: `response_${rewindRequest.requestId}_cancel`,
                type: ActivityEventType.REWIND_RESPONSE,
                timestamp: Date.now(),
                data: {
                  requestId: rewindRequest.requestId,
                  cancelled: true,
                },
              });
            } catch (error) {
              console.error('[InputPrompt] Failed to emit rewind cancellation:', error);
            }
          }
          return;
        }

        // Block all other input when rewind selector is active
        return;
      }

      // ===== Undo File List Navigation (Two-Stage Flow - Stage 1) =====
      if (undoFileListRequest && onUndoFileListNavigate && activityStream) {
        const filesCount = undoFileListRequest.fileList.length;
        const currentIndex = undoFileListRequest.selectedIndex;

        // Up arrow - navigate to previous file
        if (key.upArrow) {
          const newIndex = Math.max(0, currentIndex - 1);
          onUndoFileListNavigate(newIndex);
          return;
        }

        // Down arrow - navigate to next file
        if (key.downArrow) {
          const newIndex = Math.min(filesCount - 1, currentIndex + 1);
          onUndoFileListNavigate(newIndex);
          return;
        }

        // Enter - select file (move to stage 2: show diff)
        if (key.return) {
          try {
            const selectedFile = undoFileListRequest.fileList[currentIndex];
            if (selectedFile) {
              activityStream.emit({
                id: `undo_file_selected_${Date.now()}`,
                type: ActivityEventType.UNDO_FILE_SELECTED,
                timestamp: Date.now(),
                data: {
                  requestId: undoFileListRequest.requestId,
                  patchNumber: selectedFile.patch_number,
                  filePath: selectedFile.file_path,
                },
              });
            }
          } catch (error) {
            console.error('[InputPrompt] Failed to emit file selection:', error);
          }
          return;
        }

        // Escape or Ctrl+C - cancel undo
        if (key.escape || (key.ctrl && input === 'c')) {
          // Prevent duplicate cancellations for same request
          if (lastCancelledIdRef.current === undoFileListRequest.requestId) return;
          lastCancelledIdRef.current = undoFileListRequest.requestId;

          try {
            activityStream.emit({
              id: `undo_cancelled_${Date.now()}`,
              type: ActivityEventType.UNDO_CANCELLED,
              timestamp: Date.now(),
              data: {
                requestId: undoFileListRequest.requestId,
              },
            });
          } catch (error) {
            console.error('[InputPrompt] Failed to emit undo cancellation:', error);
          }
          return;
        }

        // Block all other input when file list is active
        return;
      }

      // ===== Undo Prompt Navigation (Two-Stage Flow - Stage 2) =====
      if (undoRequest && onUndoNavigate && activityStream) {
        const optionsCount = 2; // Confirm and Cancel

        // Up arrow - navigate to previous option
        if (key.upArrow) {
          const newIndex = Math.max(0, undoSelectedIndex - 1);
          onUndoNavigate(newIndex);
          return;
        }

        // Down arrow - navigate to next option
        if (key.downArrow) {
          const newIndex = Math.min(optionsCount - 1, undoSelectedIndex + 1);
          onUndoNavigate(newIndex);
          return;
        }

        // Enter - submit selection
        if (key.return) {
          const confirmed = undoSelectedIndex === 0; // 0 = Confirm, 1 = Cancel
          try {
            if (confirmed) {
              activityStream.emit({
                id: `undo_confirm_${Date.now()}`,
                type: ActivityEventType.UNDO_CONFIRM,
                timestamp: Date.now(),
                data: {
                  requestId: undoRequest.requestId,
                },
              });
            } else {
              activityStream.emit({
                id: `undo_file_back_${Date.now()}`,
                type: ActivityEventType.UNDO_FILE_BACK,
                timestamp: Date.now(),
                data: {
                  requestId: undoRequest.requestId,
                },
              });
            }
          } catch (error) {
            console.error('[InputPrompt] Failed to emit undo response:', error);
          }
          return;
        }

        // Escape or Ctrl+C - go back to file list
        if (key.escape || (key.ctrl && input === 'c')) {
          // Prevent duplicate cancellations for same request
          if (lastCancelledIdRef.current === undoRequest.requestId) return;
          lastCancelledIdRef.current = undoRequest.requestId;

          try {
            activityStream.emit({
              id: `undo_file_back_${Date.now()}`,
              type: ActivityEventType.UNDO_FILE_BACK,
              timestamp: Date.now(),
              data: {
                requestId: undoRequest.requestId,
              },
            });
          } catch (error) {
            console.error('[InputPrompt] Failed to emit undo back:', error);
          }
          return;
        }

        // Block all other input when undo prompt is active
        return;
      }

      // ===== Permission Prompt Navigation =====
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
            try {
              activityStream.emit({
                id: `response_${permissionRequest.requestId}`,
                type: ActivityEventType.PERMISSION_RESPONSE,
                timestamp: Date.now(),
                data: {
                  requestId: permissionRequest.requestId,
                  choice: selectedChoice,
                },
              });
            } catch (error) {
              console.error('[InputPrompt] Failed to emit permission response:', error);
            }
          }
          return;
        }

        // Escape or Ctrl+C - deny permission and cancel
        if (key.escape || (key.ctrl && input === 'c')) {
          // Prevent duplicate cancellations for same request
          if (lastCancelledIdRef.current === permissionRequest.requestId) return;
          lastCancelledIdRef.current = permissionRequest.requestId;

          try {
            activityStream.emit({
              id: `response_${permissionRequest.requestId}_cancel`,
              type: ActivityEventType.PERMISSION_RESPONSE,
              timestamp: Date.now(),
              data: {
                requestId: permissionRequest.requestId,
                choice: PermissionChoice.DENY,
              },
            });
          } catch (error) {
            console.error('[InputPrompt] Failed to emit permission denial:', error);
          }
          return;
        }

        // Block all other input when permission prompt is active
        return;
      }

      // ===== History Navigation / Line Navigation =====
      if (key.upArrow && !showCompletions) {
        // For multiline: move between lines, only navigate history from first line
        const lines = buffer.split('\n');
        const cursorInfo = getCursorLineInfo(buffer, cursorPosition);

        if (cursorInfo.line > 0) {
          // Move to previous line at same column position or end of line
          const prevLineStart = cursorInfo.charsBeforeLine - (lines[cursorInfo.line - 1] || '').length - 1;
          const prevLineLength = (lines[cursorInfo.line - 1] || '').length;
          const newPos = prevLineStart + Math.min(cursorInfo.posInLine, prevLineLength);
          setCursorPosition(newPos);
        } else if (cursorPosition === 0) {
          // At start of first line - navigate history
          navigateHistoryPrevious();
        } else {
          // On first line but not at start - move to start
          setCursorPosition(0);
        }
        return;
      }

      if (key.downArrow && !showCompletions) {
        // For multiline: move between lines, only navigate history from last line
        const lines = buffer.split('\n');
        const cursorInfo = getCursorLineInfo(buffer, cursorPosition);

        if (cursorInfo.line < lines.length - 1) {
          // Move to next line at same column position or end of line
          const nextLineStart = cursorInfo.charsBeforeLine + (lines[cursorInfo.line] || '').length + 1;
          const nextLineLength = (lines[cursorInfo.line + 1] || '').length;
          const newPos = nextLineStart + Math.min(cursorInfo.posInLine, nextLineLength);
          setCursorPosition(newPos);
        } else if (cursorPosition === buffer.length) {
          // At end of last line - navigate history
          navigateHistoryNext();
        } else {
          // On last line but not at end - move to end
          setCursorPosition(buffer.length);
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

      // ===== Escape - Dismiss Completions, Interrupt Agent, or Double-Escape for Rewind =====
      if (key.escape) {
        // Prevent infinite loop from re-entry during state updates
        if (processingEscapeRef.current) return;

        // First priority: dismiss completions if showing
        if (showCompletions) {
          processingEscapeRef.current = true;
          setShowCompletions(false);
          setCompletions([]);
          // Reset after a microtask to allow state updates to complete
          queueMicrotask(() => {
            processingEscapeRef.current = false;
          });
          return;
        }

        // Second priority: Interrupt agent if processing (single escape)
        if (agent && agent.isProcessing()) {
          logger.debug('[INPUT] Escape - interrupting main agent');

          // Emit immediate visual feedback before interrupting
          if (activityStream) {
            activityStream.emit({
              id: `user-interrupt-${Date.now()}`,
              type: ActivityEventType.USER_INTERRUPT_INITIATED,
              timestamp: Date.now(),
              data: {},
            });
          }

          // Interrupt the agent (will cancel LLM request immediately)
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

        // Third priority: Double-escape to open rewind (only when no modal active)
        if (!modelSelectRequest && !sessionSelectRequest && !rewindRequest && !permissionRequest && activityStream) {
          const newCount = escCount + 1;
          setEscCount(newCount);

          // Reset counter after configured delay
          if (escTimerRef.current) clearTimeout(escTimerRef.current);
          escTimerRef.current = setTimeout(() => setEscCount(0), UI_DELAYS.ESC_RESET);

          // Open rewind on 2nd escape
          if (newCount >= 2) {
            const requestId = `rewind_${Date.now()}`;
            try {
              activityStream.emit({
                id: requestId,
                type: ActivityEventType.REWIND_REQUEST,
                timestamp: Date.now(),
                data: { requestId },
              });
            } catch (error) {
              console.error('[InputPrompt] Failed to emit rewind request:', error);
            }
            setEscCount(0); // Reset counter
          }
        }
        return;
      }

      // ===== Submit =====
      if (key.return) {
        if (key.ctrl) {
          // Ctrl+Enter - Insert newline
          const currentBuffer = bufferRef.current;
          const currentCursor = cursorPositionRef.current;
          const before = currentBuffer.slice(0, currentCursor);
          const after = currentBuffer.slice(currentCursor);
          setBuffer(before + '\n' + after);
          setCursorPosition(currentCursor + 1);
        } else {
          const message = buffer.trim();
          if (!message) return;

          // Slash commands always execute immediately, even during agent processing
          if (message.startsWith('/')) {
            handleSubmit();
            return;
          }

          // Check if agent is processing - if so, this is an interjection
          if (agent && agent.isProcessing()) {
            // This is an interjection mid-response
            if (onInterjection) {
              onInterjection(message);
              // Clear buffer after interjection
              setBuffer('');
              setCursorPosition(0);
              setHistoryIndex(-1);
              setHistoryBuffer('');
              setShowCompletions(false);
              setCompletions([]);
              setMentionedFiles([]);
            }
          } else {
            // Normal submission
            handleSubmit();
          }
        }
        return;
      }

      // ===== Clear Buffer / Quit (Ctrl+C) =====
      // Priority order: clear buffer -> exit confirmation -> quit
      // Use ref to avoid stale closure issues
      if (key.ctrl && input === 'c') {
        const currentBuffer = bufferRef.current;
        const hasContent = currentBuffer.trim().length > 0;

        // Priority 1: Clear buffer if it has content
        if (hasContent) {
          setBuffer('');
          setCursorPosition(0);
          setHistoryIndex(-1);
          setShowCompletions(false);
          // Also clear exit confirmation if active
          if (isWaitingForExitConfirmation) {
            setIsWaitingForExitConfirmation(false);
            if (exitConfirmationTimerRef.current) {
              clearTimeout(exitConfirmationTimerRef.current);
              exitConfirmationTimerRef.current = null;
            }
          }
          return;
        }

        // Priority 2: Buffer is empty - check if waiting for confirmation
        if (isWaitingForExitConfirmation) {
          // Second Ctrl+C within 1 second - quit
          exit();
          return;
        }

        // Priority 3: First Ctrl+C on empty buffer - start confirmation timer
        setIsWaitingForExitConfirmation(true);

        // Clear any existing timer
        if (exitConfirmationTimerRef.current) {
          clearTimeout(exitConfirmationTimerRef.current);
        }

        // Set 1-second timer to reset confirmation
        exitConfirmationTimerRef.current = setTimeout(() => {
          setIsWaitingForExitConfirmation(false);
          exitConfirmationTimerRef.current = null;
        }, 1000);

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
        const currentCursor = cursorPositionRef.current;
        if (currentCursor > 0) {
          const currentBuffer = bufferRef.current;
          const before = currentBuffer.slice(0, currentCursor - 1);
          const after = currentBuffer.slice(currentCursor);
          setBuffer(before + after);
          setCursorPosition(currentCursor - 1);
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
        // Use refs to avoid stale closure issues with rapid paste events
        const currentBuffer = bufferRef.current;
        const currentCursor = cursorPositionRef.current;

        // Normalize line endings - convert \r\n and \r to \n
        const normalizedInput = input.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        const before = currentBuffer.slice(0, currentCursor);
        const after = currentBuffer.slice(currentCursor);
        const newBuffer = before + normalizedInput + after;
        const newCursor = currentCursor + normalizedInput.length;

        setBuffer(newBuffer);
        setCursorPosition(newCursor);
        setHistoryIndex(-1); // Reset history when typing
      }
    },
    { isActive }
  );

  // Split buffer into lines for multiline display
  const lines = buffer.split('\n');
  const isEmpty = buffer.trim().length === 0;

  // Calculate which line the cursor is on and position within that line
  const cursorInfo = getCursorLineInfo(buffer, cursorPosition);
  const cursorLine = cursorInfo.line;
  const cursorPosInLine = cursorInfo.posInLine;

  // Determine prompt style based on first character
  const isCommandMode = buffer.startsWith('/');
  const isBashMode = buffer.startsWith('!');

  let promptText = '> ';
  let promptColor = UI_COLORS.TEXT_DIM;

  if (isCommandMode) {
    promptText = 'Command > ';
    promptColor = UI_COLORS.TEXT_DIM;
  } else if (isBashMode) {
    promptText = 'Bash > ';
    promptColor = UI_COLORS.TEXT_DIM;
  }

  /**
   * Parse text and identify mentioned file paths and plugins for highlighting
   * Returns array of segments with styling information
   */
  const parseTextWithMentions = (
    text: string
  ): Array<{ text: string; highlightType: 'none' | 'file' | 'plugin' }> => {
    if ((mentionedFiles.length === 0 && mentionedPlugins.length === 0) || !text) {
      return [{ text, highlightType: 'none' }];
    }

    const segments: Array<{ text: string; highlightType: 'none' | 'file' | 'plugin' }> = [];
    let remaining = text;
    let searchIndex = 0;

    while (remaining.length > 0) {
      // Find the earliest mention (file or plugin) in the remaining text
      let earliestIndex = -1;
      let earliestMention = '';
      let earliestType: 'file' | 'plugin' = 'file';

      // Check files
      for (const filePath of mentionedFiles) {
        const index = remaining.indexOf(filePath, searchIndex - (text.length - remaining.length));
        if (index !== -1 && (earliestIndex === -1 || index < earliestIndex)) {
          earliestIndex = index;
          earliestMention = filePath;
          earliestType = 'file';
        }
      }

      // Check plugins
      for (const pluginName of mentionedPlugins) {
        const index = remaining.indexOf(pluginName, searchIndex - (text.length - remaining.length));
        if (index !== -1 && (earliestIndex === -1 || index < earliestIndex)) {
          earliestIndex = index;
          earliestMention = pluginName;
          earliestType = 'plugin';
        }
      }

      if (earliestIndex === -1) {
        // No more mentions found
        segments.push({ text: remaining, highlightType: 'none' });
        break;
      }

      // Add text before mention
      if (earliestIndex > 0) {
        segments.push({ text: remaining.slice(0, earliestIndex), highlightType: 'none' });
      }

      // Add the mention
      segments.push({ text: earliestMention, highlightType: earliestType });

      // Continue with text after mention
      remaining = remaining.slice(earliestIndex + earliestMention.length);
      searchIndex = 0;
    }

    return segments.length > 0 ? segments : [{ text, highlightType: 'none' }];
  };

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
          const prompt = isFirstLine ? promptText : '';
          // Fix for multiple consecutive line breaks: use !== '' instead of || to preserve empty lines
          // Empty lines should render as a space to maintain proper height
          const displayText = line !== '' ? line : (isEmpty && isFirstLine ? placeholder : ' ');
          const textColor = isEmpty && isFirstLine ? 'gray' : 'white';
          const isCursorLine = index === cursorLine;

          // Parse line into segments with mentions
          const segments = parseTextWithMentions(displayText);

          // Get color for segment based on highlight type
          const getSegmentColor = (highlightType: 'none' | 'file' | 'plugin'): string => {
            if (highlightType === 'file') return UI_COLORS.PRIMARY;
            if (highlightType === 'plugin') return UI_COLORS.PRIMARY;
            return textColor;
          };

          return (
            <Box key={`line-${index}`}>
              <Text wrap="wrap" color={promptColor} bold={isCommandMode || isBashMode}>
                {prompt}
              </Text>

              {/* Non-cursor line or inactive - simple rendering */}
              {(!isCursorLine || !isActive) && (
                <>
                  {segments.map((segment, segIdx) => (
                    <Text
                      wrap="wrap"
                      key={segIdx}
                      color={getSegmentColor(segment.highlightType)}
                      dimColor={isEmpty && isFirstLine && segment.highlightType === 'none'}
                    >
                      {segment.text}
                    </Text>
                  ))}
                </>
              )}

              {/* Cursor line with active input - handle cursor within segments */}
              {isCursorLine && isActive && (
                <>
                  {segments.map((segment, segIdx) => {
                    // Calculate character range for this segment
                    const segmentStart = segments.slice(0, segIdx).reduce((sum, s) => sum + s.text.length, 0);
                    const segmentEnd = segmentStart + segment.text.length;
                    const segmentColor = getSegmentColor(segment.highlightType);

                    // Adjust cursor position for empty lines: if original line is empty but displayText is ' '
                    // we need to ensure cursor position maps correctly
                    const adjustedCursorPos = line === '' && displayText === ' ' && cursorPosInLine === 0 ? 0 : cursorPosInLine;

                    // Check if cursor is in this segment
                    if (adjustedCursorPos >= segmentStart && adjustedCursorPos < segmentEnd) {
                      const localCursorPos = adjustedCursorPos - segmentStart;
                      const before = segment.text.slice(0, localCursorPos);
                      const at = segment.text[localCursorPos] || ' ';
                      const after = segment.text.slice(localCursorPos + 1);

                      return (
                        <React.Fragment key={segIdx}>
                          <Text wrap="wrap" color={segmentColor} dimColor={isEmpty && isFirstLine && segment.highlightType === 'none'}>
                            {before}
                          </Text>
                          <Text wrap="wrap" color={UI_COLORS.TEXT_CONTRAST} backgroundColor={UI_COLORS.PRIMARY}>
                            {at}
                          </Text>
                          <Text wrap="wrap" color={segmentColor} dimColor={isEmpty && isFirstLine && segment.highlightType === 'none'}>
                            {after}
                          </Text>
                        </React.Fragment>
                      );
                    }

                    // Cursor not in this segment
                    return (
                      <Text
                        wrap="wrap"
                        key={segIdx}
                        color={segmentColor}
                        dimColor={isEmpty && isFirstLine && segment.highlightType === 'none'}
                      >
                        {segment.text}
                      </Text>
                    );
                  })}
                  {/* Handle cursor at end of line - only show if cursor is beyond all displayed segments */}
                  {cursorPosInLine >= displayText.length && (
                    <Text wrap="wrap" color={UI_COLORS.TEXT_CONTRAST} backgroundColor={UI_COLORS.PRIMARY}>
                      {' '}
                    </Text>
                  )}
                </>
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
