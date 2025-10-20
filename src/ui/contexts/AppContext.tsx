/**
 * AppContext - Global application state management
 *
 * Provides centralized state for messages, configuration, context usage,
 * and active tool calls. This context enables components throughout the
 * tree to access and update global application state.
 */

import React, { createContext, useContext, useState, useCallback } from 'react';
import type { Message, Config, ToolCallState } from '../../types/index.js';

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

  // Actions
  const addMessage = useCallback((message: Message) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  const updateConfig = useCallback((updates: Partial<Config>) => {
    setConfig((prev) => ({ ...prev, ...updates }));
  }, []);

  const addToolCall = useCallback((toolCall: ToolCallState) => {
    setActiveToolCalls((prev) => [...prev, toolCall]);
  }, []);

  const updateToolCall = useCallback((id: string, updates: Partial<ToolCallState>) => {
    setActiveToolCalls((prev) =>
      prev.map((call) => (call.id === id ? { ...call, ...updates } : call))
    );
  }, []);

  const removeToolCall = useCallback((id: string) => {
    setActiveToolCalls((prev) => prev.filter((call) => call.id !== id));
  }, []);

  const clearToolCalls = useCallback(() => {
    setActiveToolCalls([]);
  }, []);

  // Build context value
  const value: AppContextValue = {
    state: {
      messages,
      config,
      contextUsage,
      activeToolCallsCount: activeToolCalls.length,
      activeToolCalls,
    },
    actions: {
      addMessage,
      setMessages,
      updateConfig,
      setContextUsage,
      addToolCall,
      updateToolCall,
      removeToolCall,
      clearToolCalls,
    },
  };

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
