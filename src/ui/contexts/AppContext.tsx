/**
 * AppContext - Global application state management
 *
 * Provides centralized state for messages, configuration, context usage,
 * and active tool calls. This context enables components throughout the
 * tree to access and update global application state.
 */

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { Message, Config, ToolCallState } from '@shared/index.js';
import { UI_DELAYS } from '@config/constants.js';
import { generateMessageId } from '@utils/id.js';

/**
 * Compaction notice for UI display
 */
export interface CompactionNotice {
  id: string;
  timestamp: number;
  oldContextUsage: number;
  threshold: number;
}

/**
 * Rewind notice for UI display
 */
export interface RewindNotice {
  id: string;
  timestamp: number;
  targetMessageIndex: number;
  restoredFiles?: string[];
  failedRestorations?: string[];
}

/**
 * Global application state
 */
export interface AppState {
  /** Conversation message history */
  messages: Message[];

  /** Application configuration */
  config: Config;

  /** Current context usage percentage (0-100) */
  contextUsage: number;

  /** Number of active tool calls */
  activeToolCallsCount: number;

  /** Active tool call states */
  activeToolCalls: ToolCallState[];

  /** Whether the assistant is currently thinking/processing */
  isThinking: boolean;

  /** Current streaming assistant content (if any) */
  streamingContent?: string;

  /** Whether the conversation is being compacted */
  isCompacting: boolean;

  /** Compaction notices to display in conversation */
  compactionNotices: CompactionNotice[];

  /** Rewind notices to display in conversation */
  rewindNotices: RewindNotice[];

  /** Counter to force Static component remount (for rewind/compaction) */
  staticRemountKey: number;
}

/**
 * Actions to update application state
 */
export interface AppActions {
  /** Add a message to the conversation */
  addMessage: (message: Message) => void;

  /** Update multiple messages at once */
  setMessages: (messages: Message[]) => void;

  /** Update configuration */
  updateConfig: (config: Partial<Config>) => void;

  /** Update context usage percentage */
  setContextUsage: (percentage: number) => void;

  /** Add an active tool call */
  addToolCall: (toolCall: ToolCallState) => void;

  /** Update an existing tool call */
  updateToolCall: (id: string, updates: Partial<ToolCallState>) => void;

  /** Remove a tool call (when completed or cancelled) */
  removeToolCall: (id: string) => void;

  /** Clear all active tool calls */
  clearToolCalls: () => void;

  /** Set thinking state */
  setIsThinking: (isThinking: boolean) => void;

  /** Set streaming content */
  setStreamingContent: (content?: string) => void;

  /** Set compacting state */
  setIsCompacting: (isCompacting: boolean) => void;

  /** Add a compaction notice */
  addCompactionNotice: (notice: CompactionNotice) => void;

  /** Add a rewind notice */
  addRewindNotice: (notice: RewindNotice) => void;

  /** Clear all rewind notices */
  clearRewindNotices: () => void;

  /** Force Static component to remount (for rewind/compaction) */
  forceStaticRemount: () => void;

  /** Atomically reset conversation view with new messages (for resume/compact/rewind) */
  resetConversationView: (messages: Message[]) => void;
}

/**
 * Combined app context value
 */
export interface AppContextValue {
  state: AppState;
  actions: AppActions;
}

/**
 * Context for global app state
 */
export const AppContext = createContext<AppContextValue | null>(null);

/**
 * Props for AppProvider
 */
export interface AppProviderProps {
  initialConfig: Config;
  children: React.ReactNode;
}

/**
 * Provider component for global app state
 *
 * Manages all application state and provides actions to update it.
 *
 * @example
 * ```tsx
 * <AppProvider initialConfig={config}>
 *   <App />
 * </AppProvider>
 * ```
 */
export const AppProvider: React.FC<AppProviderProps> = ({
  initialConfig,
  children,
}) => {
  // State
  const [messages, setMessages] = useState<Message[]>([]);
  const [config, setConfig] = useState<Config>(initialConfig);
  const [contextUsage, setContextUsage] = useState<number>(0);
  const [activeToolCalls, setActiveToolCalls] = useState<ToolCallState[]>([]);
  const [isThinking, setIsThinking] = useState<boolean>(false);
  const [streamingContent, setStreamingContent] = useState<string | undefined>(undefined);
  const [isCompacting, setIsCompacting] = useState<boolean>(false);
  const [compactionNotices, setCompactionNotices] = useState<CompactionNotice[]>([]);
  const [rewindNotices, setRewindNotices] = useState<RewindNotice[]>([]);
  const [staticRemountKey, setStaticRemountKey] = useState<number>(0);

  // Batching mechanism for tool call updates
  const pendingUpdatesRef = useRef<Map<string, Partial<ToolCallState>>>(new Map());
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Actions
  const addMessage = useCallback((message: Message) => {
    // Add ID and timestamp if not present
    const messageWithMetadata = {
      ...message,
      id: message.id || generateMessageId(),
      timestamp: message.timestamp || Date.now(),
    };

    setMessages((prev) => {
      // Check for duplicate by ID
      if (prev.some(m => m.id === messageWithMetadata.id)) {
        return prev;
      }
      return [...prev, messageWithMetadata];
    });
  }, []);

  const setMessagesWithTimestamps = useCallback((newMessages: Message[]) => {
    // Add IDs and timestamps to messages that don't have them
    const messagesWithMetadata = newMessages.map((msg, idx) => ({
      ...msg,
      id: msg.id || generateMessageId(),
      timestamp: msg.timestamp || Date.now() + idx, // Add small offset for ordering
    }));

    // Deduplicate by ID - keep first occurrence of each unique ID
    const seen = new Set<string>();
    const deduplicated = messagesWithMetadata.filter(msg => {
      if (!msg.id || seen.has(msg.id)) {
        return false;
      }
      seen.add(msg.id);
      return true;
    });

    setMessages(deduplicated);
  }, []);

  const updateConfig = useCallback((updates: Partial<Config>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  }, []);

  const addToolCall = useCallback((toolCall: ToolCallState) => {
    // Enforce structure: tool calls MUST have IDs
    if (!toolCall.id) {
      throw new Error(`Cannot add tool call without ID. Tool: ${toolCall.toolName}`);
    }

    setActiveToolCalls((prev) => {
      // Check if tool call already exists by ID (prevent duplicates)
      const exists = prev.some(tc => tc.id === toolCall.id);
      if (exists) {
        throw new Error(`Duplicate tool call detected. ID ${toolCall.id} already exists. Tool: ${toolCall.toolName}`);
      }

      return [...prev, toolCall];
    });
  }, []);

  // Flush pending updates
  const flushPendingUpdates = useCallback(() => {
    if (pendingUpdatesRef.current.size === 0) return;

    const updates = new Map(pendingUpdatesRef.current);
    pendingUpdatesRef.current.clear();

    setActiveToolCalls((prev) => {
      // Only create new array if something actually changed
      let hasChanges = false;
      const newArray = prev.map((call) => {
        const update = updates.get(call.id);
        if (update) {
          hasChanges = true;
          return { ...call, ...update };
        }
        return call;
      });
      return hasChanges ? newArray : prev;
    });
  }, []);

  const updateToolCall = useCallback((id: string, updates: Partial<ToolCallState>) => {
    // Enforce structure: ID must exist
    if (!id) {
      throw new Error(`Cannot update tool call without ID`);
    }

    // Merge with any pending updates for this ID
    const existing = pendingUpdatesRef.current.get(id) || {};
    pendingUpdatesRef.current.set(id, { ...existing, ...updates });

    // Clear existing timeout
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
    }

    // Batch updates - flush after one frame
    updateTimeoutRef.current = setTimeout(() => {
      flushPendingUpdates();
    }, UI_DELAYS.TOOL_CALL_BATCH_FLUSH);
  }, [flushPendingUpdates]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
        flushPendingUpdates();
      }
    };
  }, [flushPendingUpdates]);

  const removeToolCall = useCallback((id: string) => {
    setActiveToolCalls((prev) => prev.filter((call) => call.id !== id));
  }, []);

  const clearToolCalls = useCallback(() => {
    setActiveToolCalls([]);
  }, []);

  const addCompactionNotice = useCallback((notice: CompactionNotice) => {
    setCompactionNotices((prev) => [...prev, notice]);
  }, []);

  const addRewindNotice = useCallback((notice: RewindNotice) => {
    setRewindNotices((prev) => [...prev, notice]);
  }, []);

  const clearRewindNotices = useCallback(() => {
    setRewindNotices([]);
  }, []);

  const forceStaticRemount = useCallback(() => {
    setStaticRemountKey((prev) => prev + 1);
  }, []);

  const resetConversationView = useCallback((newMessages: Message[]) => {
    // Add metadata and deduplicate messages
    const messagesWithMetadata = newMessages.map((msg, idx) => ({
      ...msg,
      id: msg.id || generateMessageId(),
      timestamp: msg.timestamp || Date.now() + idx,
    }));

    const seen = new Set<string>();
    const deduplicated = messagesWithMetadata.filter(msg => {
      if (!msg.id || seen.has(msg.id)) {
        return false;
      }
      seen.add(msg.id);
      return true;
    });

    // CRITICAL: Clear messages and remount key FIRST, then clear terminal, then set new messages
    // This ensures the old Static component unmounts cleanly before terminal clear
    setMessages([]);
    setStaticRemountKey((prev) => prev + 1);

    // Use setImmediate to ensure React has processed the empty state before we clear and set new content
    setImmediate(() => {
      // Clear terminal AFTER old Static has unmounted
      // \x1B[2J = Clear entire screen
      // \x1B[3J = Clear scrollback buffer
      // \x1B[H = Move cursor to home (0,0)
      process.stdout.write('\x1B[2J\x1B[3J\x1B[H');

      // Now set the new messages
      setMessages(deduplicated);
    });
  }, []);

  // Memoize state object to prevent unnecessary context updates
  const state = React.useMemo(() => ({
    messages,
    config,
    contextUsage,
    activeToolCallsCount: activeToolCalls.length,
    activeToolCalls,
    isThinking,
    streamingContent,
    isCompacting,
    compactionNotices,
    rewindNotices,
    staticRemountKey,
  }), [messages, config, contextUsage, activeToolCalls, isThinking, streamingContent, isCompacting, compactionNotices, rewindNotices, staticRemountKey]);

  // Memoize actions object to prevent unnecessary context updates
  const actions = React.useMemo(() => ({
    addMessage,
    setMessages: setMessagesWithTimestamps,
    updateConfig,
    setContextUsage,
    addToolCall,
    updateToolCall,
    removeToolCall,
    clearToolCalls,
    setIsThinking,
    setStreamingContent,
    setIsCompacting,
    addCompactionNotice,
    addRewindNotice,
    clearRewindNotices,
    forceStaticRemount,
    resetConversationView,
  }), [addMessage, setMessagesWithTimestamps, updateConfig, setContextUsage, addToolCall, updateToolCall, removeToolCall, clearToolCalls, setIsThinking, setStreamingContent, setIsCompacting, addCompactionNotice, addRewindNotice, clearRewindNotices, forceStaticRemount, resetConversationView]);

  // Memoize context value to prevent unnecessary re-renders of consumers
  const value: AppContextValue = React.useMemo(() => ({
    state,
    actions,
  }), [state, actions]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

/**
 * Hook to access app state and actions
 *
 * @throws Error if used outside AppProvider
 * @returns App state and actions
 *
 * @example
 * ```tsx
 * const { state, actions } = useAppContext();
 *
 * // Access state
 * console.log('Messages:', state.messages);
 * console.log('Context usage:', state.contextUsage);
 *
 * // Update state
 * actions.addMessage({ role: 'user', content: 'Hello!' });
 * actions.setContextUsage(75);
 * ```
 */
export const useAppContext = (): AppContextValue => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useAppContext must be used within AppProvider');
  }
  return context;
};
