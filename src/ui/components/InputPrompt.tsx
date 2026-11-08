/**
 * InputPrompt Component - Enhanced with history and completion
 *
 * Features:
 * - Command history (up/down arrows)
 * - Tab completion and Enter acceptance for slash commands
 * - Advanced editing shortcuts (delegated to TextInput)
 * - Multiline support (delegated to TextInput)
 * - Context-aware completions
 * - Mention highlighting
 * - Modal integrations
 */

import type { PermissionMode } from '../../security/PermissionMode.js';
import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { useBottomLayout } from './BottomAlignedLayout.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { useForceQuit } from '../hooks/useForceQuit.js';
import { usePromptDraft, type PromptDraft } from '../hooks/usePromptDraft.js';
import { Box, useInput, useApp, type Key } from 'ink';
import { TextInput } from './TextInput.js';
import { CommandHistory } from '@services/CommandHistory.js';
import { CompletionProvider, Completion } from '@services/CompletionProvider.js';
import { CompletionDropdown } from './CompletionDropdown.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ActivityEventType } from '@shared/index.js';
import { logger } from '@services/Logger.js';
import { Agent } from '@agent/Agent.js';
import { UI_DELAYS } from '@config/constants.js';
import { UI_COLORS } from '../constants/colors.js';
import { classifyPaths } from '@utils/pathUtils.js';
import { applyCompletionToInput, type CompletionApplicationOptions } from '../utils/completionUtils.js';
import {
  getCompletionAcceptDecision,
  moveCompletionSelection,
  shouldConsumeHistoryNextAtDraft,
  shouldNavigateHistoryNext,
  shouldNavigateHistoryPrevious,
} from '../utils/inputInteraction.js';

interface InputPromptProps {
  prominent?: boolean;
  /** Callback when user submits input */
  onSubmit: (input: string, mentions?: { files?: string[]; images?: string[]; directories?: string[] }) => void;
  /** Callback when user interjections (submits mid-response) */
  onInterjection?: (message: string) => void;
  onFollowUp?: InputPromptProps['onSubmit'];
  /** Background the current shell command and submit this prompt normally. */
  onBackgroundAndSubmit?: InputPromptProps['onSubmit'];
  onRecallFollowUp?: () => string | undefined;
  conversationReadOnly?: boolean;
  /** Whether input is currently active/enabled */
  isActive?: boolean;

  // ===== Background-agent fleet navigation =====
  /** Whether the fleet list below the prompt currently has keyboard focus */
  fleetFocused?: boolean;
  /** Number of background agents (selectable list size is this + 1 for 'main') */
  fleetCount?: number;
  /** Selected index over [main, ...agents] (0 === 'main') */
  fleetSelectedIndex?: number;
  /** Whether the user is currently viewing an entered background agent */
  isViewingAgent?: boolean;
  /** Move focus from the prompt into the fleet list (↓ on empty prompt) */
  onEnterFleet?: () => void;
  /** Change the selected fleet row */
  onFleetNavigate?: (index: number) => void;
  /** Enter the selected agent's conversation (index over [main, ...agents]) */
  onEnterAgent?: (selectedIndex: number) => void;
  /** Return focus from the fleet list back to the prompt */
  onExitFleet?: () => void;
  /** Exit an entered background agent back to the main conversation */
  onExitAgent?: () => void;
  /** Background running foreground shell commands (Ctrl+B) */
  onBackgroundCommand?: () => void;
  /** Open or close every tool call in the live region (Ctrl+O) */
  onToggleToolOutput?: () => void;
  /** Kill the selected fleet agent (index over [main, ...agents]; excludes main) */
  onKillAgent?: (selectedIndex: number) => void;
  /** Placeholder text to show when empty */
  placeholder?: string;
  /** Command history instance */
  commandHistory?: CommandHistory;
  /** Completion provider instance */
  completionProvider?: CompletionProvider;
  /** Callback to toggle auto-allow mode during permission prompts */
  onPermissionModeCycle?: () => void;
  /** Callback to switch back to default agent (Esc shortcut) */
  onSwitchToDefault?: () => void;
  /** Current active agent name (for Esc behavior) */
  currentAgent?: string;
  /** Default agent from config (Esc won't switch if already on default) */
  defaultAgent?: string;
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
  /** Conversation-owned editing state, retained while a modal or another agent is selected. */
  draft?: PromptDraft;
  onDraftChange?: (draft: PromptDraft) => void;
  /** Effective permission mode (Allow-all uses a danger-colored border) */
  permissionMode?: PermissionMode;
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
  prominent = false,
  onInterjection,
  onFollowUp,
  onBackgroundAndSubmit,
  onRecallFollowUp,
  conversationReadOnly = false,
  isActive = true,
  fleetFocused = false,
  fleetCount = 0,
  fleetSelectedIndex = 0,
  isViewingAgent = false,
  onEnterFleet,
  onFleetNavigate,
  onEnterAgent,
  onExitFleet,
  onExitAgent,
  onBackgroundCommand,
  onToggleToolOutput,
  onKillAgent,
  placeholder = 'Type a message...',
  commandHistory,
  completionProvider,
  onPermissionModeCycle,
  onSwitchToDefault,
  currentAgent,
  defaultAgent = 'ally',
  activityStream,
  agent,
  prefillText,
  onPrefillConsumed,
  onExitConfirmationChange,
  draft,
  onDraftChange,
  permissionMode = 'manual',
  promptPrefilled = false,
  onPromptPrefilledClear,
}) => {
  const bottomLayout = useBottomLayout();
  const terminalRows = useTerminalRows();
  useLayoutEffect(() => {
    bottomLayout?.measure();
  });
  const { exit } = useApp();
  useForceQuit(isActive);
  const { buffer, cursorPosition, bufferRef, cursorPositionRef, updateBuffer, setCursorPosition } = usePromptDraft(
    draft,
    onDraftChange
  );
  const onPrefillConsumedRef = useRef(onPrefillConsumed);

  useEffect(() => {
    onPrefillConsumedRef.current = onPrefillConsumed;
  }, [onPrefillConsumed]);

  // Handle prefill text
  useEffect(() => {
    if (prefillText !== undefined && prefillText !== '') {
      updateBuffer(prefillText);
      setCursorPosition(prefillText.length);
      onPrefillConsumedRef.current?.();
    }
  }, [prefillText, updateBuffer, setCursorPosition]);

  // Use refs for agent and activityStream to avoid stale closures in useInput
  // This is critical for interrupt handling - a stale agent reference can cause
  // USER_INTERRUPT_INITIATED to fire but AGENT_END to never fire, leaving UI stuck
  const agentRef = useRef(agent);
  const activityStreamRef = useRef(activityStream);
  useEffect(() => {
    agentRef.current = agent;
  }, [agent]);
  useEffect(() => {
    activityStreamRef.current = activityStream;
  }, [activityStream]);

  // History navigation state
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [historyBuffer, setHistoryBuffer] = useState(''); // Store current input when navigating history
  const [historyBufferCursor, setHistoryBufferCursor] = useState(0); // Store cursor position when entering history

  // Completion state
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [showCompletions, setShowCompletions] = useState(false);
  const completionRequestIdRef = useRef(0);
  const completionsRef = useRef<Completion[]>([]);
  const completionIndexRef = useRef(0);
  const completionSourceRef = useRef<{ input: string; cursorPosition: number } | null>(null);

  const replaceCompletions = React.useCallback((nextCompletions: Completion[]) => {
    const previousSelection = completionsRef.current[completionIndexRef.current];
    const matchingIndex = previousSelection
      ? nextCompletions.findIndex(
          completion =>
            completion.type === previousSelection.type &&
            completion.value === previousSelection.value &&
            completion.insertText === previousSelection.insertText
        )
      : -1;
    const nextIndex = matchingIndex >= 0 ? matchingIndex : 0;

    completionsRef.current = nextCompletions;
    completionIndexRef.current = nextIndex;
    setCompletions(nextCompletions);
    setCompletionIndex(nextIndex);
  }, []);

  const updateCompletionIndex = React.useCallback((update: (index: number) => number) => {
    setCompletionIndex(index => {
      const nextIndex = update(index);
      completionIndexRef.current = nextIndex;
      return nextIndex;
    });
  }, []);

  const dismissCompletions = React.useCallback((invalidatePending: boolean = true) => {
    if (invalidatePending) completionRequestIdRef.current++;
    completionSourceRef.current = null;
    completionsRef.current = [];
    completionIndexRef.current = 0;
    setShowCompletions(false);
    setCompletions([]);
    setCompletionIndex(0);
  }, []);

  // Double-escape mechanism for rewind (2x Esc within 500ms)
  const escCountRef = useRef(0);
  const escTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Exit confirmation mechanism (Ctrl+C on empty buffer - 1s to confirm)
  const [isWaitingForExitConfirmation, setIsWaitingForExitConfirmation] = useState(false);
  const exitConfirmationTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Notify parent when exit confirmation state changes
  useEffect(() => {
    onExitConfirmationChange?.(isWaitingForExitConfirmation);
  }, [isWaitingForExitConfirmation, onExitConfirmationChange]);

  // A replacement provider must invalidate in-flight completion results.
  useEffect(
    () => () => {
      completionRequestIdRef.current++;
    },
    [completionProvider]
  );

  const refreshCompletions = React.useCallback(
    async (input: string, cursor: number, activeHistoryIndex: number): Promise<Completion[] | null> => {
      const requestId = ++completionRequestIdRef.current;
      if (!completionProvider || !input.trim() || activeHistoryIndex !== -1) {
        completionSourceRef.current = null;
        replaceCompletions([]);
        setShowCompletions(false);
        return [];
      }

      let results: Completion[];
      try {
        results = await completionProvider.getCompletions(input, cursor);
      } catch (error) {
        if (requestId === completionRequestIdRef.current) {
          completionSourceRef.current = null;
        }
        logger.debug(`[COMPLETION] Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
      if (requestId !== completionRequestIdRef.current) return null;
      completionSourceRef.current = { input, cursorPosition: cursor };
      replaceCompletions(results);
      setShowCompletions(results.length > 0);
      return results;
    },
    [completionProvider, replaceCompletions]
  );

  const updateCompletions = React.useCallback(
    () => refreshCompletions(buffer, cursorPosition, historyIndex),
    [buffer, cursorPosition, historyIndex, refreshCompletions]
  );

  /**
   * Debounced completion update
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      void updateCompletions();
    }, UI_DELAYS.COMPLETION_DEBOUNCE);

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [updateCompletions]);

  /**
   * Apply selected completion
   */
  const applyCompletion = (
    completion: Completion,
    input: string,
    cursor: number,
    options: CompletionApplicationOptions = {}
  ) => {
    // Clear prompt prefill highlight if user modifies buffer
    if (promptPrefilled) {
      onPromptPrefilledClear?.();
    }

    completionRequestIdRef.current++;
    const application = applyCompletionToInput(input, cursor, completion, options);

    updateBuffer(application.nextValue);
    cursorPositionRef.current = application.nextCursorPosition;
    setCursorPosition(application.nextCursorPosition);
    dismissCompletions(false);

    return application;
  };

  const completionSourceIsCurrent = (): boolean => {
    const source = completionSourceRef.current;
    return Boolean(source && source.input === bufferRef.current && source.cursorPosition === cursorPositionRef.current);
  };

  const acceptCompletion = async (key: 'enter' | 'tab'): Promise<void> => {
    const input = bufferRef.current;
    const cursor = cursorPositionRef.current;
    const previousSelection = completionsRef.current[completionIndexRef.current];
    let available = completionsRef.current;

    if (!completionSourceIsCurrent()) {
      const refreshed = await refreshCompletions(input, cursor, -1);
      if (!refreshed) return;
      available = refreshed;
    }

    const completion = previousSelection
      ? (available.find(
          candidate =>
            candidate.type === previousSelection.type &&
            candidate.value === previousSelection.value &&
            candidate.insertText === previousSelection.insertText
        ) ?? available[0])
      : (available[completionIndexRef.current] ?? available[0]);

    if (!completion) {
      if (key === 'enter') void handleSubmit(input);
      return;
    }

    const decision = getCompletionAcceptDecision(completion, key);

    // A suggestion the user already typed in full leaves the buffer unchanged.
    // Enter then means "run this", not "accept it again".
    const preview = applyCompletionToInput(input, cursor, completion, {
      appendSpace: decision.appendSpace,
    });
    if (key === 'enter' && !decision.submit && preview.nextValue.trimEnd() === input.trimEnd()) {
      dismissCompletions();
      void handleSubmit(input);
      return;
    }

    const application = applyCompletion(completion, input, cursor, {
      appendSpace: decision.appendSpace,
    });
    if (decision.submit) void handleSubmit(application.nextValue);
  };

  /**
   * Navigate history backward (older)
   */
  const navigateHistoryPrevious = (): boolean => {
    if (!commandHistory) return false;

    completionRequestIdRef.current++;

    // First time navigating - save current buffer and cursor position
    if (historyIndex === -1) {
      setHistoryBuffer(buffer);
      setHistoryBufferCursor(cursorPosition);
    }

    const result = commandHistory.getPrevious(historyIndex);
    if (result) {
      updateBuffer(result.command);
      // Shell-style history recall places editing at the end of the entry.
      setCursorPosition(result.command.length);
      setHistoryIndex(result.index);
      dismissCompletions(false);
      return true;
    }
    return false;
  };

  /**
   * Navigate history forward (newer)
   */
  const navigateHistoryNext = (): boolean => {
    if (!commandHistory || historyIndex === -1) return false;

    completionRequestIdRef.current++;

    const result = commandHistory.getNext(historyIndex);
    if (result) {
      updateBuffer(result.command);
      setCursorPosition(result.command.length);
      setHistoryIndex(result.index);
    } else {
      // Reached end - restore original buffer and cursor position
      updateBuffer(historyBuffer);
      setCursorPosition(historyBufferCursor);
      setHistoryIndex(-1);
    }
    dismissCompletions(false);
    return true;
  };

  /**
   * Submit input
   */
  const resetInputState = () => {
    completionRequestIdRef.current++;
    updateBuffer('');
    setCursorPosition(0);
    setHistoryIndex(-1);
    setHistoryBuffer('');
    setHistoryBufferCursor(0);
    dismissCompletions(false);
  };

  const handleSubmit = (inputValue = buffer, followUp = false, background = false) => {
    if (conversationReadOnly) return;
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    // History owns its asynchronous persistence. Message admission and buffer
    // ownership must not wait for disk I/O or a debounced save.
    commandHistory?.addCommand(trimmed);
    resetInputState();

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
    const {
      directories: extractedDirectories,
      images: extractedImages,
      files: extractedFiles,
    } = classifyPaths(extractedPaths);

    // Call callback with mentions if any
    const mentions = {
      ...(extractedDirectories.length > 0 && { directories: extractedDirectories }),
      ...(extractedFiles.length > 0 && { files: extractedFiles }),
      ...(extractedImages.length > 0 && { images: extractedImages }),
    };
    (background && onBackgroundAndSubmit ? onBackgroundAndSubmit : followUp && onFollowUp ? onFollowUp : onSubmit)(trimmed, Object.keys(mentions).length > 0 ? mentions : undefined);
  };

  const textInputActive = isActive && !fleetFocused;

  /**
   * Handle value changes from TextInput
   */
  const handleValueChange = (newValue: string) => {
    // Clear prompt prefill highlight if user modifies buffer
    if (promptPrefilled) {
      onPromptPrefilledClear?.();
    }
    completionRequestIdRef.current++;
    updateBuffer(newValue);
    setHistoryIndex(-1); // Reset history when editing
  };

  /**
   * Handle cursor changes from TextInput
   */
  const handleCursorChange = (newPosition: number) => {
    completionRequestIdRef.current++;
    cursorPositionRef.current = newPosition;
    setCursorPosition(newPosition);
  };

  /**
   * Handle submit from TextInput
   */
  const handleTextInputSubmit = (value: string) => {
    if (conversationReadOnly) return;
    const message = value.trim();
    if (!message) return;

    // Slash commands always execute immediately, even during agent processing
    if (message.startsWith('/')) {
      void handleSubmit(value);
      return;
    }

    // Check if agent is processing - if so, this is an interjection
    if (agent && agent.isProcessing()) {
      // This is an interjection mid-response
      if (onInterjection) {
        onInterjection(message);
        // Clear buffer after interjection
        resetInputState();
      }
    } else {
      // Normal submission
      void handleSubmit(value);
    }
  };

  /**
   * Handle Ctrl+C on empty buffer from TextInput
   * First press starts exit confirmation, second press within 1s exits
   */
  const handleCtrlC = () => {
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
  };

  useEffect(
    () => () => {
      completionRequestIdRef.current++;
      if (escTimerRef.current) clearTimeout(escTimerRef.current);
      if (exitConfirmationTimerRef.current) clearTimeout(exitConfirmationTimerRef.current);
    },
    []
  );

  const handlePromptEscape = () => {
    // Dismissal is local and non-destructive. It never interrupts a running
    // agent on the same keypress.
    if (showCompletions) {
      dismissCompletions();
      return;
    }

    if (conversationReadOnly) {
      onExitAgent?.();
      return;
    }

    const currentAgentRef = agentRef.current;
    const currentActivityStream = activityStreamRef.current;

    if (isViewingAgent && buffer.length === 0 && onExitAgent && !currentAgentRef?.isProcessing?.()) {
      onExitAgent();
      return;
    }

    if (currentAgentRef?.isProcessing() || currentAgentRef?.getInputQueue?.().isExecuting()) {
      logger.debug('[INPUT] Escape - interrupting main agent');
      currentActivityStream?.emit({
        id: `user-interrupt-${Date.now()}`,
        type: ActivityEventType.USER_INTERRUPT_INITIATED,
        timestamp: Date.now(),
        data: {},
      });
      currentAgentRef.getSession().cancel();
      currentActivityStream?.emit({
        id: `interrupt-${Date.now()}`,
        type: ActivityEventType.INTERRUPT_ALL,
        timestamp: Date.now(),
        data: {},
      });
      return;
    }

    if (currentAgent && currentAgent !== defaultAgent && onSwitchToDefault) {
      logger.debug('[INPUT] Escape - returning to default agent:', defaultAgent);
      onSwitchToDefault();
      return;
    }

    if (currentActivityStream) {
      escCountRef.current += 1;
      if (escTimerRef.current) clearTimeout(escTimerRef.current);
      escTimerRef.current = setTimeout(() => {
        escCountRef.current = 0;
      }, UI_DELAYS.ESC_RESET);

      if (escCountRef.current >= 2) {
        const requestId = `rewind_${Date.now()}`;
        currentActivityStream.emit({
          id: requestId,
          type: ActivityEventType.REWIND_REQUEST,
          timestamp: Date.now(),
          data: { requestId },
        });
        escCountRef.current = 0;
      }
    }
  };

  /**
   * Synchronous key arbitration for the live editor. Returning true guarantees
   * TextInput will not also move its cursor or mutate its buffer for this key.
   */
  const handleEditorKeyCapture = (_input: string, key: Key): boolean => {
    if (key.ctrl && _input === 'b' && onBackgroundCommand) {
      onBackgroundCommand();
      return true;
    }
    if (key.ctrl && key.return && onBackgroundAndSubmit) {
      handleSubmit(bufferRef.current, false, true);
      return true;
    }
    // Ink 4 strips the ESC prefix from Alt+Enter but leaves return=false.
    if ((key.meta && key.return) || (_input === '\r' && !key.return)) {
      if (onFollowUp) handleSubmit(bufferRef.current, true);
      return true;
    }
    if (key.meta && key.upArrow && onRecallFollowUp && !bufferRef.current) {
      const recalled = onRecallFollowUp();
      if (recalled !== undefined) {
        updateBuffer(recalled);
        setCursorPosition(recalled.length);
      }
      return true;
    }
    if (showCompletions) {
      if (key.upArrow) {
        updateCompletionIndex(index => moveCompletionSelection(index, completions.length, -1));
        return true;
      }
      if (key.downArrow) {
        updateCompletionIndex(index => moveCompletionSelection(index, completions.length, 1));
        return true;
      }
      if (key.pageUp || key.pageDown) {
        const delta = key.pageUp ? -8 : 8;
        updateCompletionIndex(index => Math.max(0, Math.min(completions.length - 1, index + delta)));
        return true;
      }
      if (key.return && !key.shift) {
        void acceptCompletion('enter');
        return true;
      }
    }

    if (key.downArrow && fleetCount > 0 && buffer.length === 0 && onEnterFleet) {
      onEnterFleet();
      return true;
    }

    if (key.upArrow) {
      if (shouldNavigateHistoryPrevious(buffer, cursorPosition, historyIndex !== -1)) {
        navigateHistoryPrevious();
        return true;
      }
      return false;
    }

    if (key.downArrow) {
      if (historyIndex !== -1 || shouldNavigateHistoryNext(buffer, cursorPosition, false)) {
        navigateHistoryNext();
        return true;
      }
      if (shouldConsumeHistoryNextAtDraft(buffer, false)) return true;
      return false;
    }

    if (key.tab) {
      if (key.shift && onPermissionModeCycle) {
        onPermissionModeCycle();
        return true;
      }
      if (showCompletions) {
        void acceptCompletion('tab');
      } else {
        void updateCompletions();
      }
      return true;
    }

    if (key.escape) {
      handlePromptEscape();
      return true;
    }

    return false;
  };

  // Fleet focus and application shortcuts are separate from editor key capture.
  useInput(
    (input, key) => {
      if (!isActive || key.eventType === 'release') return;

      if (fleetFocused && key.ctrl && input === 'b') {
        onBackgroundCommand?.();
        return;
      }

      // ===== Background Agent Fleet Navigation =====
      // A focus region (NOT a modal) that coexists with the live prompt.
      if (fleetFocused && onFleetNavigate) {
        const listSize = fleetCount + 1; // [main, ...agents]
        if (key.upArrow) {
          if (fleetSelectedIndex <= 0) {
            onExitFleet?.(); // up past 'main' returns focus to the prompt
          } else {
            onFleetNavigate(Math.max(0, fleetSelectedIndex - 1));
          }
          return;
        }
        if (key.downArrow) {
          onFleetNavigate(Math.min(listSize - 1, fleetSelectedIndex + 1));
          return;
        }
        if (key.return) {
          onEnterAgent?.(fleetSelectedIndex);
          return;
        }
        // 'x' kills the selected agent (never the 'main' row at index 0).
        if (input === 'x' && fleetSelectedIndex > 0) {
          onKillAgent?.(fleetSelectedIndex);
          return;
        }
        if (key.escape) {
          onExitFleet?.();
          return;
        }
        return; // block other keys while the fleet has focus
      }

      // ===== Ctrl+O: open or close the tool calls in the live region =====
      if (key.ctrl && input === 'o' && onToggleToolOutput) {
        onToggleToolOutput();
        return;
      }

      // Note: Exit confirmation (Ctrl+C on empty buffer) is now handled
      // via TextInput's onCtrlC callback -> handleCtrlC
    },
    { isActive }
  );

  // Determine prompt style based on first character
  const isCommandMode = buffer.startsWith('/');
  const isBashMode = buffer.startsWith('!');
  const isMemoryMode = buffer.startsWith('#');

  let promptText = '> ';
  let borderColor: string = prominent ? UI_COLORS.PRIMARY : UI_COLORS.TEXT_DIM;

  if (isCommandMode) {
    promptText = '/ ';
    borderColor = UI_COLORS.TEXT_DIM;
  } else if (isBashMode) {
    promptText = '! ';
    borderColor = UI_COLORS.TEXT_DIM;
  } else if (isMemoryMode) {
    promptText = '# ';
    borderColor = UI_COLORS.MEMORY;
  }

  // Keep unrestricted approval visible even while editing a command.
  if (permissionMode === 'allow-all') {
    borderColor = UI_COLORS.ERROR;
  }

  // Override border color when prompt is prefilled from library (primary color)
  if (promptPrefilled && permissionMode !== 'allow-all') {
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
        onKeyPressCapture={handleEditorKeyCapture}
        onSubmit={handleTextInputSubmit}
        onCtrlC={handleCtrlC}
        isActive={textInputActive}
        suppressVerticalNavigation={showCompletions || historyIndex !== -1}
        multiline={true}
        placeholder={placeholder}
        bordered={prominent}
        borderColor={borderColor}
        maxVisibleRows={prominent ? Math.max(1, Math.min(5, Math.floor(terminalRows / 6))) : undefined}
        showPrompt={true}
        promptText={promptText}
        promptColor={borderColor}
      />

      {/* Completion dropdown */}
      {showCompletions && (
        <CompletionDropdown
          completions={completions}
          selectedIndex={completionIndex}
          visible={showCompletions}
          maxHeight={prominent ? Math.max(1, Math.min(4, Math.floor(terminalRows / 8))) : undefined}
        />
      )}
    </Box>
  );
};
