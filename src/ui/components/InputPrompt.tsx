/**
 * InputPrompt Component - Enhanced with history and completion
 *
 * Features:
 * - Command history (up/down arrows)
 * - Tab completion
 * - Advanced editing shortcuts (delegated to TextInput)
 * - Multiline support (delegated to TextInput)
 * - Context-aware completions
 * - Mention highlighting
 * - Modal integrations
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, useInput, useApp } from 'ink';
import { TextInput } from './TextInput.js';
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
import { classifyPaths } from '@utils/pathUtils.js';

interface InputPromptProps {
  /** Callback when user submits input */
  onSubmit: (input: string, mentions?: { files?: string[]; images?: string[]; directories?: string[] }) => void;
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
  /** Callback to toggle auto-allow mode during permission prompts */
  onAutoAllowToggle?: () => void;
  /** Callback to switch back to ally agent (Esc shortcut) */
  onSwitchToAlly?: () => void;
  /** Current active agent name (for Esc behavior) */
  currentAgent?: string;
  /** Model selector data (if active) */
  modelSelectRequest?: {
    requestId: string;
    models: ModelOption[];
    currentModel?: string;
    modelType?: 'ally' | 'service';
    typeName?: string;
  };
  /** Selected model index */
  modelSelectedIndex?: number;
  /** Callback when model selection changes */
  onModelNavigate?: (newIndex: number) => void;
  /** Whether config viewer is open */
  configViewerOpen?: boolean;
  /** Session selector data (if active) */
  sessionSelectRequest?: {
    requestId: string;
    sessions: import('@shared/index.js').SessionInfo[];
    selectedIndex: number;
  };
  /** Callback when session selection changes */
  onSessionNavigate?: (newIndex: number) => void;
  /** Library selector data (if active) */
  librarySelectRequest?: import('../hooks/useModalState.js').LibrarySelectRequest;
  /** Callback when library selection changes */
  onLibraryNavigate?: (newIndex: number) => void;
  /** Message selector data (for prompt creation - if active) */
  messageSelectRequest?: import('../hooks/useModalState.js').MessageSelectRequest;
  /** Callback when message selection changes */
  onMessageNavigate?: (newIndex: number) => void;
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
  /** Library clear confirmation data (if active) */
  libraryClearConfirmRequest?: import('../hooks/useModalState.js').LibraryClearConfirmRequest;
  /** Callback when library clear confirmation selection changes */
  onLibraryClearConfirmNavigate?: (newIndex: number) => void;
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
  /** Whether auto-allow mode is enabled (changes border color to danger) */
  autoAllowMode?: boolean;
  /** Whether the input was prefilled from prompt library (changes border color to primary) */
  promptPrefilled?: boolean;
  /** Callback when prompt prefill state should be cleared (user modified buffer) */
  onPromptPrefilledClear?: () => void;
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
  onAutoAllowToggle,
  onSwitchToAlly,
  currentAgent,
  modelSelectRequest,
  modelSelectedIndex = 0,
  onModelNavigate,
  sessionSelectRequest,
  onSessionNavigate,
  librarySelectRequest,
  onLibraryNavigate,
  messageSelectRequest,
  onMessageNavigate,
  configViewerOpen = false,
  rewindRequest,
  onRewindNavigate,
  onRewindEnter,
  undoRequest,
  undoSelectedIndex = 0,
  onUndoNavigate,
  undoFileListRequest,
  onUndoFileListNavigate,
  libraryClearConfirmRequest,
  onLibraryClearConfirmNavigate,
  activityStream,
  agent,
  prefillText,
  onPrefillConsumed,
  onExitConfirmationChange,
  bufferValue,
  onBufferChange,
  autoAllowMode = false,
  promptPrefilled = false,
  onPromptPrefilledClear,
}) => {
  const { exit } = useApp();
  const [buffer, setBuffer] = useState(bufferValue || '');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [mentionedFiles, setMentionedFiles] = useState<string[]>([]);
  const [mentionedImages, setMentionedImages] = useState<string[]>([]);
  const [mentionedDirectories, setMentionedDirectories] = useState<string[]>([]);
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
   * Apply selected completion
   */
  const applyCompletion = () => {
    if (!showCompletions || completions.length === 0 || !completions[completionIndex]) {
      return;
    }

    // Clear prompt prefill highlight if user modifies buffer
    if (promptPrefilled) {
      onPromptPrefilledClear?.();
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
   * Helper to calculate cursor line info (reused from TextInput logic)
   */
  const getCursorLineInfo = (
    text: string,
    cursor: number
  ): { line: number; posInLine: number; charsBeforeLine: number } => {
    const clampedCursor = Math.max(0, Math.min(cursor, text.length));
    const lines = text.split('\n');
    let charCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineLength = (lines[i] || '').length;
      if (charCount + lineLength >= clampedCursor) {
        return {
          line: i,
          posInLine: Math.min(clampedCursor - charCount, lineLength),
          charsBeforeLine: charCount,
        };
      }
      charCount += lineLength + 1;
    }

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

    // Extract all @ mentions from buffer (handles both quoted and unquoted paths)
    const extractedPaths: string[] = [];
    const atMentionRegex = /@(?:"([^"]+)"|([^\s]+))/g;
    let match;
    while ((match = atMentionRegex.exec(trimmed)) !== null) {
      // match[1] is quoted path, match[2] is unquoted path
      const path = match[1] || match[2];
      if (path) {
        extractedPaths.push(path);
      }
    }

    // Classify extracted paths into directories, images, and files
    const { directories: extractedDirectories, images: extractedImages, files: extractedFiles } = classifyPaths(extractedPaths);

    // Combine tracked mentions with extracted mentions (deduplicate)
    const allDirectories = [...new Set([...mentionedDirectories, ...extractedDirectories])];
    const allFiles = [...new Set([...mentionedFiles, ...extractedFiles])];
    const allImages = [...new Set([...mentionedImages, ...extractedImages])];

    // Call callback with mentions if any
    const mentions = {
      ...(allDirectories.length > 0 && { directories: allDirectories }),
      ...(allFiles.length > 0 && { files: allFiles }),
      ...(allImages.length > 0 && { images: allImages }),
    };
    onSubmit(trimmed, Object.keys(mentions).length > 0 ? mentions : undefined);

    // Reset state
    setBuffer('');
    setCursorPosition(0);
    setHistoryIndex(-1);
    setHistoryBuffer('');
    setShowCompletions(false);
    setCompletions([]);
    setMentionedFiles([]);
    setMentionedImages([]);
    setMentionedDirectories([]);
  };

  // Track whether TextInput is active (inactive when modals are open)
  const textInputActive =
    isActive &&
    !permissionRequest &&
    !modelSelectRequest &&
    !sessionSelectRequest &&
    !librarySelectRequest &&
    !messageSelectRequest &&
    !rewindRequest &&
    !undoRequest &&
    !undoFileListRequest &&
    !libraryClearConfirmRequest &&
    !configViewerOpen;

  /**
   * Handle value changes from TextInput
   */
  const handleValueChange = (newValue: string) => {
    // Clear prompt prefill highlight if user modifies buffer
    if (promptPrefilled) {
      onPromptPrefilledClear?.();
    }
    setBuffer(newValue);
    setHistoryIndex(-1); // Reset history when editing
  };

  /**
   * Handle cursor changes from TextInput
   */
  const handleCursorChange = (newPosition: number) => {
    setCursorPosition(newPosition);
  };

  /**
   * Handle file paths pasted into TextInput
   */
  const handleFilesPasted = (files: string[]) => {
    // Add files to mentionedFiles, avoiding duplicates
    setMentionedFiles(prev => [
      ...prev,
      ...files.filter(f => !prev.includes(f))
    ]);
  };

  /**
   * Handle images pasted into TextInput
   */
  const handleImagesPasted = (images: string[]) => {
    // Add images to mentionedImages, avoiding duplicates
    setMentionedImages(prev => [
      ...prev,
      ...images.filter(i => !prev.includes(i))
    ]);
  };

  /**
   * Handle directories pasted into TextInput
   */
  const handleDirectoriesPasted = (directories: string[]) => {
    // Add directories to mentionedDirectories, avoiding duplicates
    setMentionedDirectories(prev => [
      ...prev,
      ...directories.filter(d => !prev.includes(d))
    ]);
  };

  /**
   * Handle submit from TextInput
   */
  const handleTextInputSubmit = (value: string) => {
    const message = value.trim();
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
        setMentionedImages([]);
      }
    } else {
      // Normal submission
      handleSubmit();
    }
  };

  // Handle keyboard input for special features (history, completion, modals, etc.)
  // TextInput handles basic editing, we only intercept for our special features
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

      // ===== Message Selector Navigation (for prompt creation) =====
      if (messageSelectRequest && onMessageNavigate && activityStream) {
        const messagesCount = messageSelectRequest.messages.length;
        const currentIndex = messageSelectRequest.selectedIndex;

        // Up arrow - navigate to previous message
        if (key.upArrow) {
          const newIndex = Math.max(0, currentIndex - 1);
          onMessageNavigate(newIndex);
          return;
        }

        // Down arrow - navigate to next message
        if (key.downArrow) {
          const newIndex = Math.min(messagesCount - 1, currentIndex + 1);
          onMessageNavigate(newIndex);
          return;
        }

        // Enter - select message and use for prompt content
        if (key.return) {
          try {
            const selectedMessage = messageSelectRequest.messages[currentIndex];
            if (selectedMessage) {
              activityStream.emit({
                id: `response_${messageSelectRequest.requestId}`,
                type: ActivityEventType.PROMPT_MESSAGE_SELECT_RESPONSE,
                timestamp: Date.now(),
                data: {
                  requestId: messageSelectRequest.requestId,
                  selectedMessage: selectedMessage,
                  cancelled: false,
                },
              });
            }
          } catch (error) {
            console.error('[InputPrompt] Failed to emit message selection:', error);
          }
          return;
        }

        // 'N' key - create new prompt (skip message selection)
        if (input.toLowerCase() === 'n') {
          try {
            activityStream.emit({
              id: `response_${messageSelectRequest.requestId}_new`,
              type: ActivityEventType.PROMPT_MESSAGE_SELECT_RESPONSE,
              timestamp: Date.now(),
              data: {
                requestId: messageSelectRequest.requestId,
                selectedMessage: undefined, // No message selected
                cancelled: false,
              },
            });
          } catch (error) {
            console.error('[InputPrompt] Failed to emit new prompt request:', error);
          }
          return;
        }

        // Escape or Ctrl+C - cancel entire flow
        if (key.escape || (key.ctrl && input === 'c')) {
          // Prevent duplicate cancellations for same request
          if (lastCancelledIdRef.current === messageSelectRequest.requestId) return;
          lastCancelledIdRef.current = messageSelectRequest.requestId;

          try {
            activityStream.emit({
              id: `response_${messageSelectRequest.requestId}_cancel`,
              type: ActivityEventType.PROMPT_MESSAGE_SELECT_RESPONSE,
              timestamp: Date.now(),
              data: {
                requestId: messageSelectRequest.requestId,
                cancelled: true,
              },
            });
          } catch (error) {
            console.error('[InputPrompt] Failed to emit message selection cancellation:', error);
          }
          return;
        }

        // Block all other input when message selector is active
        return;
      }

      // ===== Library Selector Navigation =====
      if (librarySelectRequest && onLibraryNavigate && activityStream) {
        const promptsCount = librarySelectRequest.prompts.length;
        const currentIndex = librarySelectRequest.selectedIndex;

        // Up arrow - navigate to previous prompt
        if (key.upArrow) {
          const newIndex = Math.max(0, currentIndex - 1);
          onLibraryNavigate(newIndex);
          return;
        }

        // Down arrow - navigate to next prompt
        if (key.downArrow) {
          const newIndex = Math.min(promptsCount - 1, currentIndex + 1);
          onLibraryNavigate(newIndex);
          return;
        }

        // Enter - submit selection (load prompt)
        if (key.return) {
          try {
            const selectedPrompt = librarySelectRequest.prompts[currentIndex];
            if (selectedPrompt) {
              activityStream.emit({
                id: `response_${librarySelectRequest.requestId}`,
                type: ActivityEventType.LIBRARY_SELECT_RESPONSE,
                timestamp: Date.now(),
                data: {
                  requestId: librarySelectRequest.requestId,
                  promptId: selectedPrompt.id,
                  cancelled: false,
                },
              });
            }
          } catch (error) {
            console.error('[InputPrompt] Failed to emit library selection:', error);
          }
          return;
        }

        // Escape or Ctrl+C - cancel selection
        if (key.escape || (key.ctrl && input === 'c')) {
          // Prevent duplicate cancellations for same request
          if (lastCancelledIdRef.current === librarySelectRequest.requestId) return;
          lastCancelledIdRef.current = librarySelectRequest.requestId;

          try {
            activityStream.emit({
              id: `response_${librarySelectRequest.requestId}_cancel`,
              type: ActivityEventType.LIBRARY_SELECT_RESPONSE,
              timestamp: Date.now(),
              data: {
                requestId: librarySelectRequest.requestId,
                cancelled: true,
              },
            });
          } catch (error) {
            console.error('[InputPrompt] Failed to emit library cancellation:', error);
          }
          return;
        }

        // Block all other input when library selector is active
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

      // ===== Library Clear Confirmation Navigation =====
      if (libraryClearConfirmRequest && onLibraryClearConfirmNavigate && activityStream) {
        const optionsCount = 2; // Confirm and Cancel
        const currentIndex = libraryClearConfirmRequest.selectedIndex;

        // Up arrow - navigate to previous option
        if (key.upArrow) {
          const newIndex = Math.max(0, currentIndex - 1);
          onLibraryClearConfirmNavigate(newIndex);
          return;
        }

        // Down arrow - navigate to next option
        if (key.downArrow) {
          const newIndex = Math.min(optionsCount - 1, currentIndex + 1);
          onLibraryClearConfirmNavigate(newIndex);
          return;
        }

        // Enter - submit selection
        if (key.return) {
          const confirmed = currentIndex === 0; // 0 = Confirm, 1 = Cancel
          try {
            activityStream.emit({
              id: `response_${libraryClearConfirmRequest.requestId}`,
              type: ActivityEventType.LIBRARY_CLEAR_CONFIRM_RESPONSE,
              timestamp: Date.now(),
              data: {
                requestId: libraryClearConfirmRequest.requestId,
                confirmed,
                cancelled: false,
              },
            });
          } catch (error) {
            console.error('[InputPrompt] Failed to emit library clear confirmation:', error);
          }
          return;
        }

        // Escape or Ctrl+C - cancel
        if (key.escape || (key.ctrl && input === 'c')) {
          // Prevent duplicate cancellations for same request
          if (lastCancelledIdRef.current === libraryClearConfirmRequest.requestId) return;
          lastCancelledIdRef.current = libraryClearConfirmRequest.requestId;

          try {
            activityStream.emit({
              id: `response_${libraryClearConfirmRequest.requestId}_cancel`,
              type: ActivityEventType.LIBRARY_CLEAR_CONFIRM_RESPONSE,
              timestamp: Date.now(),
              data: {
                requestId: libraryClearConfirmRequest.requestId,
                confirmed: false,
                cancelled: true,
              },
            });
          } catch (error) {
            console.error('[InputPrompt] Failed to emit library clear cancellation:', error);
          }
          return;
        }

        // Block all other input when confirmation is active
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

      // ===== History Navigation (override TextInput's arrow keys at boundaries) =====
      // Only intercept when NOT showing completions and at text boundaries
      if (key.upArrow && !showCompletions && !textInputActive) {
        // TextInput is inactive (modal open) - let modal handle it
        return;
      }

      if (key.upArrow && !showCompletions && textInputActive) {
        // Check if we're at the start of the first line - then navigate history
        const cursorInfo = getCursorLineInfo(buffer, cursorPosition);
        if (cursorInfo.line === 0 && cursorPosition === 0) {
          navigateHistoryPrevious();
          return;
        }
        // Otherwise let TextInput handle it (multiline navigation)
      }

      if (key.downArrow && !showCompletions && !textInputActive) {
        // TextInput is inactive (modal open) - let modal handle it
        return;
      }

      if (key.downArrow && !showCompletions && textInputActive) {
        // Check if we're at the end of the last line - then navigate history
        const cursorInfo = getCursorLineInfo(buffer, cursorPosition);
        const lines = buffer.split('\n');
        if (cursorInfo.line === lines.length - 1 && cursorPosition === buffer.length) {
          navigateHistoryNext();
          return;
        }
        // Otherwise let TextInput handle it (multiline navigation)
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

      // ===== Tab - Completion or Auto-Allow Toggle =====
      if (key.tab) {
        // Shift+Tab: Toggle auto-allow mode (global shortcut)
        if (key.shift && onAutoAllowToggle) {
          onAutoAllowToggle();
          return;
        }

        // Tab alone: Completion (existing behavior)
        if (showCompletions && completions.length > 0) {
          applyCompletion();
        } else {
          // Trigger completions
          updateCompletions();
        }
        return;
      }

      // ===== Escape - Dismiss Completions, Interrupt Agent, Return to Ally, or Double-Escape for Rewind =====
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

        // Third priority: Return to ally if on a different agent
        if (currentAgent && currentAgent !== 'ally' && onSwitchToAlly) {
          logger.debug('[INPUT] Escape - returning to ally agent');
          onSwitchToAlly();
          return;
        }

        // Fourth priority: Double-escape to open rewind (only when no modal active)
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

      // ===== Exit Confirmation (Ctrl+C on empty buffer) =====
      // Note: TextInput handles buffer clearing when buffer has content
      // We only need to handle exit confirmation when buffer is empty
      if (key.ctrl && input === 'c' && textInputActive) {
        const currentBuffer = bufferRef.current;
        const hasContent = currentBuffer.trim().length > 0;

        // If buffer has content, TextInput will handle clearing it
        if (hasContent) return;

        // Buffer is empty - handle exit confirmation
        if (isWaitingForExitConfirmation) {
          // Second Ctrl+C within 1 second - quit
          exit();
          return;
        }

        // First Ctrl+C on empty buffer - start confirmation timer
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
    },
    { isActive }
  );

  // Determine prompt style based on first character
  const isCommandMode = buffer.startsWith('/');
  const isBashMode = buffer.startsWith('!');

  let promptText = '> ';
  let borderColor: string = UI_COLORS.TEXT_DIM;

  if (isCommandMode) {
    promptText = 'Command > ';
    borderColor = UI_COLORS.TEXT_DIM;
  } else if (isBashMode) {
    promptText = 'Bash > ';
    borderColor = UI_COLORS.TEXT_DIM;
  }

  // Override border color when auto-allow mode is active (danger color)
  if (autoAllowMode) {
    borderColor = UI_COLORS.ERROR;
  }

  // Override border color when prompt is prefilled from library (primary color)
  if (promptPrefilled && !autoAllowMode) {
    borderColor = UI_COLORS.PRIMARY;
  }

  return (
    <Box flexDirection="column" width="100%">
      {/* Use TextInput for base text editing functionality */}
      <TextInput
        value={buffer}
        onValueChange={handleValueChange}
        cursorPosition={cursorPosition}
        onCursorChange={handleCursorChange}
        onSubmit={handleTextInputSubmit}
        onFilesPasted={handleFilesPasted}
        onImagesPasted={handleImagesPasted}
        onDirectoriesPasted={handleDirectoriesPasted}
        isActive={textInputActive}
        multiline={true}
        placeholder={placeholder}
        bordered={true}
        borderColor={borderColor}
        promptText={promptText}
      />

      {/* Completion dropdown */}
      {showCompletions && (
        <CompletionDropdown completions={completions} selectedIndex={completionIndex} visible={showCompletions} />
      )}
    </Box>
  );
};
