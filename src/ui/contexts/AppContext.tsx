/**
 * AppContext - Global application state management
 *
 * Provides centralized state for messages, configuration, context usage,
 * and active tool calls. This context enables components throughout the
 * tree to access and update global application state.
 */

import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import type { Message, Config, ToolCallState } from '../../types/index.js';
import { UI_DELAYS } from '../../config/constants.js';

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

  /** Force Static component to remount (for rewind/compaction) */
  forceStaticRemount: () => void;
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
  const [staticRemountKey, setStaticRemountKey] = useState<number>(0);

  // Batching mechanism for tool call updates
  const pendingUpdatesRef = useRef<Map<string, Partial<ToolCallState>>>(new Map());
  const updateTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Actions
  const addMessage = useCallback((message: Message) => {
    // Add timestamp if not present
    const messageWithTimestamp = {
      ...message,
      timestamp: message.timestamp || Date.now(),
    };
    setMessages((prev) => [...prev, messageWithTimestamp]);
  }, []);

  const setMessagesWithTimestamps = useCallback((newMessages: Message[]) => {
    // Add timestamps to messages that don't have them
    const messagesWithTimestamps = newMessages.map((msg, idx) => ({
      ...msg,
      timestamp: msg.timestamp || Date.now() + idx, // Add small offset for ordering
    }));
    setMessages(messagesWithTimestamps);
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

  const forceStaticRemount = useCallback(() => {
    setStaticRemountKey((prev) => prev + 1);
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
    staticRemountKey,
  }), [messages, config, contextUsage, activeToolCalls, isThinking, streamingContent, isCompacting, compactionNotices, staticRemountKey]);

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
    forceStaticRemount,
  }), [addMessage, setMessagesWithTimestamps, updateConfig, setContextUsage, addToolCall, updateToolCall, removeToolCall, clearToolCalls, setIsThinking, setStreamingContent, setIsCompacting, addCompactionNotice, forceStaticRemount]);

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
