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
import { ActivityEventType, Config, Message } from '../types/index.js';
import { InputPrompt } from './components/InputPrompt.js';
import { ConversationView } from './components/ConversationView.js';
import { PermissionPrompt } from './components/PermissionPrompt.js';
import { ModelSelector } from './components/ModelSelector.js';
import { ConfigViewer } from './components/ConfigViewer.js';
import { SetupWizardView } from './components/SetupWizardView.js';
import { ProjectWizardView } from './components/ProjectWizardView.js';
import { AgentWizardView } from './components/AgentWizardView.js';
import { PluginConfigView } from './components/PluginConfigView.js';
import { RewindSelector } from './components/RewindSelector.js';
import { RewindOptionsSelector } from './components/RewindOptionsSelector.js';
import { SessionSelector } from './components/SessionSelector.js';
import { PromptLibrarySelector } from './components/PromptLibrarySelector.js';
import { MessageSelector } from './components/MessageSelector.js';
import { PromptAddWizard } from './components/PromptAddWizard.js';
import { StatusIndicator } from './components/StatusIndicator.js';
import { UndoPrompt } from './components/UndoPrompt.js';
import { UndoFileList } from './components/UndoFileList.js';
import { LibraryClearConfirmation } from './components/LibraryClearConfirmation.js';
import { CONTEXT_THRESHOLDS } from '../config/toolDefaults.js';
import { Agent } from '../agent/Agent.js';
import { PatchManager, PatchMetadata } from '../services/PatchManager.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ToolManager } from '../tools/ToolManager.js';
import { FocusManager } from '../services/FocusManager.js';
import { PluginConfigManager } from '../plugins/PluginConfigManager.js';
import { logger, LogLevel } from '../services/Logger.js';
import { useServiceInitialization } from './hooks/useServiceInitialization.js';
import { useModalState } from './hooks/useModalState.js';
import { useSessionResume } from './hooks/useSessionResume.js';
import { useInputHandlers } from './hooks/useInputHandlers.js';
import { useActivitySubscriptions } from './hooks/useActivitySubscriptions.js';
import { useContentWidth } from './hooks/useContentWidth.js';
import { useBackgroundProcesses } from './hooks/useBackgroundProcesses.js';
import { useAgentSwitch } from './hooks/useAgentSwitch.js';
import { switchAgent } from '../services/AgentSwitcher.js';
import { getActiveProfile } from '../config/paths.js';
import { UI_COLORS } from './constants/colors.js';

/**
 * Props for the App component
 */
export interface AppProps {
  /** Initial configuration */
  config: Config;

  /** Activity stream instance */
  activityStream?: ActivityStream;

  /** Agent instance */
  agent: Agent;

  /** Session to resume (session ID, 'interactive' for selector, or null) */
  resumeSession?: string | 'interactive' | null;

  /** Force show setup wizard (e.g., from --init flag) */
  showSetupWizard?: boolean;

  /** Force show model selector (e.g., when model not found during startup) */
  showModelSelector?: boolean;

  /** Available models from startup validation */
  availableModels?: any[];

  /** Number of active plugins */
  activePluginCount?: number;

  /** Total number of loaded plugins */
  totalPluginCount?: number;
}

/**
 * Inner app component that uses contexts
 *
 * This component is wrapped by providers and has access to all context values.
 * It subscribes to activity events and updates the app state accordingly.
 * Memoized to prevent unnecessary re-renders when children update.
 */
const AppContentComponent: React.FC<{
  agent: Agent;
  resumeSession?: string | 'interactive' | null;
  showSetupWizard?: boolean;
  showModelSelector?: boolean;
  availableModels?: any[];
  activePluginCount?: number;
  totalPluginCount?: number;
}> = ({
  agent,
  resumeSession,
  showSetupWizard,
  showModelSelector,
  availableModels,
  activePluginCount,
  totalPluginCount,
}) => {
  const { state, actions } = useAppContext();
  const activityStream = useActivityStreamContext();

  // Initialize services (command history, completion provider, command handler)
  const { commandHistory, completionProvider, commandHandler, shouldShowSetupWizard } = useServiceInitialization(
    agent,
    actions,
    showSetupWizard
  );

  // Manage all modal and selector state
  const modal = useModalState();

  // Track background processes for status line
  const backgroundProcessCount = useBackgroundProcesses();

  // Connect auto-allow mode to TrustManager after initialization
  useEffect(() => {
    const registry = ServiceRegistry.getInstance();
    const trustManager = registry.get<any>('trust_manager');
    if (trustManager && trustManager.setAutoAllowModeGetter) {
      trustManager.setAutoAllowModeGetter(() => modal.autoAllowMode);
    }
  }, [modal.autoAllowMode]);

  // Handle session resumption on mount
  const { sessionLoaded } = useSessionResume(
    resumeSession,
    agent,
    actions,
    activityStream,
    modal.setSessionSelectRequest
  );

  // Subscribe to all activity events
  const { isCancelling } = useActivitySubscriptions(state, actions, modal, agent, activityStream);

  // Get input handler functions
  const { handleInput, handleInterjection } = useInputHandlers(commandHandler, activityStream, state, actions);

  // Handler for Esc shortcut to quickly return to ally
  const handleSwitchToAlly = async () => {
    // Only switch if not already on ally
    if (state.currentAgent === 'ally') {
      return;
    }

    try {
      const registry = ServiceRegistry.getInstance();
      const newAgent = await switchAgent('ally', registry);

      // Emit AGENT_SWITCHED event
      activityStream.emit({
        id: `agent_switch_${Date.now()}`,
        type: ActivityEventType.AGENT_SWITCHED,
        timestamp: Date.now(),
        data: {
          agentName: 'ally',
          agentId: newAgent.getInstanceId(),
        },
      });

      logger.debug('[APP]', 'Switched to ally via Esc shortcut');
    } catch (error) {
      logger.error('[APP]', 'Failed to switch to ally:', error);
    }
  };

  // Show setup wizard if needed
  useEffect(() => {
    if (shouldShowSetupWizard) {
      modal.setSetupWizardOpen(true);
    }
  }, [shouldShowSetupWizard]);

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

  // State for patches to pass to RewindSelector
  const [patches, setPatches] = useState<PatchMetadata[]>([]);

  // Track debug mode state and stats
  const [isDebugMode, setIsDebugMode] = useState<boolean>(logger.getLevel() === LogLevel.DEBUG);
  const [debugStats, setDebugStats] = useState<{
    sessionId: string;
    heapMB: number;
    rssMB: number;
    tokensUsed: number;
    tokensTotal: number;
    todoPending: number;
    todoCompleted: number;
    todoTotal: number;
  }>({
    sessionId: '',
    heapMB: 0,
    rssMB: 0,
    tokensUsed: 0,
    tokensTotal: 0,
    todoPending: 0,
    todoCompleted: 0,
    todoTotal: 0,
  });

  // Poll logger level and collect debug stats
  useEffect(() => {
    const updateDebugStats = () => {
      const debugMode = logger.getLevel() === LogLevel.DEBUG;
      setIsDebugMode(debugMode);

      if (debugMode) {
        try {
          const registry = ServiceRegistry.getInstance();

          // Get session ID
          const sessionManager = registry.get<any>('session_manager');
          const sessionId = sessionManager?.getCurrentSession() || 'none';

          // Get memory stats
          const memUsage = process.memoryUsage();
          const heapMB = Math.round(memUsage.heapUsed / 1024 / 1024);
          const rssMB = Math.round(memUsage.rss / 1024 / 1024);

          // Get token stats
          const tokenManager = registry.get<any>('token_manager');
          const tokensUsed = tokenManager?.getCurrentTokenCount() || 0;
          const tokensTotal = tokenManager?.contextSize || 200000;

          // Get todo stats
          const todoManager = registry.get<any>('todo_manager');
          const todos = todoManager?.getTodos() || [];
          const todoPending = todos.filter((t: any) => t.status === 'pending').length;
          const todoCompleted = todos.filter((t: any) => t.status === 'completed').length;
          const todoTotal = todos.length;

          setDebugStats({
            sessionId,
            heapMB,
            rssMB,
            tokensUsed,
            tokensTotal,
            todoPending,
            todoCompleted,
            todoTotal,
          });
        } catch (error) {
          // Silently handle errors
        }
      }
    };

    updateDebugStats();
    const interval = setInterval(updateDebugStats, 1000); // Update every second

    return () => clearInterval(interval);
  }, []);

  // Fetch patches when rewind request is shown
  useEffect(() => {
    if (modal.rewindRequest) {
      const fetchPatches = async () => {
        const serviceRegistry = ServiceRegistry.getInstance();
        const patchManager = serviceRegistry.get<PatchManager>('patch_manager');

        if (patchManager) {
          // Get all patches from the beginning of the session (timestamp 0)
          const allPatches = await patchManager.getPatchesSinceTimestamp(0);
          setPatches(allPatches);
        } else {
          setPatches([]);
        }
      };

      fetchPatches();
    } else {
      // Clear patches when rewind request is closed
      setPatches([]);
    }
  }, [modal.rewindRequest]);

  // Check for pending plugin config requests on mount
  useEffect(() => {
    const checkPendingPluginConfig = async () => {
      // Dynamic import to avoid circular dependencies
      const { PluginLoader } = await import('../plugins/PluginLoader.js');

      // Check if there's a pending config request
      const pendingRequest = PluginLoader.getPendingConfigRequest();
      if (pendingRequest) {
        logger.debug('[App] Found pending plugin config request on mount:', pendingRequest.pluginName);

        // Load existing config if available
        const serviceRegistry = ServiceRegistry.getInstance();
        const pluginConfigManager = serviceRegistry.get<PluginConfigManager>('plugin_config_manager');
        let existingConfig: any = undefined;

        if (pluginConfigManager) {
          try {
            existingConfig = await pluginConfigManager.loadConfig(
              pendingRequest.pluginName,
              pendingRequest.pluginPath,
              pendingRequest.schema
            );
            logger.debug(`[App] Loaded existing config for pending request: ${JSON.stringify(existingConfig)}`);
          } catch (error) {
            logger.debug(`[App] No existing config found for pending request: ${error}`);
          }
        }

        // Set the plugin config request state
        modal.setPluginConfigRequest({
          pluginName: pendingRequest.pluginName,
          pluginPath: pendingRequest.pluginPath,
          schema: pendingRequest.schema,
          existingConfig: existingConfig || {},
          author: pendingRequest.author,
          description: pendingRequest.description,
          version: pendingRequest.version,
          tools: pendingRequest.tools,
        });
      }
    };

    checkPendingPluginConfig();
  }, []);

  // Get current focus display (if any)
  const currentFocus = useMemo(() => {
    const serviceRegistry = ServiceRegistry.getInstance();
    const focusManager = serviceRegistry.get<FocusManager>('focus_manager');
    return focusManager?.getFocusDisplay() ?? null;
  }, [state.messages.length]); // Re-compute when messages change (focus commands add messages)

  // Get content width with max width constraint for readability
  const contentWidth = useContentWidth();

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

  return (
    <Box flexDirection="column" padding={1} width={contentWidth}>
      {/* Conversation View - contains header + all conversation history */}
      <ConversationView
        messages={state.messages}
        isThinking={state.isThinking}
        streamingContent={state.streamingContent}
        activeToolCalls={state.activeToolCalls}
        contextUsage={state.contextUsage}
        compactionNotices={state.compactionNotices}
        rewindNotices={state.rewindNotices}
        staticRemountKey={state.staticRemountKey}
        config={effectiveConfig}
        activePluginCount={activePluginCount}
        totalPluginCount={totalPluginCount}
        currentAgent={state.currentAgent}
      />

      {/* Config Viewer (non-modal - shown above input) */}
      {modal.configViewerOpen && !modal.setupWizardOpen && (
        <Box marginTop={1}>
          <ConfigViewer visible={true} />
        </Box>
      )}

      {/* Setup Wizard (modal - replaces input when active) */}
      {modal.setupWizardOpen ? (
        <Box marginTop={1}>
          <SetupWizardView
            onComplete={() => {
              if (activityStream) {
                activityStream.emit({
                  id: `setup_wizard_complete_${Date.now()}`,
                  type: ActivityEventType.SETUP_WIZARD_COMPLETE,
                  timestamp: Date.now(),
                  data: {},
                });
              }
            }}
            onSkip={() => {
              if (activityStream) {
                activityStream.emit({
                  id: `setup_wizard_skip_${Date.now()}`,
                  type: ActivityEventType.SETUP_WIZARD_SKIP,
                  timestamp: Date.now(),
                  data: {},
                });
              }
            }}
          />
        </Box>
      ) : /* Project Wizard (modal - replaces input when active) */
      modal.projectWizardOpen ? (
        <Box marginTop={1}>
          <ProjectWizardView
            onComplete={() => {
              if (activityStream) {
                activityStream.emit({
                  id: `project_wizard_complete_${Date.now()}`,
                  type: ActivityEventType.PROJECT_WIZARD_COMPLETE,
                  timestamp: Date.now(),
                  data: {},
                });
              }
            }}
            onSkip={() => {
              if (activityStream) {
                activityStream.emit({
                  id: `project_wizard_skip_${Date.now()}`,
                  type: ActivityEventType.PROJECT_WIZARD_SKIP,
                  timestamp: Date.now(),
                  data: {},
                });
              }
            }}
          />
        </Box>
      ) : /* Agent Wizard (modal - replaces input when active) */
      modal.agentWizardOpen ? (
        <Box marginTop={1}>
          <AgentWizardView
            initialDescription={modal.agentWizardData.initialDescription}
            onComplete={agentData => {
              if (activityStream) {
                activityStream.emit({
                  id: `agent_wizard_complete_${Date.now()}`,
                  type: ActivityEventType.AGENT_WIZARD_COMPLETE,
                  timestamp: Date.now(),
                  data: agentData,
                });
              }
            }}
            onCancel={() => {
              if (activityStream) {
                activityStream.emit({
                  id: `agent_wizard_skip_${Date.now()}`,
                  type: ActivityEventType.AGENT_WIZARD_SKIP,
                  timestamp: Date.now(),
                  data: {},
                });
              }
            }}
          />
        </Box>
      ) : /* Plugin Config View (modal - replaces input when active) */
      modal.pluginConfigRequest ? (
        <Box marginTop={1}>
          <PluginConfigView
            pluginName={modal.pluginConfigRequest.pluginName}
            configSchema={modal.pluginConfigRequest.schema}
            existingConfig={modal.pluginConfigRequest.existingConfig}
            author={modal.pluginConfigRequest.author}
            description={modal.pluginConfigRequest.description}
            version={modal.pluginConfigRequest.version}
            tools={modal.pluginConfigRequest.tools}
            agents={modal.pluginConfigRequest.agents}
            onComplete={async config => {
              // Capture the request early to avoid null safety issues
              const request = modal.pluginConfigRequest;
              if (!request) return;

              const serviceRegistry = ServiceRegistry.getInstance();
              const pluginConfigManager = serviceRegistry.get<PluginConfigManager>('plugin_config_manager');

              if (!pluginConfigManager) {
                actions.addMessage({
                  role: 'assistant',
                  content: 'Error: Plugin configuration manager not available',
                });
                modal.setPluginConfigRequest(undefined);
                return;
              }

              try {
                // Extract activation mode from config (if present)
                const { activationMode, ...pluginConfig } = config;

                // Save the plugin configuration (without activation mode)
                await pluginConfigManager.saveConfig(
                  request.pluginName,
                  request.pluginPath,
                  pluginConfig,
                  request.schema
                );

                // If activation mode was set, update the plugin manifest
                if (activationMode !== undefined) {
                  try {
                    const fs = await import('fs/promises');
                    const { join } = await import('path');
                    const manifestPath = join(request.pluginPath, 'plugin.json');
                    const manifestContent = await fs.readFile(manifestPath, 'utf-8');
                    const manifest = JSON.parse(manifestContent);

                    // Update activation mode in manifest
                    manifest.activationMode = activationMode;

                    // Write updated manifest
                    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
                    logger.debug(`[App] Updated activation mode for '${request.pluginName}' to '${activationMode}'`);

                    // Refresh PluginActivationManager to pick up the new mode
                    const pluginActivationManager = serviceRegistry.getPluginActivationManager();
                    if (pluginActivationManager) {
                      await pluginActivationManager.refresh();
                    }
                  } catch (manifestError) {
                    logger.error(`[App] Failed to update manifest for '${request.pluginName}':`, manifestError);
                    // Don't fail the whole config save if manifest update fails
                  }
                }

                // Reload the plugin immediately
                const { PluginLoader } = await import('../plugins/PluginLoader.js');
                const pluginLoader = serviceRegistry.get<InstanceType<typeof PluginLoader>>('plugin_loader');
                const toolManager = serviceRegistry.get<ToolManager>('tool_manager');

                if (pluginLoader && toolManager) {
                  try {
                    // Reload plugin to get the tools
                    const newTools = await pluginLoader.reloadPlugin(request.pluginName, request.pluginPath);

                    // Register the new tools
                    toolManager.registerTools(newTools);

                    logger.debug(`Plugin '${request.pluginName}' reloaded successfully`);

                    // Start background process if plugin has background daemon enabled
                    const loadedPlugins = pluginLoader.getLoadedPlugins();
                    const pluginInfo = loadedPlugins.find((p: any) => p.name === request.pluginName);

                    if (pluginInfo?.manifest.background?.enabled) {
                      try {
                        await pluginLoader.startPluginBackground(request.pluginName);
                        logger.info(`[App] Started background process for '${request.pluginName}'`);
                      } catch (bgError) {
                        // Log error but don't fail the config save - plugin is still usable
                        logger.error(`[App] Failed to start background process for '${request.pluginName}':`, bgError);
                        logger.warn(
                          `[App] Plugin '${request.pluginName}' configured but background process failed to start. Some features may not work until the daemon is started.`
                        );
                      }
                    }

                    // Refresh PluginActivationManager after tools are registered to make them available
                    try {
                      const pluginActivationManager = serviceRegistry.getPluginActivationManager();
                      if (pluginActivationManager) {
                        await pluginActivationManager.refresh();
                        logger.debug(`[App] Refreshed PluginActivationManager after reloading '${request.pluginName}'`);
                      }
                    } catch (refreshError) {
                      logger.error(
                        `[App] Failed to refresh PluginActivationManager after reloading '${request.pluginName}':`,
                        refreshError
                      );
                      // Continue - not a fatal error
                    }
                  } catch (reloadError) {
                    logger.error(`Error reloading plugin '${request.pluginName}':`, reloadError);
                    // Continue - config was saved, just the reload failed
                  }
                }

                // Emit completion event
                if (activityStream) {
                  activityStream.emit({
                    id: `plugin_config_complete_${Date.now()}`,
                    type: ActivityEventType.PLUGIN_CONFIG_COMPLETE,
                    timestamp: Date.now(),
                    data: {
                      pluginName: request.pluginName,
                      pluginPath: request.pluginPath,
                    },
                  });
                }

                // Clear request
                modal.setPluginConfigRequest(undefined);

                // Add success message
                actions.addMessage({
                  role: 'assistant',
                  content: `✓ Plugin '${request.pluginName}' configured and activated!`,
                });
              } catch (error) {
                actions.addMessage({
                  role: 'assistant',
                  content: `Error saving plugin configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
                });
                modal.setPluginConfigRequest(undefined);
              }
            }}
            onCancel={() => {
              // Capture the request early to avoid null safety issues
              const request = modal.pluginConfigRequest;
              if (!request) return;

              // Emit cancel event
              if (activityStream) {
                activityStream.emit({
                  id: `plugin_config_cancel_${Date.now()}`,
                  type: ActivityEventType.PLUGIN_CONFIG_CANCEL,
                  timestamp: Date.now(),
                  data: {
                    pluginName: request.pluginName,
                  },
                });
              }

              // Clear request
              modal.setPluginConfigRequest(undefined);

              actions.addMessage({
                role: 'assistant',
                content: `Plugin configuration cancelled. Plugin '${request.pluginName}' remains inactive.`,
              });
            }}
          />
        </Box>
      ) : /* Session Selector (replaces input when active) */
      modal.sessionSelectRequest ? (
        <Box marginTop={1} flexDirection="column">
          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator
            isProcessing={state.isThinking}
            isCompacting={state.isCompacting}
            isCancelling={isCancelling}
            recentMessages={state.messages.slice(-3)}
            sessionLoaded={sessionLoaded}
            isResuming={!!resumeSession}
            activeToolCalls={state.activeToolCalls}
          />

          <SessionSelector
            sessions={modal.sessionSelectRequest.sessions}
            selectedIndex={modal.sessionSelectRequest.selectedIndex}
            visible={true}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              onInterjection={handleInterjection}
              isActive={true}
              commandHistory={commandHistory || undefined}
              completionProvider={completionProvider || undefined}
              sessionSelectRequest={modal.sessionSelectRequest}
              onSessionNavigate={newIndex => {
                if (modal.sessionSelectRequest) {
                  modal.setSessionSelectRequest({ ...modal.sessionSelectRequest, selectedIndex: newIndex });
                }
              }}
              activityStream={activityStream}
              agent={agent}
              prefillText={modal.inputPrefillText}
              onPrefillConsumed={() => modal.setInputPrefillText(undefined)}
              bufferValue={modal.inputBuffer}
              onBufferChange={modal.setInputBuffer}
            />
          </Box>
        </Box>
      ) : /* Library Selector (replaces input when active) */
      modal.librarySelectRequest ? (
        <Box marginTop={1} flexDirection="column">
          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator
            isProcessing={state.isThinking}
            isCompacting={state.isCompacting}
            isCancelling={isCancelling}
            recentMessages={state.messages.slice(-3)}
            sessionLoaded={sessionLoaded}
            isResuming={!!resumeSession}
            activeToolCalls={state.activeToolCalls}
          />

          <PromptLibrarySelector
            prompts={modal.librarySelectRequest.prompts}
            selectedIndex={modal.librarySelectRequest.selectedIndex}
            visible={true}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              onInterjection={handleInterjection}
              isActive={true}
              commandHistory={commandHistory || undefined}
              completionProvider={completionProvider || undefined}
              librarySelectRequest={modal.librarySelectRequest}
              onLibraryNavigate={newIndex => {
                if (modal.librarySelectRequest) {
                  modal.setLibrarySelectRequest({ ...modal.librarySelectRequest, selectedIndex: newIndex });
                }
              }}
              activityStream={activityStream}
              agent={agent}
              prefillText={modal.inputPrefillText}
              onPrefillConsumed={() => modal.setInputPrefillText(undefined)}
              bufferValue={modal.inputBuffer}
              onBufferChange={modal.setInputBuffer}
            />
          </Box>
        </Box>
      ) : /* Message Selector (for prompt creation) */
      modal.messageSelectRequest ? (
        <Box marginTop={1} flexDirection="column">
          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator
            isProcessing={state.isThinking}
            isCompacting={state.isCompacting}
            isCancelling={isCancelling}
            recentMessages={state.messages.slice(-3)}
            sessionLoaded={sessionLoaded}
            isResuming={!!resumeSession}
            activeToolCalls={state.activeToolCalls}
          />

          <MessageSelector
            messages={modal.messageSelectRequest.messages}
            selectedIndex={modal.messageSelectRequest.selectedIndex}
            visible={true}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              onInterjection={handleInterjection}
              isActive={true}
              commandHistory={commandHistory || undefined}
              completionProvider={completionProvider || undefined}
              messageSelectRequest={modal.messageSelectRequest}
              onMessageNavigate={newIndex => {
                if (modal.messageSelectRequest) {
                  modal.setMessageSelectRequest({ ...modal.messageSelectRequest, selectedIndex: newIndex });
                }
              }}
              activityStream={activityStream}
              agent={agent}
              prefillText={modal.inputPrefillText}
              onPrefillConsumed={() => modal.setInputPrefillText(undefined)}
              bufferValue={modal.inputBuffer}
              onBufferChange={modal.setInputBuffer}
            />
          </Box>
        </Box>
      ) : /* Prompt Add Wizard (replaces input when active) */
      modal.promptAddRequest ? (
        <Box marginTop={1} flexDirection="column">
          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator
            isProcessing={state.isThinking}
            isCompacting={state.isCompacting}
            isCancelling={isCancelling}
            recentMessages={state.messages.slice(-3)}
            sessionLoaded={sessionLoaded}
            isResuming={!!resumeSession}
            activeToolCalls={state.activeToolCalls}
          />

          <PromptAddWizard
            title={modal.promptAddRequest.title}
            content={modal.promptAddRequest.content}
            tags={modal.promptAddRequest.tags}
            focusedField={modal.promptAddRequest.focusedField}
            onFieldChange={(field, value) => {
              if (modal.promptAddRequest) {
                modal.setPromptAddRequest({ ...modal.promptAddRequest, [field]: value });
              }
            }}
            onFieldFocus={field => {
              if (modal.promptAddRequest) {
                modal.setPromptAddRequest({ ...modal.promptAddRequest, focusedField: field });
              }
            }}
            onSubmit={() => {
              if (modal.promptAddRequest && activityStream) {
                const { promptId, title, content, tags } = modal.promptAddRequest;

                // Validate required fields
                if (!title.trim() || !content.trim()) {
                  return; // Don't submit if fields are empty
                }

                activityStream.emit({
                  id: `response_${modal.promptAddRequest.requestId}`,
                  type: ActivityEventType.PROMPT_ADD_RESPONSE,
                  timestamp: Date.now(),
                  data: {
                    requestId: modal.promptAddRequest.requestId,
                    promptId, // Include promptId if editing
                    title: title.trim(),
                    content: content.trim(),
                    tags: tags.trim(),
                    cancelled: false,
                  },
                });
              }
            }}
            onCancel={() => {
              if (modal.promptAddRequest && activityStream) {
                activityStream.emit({
                  id: `response_${modal.promptAddRequest.requestId}_cancel`,
                  type: ActivityEventType.PROMPT_ADD_RESPONSE,
                  timestamp: Date.now(),
                  data: {
                    requestId: modal.promptAddRequest.requestId,
                    cancelled: true,
                  },
                });
              }
            }}
          />
        </Box>
      ) : /* Model Selector (replaces input when active) */
      modal.modelSelectRequest ? (
        <Box marginTop={1} flexDirection="column">
          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator
            isProcessing={state.isThinking}
            isCompacting={state.isCompacting}
            isCancelling={isCancelling}
            recentMessages={state.messages.slice(-3)}
            sessionLoaded={sessionLoaded}
            isResuming={!!resumeSession}
            activeToolCalls={state.activeToolCalls}
          />

          <ModelSelector
            models={modal.modelSelectRequest.models}
            selectedIndex={modal.modelSelectedIndex}
            currentModel={modal.modelSelectRequest.currentModel}
            typeName={modal.modelSelectRequest.typeName}
            visible={true}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              onInterjection={handleInterjection}
              isActive={true}
              commandHistory={commandHistory || undefined}
              completionProvider={completionProvider || undefined}
              modelSelectRequest={modal.modelSelectRequest}
              modelSelectedIndex={modal.modelSelectedIndex}
              onModelNavigate={modal.setModelSelectedIndex}
              activityStream={activityStream}
              agent={agent}
              prefillText={modal.inputPrefillText}
              onPrefillConsumed={() => modal.setInputPrefillText(undefined)}
              bufferValue={modal.inputBuffer}
              onBufferChange={modal.setInputBuffer}
            />
          </Box>
        </Box>
      ) : modal.rewindOptionsRequest ? (
        /* Rewind Options Selector (shown after selecting message in rewind) */
        <Box marginTop={1} flexDirection="column">
          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator
            isProcessing={state.isThinking}
            isCompacting={state.isCompacting}
            isCancelling={isCancelling}
            recentMessages={state.messages.slice(-3)}
            sessionLoaded={sessionLoaded}
            isResuming={!!resumeSession}
            activeToolCalls={state.activeToolCalls}
          />

          <RewindOptionsSelector
            targetMessage={modal.rewindOptionsRequest.targetMessage}
            fileChanges={modal.rewindOptionsRequest.fileChanges}
            previewData={modal.rewindOptionsRequest.previewData}
            visible={true}
            onConfirm={choice => {
              // Handle cancel choice
              if (choice === 'cancel') {
                // Go back to rewind selector
                modal.setRewindOptionsRequest(undefined);
                return;
              }

              // Emit REWIND_RESPONSE event with selected options
              if (activityStream && modal.rewindRequest && modal.rewindOptionsRequest) {
                try {
                  activityStream.emit({
                    id: `response_${modal.rewindRequest.requestId}`,
                    type: ActivityEventType.REWIND_RESPONSE,
                    timestamp: Date.now(),
                    data: {
                      requestId: modal.rewindRequest.requestId,
                      selectedIndex: modal.rewindOptionsRequest.selectedIndex,
                      cancelled: false,
                      options: {
                        restoreFiles: choice === 'conversation-and-files',
                      },
                    },
                  });
                } catch (error) {
                  console.error('[App] Failed to emit rewind response:', error);
                }
              }
              // Clear both rewind request and options request
              modal.setRewindOptionsRequest(undefined);
              modal.setRewindRequest(undefined);
            }}
          />
        </Box>
      ) : modal.rewindRequest ? (
        /* Rewind Selector (replaces input when active) */
        (() => {
          const userMessages = state.messages.filter(m => m.role === 'user');
          return (
            <Box marginTop={1} flexDirection="column">
              {/* Status Indicator - always visible to show todos */}
              <StatusIndicator
                isProcessing={state.isThinking}
                isCompacting={state.isCompacting}
                recentMessages={state.messages.slice(-3)}
                sessionLoaded={sessionLoaded}
                isResuming={!!resumeSession}
                activeToolCalls={state.activeToolCalls}
              />

              <RewindSelector
                messages={userMessages}
                selectedIndex={modal.rewindRequest.selectedIndex}
                visible={true}
                patches={patches}
              />
              {/* Hidden InputPrompt for keyboard handling only */}
              <Box height={0} overflow="hidden">
                <InputPrompt
                  onSubmit={handleInput}
                  onInterjection={handleInterjection}
                  isActive={true}
                  commandHistory={commandHistory || undefined}
                  completionProvider={completionProvider || undefined}
                  rewindRequest={modal.rewindRequest}
                  onRewindNavigate={newIndex => {
                    if (modal.rewindRequest) {
                      modal.setRewindRequest({ ...modal.rewindRequest, selectedIndex: newIndex });
                    }
                  }}
                  onRewindEnter={selectedIndex => {
                    // Show options selector when Enter is pressed
                    const userMessages = state.messages.filter(m => m.role === 'user');
                    const targetMessage = userMessages[selectedIndex];

                    if (targetMessage) {
                      // Calculate file changes for this message
                      const serviceRegistry = ServiceRegistry.getInstance();
                      const patchManager = serviceRegistry.get<PatchManager>('patch_manager');

                      const calculateFileChanges = async () => {
                        if (!patchManager || !targetMessage.timestamp) {
                          return { fileCount: 0, files: [], previewData: undefined };
                        }

                        const patchesSince = await patchManager.getPatchesSinceTimestamp(targetMessage.timestamp);
                        const uniqueFiles = new Set<string>();
                        patchesSince.forEach(p => uniqueFiles.add(p.file_path));

                        // Fetch preview data for diff stats
                        const previewData = await patchManager.previewUndoSinceTimestamp(targetMessage.timestamp);

                        return {
                          fileCount: uniqueFiles.size,
                          files: Array.from(uniqueFiles).map(path => ({ path })),
                          previewData: previewData || undefined,
                        };
                      };

                      calculateFileChanges().then(result => {
                        modal.setRewindOptionsRequest({
                          selectedIndex,
                          targetMessage,
                          fileChanges: { fileCount: result.fileCount, files: result.files },
                          previewData: result.previewData,
                        });
                      });
                    }
                  }}
                  activityStream={activityStream}
                  agent={agent}
                  prefillText={modal.inputPrefillText}
                  onPrefillConsumed={() => modal.setInputPrefillText(undefined)}
                  bufferValue={modal.inputBuffer}
                  onBufferChange={modal.setInputBuffer}
                />
              </Box>
            </Box>
          );
        })()
      ) : modal.undoFileListRequest && !modal.undoRequest ? (
        /* Undo File List (two-stage flow - stage 1) */
        <Box marginTop={1} flexDirection="column">
          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator
            isProcessing={state.isThinking}
            isCompacting={state.isCompacting}
            isCancelling={isCancelling}
            recentMessages={state.messages.slice(-3)}
            sessionLoaded={sessionLoaded}
            isResuming={!!resumeSession}
            activeToolCalls={state.activeToolCalls}
          />

          <UndoFileList request={modal.undoFileListRequest} visible={true} />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              onInterjection={handleInterjection}
              isActive={true}
              commandHistory={commandHistory || undefined}
              completionProvider={completionProvider || undefined}
              undoFileListRequest={modal.undoFileListRequest}
              onUndoFileListNavigate={newIndex => {
                if (modal.undoFileListRequest) {
                  modal.setUndoFileListRequest({ ...modal.undoFileListRequest, selectedIndex: newIndex });
                }
              }}
              activityStream={activityStream}
              agent={agent}
              prefillText={modal.inputPrefillText}
              onPrefillConsumed={() => modal.setInputPrefillText(undefined)}
              bufferValue={modal.inputBuffer}
              onBufferChange={modal.setInputBuffer}
            />
          </Box>
        </Box>
      ) : modal.libraryClearConfirmRequest ? (
        /* Library Clear Confirmation */
        <Box marginTop={1} flexDirection="column">
          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator
            isProcessing={state.isThinking}
            isCompacting={state.isCompacting}
            isCancelling={isCancelling}
            recentMessages={state.messages.slice(-3)}
            sessionLoaded={sessionLoaded}
            isResuming={!!resumeSession}
            activeToolCalls={state.activeToolCalls}
          />

          <LibraryClearConfirmation
            promptCount={modal.libraryClearConfirmRequest.promptCount}
            selectedIndex={modal.libraryClearConfirmRequest.selectedIndex}
            visible={true}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              onInterjection={handleInterjection}
              isActive={true}
              commandHistory={commandHistory || undefined}
              completionProvider={completionProvider || undefined}
              libraryClearConfirmRequest={modal.libraryClearConfirmRequest}
              onLibraryClearConfirmNavigate={newIndex => {
                modal.setLibraryClearConfirmRequest({
                  ...modal.libraryClearConfirmRequest!,
                  selectedIndex: newIndex,
                });
              }}
              activityStream={activityStream}
              agent={agent}
              prefillText={modal.inputPrefillText}
              onPrefillConsumed={() => modal.setInputPrefillText(undefined)}
              bufferValue={modal.inputBuffer}
              onBufferChange={modal.setInputBuffer}
            />
          </Box>
        </Box>
      ) : modal.undoRequest ? (
        /* Undo Prompt (two-stage flow - stage 2, or legacy single-stage) */
        <Box marginTop={1} flexDirection="column">
          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator
            isProcessing={state.isThinking}
            isCompacting={state.isCompacting}
            isCancelling={isCancelling}
            recentMessages={state.messages.slice(-3)}
            sessionLoaded={sessionLoaded}
            isResuming={!!resumeSession}
            activeToolCalls={state.activeToolCalls}
          />

          <UndoPrompt request={modal.undoRequest} selectedIndex={modal.undoSelectedIndex} visible={true} />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              onInterjection={handleInterjection}
              isActive={true}
              commandHistory={commandHistory || undefined}
              completionProvider={completionProvider || undefined}
              undoRequest={modal.undoRequest}
              undoSelectedIndex={modal.undoSelectedIndex}
              onUndoNavigate={modal.setUndoSelectedIndex}
              activityStream={activityStream}
              agent={agent}
              prefillText={modal.inputPrefillText}
              onPrefillConsumed={() => modal.setInputPrefillText(undefined)}
              bufferValue={modal.inputBuffer}
              onBufferChange={modal.setInputBuffer}
            />
          </Box>
        </Box>
      ) : modal.permissionRequest ? (
        /* Permission Prompt (replaces input when active) */
        <Box marginTop={1} flexDirection="column">
          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator
            isProcessing={state.isThinking}
            isCompacting={state.isCompacting}
            isCancelling={isCancelling}
            recentMessages={state.messages.slice(-3)}
            sessionLoaded={sessionLoaded}
            isResuming={!!resumeSession}
            activeToolCalls={state.activeToolCalls}
          />

          <PermissionPrompt
            request={modal.permissionRequest}
            selectedIndex={modal.permissionSelectedIndex}
            visible={true}
            autoAllowMode={modal.autoAllowMode}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              onInterjection={handleInterjection}
              isActive={true}
              commandHistory={commandHistory || undefined}
              completionProvider={completionProvider || undefined}
              permissionRequest={modal.permissionRequest}
              permissionSelectedIndex={modal.permissionSelectedIndex}
              onPermissionNavigate={modal.setPermissionSelectedIndex}
              onAutoAllowToggle={() => modal.setAutoAllowMode(!modal.autoAllowMode)}
              onSwitchToAlly={handleSwitchToAlly}
              currentAgent={state.currentAgent}
              activityStream={activityStream}
              agent={agent}
              prefillText={modal.inputPrefillText}
              onPrefillConsumed={() => modal.setInputPrefillText(undefined)}
              bufferValue={modal.inputBuffer}
              onBufferChange={modal.setInputBuffer}
            />
          </Box>
        </Box>
      ) : (
        /* Input Group - Status Indicator + Input Prompt */
        <Box marginTop={1} flexDirection="column">
          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator
            isProcessing={state.isThinking}
            isCompacting={state.isCompacting}
            isCancelling={isCancelling}
            recentMessages={state.messages.slice(-3)}
            sessionLoaded={sessionLoaded}
            isResuming={!!resumeSession}
            activeToolCalls={state.activeToolCalls}
          />

          {/* Input Prompt */}
          <InputPrompt
            onSubmit={handleInput}
            onInterjection={handleInterjection}
            isActive={true}
            commandHistory={commandHistory || undefined}
            completionProvider={completionProvider || undefined}
            configViewerOpen={modal.configViewerOpen}
            onAutoAllowToggle={() => modal.setAutoAllowMode(!modal.autoAllowMode)}
            onSwitchToAlly={handleSwitchToAlly}
            currentAgent={state.currentAgent}
            autoAllowMode={modal.autoAllowMode}
            activityStream={activityStream}
            agent={agent}
            prefillText={modal.inputPrefillText}
            onPrefillConsumed={() => modal.setInputPrefillText(undefined)}
            promptPrefilled={modal.promptPrefilled}
            onPromptPrefilledClear={() => modal.setPromptPrefilled(false)}
            onExitConfirmationChange={modal.setIsWaitingForExitConfirmation}
            bufferValue={modal.inputBuffer}
            onBufferChange={modal.setInputBuffer}
          />
        </Box>
      )}

      {/* Footer / Help */}
      <Box width={contentWidth - 2} paddingLeft={1}>
        {isDebugMode ? (
          <Box flexDirection="column">
            {/* Debug Mode: Line 1 - Session and Memory */}
            <Text dimColor>
              <Text color="yellow">DEBUG MODE</Text>
              <Text> · Session: {debugStats.sessionId}</Text>
              <Text>
                {' '}
                · Memory: {debugStats.heapMB} MB heap / {debugStats.rssMB} MB RSS
              </Text>
            </Text>
            {/* Debug Mode: Line 2 - Tokens, Todos, Model, Exit */}
            {modal.isWaitingForExitConfirmation ? (
              <Text>
                <Text color={UI_COLORS.PRIMARY}>Ctrl+C again to exit</Text>
              </Text>
            ) : (
              <>
                <Text dimColor>
                  <Text>
                    Tokens: {debugStats.tokensUsed.toLocaleString()}/{debugStats.tokensTotal.toLocaleString()} (
                    {state.contextUsage}%)
                  </Text>
                  {debugStats.todoTotal > 0 && (
                    <Text>
                      {' '}
                      · Todos: {debugStats.todoPending} pending, {debugStats.todoCompleted} done, {debugStats.todoTotal}{' '}
                      total
                    </Text>
                  )}
                  <Text> · {state.config.model || 'none'}</Text>
                  {currentFocus && (
                    <Text>
                      {' '}
                      · Focus: <Text color="magenta">{currentFocus}</Text>
                    </Text>
                  )}
                  {(() => {
                    const activeProfile = getActiveProfile();
                    return (
                      activeProfile !== 'default' && (
                        <Text>
                          {' '}
                          · <Text color={UI_COLORS.PRIMARY}>{activeProfile}</Text> (--profile to switch)
                        </Text>
                      )
                    );
                  })()}
                  {backgroundProcessCount > 0 && (
                    <Text>
                      {' '}
                      · <Text color={UI_COLORS.PRIMARY}>{backgroundProcessCount} running task{backgroundProcessCount === 1 ? '' : 's'}</Text> (/task list)
                    </Text>
                  )}
                </Text>
                {modal.autoAllowMode ? (
                  <Text color={UI_COLORS.ERROR}> · Auto-allow enabled (Shift+Tab to disable)</Text>
                ) : (
                  <Text dimColor> · Shift+Tab to auto-allow tools</Text>
                )}
                {state.currentAgent !== 'ally' && (
                  <Text color={UI_COLORS.PRIMARY}> · Talking to {state.currentAgent} (esc to switch back)</Text>
                )}
              </>
            )}
          </Box>
        ) : modal.isWaitingForExitConfirmation ? (
          /* Exit Confirmation Mode */
          <Text>
            <Text color={UI_COLORS.PRIMARY}>Ctrl+C again to exit</Text>
          </Text>
        ) : (
          /* Normal Mode: Single line */
          <>
            <Text dimColor>
              {state.config.model || 'none'}
              {currentFocus && (
                <Text>
                  {' '}
                  · Focus: <Text color="magenta">{currentFocus}</Text>
                </Text>
              )}
              {state.contextUsage > CONTEXT_THRESHOLDS.VISIBILITY && (
                <>
                  {' · '}
                  {state.contextUsage >= CONTEXT_THRESHOLDS.WARNING ? (
                    <Text color="red">
                      {CONTEXT_THRESHOLDS.MAX_PERCENT - state.contextUsage}% context left - use /compact
                    </Text>
                  ) : state.contextUsage >= CONTEXT_THRESHOLDS.NORMAL ? (
                    <Text color="yellow">
                      {CONTEXT_THRESHOLDS.MAX_PERCENT - state.contextUsage}% context left - consider /compact
                    </Text>
                  ) : (
                    <Text>{CONTEXT_THRESHOLDS.MAX_PERCENT - state.contextUsage}% context left</Text>
                  )}
                </>
              )}
              {(() => {
                const activeProfile = getActiveProfile();
                return (
                  activeProfile !== 'default' && (
                    <Text>
                      {' '}
                      · <Text color={UI_COLORS.PRIMARY}>{activeProfile}</Text> (--profile to switch)
                    </Text>
                  )
                );
              })()}
              {backgroundProcessCount > 0 && (
                <Text>
                  {' '}
                  · <Text color={UI_COLORS.PRIMARY}>{backgroundProcessCount} running task{backgroundProcessCount === 1 ? '' : 's'}</Text> (/task list)
                </Text>
              )}
            </Text>
            {modal.autoAllowMode ? (
              <Text color={UI_COLORS.ERROR}> · Auto-allow enabled (Shift+Tab to disable)</Text>
            ) : (
              <Text dimColor> · Shift+Tab to auto-allow tools</Text>
            )}
            {state.currentAgent !== 'ally' && (
              <Text color={UI_COLORS.PRIMARY}> · Talking to {state.currentAgent} (esc to switch back)</Text>
            )}
          </>
        )}
      </Box>
    </Box>
  );
};

/**
 * Memoized AppContent - prevents re-renders unless props actually change
 */
const AppContent = React.memo(AppContentComponent, (prevProps, nextProps) => {
  const agentSame = prevProps.agent === nextProps.agent;
  const resumeSame = prevProps.resumeSession === nextProps.resumeSession;
  const setupSame = prevProps.showSetupWizard === nextProps.showSetupWizard;
  const modelSelectorSame = prevProps.showModelSelector === nextProps.showModelSelector;
  const modelsSame = prevProps.availableModels === nextProps.availableModels;
  return agentSame && resumeSame && setupSame && modelSelectorSame && modelsSame;
});

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
export const App: React.FC<AppProps> = ({
  config,
  activityStream,
  agent,
  resumeSession,
  showSetupWizard,
  showModelSelector,
  availableModels,
  activePluginCount,
  totalPluginCount,
}) => {
  // Create activity stream if not provided
  const streamRef = useRef(activityStream || new ActivityStream());

  // Track current agent (updates when agent is switched via useAgentSwitch hook)
  const currentAgent = useAgentSwitch(agent, streamRef.current);

  return (
    <TerminalProvider>
      <ActivityProvider activityStream={streamRef.current}>
        <AppProvider initialConfig={config}>
          <AppContent
            agent={currentAgent}
            resumeSession={resumeSession}
            showSetupWizard={showSetupWizard}
            showModelSelector={showModelSelector}
            availableModels={availableModels}
            activePluginCount={activePluginCount}
            totalPluginCount={totalPluginCount}
          />
        </AppProvider>
      </ActivityProvider>
    </TerminalProvider>
  );
};

/**
 * Example usage with message injection for testing
 */
export interface AppWithMessagesProps extends AppProps {
  /** Initial messages to display */
  initialMessages?: Message[];
}

/**
 * App component with initial messages
 *
 * Useful for testing and development. Allows pre-populating the conversation.
 *
 * @example
 * ```tsx
 * const messages: Message[] = [
 *   { role: 'user', content: 'Hello!' },
 *   { role: 'assistant', content: 'Hi there!' },
 * ];
 *
 * render(<AppWithMessages config={config} initialMessages={messages} />);
 * ```
 */
export const AppWithMessages: React.FC<AppWithMessagesProps> = ({
  config,
  activityStream,
  agent,
  initialMessages = [],
}) => {
  const streamRef = useRef(activityStream || new ActivityStream());

  // Track current agent (updates when agent is switched via useAgentSwitch hook)
  const currentAgent = useAgentSwitch(agent, streamRef.current);

  return (
    <TerminalProvider>
      <ActivityProvider activityStream={streamRef.current}>
        <AppProvider initialConfig={config}>
          <AppContentWithMessages agent={currentAgent} initialMessages={initialMessages} />
        </AppProvider>
      </ActivityProvider>
    </TerminalProvider>
  );
};

/**
 * Inner component that accepts initial messages
 */
const AppContentWithMessages: React.FC<{ agent: Agent; initialMessages: Message[] }> = ({ agent, initialMessages }) => {
  const { actions } = useAppContext();
  const hasLoadedRef = useRef(false);

  // Load initial messages on mount
  useEffect(() => {
    if (!hasLoadedRef.current && initialMessages.length > 0) {
      actions.setMessages(initialMessages);
      hasLoadedRef.current = true;
    }
  }, [initialMessages, actions]);

  return <AppContent agent={agent} />;
};

export default App;
