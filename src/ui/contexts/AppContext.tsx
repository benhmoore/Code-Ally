/** Application presentation state backed by the conversation owner's projection. */
import React, { createContext, useContext, useState, useCallback, useSyncExternalStore } from 'react';
import { useStdout } from 'ink';
import type { Message, Config } from '@shared/index.js';
import type { ConversationViewStore, ConversationViewSnapshot } from '@services/ConversationViewStore.js';

export type CompactionNotice = ConversationViewSnapshot['compactionNotices'][number];
export type StatusMessage = ConversationViewSnapshot['statusMessages'][number];

export interface RewindNotice {
  id: string;
  timestamp: number;
  targetMessageIndex: number;
  restoredFiles?: string[];
  failedRestorations?: string[];
}

export interface AppState extends ConversationViewSnapshot {
  config: Config;
  activeToolCallsCount: number;
  rewindNotices: RewindNotice[];
  staticRemountKey: number;
  currentAgent: string;
  currentAgentModel: string;
  activeSubAgents: string[];
  activeAgentId: string;
}

export interface AppActions {
  addMessage: (message: Message) => void;
  updateConfig: (config: Partial<Config>) => void;
  setContextUsage: (percentage: number) => void;
  toggleToolCallExpanded: (id: string) => void;
  setToolCallsExpanded: (expanded: boolean) => void;
  addRewindNotice: (notice: RewindNotice) => void;
  clearRewindNotices: () => void;
  forceStaticRemount: () => void;
  /** Repaint the owner's current projection without replacing conversation state. */
  repaintConversationSurface: () => void;
  setCurrentAgent: (agent: string, model?: string) => void;
  addSubAgent: (agentName: string) => void;
  removeSubAgent: (agentName: string) => void;
  setActiveAgentId: (agentId: string) => void;
}

export interface AppContextValue {
  state: AppState;
  actions: AppActions;
}
export const AppContext = createContext<AppContextValue | null>(null);

export interface AppProviderProps {
  conversationStore: Pick<ConversationViewStore,
    'getSnapshot' | 'subscribe' | 'addDisplayMessage' | 'setContextUsage' | 'toggleToolCallExpanded' | 'setToolCallsExpanded'>;
  initialConfig: Config;
  children: React.ReactNode;
}

export function resolveCurrentAgentModelOverride(
  agentModel: string | undefined,
  configModel: string | null | undefined
): string {
  return agentModel && agentModel !== configModel ? agentModel : '';
}

/** Clear the terminal through Ink so its cached dynamic frame is restored. */
export function clearTerminalPreservingInk(write: (data: string) => void): void {
  write('\x1B[2J\x1B[3J\x1B[H');
}

export function reconcileCurrentAgentModelAfterConfigUpdate(
  currentAgentModel: string,
  previousConfig: Config,
  updates: Partial<Config>
): string {
  return Object.prototype.hasOwnProperty.call(updates, 'model') && currentAgentModel === previousConfig.model
    ? ''
    : currentAgentModel;
}

/** Keep UI preferences and navigation local; the session owns conversation state. */
export const AppProvider: React.FC<AppProviderProps> = ({ initialConfig, conversationStore, children }) => {
  const { write: writeToStdout } = useStdout();
  const runtimeView = useSyncExternalStore(conversationStore.subscribe, conversationStore.getSnapshot);
  const [config, setConfig] = useState(initialConfig);
  const [rewindNotices, setRewindNotices] = useState<RewindNotice[]>([]);
  const [staticRemountKey, setStaticRemountKey] = useState(0);
  const [currentAgent, setCurrentAgentState] = useState(initialConfig.default_agent || 'ally');
  const [currentAgentModel, setCurrentAgentModel] = useState('');
  const [activeSubAgents, setActiveSubAgents] = useState<string[]>([]);
  const [activeAgentId, setActiveAgentId] = useState('main');

  const updateConfig = useCallback((updates: Partial<Config>) => {
    setCurrentAgentModel(current => reconcileCurrentAgentModelAfterConfigUpdate(current, config, updates));
    setConfig(previous => ({ ...previous, ...updates }));
  }, [config]);
  const addRewindNotice = useCallback((notice: RewindNotice) => {
    setRewindNotices(previous => [...previous, notice].slice(-100));
  }, []);
  const clearRewindNotices = useCallback(() => setRewindNotices([]), []);
  const forceStaticRemount = useCallback(() => setStaticRemountKey(previous => previous + 1), []);
  const repaintConversationSurface = useCallback(() => {
    // Clear before remounting Static so the replacement projection is not erased.
    clearTerminalPreservingInk(writeToStdout);
    setStaticRemountKey(previous => previous + 1);
  }, [writeToStdout]);
  const setCurrentAgent = useCallback((agent: string, model?: string) => {
    setCurrentAgentState(agent);
    setCurrentAgentModel(resolveCurrentAgentModelOverride(model, config.model));
  }, [config.model]);
  const addSubAgent = useCallback((name: string) => {
    setActiveSubAgents(previous => previous.includes(name) ? previous : [...previous, name]);
  }, []);
  const removeSubAgent = useCallback((name: string) => {
    setActiveSubAgents(previous => previous.filter(candidate => candidate !== name));
  }, []);

  const state: AppState = React.useMemo(() => ({
    ...runtimeView, config, activeToolCallsCount: runtimeView.activeToolCalls.length,
    rewindNotices, staticRemountKey, currentAgent, currentAgentModel, activeSubAgents, activeAgentId,
  }), [runtimeView, config, rewindNotices, staticRemountKey, currentAgent, currentAgentModel, activeSubAgents, activeAgentId]);
  const actions: AppActions = React.useMemo(() => ({
    addMessage: conversationStore.addDisplayMessage,
    setContextUsage: conversationStore.setContextUsage,
    toggleToolCallExpanded: conversationStore.toggleToolCallExpanded,
    setToolCallsExpanded: conversationStore.setToolCallsExpanded,
    updateConfig, addRewindNotice, clearRewindNotices, forceStaticRemount,
    repaintConversationSurface, setCurrentAgent, addSubAgent, removeSubAgent, setActiveAgentId,
  }), [conversationStore, updateConfig, addRewindNotice, clearRewindNotices, forceStaticRemount,
    repaintConversationSurface, setCurrentAgent, addSubAgent, removeSubAgent]);
  const value = React.useMemo(() => ({ state, actions }), [state, actions]);
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};

export function useAppContext(): AppContextValue {
  const context = useContext(AppContext);
  if (!context) throw new Error('useAppContext must be used within AppProvider');
  return context;
}
