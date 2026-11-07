/**
 * App - Root React component for Code Ally UI
 *
 * This is the main entry point for the Ink-based terminal UI. It sets up
 * the context providers, manages global state, and coordinates the overall
 * application structure.
 */

import React, { useEffect, useRef, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { ActivityStream } from '../services/ActivityStream.js';
import { ActivityProvider, useActivityStreamContext } from './contexts/ActivityContext.js';
import { AppProvider, useAppContext } from './contexts/AppContext.js';
import { TerminalProvider } from './contexts/TerminalContext.js';
import { ActivityEventType, Config } from '../types/index.js';
import { BottomAlignedLayout } from './components/BottomAlignedLayout.js';
import { useProviderDiagnostics } from './hooks/useProviderDiagnostics.js';
import { useTerminalRows } from './hooks/useTerminalRows.js';
import { PermissionModeStatus } from './components/PermissionModeStatus.js';
import { usePermissionMode } from './hooks/usePermissionPolicy.js';
import { ModalHost } from './components/ModalHost.js';
import { InputPrompt } from './components/InputPrompt.js';
import { EMPTY_DRAFT, type PromptDraft } from './hooks/usePromptDraft.js';
import { AgentFleetView } from './components/AgentFleetView.js';
import { ConversationPane } from './components/ConversationPane.js';
import { ConversationStatus } from './components/ConversationStatus.js';
import { ConversationMetrics } from './components/ConversationMetrics.js';
import { Agent } from '../agent/Agent.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { logger } from '../services/Logger.js';
import { useServiceInitialization } from './hooks/useServiceInitialization.js';
import { useModalState } from './hooks/useModalState.js';
import { useSessionResume } from './hooks/useSessionResume.js';
import { useInputHandlers } from './hooks/useInputHandlers.js';
import { useActivitySubscriptions } from './hooks/useActivitySubscriptions.js';
import { useTerminalWidth } from './hooks/useTerminalWidth.js';
import { useReflowOnResize } from './hooks/useReflowOnResize.js';
import { useBackgroundProcesses } from './hooks/useBackgroundProcesses.js';
import { useFleetNavigation } from './hooks/useFleetNavigation.js';
import { useAgentDiagnostics } from './hooks/useAgentDiagnostics.js';
import { useScheduledTaskCount } from './hooks/useScheduledTaskCount.js';
import { useTaskWake } from './hooks/useTaskWake.js';
import { useAgentRouting, type AgentRouting } from './hooks/useAgentRouting.js';
import { useConversationSelector, selectThinking, selectActivity, shallowEqual } from './hooks/useConversationSelector.js';
import { switchAgent } from '../services/AgentSwitcher.js';
import { SyntaxHighlighter } from '../services/SyntaxHighlighter.js';
import { clearMarkdownCache } from './components/MarkdownText.js';
import { getActiveProfile } from '../config/paths.js';
import { UI_COLORS } from './constants/colors.js';
import { PointerProvider, shouldTrackPointer } from './contexts/PointerContext.js';
import type { TerminalInputStream } from '@utils/terminalInput.js';

/**
 * Props for the App component
 */
interface AdvertisedModel {
  name: string;
  size?: number;
  modified_at?: string;
}

export interface AppProps {
  /** Initial configuration */
  config: Config;

  /** Activity stream instance */
  activityStream?: ActivityStream;

  /** Terminal input with mouse and cursor reports split off; enables clicks */
  terminalInput?: TerminalInputStream;

  /** Agent instance */
  agent: Agent;

  /** Session to resume (session ID, 'interactive' for selector, or null) */
  resumeSession?: string | 'interactive' | null;

  /** Force show setup wizard (e.g., from --init flag) */
  showSetupWizard?: boolean;

  /** Force show model selector (e.g., when model not found during startup) */
  showModelSelector?: boolean;

  /** Available models from startup validation */
  availableModels?: AdvertisedModel[];

  /** Number of active plugins */
  activePluginCount?: number;

  /** Total number of loaded plugins */
  totalPluginCount?: number;

  /** Number of connected MCP servers */
  activeMcpCount?: number;

  /** Total number of configured MCP servers */
  totalMcpCount?: number;

  /** Called once startup services and any direct session resume are ready. */
  onInteractiveReady?: () => void;

  /** One-off notices from session startup, shown with the header. */
  startupNotices?: string[];
  validateProviderOnStartup?: boolean;
}

/**
 * Inner app component that uses contexts
 *
 * This component is wrapped by providers and has access to all context values.
 * It subscribes to activity events and updates the app state accordingly.
 * Memoized to prevent unnecessary re-renders when children update.
 */
type AppContentProps = Omit<AppProps, 'config' | 'activityStream' | 'agent'> & AgentRouting;

const AppContentComponent: React.FC<AppContentProps> = ({
  foregroundAgent,
  foregroundAgentId,
  primaryAgent,
  selectForegroundConversation,
  returnToPrimaryConversation,
  resumeSession,
  showSetupWizard,
  showModelSelector,
  availableModels,
  activePluginCount,
  totalPluginCount,
  activeMcpCount,
  totalMcpCount,
  onInteractiveReady,
  startupNotices,
  terminalInput,
  validateProviderOnStartup,
}) => {
  const { state, actions } = useAppContext();
  const activityStream = useActivityStreamContext();
  useProviderDiagnostics(validateProviderOnStartup === true, state.config, activityStream);

  // Initialize services (command history, completion provider, command handler)
  const { commandHistory, completionProvider, commandHandler, shouldShowSetupWizard } = useServiceInitialization(
    primaryAgent,
    actions,
    showSetupWizard
  );

  // Manage all modal and selector state
  const modal = useModalState();
  const [drafts, setDrafts] = React.useState<Record<string, PromptDraft>>({});
  const inputDraft = drafts[state.activeAgentId] ?? EMPTY_DRAFT;
  const setInputDraft = React.useCallback((draft: PromptDraft) => {
    setDrafts(current => ({ ...current, [state.activeAgentId]: draft }));
  }, [state.activeAgentId]);
  const fleet = useFleetNavigation({
    activeAgentId: state.activeAgentId, primaryAgent, foregroundAgent, foregroundAgentId,
    selectForegroundConversation, returnToPrimaryConversation, actions,
  });
  const { backgroundAgents, selectedTask, completedChild, isChildSelected, conversationSource, conversationControls,
    returnToMain, handleEnterFleet, handleFleetNavigate, handleExitFleet, handleEnterAgent,
    handleBackgroundAgents, handleKillAgent } = fleet;
  const queue = selectedTask?.inputQueue ?? foregroundAgent.getInputQueue();
  const pendingInput = React.useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const recallFollowUp = React.useCallback(() => {
    const last = queue.getSnapshot().at(-1);
    return last ? queue.remove(last.id)?.text : undefined;
  }, [queue]);

  // Track background processes for status line
  const backgroundProcessCount = useBackgroundProcesses();
  const scheduledTaskCount = useScheduledTaskCount();

  const permission = usePermissionMode(state.config, actions);

  // Periodic cache maintenance — clear syntax highlighting and markdown parse caches
  // every 5 minutes to prevent unbounded memory growth in long sessions
  useEffect(() => {
    const CACHE_RESET_INTERVAL_MS = 5 * 60 * 1000;
    const interval = setInterval(() => {
      clearMarkdownCache();
      SyntaxHighlighter.getInstance().clearCache();
    }, CACHE_RESET_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // Handle session resumption on mount
  const { sessionLoaded } = useSessionResume(
    resumeSession,
    primaryAgent,
    actions,
    modal.setSessionSelectRequest
  );

  const interactiveReadySignalled = useRef(false);
  useEffect(() => {
    if (interactiveReadySignalled.current
      || !onInteractiveReady
      || !sessionLoaded
      || !commandHandler
      || !completionProvider
      || shouldShowSetupWizard
      || showModelSelector
      || resumeSession === 'interactive') return;
    interactiveReadySignalled.current = true;
    onInteractiveReady();
  }, [
    commandHandler,
    completionProvider,
    onInteractiveReady,
    resumeSession,
    sessionLoaded,
    shouldShowSetupWizard,
    showModelSelector,
  ]);

  // Subscribe to all activity events
  const { isCancelling } = useActivitySubscriptions(state, actions, modal, primaryAgent, activityStream);

  const conversationRoute = useMemo(() => ({
    id: foregroundAgentId,
    kind: foregroundAgentId === 'main' ? 'primary' as const : 'child' as const,
    agent: foregroundAgent,
    activityStream: foregroundAgentId === 'main'
      ? activityStream
      : foregroundAgent.getActivityStream(),
    isAvailable: () => {
      if (foregroundAgentId === 'main') return true;
      return ServiceRegistry.getInstance()
        .get('background_agent_manager')
        ?.getTask(foregroundAgentId)?.status === 'running';
    },
  }), [activityStream, foregroundAgent, foregroundAgentId]);

  // Get input handler functions. The immutable route is captured per submit,
  // so navigation cannot redirect an already-running operation.
  const { handleInput, handleInterjection, handleFollowUp } = useInputHandlers(
    commandHandler,
    conversationRoute,
    actions,
  );

  // Auto-wake the idle main agent when a watched task completes.
  const primaryThinking = useConversationSelector(primaryAgent.getSession(), selectThinking);
  useTaskWake({ isThinking: primaryThinking, activeAgentId: state.activeAgentId, submit: handleInput });

  const { isThinking: displayedIsThinking, isCompacting: displayedIsCompacting } =
    useConversationSelector(conversationSource, selectActivity, shallowEqual);

  // Default agent from config (determines Esc behavior and footer hint)
  const defaultAgent = state.config.default_agent || 'ally';

  // Handler for Esc shortcut to return to default agent
  const handleSwitchToDefault = async () => {
    // Only switch if not already on the default agent
    if (state.currentAgent === defaultAgent) {
      return;
    }

    try {
      const registry = ServiceRegistry.getInstance();
      const newAgent = await switchAgent(defaultAgent, registry);

      // Emit AGENT_SWITCHED event
      activityStream.emit({
        id: `agent_switch_${Date.now()}`,
        type: ActivityEventType.AGENT_SWITCHED,
        timestamp: Date.now(),
        data: {
          agentName: defaultAgent,
          agentId: newAgent.getInstanceId(),
          agentModel: newAgent.getModelClient().modelName,
        },
      });

      logger.debug('[APP]', 'Switched to', defaultAgent, 'via Esc shortcut');
    } catch (error) {
      logger.error('[APP]', 'Failed to switch to default agent:', error);
    }
  };

  // Show setup wizard if needed
  const setSetupWizardOpen = modal.setSetupWizardOpen;
  useEffect(() => {
    if (shouldShowSetupWizard) {
      setSetupWizardOpen(true);
    }
  }, [shouldShowSetupWizard, setSetupWizardOpen]);

  // Track whether we've already shown the model selector (to prevent showing it twice)
  const modelSelectorShownRef = useRef(false);

  // Show model selector if model not found during startup (but NOT if setup wizard is open)
  useEffect(() => {
    if (showModelSelector && activityStream && !modal.setupWizardOpen && !modelSelectorShownRef.current) {
      modelSelectorShownRef.current = true;
      const requestId = `model_select_${Date.now()}`;
      const config = state.config;

      // Format available models for the selector
      const models = (availableModels || []).map(m => ({
        name: m.name,
        size: m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(2)}GB` : undefined,
        modified: m.modified_at,
      }));

      activityStream.emit({
        id: requestId,
        type: ActivityEventType.MODEL_SELECT_REQUEST,
        timestamp: Date.now(),
        data: {
          requestId,
          models,
          currentModel: config.model,
          modelType: 'ally',
          typeName: 'ally model',
        },
      });
    }
  }, [showModelSelector, activityStream, availableModels, modal.setupWizardOpen, state.config]);


  const diagnosticAgent = !completedChild && foregroundAgentId === state.activeAgentId ? foregroundAgent : undefined;
  const { isDebugMode, debugStats, currentFocus } = useAgentDiagnostics(diagnosticAgent,
    completedChild ? selectedTask?.tokens : undefined);

  // Get full terminal width for elements that should expand (input, footer, modals)
  const terminalWidth = useTerminalWidth();
  const terminalRows = useTerminalRows();

  // Reflow the committed transcript when the terminal narrows.
  useReflowOnResize(conversationSource, !isChildSelected);

  // Create debug-enhanced config when debug mode is active
  const effectiveConfig = useMemo(() => {
    if (!isDebugMode) {
      return state.config;
    }

    // Override debug-related settings when in debug mode
    return {
      ...state.config,
      show_tool_parameters_in_chat: true,
      show_full_tool_output: true,
      show_thinking_in_chat: true,
    };
  }, [isDebugMode, state.config]);

  const displayedAgentName = isChildSelected
    ? selectedTask?.agentType ?? state.activeAgentId : state.currentAgent;
  const displayedModel = isChildSelected
    ? completedChild ? selectedTask?.completedModel : foregroundAgentId === state.activeAgentId
      ? foregroundAgent.getModelClient().modelName : undefined
    : state.currentAgentModel || state.config.model;
  const statusIndicator = completedChild ? null : (
    <ConversationStatus
      source={conversationSource}
      isCancelling={isCancelling}
      awaitingHuman={modal.activeModal?.kind === 'permission' || modal.activeModal?.kind === 'planApproval' ? 'approval' : modal.activeModal?.kind === 'toolForm' ? 'input' : undefined}
      activityStream={isChildSelected ? foregroundAgent.getActivityStream() : undefined}
      hideTodos={isChildSelected}
    />
  );

  // Expansion belongs to the selected live session; completed views are frozen.
  const handleToggleToolOutput = React.useCallback(() => {
    if (!conversationControls) return;
    const calls = conversationControls.getSnapshot().activeToolCalls;
    const expand = calls.some(call => !(call.expanded ?? !call.collapsed));
    conversationControls.setToolCallsExpanded(expand);
  }, [conversationControls]);

  // Native scrollback stays available when unsolicited approvals appear.
  // Click tracking is opt-in because the terminal also captures the wheel.
  const pointerTracking = shouldTrackPointer(effectiveConfig.mouse_support, modal.hasOpenModal || fleet.fleetFocused);

  return (
    <PointerProvider input={terminalInput} tracking={pointerTracking}>
    <BottomAlignedLayout historyKey={state.staticRemountKey} footer={
      <>

      <ModalHost requestedPermissionMode={state.config.permission_mode} permissionMode={permission.effectiveMode} onPermissionModeCycle={permission.cycle} modal={modal} activityStream={activityStream} status={statusIndicator}
        onPermissionInstruct={handleInterjection}
        reportError={content => actions.addMessage({ role: 'assistant', content, metadata: { isError: true } })}>
        {/* Bottom interaction region */}
        <Box flexDirection="column">
      {completedChild && <Text dimColor wrap="truncate-end">Completed conversation · Esc returns to main · queued text can be recalled with Alt+↑</Text>}
      {pendingInput.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor wrap="truncate-end">Queued follow-ups ({pendingInput.length}) · Alt+↑ recalls the last message to edit or discard</Text>
          {pendingInput.slice(terminalRows >= 30 ? -2 : -1).map(input => <Text key={input.id} dimColor wrap="truncate">{input.status === 'not_sent' ? 'Not sent (conversation closed): ' : ''}{input.text}</Text>)}
        </Box>
      )}

          {statusIndicator}
          {!displayedIsThinking && !displayedIsCompacting && !isCancelling && (
            <Box paddingLeft={3}>
              <Text dimColor wrap="truncate-end">{completedChild ? 'Completed' : 'Ready'} · {displayedAgentName}</Text>
            </Box>
          )}

          {displayedIsThinking && (
            <Box paddingLeft={1}>
              <Text dimColor wrap="truncate-end">
                {isChildSelected ? 'Enter steers this agent · Esc stops' : 'Enter steers · Alt+Enter queues a follow-up · Esc stops'}
              </Text>
            </Box>
          )}

          {/* Input Prompt */}
          <InputPrompt
            key={state.activeAgentId}
            onSubmit={handleInput}
            prominent
            onInterjection={handleInterjection}
            conversationReadOnly={completedChild}
            onFollowUp={state.activeAgentId === 'main' ? handleFollowUp : undefined}
            onRecallFollowUp={recallFollowUp}
            isActive={true}
            commandHistory={commandHistory || undefined}
            completionProvider={completionProvider || undefined}
            onPermissionModeCycle={permission.cycle}
            onSwitchToDefault={handleSwitchToDefault}
            currentAgent={displayedAgentName}
            defaultAgent={defaultAgent}
            permissionMode={permission.effectiveMode}
            activityStream={activityStream}
            agent={foregroundAgent}
            prefillText={modal.inputPrefillText}
            onPrefillConsumed={() => modal.setInputPrefillText(undefined)}
            promptPrefilled={modal.promptPrefilled}
            onPromptPrefilledClear={() => modal.setPromptPrefilled(false)}
            onExitConfirmationChange={modal.setIsWaitingForExitConfirmation}
            draft={inputDraft}
            onDraftChange={setInputDraft}
            fleetFocused={fleet.fleetFocused}
            fleetCount={backgroundAgents.length}
            fleetSelectedIndex={fleet.fleetSelectedIndex}
            isViewingAgent={state.activeAgentId !== 'main'}
            onEnterFleet={handleEnterFleet}
            onFleetNavigate={handleFleetNavigate}
            onEnterAgent={handleEnterAgent}
            onExitFleet={handleExitFleet}
            onExitAgent={returnToMain}
            onBackgroundAgents={handleBackgroundAgents}
            onKillAgent={handleKillAgent}
            onToggleToolOutput={handleToggleToolOutput}
          />

          {/* Background agent fleet — reachable with ↓ from an empty prompt */}
          <AgentFleetView
            compact
            agents={backgroundAgents}
            selectedIndex={fleet.fleetSelectedIndex}
            focused={fleet.fleetFocused}
            activeAgentId={state.activeAgentId}
            onOptionPress={handleEnterAgent}
            maxVisible={Math.max(1, Math.min(4, Math.floor(terminalRows / 8)))}
          />

          <PermissionModeStatus requestedMode={state.config.permission_mode} onCycle={permission.cycle}/>
          {/* Persistent metadata belongs to the normal input state only. */}
          <Box width={Math.max(1, terminalWidth - 2)} paddingLeft={1}>
            {modal.isWaitingForExitConfirmation ? (
              <Text color={UI_COLORS.PRIMARY}>ctrl+c again to exit</Text>
            ) : (
              <Text dimColor wrap="truncate-end">
                {isDebugMode && <Text color={UI_COLORS.PRIMARY}>debug · </Text>}
                {displayedModel || 'no model'}
                <ConversationMetrics source={conversationSource} kind="rate"/>
                {isDebugMode && ` · ${debugStats.heapMB} MB · ${debugStats.tokensUsed.toLocaleString()}${debugStats.tokensTotal ? `/${debugStats.tokensTotal.toLocaleString()}` : ''} tokens`}
                {currentFocus && <> · focus <Text color="magenta">{currentFocus}</Text></>}
                <ConversationMetrics source={conversationSource} kind="context"/>
                {getActiveProfile() !== 'default' && <> · <Text color={UI_COLORS.PRIMARY}>{getActiveProfile()}</Text></>}
                {backgroundProcessCount > 0 && <> · <Text color={UI_COLORS.PRIMARY}>{backgroundProcessCount} running</Text></>}
                {scheduledTaskCount > 0 && <> · <Text color={UI_COLORS.PRIMARY}>{scheduledTaskCount} scheduled</Text></>}
                {displayedAgentName !== defaultAgent && <> · <Text color={UI_COLORS.PRIMARY}>{displayedAgentName}</Text></>}
              </Text>
            )}
          </Box>
        </Box>
      </ModalHost>
      </>
    }>
      <ConversationPane
        source={conversationSource}
        onToggleToolCall={conversationControls?.toggleToolCallExpanded}
        rewindNotices={isChildSelected ? [] : state.rewindNotices}
        staticRemountKey={state.staticRemountKey}
        config={effectiveConfig}
        activePluginCount={activePluginCount}
        totalPluginCount={totalPluginCount}
        activeMcpCount={activeMcpCount}
        totalMcpCount={totalMcpCount}
        startupNotices={startupNotices}
        currentAgent={displayedAgentName}
      />


    </BottomAlignedLayout>
    </PointerProvider>
  );
};

/**
 * Memoized AppContent - prevents re-renders unless props actually change.
 *
 * Uses React's default shallow prop comparison. A previous hand-written
 * comparator omitted the plugin/MCP count props, which silently froze those
 * header values when they changed at runtime; since every prop here is a
 * primitive or stable ref, the default comparison is both correct and safe.
 */
const AppContent = React.memo(AppContentComponent);

/**
 * Root App Component
 *
 * Sets up all context providers and renders the main application.
 * This is the entry point for the Ink application.
 *
 * @example
 * ```tsx
 * import { render } from 'ink';
 * import { App } from './ui/App.js';
 *
 * const config = await configManager.getConfig();
 * const { unmount } = render(<App config={config} />);
 * ```
 */
export const App: React.FC<AppProps> = ({ config, activityStream, agent, ...props }) => {
  const [stream] = useState(() => activityStream ?? new ActivityStream());
  const routing = useAgentRouting(agent, stream);
  return (
    <TerminalProvider>
      <ActivityProvider activityStream={stream}>
        <AppProvider initialConfig={config} conversationStore={routing.primaryAgent.getSession()}>
          <AppContent {...props} {...routing}/>
        </AppProvider>
      </ActivityProvider>
    </TerminalProvider>
  );
};

export default App;
