/**
 * App - Root React component for Code Ally UI
 *
 * This is the main entry point for the Ink-based terminal UI. It sets up
 * the context providers, manages global state, and coordinates the overall
 * application structure.
 */

import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import { ActivityStream } from '../services/ActivityStream.js';
import { ActivityProvider, useActivityStreamContext } from './contexts/ActivityContext.js';
import { AppProvider, useAppContext } from './contexts/AppContext.js';
import { useActivityEvent } from './hooks/useActivityEvent.js';
import { ActivityEventType, Config, ToolCallState, Message } from '../types/index.js';
import { InputPrompt } from './components/InputPrompt.js';
import { ConversationView } from './components/ConversationView.js';
import { PermissionPrompt, PermissionRequest } from './components/PermissionPrompt.js';
import { ModelSelector, ModelOption } from './components/ModelSelector.js';
import { ConfigViewer } from './components/ConfigViewer.js';
import { SetupWizardView } from './components/SetupWizardView.js';
import { ProjectWizardView } from './components/ProjectWizardView.js';
import { AgentWizardView } from './components/AgentWizardView.js';
import { PluginConfigView } from './components/PluginConfigView.js';
import { RewindSelector } from './components/RewindSelector.js';
import { SessionSelector } from './components/SessionSelector.js';
import { StatusIndicator } from './components/StatusIndicator.js';
import { UndoPrompt } from './components/UndoPrompt.js';
import { UndoFileList } from './components/UndoFileList.js';
import { UI_DELAYS } from '../config/constants.js';
import { CONTEXT_THRESHOLDS } from '../config/toolDefaults.js';
import { ReasoningStream } from './components/ReasoningStream.js';
import { Agent } from '../agent/Agent.js';
import { CommandHistory } from '../services/CommandHistory.js';
import { CompletionProvider } from '../services/CompletionProvider.js';
import { AgentManager } from '../services/AgentManager.js';
import { CommandHandler } from '../agent/CommandHandler.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ConfigManager } from '../services/ConfigManager.js';
import { SessionManager } from '../services/SessionManager.js';
import { ToolManager } from '../tools/ToolManager.js';
import { PatchManager } from '../services/PatchManager.js';
import { FocusManager } from '../services/FocusManager.js';
import { PluginConfigManager } from '../plugins/PluginConfigManager.js';
import { logger } from '../services/Logger.js';

/**
 * Reconstruct ToolCallState objects from message history
 *
 * When loading a session from disk, we have messages with tool_calls and tool results,
 * but we don't have the ToolCallState objects that are needed for proper UI rendering.
 * This function reconstructs those states from the message history.
 *
 * @param messages - Array of messages from the session
 * @param serviceRegistry - Service registry to look up tool definitions
 * @returns Array of reconstructed ToolCallState objects
 */
function reconstructToolCallsFromMessages(messages: Message[], serviceRegistry: ServiceRegistry): ToolCallState[] {
  const toolCalls: ToolCallState[] = [];
  const toolResultsMap = new Map<string, { output: string; error?: string; timestamp: number }>();

  // Get ToolManager to look up tool visibility
  const toolManager = serviceRegistry.get<ToolManager>('tool_manager');

  // First pass: collect all tool results
  messages.forEach(msg => {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResultsMap.set(msg.tool_call_id, {
        output: msg.content,
        error: msg.content.startsWith('Error:') ? msg.content : undefined,
        timestamp: msg.timestamp || Date.now(),
      });
    }
  });

  // Second pass: reconstruct tool call states from assistant messages
  messages.forEach(msg => {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const baseTimestamp = msg.timestamp || Date.now();

      msg.tool_calls.forEach((tc, index) => {
        const result = toolResultsMap.get(tc.id);
        const hasError = result?.error !== undefined;

        // Parse arguments if they're a string
        let parsedArgs: any;
        try {
          parsedArgs = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        } catch {
          parsedArgs = tc.function.arguments;
        }

        // Look up tool definition to get visibility settings
        let visibleInChat = true; // Default to visible
        if (toolManager) {
          const toolDef = toolManager.getTool(tc.function.name);
          if (toolDef) {
            visibleInChat = toolDef.visibleInChat ?? true;
          }
        }

        const toolCallState: ToolCallState = {
          id: tc.id,
          status: result ? (hasError ? 'error' : 'success') : 'success', // Default to success if we have the call
          toolName: tc.function.name,
          arguments: parsedArgs,
          output: result?.output,
          error: result?.error,
          startTime: baseTimestamp + index, // Slightly offset multiple calls in same message
          endTime: result?.timestamp,
          visibleInChat: visibleInChat,
        };

        toolCalls.push(toolCallState);
      });
    }
  });

  return toolCalls;
}


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

  /** Number of loaded plugins */
  pluginCount?: number;
}

/**
 * Inner app component that uses contexts
 *
 * This component is wrapped by providers and has access to all context values.
 * It subscribes to activity events and updates the app state accordingly.
 * Memoized to prevent unnecessary re-renders when children update.
 */
const AppContentComponent: React.FC<{ agent: Agent; resumeSession?: string | 'interactive' | null; showSetupWizard?: boolean; pluginCount?: number }> = ({ agent, resumeSession, showSetupWizard, pluginCount }) => {
  const { state, actions } = useAppContext();
  const activityStream = useActivityStreamContext();

  // Initialize command history, completion provider, and command handler
  const commandHistory = useRef<CommandHistory | null>(null);
  const [completionProvider, setCompletionProvider] = useState<CompletionProvider | null>(null);
  const commandHandler = useRef<CommandHandler | null>(null);


  // Streaming content accumulator (use ref to avoid stale closure in event handlers)
  const streamingContentRef = useRef<string>('');

  // Permission prompt state
  const [permissionRequest, setPermissionRequest] = useState<(PermissionRequest & { requestId: string }) | undefined>(undefined);
  const [permissionSelectedIndex, setPermissionSelectedIndex] = useState(0);

  // Model selector state
  const [modelSelectRequest, setModelSelectRequest] = useState<{ requestId: string; models: ModelOption[]; currentModel?: string; modelType?: 'ally' | 'service'; typeName?: string } | undefined>(undefined);
  const [modelSelectedIndex, setModelSelectedIndex] = useState(0);

  // Config viewer state (non-modal - stays open while user interacts)
  const [configViewerOpen, setConfigViewerOpen] = useState(false);

  // Setup wizard state
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);

  // Project wizard state
  const [projectWizardOpen, setProjectWizardOpen] = useState(false);

  // Agent wizard state
  const [agentWizardOpen, setAgentWizardOpen] = useState(false);
  const [agentWizardData, setAgentWizardData] = useState<{ initialDescription?: string }>({});

  // Plugin config state
  const [pluginConfigRequest, setPluginConfigRequest] = useState<{ pluginName: string; pluginPath: string; schema: any; existingConfig?: any } | undefined>(undefined);

  // Rewind selector state
  const [rewindRequest, setRewindRequest] = useState<{ requestId: string; userMessagesCount: number; selectedIndex: number } | undefined>(undefined);
  const [inputPrefillText, setInputPrefillText] = useState<string | undefined>(undefined);

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
        setPluginConfigRequest({
          pluginName: pendingRequest.pluginName,
          pluginPath: pendingRequest.pluginPath,
          schema: pendingRequest.schema,
          existingConfig: existingConfig || {},
        });
      }
    };

    checkPendingPluginConfig();
  }, []);

  // Input buffer state - preserve across modal renders
  const [inputBuffer, setInputBuffer] = useState<string>('');

  // Undo prompt state
  const [undoRequest, setUndoRequest] = useState<{ requestId: string; count: number; patches: any[]; previewData: any[] } | undefined>(undefined);
  const [undoSelectedIndex, setUndoSelectedIndex] = useState(0);

  // Undo file list state (two-stage flow)
  const [undoFileListRequest, setUndoFileListRequest] = useState<{ requestId: string; fileList: any[]; selectedIndex: number } | undefined>(undefined);

  // Session selector state
  const [sessionSelectRequest, setSessionSelectRequest] = useState<{ requestId: string; sessions: import('../types/index.js').SessionInfo[]; selectedIndex: number } | undefined>(undefined);

  // Track if we've already processed session resume to prevent duplicate runs
  const sessionResumed = useRef(false);

  // Track if we've already checked for first run to prevent duplicate checks
  const firstRunChecked = useRef(false);

  // Track active background agents (subagents, todo generator, etc.)
  const [activeAgentsCount, setActiveAgentsCount] = useState(0);

  // Track cancellation state for immediate visual feedback
  const [isCancelling, setIsCancelling] = useState(false);

  // Track exit confirmation state (Ctrl+C on empty buffer)
  const [isWaitingForExitConfirmation, setIsWaitingForExitConfirmation] = useState(false);

  // Get current focus display (if any)
  const currentFocus = useMemo(() => {
    const serviceRegistry = ServiceRegistry.getInstance();
    const focusManager = serviceRegistry.get<FocusManager>('focus_manager');
    return focusManager?.getFocusDisplay() ?? null;
  }, [state.messages.length]); // Re-compute when messages change (focus commands add messages)

  // Throttle tool call updates to max once every 2 seconds
  const pendingToolUpdates = useRef<Map<string, Partial<ToolCallState>>>(new Map());
  const lastUpdateTime = useRef<number>(Date.now());
  const updateTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Flush pending tool call updates
  const flushToolUpdates = useRef(() => {
    if (pendingToolUpdates.current.size === 0) return;

    // Apply all pending updates
    pendingToolUpdates.current.forEach((update, id) => {
      if (update.status === 'executing' && update.startTime) {
        // This is a new tool call
        actions.addToolCall(update as ToolCallState);
      } else {
        // This is an update to existing tool call
        actions.updateToolCall(id, update);
      }
    });

    pendingToolUpdates.current.clear();
    lastUpdateTime.current = Date.now();
  });

  // Schedule throttled update (batches updates, applies every 2s max)
  const scheduleToolUpdate = useRef((id: string, update: Partial<ToolCallState>, immediate: boolean = false) => {
    // Immediate updates for completion events (to avoid perceived lag)
    if (immediate) {
      actions.updateToolCall(id, update);
      return;
    }

    // Batch update
    const existing = pendingToolUpdates.current.get(id);
    pendingToolUpdates.current.set(id, { ...existing, ...update });

    // Clear existing timer
    if (updateTimerRef.current) {
      clearTimeout(updateTimerRef.current);
    }

    // If last update was beyond throttle window, flush immediately
    const timeSinceLastUpdate = Date.now() - lastUpdateTime.current;
    if (timeSinceLastUpdate >= UI_DELAYS.TOOL_UPDATE_THROTTLE) {
      flushToolUpdates.current();
    } else {
      // Otherwise schedule flush in remaining time
      const delay = UI_DELAYS.TOOL_UPDATE_THROTTLE - timeSinceLastUpdate;
      updateTimerRef.current = setTimeout(flushToolUpdates.current, delay);
    }
  });

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (updateTimerRef.current) {
        clearTimeout(updateTimerRef.current);
      }
    };
  }, []);

  // Initialize services and check for first-run on mount
  useEffect(() => {
    const initializeServices = async () => {
      try {
        // Get service registry and config manager
        const serviceRegistry = ServiceRegistry.getInstance();
        const configManager = serviceRegistry.get<ConfigManager>('config_manager');

        // First-run detection: Check if setup has been completed
        // OR if explicitly requested via --init flag
        // OR if required configuration values are missing
        if (configManager && !firstRunChecked.current) {
          firstRunChecked.current = true;
          const setupCompleted = configManager.getValue('setup_completed');

          // Check for required configuration values
          const endpoint = configManager.getValue('endpoint');
          const model = configManager.getValue('model');

          // Force setup if:
          // 1. Setup not completed
          // 2. Explicitly requested via --init flag
          // 3. Missing critical config (endpoint or model)
          const requiresSetup = !setupCompleted ||
                               showSetupWizard ||
                               !endpoint ||
                               !model;

          if (requiresSetup) {
            // Show setup wizard on first run, when explicitly requested, or if config is incomplete
            setSetupWizardOpen(true);
          }
        }

        // Create and load command history
        const history = new CommandHistory();
        await history.load();
        commandHistory.current = history;

        // Create completion provider with agent manager
        const agentManager = new AgentManager();
        const provider = new CompletionProvider(agentManager);
        setCompletionProvider(provider);

        // Create command handler with service registry and config manager
        if (configManager) {
          const handler = new CommandHandler(agent, configManager, serviceRegistry);
          commandHandler.current = handler;
        }

        // Initialize context usage from TokenManager
        const tokenManager = serviceRegistry.get('token_manager');
        if (tokenManager && typeof (tokenManager as any).getContextUsagePercentage === 'function') {
          const initialContextUsage = (tokenManager as any).getContextUsagePercentage();
          actions.setContextUsage(initialContextUsage);
        }
      } catch (error) {
        console.error('Failed to initialize input services:', error);
        // Continue without services
      }
    };

    initializeServices();
  }, [agent, actions]);

  // Track session loading state
  const [sessionLoaded, setSessionLoaded] = useState(!resumeSession);

  // Handle session resume on mount
  useEffect(() => {
    const handleSessionResume = async () => {
      // Only run once
      if (sessionResumed.current) return;

      const serviceRegistry = ServiceRegistry.getInstance();
      const sessionManager = serviceRegistry.get<SessionManager>('session_manager');
      const todoManager = serviceRegistry.get('todo_manager');

      if (!sessionManager) {
        setSessionLoaded(true);
        return;
      }

      // If resumeSession is 'interactive', show session selector
      if (resumeSession === 'interactive') {
        const sessions = await sessionManager.getSessionsInfoByDirectory();
        setSessionSelectRequest({
          requestId: `session_select_${Date.now()}`,
          sessions,
          selectedIndex: 0,
        });
        sessionResumed.current = true;
        setSessionLoaded(true);
        return;
      }

      // If resumeSession is a session ID, load it directly
      if (resumeSession && typeof resumeSession === 'string') {
        // CRITICAL: Set current session FIRST before loading messages
        // This prevents auto-save from creating a new session
        sessionManager.setCurrentSession(resumeSession);

        // Reload patches for the new session
        const patchManager = serviceRegistry.get<PatchManager>('patch_manager');
        if (patchManager) {
          await patchManager.onSessionChange();
        }

        // Load all session data in a single read (optimization)
        const sessionData = await sessionManager.getSessionData(resumeSession);

        // Filter out system messages to avoid duplication
        const userMessages = sessionData.messages.filter(m => m.role !== 'system');

        // Load idle messages into IdleMessageGenerator
        const idleMessageGenerator = serviceRegistry.get('idle_message_generator');
        if (idleMessageGenerator && sessionData.idleMessages.length > 0) {
          (idleMessageGenerator as any).setQueue(sessionData.idleMessages);
        }

        // Load todos into TodoManager (or clear if session has no todos)
        if (todoManager) {
          if (sessionData.todos.length > 0) {
            (todoManager as any).setTodos(sessionData.todos);
          } else {
            (todoManager as any).setTodos([]);
          }
        }

        // Bulk load messages (setMessages doesn't trigger auto-save)
        agent.setMessages(userMessages);

        // Load project context into ProjectContextDetector
        const projectContextDetector = serviceRegistry.get('project_context_detector');
        if (projectContextDetector && sessionData.projectContext) {
          (projectContextDetector as any).setCached(sessionData.projectContext);
        }

        // Reconstruct tool call states from message history for proper rendering
        const reconstructedToolCalls = reconstructToolCallsFromMessages(userMessages, serviceRegistry);
        reconstructedToolCalls.forEach(tc => actions.addToolCall(tc));

        // Mark session as loaded
        setSessionLoaded(true);

        // Update UI state
        actions.setMessages(userMessages);

        // Force Static to remount with loaded session messages
        actions.forceStaticRemount();

        // Update context usage
        const tokenManager = serviceRegistry.get('token_manager');
        if (tokenManager && typeof (tokenManager as any).updateTokenCount === 'function') {
          (tokenManager as any).updateTokenCount(agent.getMessages());
          const contextUsage = (tokenManager as any).getContextUsagePercentage();
          actions.setContextUsage(contextUsage);
        }

        sessionResumed.current = true;
      }
    };

    handleSessionResume();
  }, [resumeSession, agent, actions]);

  // Subscribe to tool call start events
  useActivityEvent(ActivityEventType.TOOL_CALL_START, (event) => {
    // Skip tool group orchestration events (they're not actual tool calls)
    if (event.data?.groupExecution) {
      return;
    }

    // Enforce structure: tool calls MUST have IDs
    if (!event.id) {
      throw new Error(`TOOL_CALL_START event missing required 'id' field. Tool: ${event.data?.toolName || 'unknown'}, Timestamp: ${event.timestamp}`);
    }

    if (!event.data?.toolName) {
      throw new Error(`TOOL_CALL_START event missing required 'toolName' field. ID: ${event.id}`);
    }

    if (!event.timestamp) {
      throw new Error(`TOOL_CALL_START event missing required 'timestamp' field. ID: ${event.id}, Tool: ${event.data.toolName}`);
    }

    const toolCall: ToolCallState = {
      id: event.id,
      status: 'executing',
      toolName: event.data.toolName,
      arguments: event.data.arguments || {},
      startTime: event.timestamp,
      parentId: event.parentId, // For nested tool calls (e.g., from subagents)
      visibleInChat: event.data.visibleInChat ?? true, // Whether to show in conversation
      isTransparent: event.data.isTransparent || false, // For wrapper tools
      collapsed: event.data.collapsed || false, // Collapse output for subagent tools
      shouldCollapse: event.data.shouldCollapse || false, // Collapse after completion
      hideOutput: event.data.hideOutput || false, // Never show output
    };

    // Tool call creation must be immediate to avoid race conditions with completion events
    actions.addToolCall(toolCall);
  });

  // Subscribe to tool call end events
  useActivityEvent(ActivityEventType.TOOL_CALL_END, (event) => {
    // Skip tool group orchestration events (they're not actual tool calls)
    if (event.data?.groupExecution) {
      return;
    }

    // Enforce structure
    if (!event.id) {
      throw new Error(`TOOL_CALL_END event missing required 'id' field. Timestamp: ${event.timestamp}`);
    }

    if (!event.timestamp) {
      throw new Error(`TOOL_CALL_END event missing required 'timestamp' field. ID: ${event.id}`);
    }

    if (event.data?.success === undefined) {
      throw new Error(`TOOL_CALL_END event missing required 'success' field. ID: ${event.id}`);
    }

    const updates: Partial<ToolCallState> = {
      status: event.data.success ? 'success' : 'error',
      endTime: event.timestamp,
      error: event.data.error,
      // Clear diff preview on completion - the preview is no longer relevant
      diffPreview: undefined,
    };

    // If executionStartTime was never set (permission timeout/denial), set it to endTime
    // This ensures duration = 0 for tools that never actually executed
    const toolCall = state.activeToolCalls.find((tc: ToolCallState) => tc.id === event.id);
    if (toolCall && !toolCall.executionStartTime) {
      updates.executionStartTime = event.timestamp;
    }

    // If tool has shouldCollapse, collapse it on completion (takes priority)
    if (event.data.shouldCollapse) {
      updates.collapsed = true;
    } else if (event.data.collapsed !== undefined) {
      // Only use explicit collapsed state if shouldCollapse is not set
      updates.collapsed = event.data.collapsed;
    }

    scheduleToolUpdate.current(event.id, updates, true); // Immediate update for completion
  });

  // Subscribe to tool execution start events (for accurate timing)
  useActivityEvent(ActivityEventType.TOOL_EXECUTION_START, (event) => {
    // Enforce structure
    if (!event.id) {
      throw new Error('TOOL_EXECUTION_START event missing required id field');
    }

    if (!event.timestamp) {
      throw new Error(`TOOL_EXECUTION_START event missing required 'timestamp' field. ID: ${event.id}`);
    }

    // Update tool call with execution start time (after permission granted)
    scheduleToolUpdate.current(event.id, {
      executionStartTime: event.timestamp,
    }, true); // Immediate update for timing accuracy
  });

  // Subscribe to tool output chunks
  useActivityEvent(ActivityEventType.TOOL_OUTPUT_CHUNK, (event) => {
    // Enforce structure
    if (!event.id) {
      throw new Error(`TOOL_OUTPUT_CHUNK event missing required 'id' field`);
    }

    scheduleToolUpdate.current(event.id, {
      output: event.data?.chunk || '',
    }, false); // Throttled update
  });

  // Subscribe to assistant content chunks (streaming final response)
  useActivityEvent(ActivityEventType.ASSISTANT_CHUNK, (event) => {
    const chunk = event.data?.chunk || '';
    if (chunk) {
      // Accumulate in ref to avoid stale closure issues
      streamingContentRef.current += chunk;
      actions.setStreamingContent(streamingContentRef.current);
    }
  });

  // Subscribe to thinking complete (when thinking block finishes during streaming)
  useActivityEvent(ActivityEventType.THOUGHT_COMPLETE, (event) => {
    const thinking = event.data?.thinking || '';

    // Only add to chat if show_thinking_in_chat is enabled
    if (state.config?.show_thinking_in_chat && thinking) {
      // Add thinking as an assistant message
      actions.addMessage({
        role: 'assistant',
        content: '',
        thinking: thinking,
        timestamp: Date.now(),
      });
    }
  });

  // Track agent start (both main and specialized agents)
  useActivityEvent(ActivityEventType.AGENT_START, (event) => {
    const isSpecialized = event.data?.isSpecializedAgent || false;

    // Increment count for specialized agents (subagents, todo generator, etc.)
    if (isSpecialized) {
      setActiveAgentsCount((prev) => prev + 1);
    } else {
      // Clear streaming content when main agent starts processing
      streamingContentRef.current = '';
      actions.setStreamingContent(undefined);
    }
  });

  // Track agent end (both main and specialized agents)
  useActivityEvent(ActivityEventType.AGENT_END, (event) => {
    const isSpecialized = event.data?.isSpecializedAgent || false;

    // Decrement count for specialized agents
    if (isSpecialized) {
      setActiveAgentsCount((prev) => Math.max(0, prev - 1));
    } else {
      // Clear streaming content when main agent finishes
      streamingContentRef.current = '';
      actions.setStreamingContent(undefined);
    }

    // Clear cancelling state when agent finishes
    setIsCancelling(false);
  });

  // Track user-initiated interrupts for immediate visual feedback
  useActivityEvent(ActivityEventType.USER_INTERRUPT_INITIATED, () => {
    setIsCancelling(true);
  });

  // Subscribe to diff preview events
  useActivityEvent(ActivityEventType.DIFF_PREVIEW, (event) => {
    if (!event.id) {
      throw new Error(`DIFF_PREVIEW event missing required 'id' field`);
    }

    scheduleToolUpdate.current(event.id, {
      diffPreview: {
        oldContent: event.data?.oldContent || '',
        newContent: event.data?.newContent || '',
        filePath: event.data?.filePath || '',
        operationType: event.data?.operationType || 'edit',
      },
    }, false); // Throttled update
  });

  // Subscribe to error events
  useActivityEvent(ActivityEventType.ERROR, (event) => {
    // Skip tool group orchestration events (they're not actual tool calls)
    if (event.data?.groupExecution) {
      return;
    }

    // Enforce structure
    if (!event.id) {
      throw new Error(`ERROR event missing required 'id' field`);
    }

    if (!event.timestamp) {
      throw new Error(`ERROR event missing required 'timestamp' field. ID: ${event.id}`);
    }

    scheduleToolUpdate.current(event.id, {
      status: 'error',
      error: event.data?.error || 'Unknown error',
      endTime: event.timestamp,
      // Clear diff preview on error
      diffPreview: undefined,
    }, true); // Immediate update for errors
  });

  // Subscribe to permission request events
  useActivityEvent(ActivityEventType.PERMISSION_REQUEST, (event) => {
    // Enforce structure
    if (!event.id) {
      throw new Error(`PERMISSION_REQUEST event missing required 'id' field`);
    }

    const { requestId, toolName, path, command, arguments: args, sensitivity, options } = event.data || {};

    if (!requestId) {
      throw new Error(`PERMISSION_REQUEST event missing required 'requestId' field. ID: ${event.id}`);
    }

    // Note: Permission requests have their own IDs (perm_xxx) that are separate from tool call IDs
    // They occur BEFORE tool calls start, so there's no tool call to update yet

    setPermissionRequest({
      requestId,
      toolName,
      path,
      command,
      arguments: args,
      sensitivity,
      options,
    });
    setPermissionSelectedIndex(0); // Reset selection
  });

  // Subscribe to permission response events (to clear UI state)
  useActivityEvent(ActivityEventType.PERMISSION_RESPONSE, () => {
    // Just clear the permission prompt UI
    // The tool call will start (TOOL_CALL_START) after permission is granted
    setPermissionRequest(undefined);
    setPermissionSelectedIndex(0);
  });

  // Subscribe to model select request events
  useActivityEvent(ActivityEventType.MODEL_SELECT_REQUEST, (event) => {
    const { requestId, models, currentModel, modelType, typeName } = event.data;
    setModelSelectRequest({ requestId, models, currentModel, modelType, typeName });
    setModelSelectedIndex(0);
  });

  // Subscribe to config view toggle events
  useActivityEvent(ActivityEventType.CONFIG_VIEW_REQUEST, () => {
    // Toggle config viewer open/closed
    setConfigViewerOpen(prev => !prev);
  });

  // Subscribe to setup wizard request events
  useActivityEvent(ActivityEventType.SETUP_WIZARD_REQUEST, () => {
    setSetupWizardOpen(true);
  });

  // Subscribe to setup wizard completion events
  useActivityEvent(ActivityEventType.SETUP_WIZARD_COMPLETE, async () => {
    setSetupWizardOpen(false);

    // Apply config changes to the current session
    const registry = ServiceRegistry.getInstance();
    const configManager = registry.get<ConfigManager>('config_manager');

    if (configManager) {
      try {
        // Reload config from disk to get latest values
        await configManager.initialize();
        const newConfig = configManager.getConfig();

        // Update main model client with new settings
        const modelClient = registry.get<any>('model_client');
        if (modelClient) {
          if (typeof modelClient.setModelName === 'function' && newConfig.model) {
            modelClient.setModelName(newConfig.model);
          }
          if (typeof modelClient.setTemperature === 'function') {
            modelClient.setTemperature(newConfig.temperature);
          }
          if (typeof modelClient.setContextSize === 'function') {
            modelClient.setContextSize(newConfig.context_size);
          }
          if (typeof modelClient.setMaxTokens === 'function') {
            modelClient.setMaxTokens(newConfig.max_tokens);
          }
        }

        // Update service model client with new settings
        const serviceModelClient = registry.get<any>('service_model_client');
        if (serviceModelClient) {
          const serviceModel = newConfig.service_model ?? newConfig.model;
          if (typeof serviceModelClient.setModelName === 'function' && serviceModel) {
            serviceModelClient.setModelName(serviceModel);
          }
          if (typeof serviceModelClient.setTemperature === 'function') {
            serviceModelClient.setTemperature(newConfig.temperature);
          }
          if (typeof serviceModelClient.setContextSize === 'function') {
            serviceModelClient.setContextSize(newConfig.context_size);
          }
          if (typeof serviceModelClient.setMaxTokens === 'function') {
            serviceModelClient.setMaxTokens(newConfig.max_tokens);
          }
        }

        // Update App context config for UI display
        actions.updateConfig(newConfig);

        actions.addMessage({
          role: 'assistant',
          content: 'Setup completed successfully! Code Ally is ready to use.',
        });
      } catch (error) {
        actions.addMessage({
          role: 'assistant',
          content: `Setup completed, but failed to apply some changes: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    } else {
      actions.addMessage({
        role: 'assistant',
        content: 'Setup completed successfully! Code Ally is ready to use.',
      });
    }
  });

  // Subscribe to setup wizard skip events
  useActivityEvent(ActivityEventType.SETUP_WIZARD_SKIP, () => {
    setSetupWizardOpen(false);
    actions.addMessage({
      role: 'assistant',
      content: 'Setup wizard skipped. You can run /init anytime to configure Code Ally.',
    });
  });

  // Subscribe to project wizard request events
  useActivityEvent(ActivityEventType.PROJECT_WIZARD_REQUEST, () => {
    setProjectWizardOpen(true);
  });

  // Subscribe to project wizard completion events
  useActivityEvent(ActivityEventType.PROJECT_WIZARD_COMPLETE, () => {
    setProjectWizardOpen(false);
    actions.addMessage({
      role: 'assistant',
      content: '✓ ALLY.md has been created successfully!',
    });
  });

  // Subscribe to project wizard skip events
  useActivityEvent(ActivityEventType.PROJECT_WIZARD_SKIP, () => {
    setProjectWizardOpen(false);
    actions.addMessage({
      role: 'assistant',
      content: 'Project configuration skipped. You can run /project init anytime.',
    });
  });

  // Subscribe to agent wizard request events
  useActivityEvent(ActivityEventType.AGENT_WIZARD_REQUEST, (event) => {
    const { initialDescription } = event.data || {};
    setAgentWizardData({ initialDescription });
    setAgentWizardOpen(true);
  });

  // Subscribe to agent wizard completion events
  useActivityEvent(ActivityEventType.AGENT_WIZARD_COMPLETE, async (event) => {
    const { name, description, systemPrompt, tools } = event.data || {};
    setAgentWizardOpen(false);

    // Save the agent using AgentManager
    const serviceRegistry = ServiceRegistry.getInstance();
    const agentManager = serviceRegistry.get<AgentManager>('agent_manager');

    if (agentManager && name && description && systemPrompt) {
      try {
        await agentManager.saveAgent({
          name,
          description,
          system_prompt: systemPrompt,
          tools, // undefined = all tools
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        actions.addMessage({
          role: 'assistant',
          content: `✓ Agent '${name}' has been created successfully!\n\nYou can use it with:\n  • agent(task_prompt="...", agent_name="${name}")\n  • /agent use ${name} <task>`,
        });
      } catch (error) {
        actions.addMessage({
          role: 'assistant',
          content: `Failed to create agent: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  });

  // Subscribe to agent wizard skip events
  useActivityEvent(ActivityEventType.AGENT_WIZARD_SKIP, () => {
    setAgentWizardOpen(false);
    actions.addMessage({
      role: 'assistant',
      content: 'Agent creation cancelled. You can run /agent create anytime.',
    });
  });

  // Subscribe to agent use request events
  useActivityEvent(ActivityEventType.AGENT_USE_REQUEST, async (event) => {
    const { agentName, taskPrompt } = event.data || {};

    if (!agentName || !taskPrompt) {
      actions.addMessage({
        role: 'assistant',
        content: 'Error: Missing agent name or task prompt',
      });
      return;
    }

    // Get the tool manager and execute the agent tool directly
    const serviceRegistry = ServiceRegistry.getInstance();
    const toolManager = serviceRegistry.get<ToolManager>('tool_manager');
    const agentTool = toolManager?.getTool('agent');

    if (!agentTool) {
      actions.addMessage({
        role: 'assistant',
        content: 'Error: Agent tool not available',
      });
      return;
    }

    // Execute the agent tool
    try {
      const result = await agentTool.execute({
        task_prompt: taskPrompt,
        agent_name: agentName,
      });

      if (result.success) {
        // Agent executed successfully, result is in the response
        const response = (result as any).agent_response || 'Agent completed task';
        actions.addMessage({
          role: 'assistant',
          content: response,
        });
      } else {
        actions.addMessage({
          role: 'assistant',
          content: `Agent execution failed: ${result.error}`,
        });
      }
    } catch (error) {
      actions.addMessage({
        role: 'assistant',
        content: `Error executing agent: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  // Subscribe to plugin config request events
  useActivityEvent(ActivityEventType.PLUGIN_CONFIG_REQUEST, async (event) => {
    logger.debug('[App] Received PLUGIN_CONFIG_REQUEST event:', JSON.stringify(event.data, null, 2));
    const { pluginName, pluginPath, schema } = event.data;

    if (!pluginName || !pluginPath || !schema) {
      logger.error('[App] PLUGIN_CONFIG_REQUEST event missing required fields');
      return;
    }

    logger.debug(`[App] Setting up config request for plugin: ${pluginName}`);

    // Load existing config if available
    const serviceRegistry = ServiceRegistry.getInstance();
    const pluginConfigManager = serviceRegistry.get<PluginConfigManager>('plugin_config_manager');
    let existingConfig: any = undefined;

    logger.debug(`[App] PluginConfigManager available: ${!!pluginConfigManager}`);

    if (pluginConfigManager) {
      try {
        existingConfig = await pluginConfigManager.loadConfig(pluginName, pluginPath, schema);
        logger.debug(`[App] Loaded existing config: ${JSON.stringify(existingConfig)}`);
      } catch (error) {
        logger.debug(`[App] No existing config found or error loading: ${error}`);
        // Ignore errors, just start with empty config
      }
    }

    logger.debug(`[App] Calling setPluginConfigRequest`);
    setPluginConfigRequest({
      pluginName,
      pluginPath,
      schema,
      existingConfig: existingConfig || {},
    });
    logger.debug(`[App] pluginConfigRequest state should now be set`);
  });

  // Subscribe to context usage updates (real-time updates during tool execution)
  useActivityEvent(ActivityEventType.CONTEXT_USAGE_UPDATE, (event) => {
    const { contextUsage } = event.data;
    if (typeof contextUsage === 'number') {
      actions.setContextUsage(contextUsage);
    }
  });

  // Subscribe to auto-compaction start event
  useActivityEvent(ActivityEventType.AUTO_COMPACTION_START, () => {
    actions.setIsCompacting(true);
  });

  // Subscribe to auto-compaction complete event
  useActivityEvent(ActivityEventType.AUTO_COMPACTION_COMPLETE, (event) => {
    const { oldContextUsage, newContextUsage, threshold, compactedMessages } = event.data;

    // Update UI messages to compacted state (filter out system messages)
    if (compactedMessages) {
      const uiMessages = compactedMessages.filter((m: Message) => m.role !== 'system');
      actions.setMessages(uiMessages);
    }

    // Force Static to remount with compacted messages
    actions.forceStaticRemount();

    // Clear all tool calls - they're part of the compacted history
    actions.clearToolCalls();

    // Add compaction notice
    actions.addCompactionNotice({
      id: event.id,
      timestamp: event.timestamp,
      oldContextUsage,
      threshold,
    });

    // Update context usage
    if (typeof newContextUsage === 'number') {
      actions.setContextUsage(newContextUsage);
    }

    // Clear compacting flag
    actions.setIsCompacting(false);
  });

  // Subscribe to model select response events
  useActivityEvent(ActivityEventType.MODEL_SELECT_RESPONSE, async (event) => {
    const { modelName, modelType } = event.data;

    // Get the model type from the stored request (fallback to 'ally' if not specified)
    const effectiveModelType = modelType || modelSelectRequest?.modelType || 'ally';

    // Clear selector immediately (crucial for unblocking input)
    setModelSelectRequest(undefined);
    setModelSelectedIndex(0);

    // Apply selection if not cancelled
    if (modelName) {
      const registry = ServiceRegistry.getInstance();
      const configManager = registry.get<ConfigManager>('config_manager');

      if (configManager) {
        try {
          // Determine which config key and client to update
          const configKey = effectiveModelType === 'service' ? 'service_model' : 'model';
          const clientKey = effectiveModelType === 'service' ? 'service_model_client' : 'model_client';

          // Update config
          await configManager.setValue(configKey, modelName);

          // Update the active ModelClient to use the new model
          const modelClient = registry.get<any>(clientKey);
          if (modelClient && typeof modelClient.setModelName === 'function') {
            modelClient.setModelName(modelName);
          }

          // Update state config for UI display
          if (effectiveModelType === 'service') {
            actions.updateConfig({ service_model: modelName });
          } else {
            actions.updateConfig({ model: modelName });
          }

          // Add confirmation message
          const typeName = effectiveModelType === 'service' ? 'Service model' : 'Model';
          actions.addMessage({
            role: 'assistant',
            content: `${typeName} changed to: ${modelName}`,
          });
        } catch (error) {
          actions.addMessage({
            role: 'assistant',
            content: `Error changing model: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
        }
      }
    }
  });

  // Subscribe to rewind request events
  useActivityEvent(ActivityEventType.REWIND_REQUEST, (event) => {
    const { requestId } = event.data;

    // Only allow rewind when agent is not thinking and no active tools
    if (state.isThinking || state.activeToolCalls.length > 0) {
      actions.addMessage({
        role: 'assistant',
        content: 'Cannot rewind while agent is processing. Please wait for current operation to complete.',
      });
      return;
    }

    // Don't calculate here - state.messages is stale!
    // Just set a marker request that will be populated in useEffect
    setRewindRequest({
      requestId,
      userMessagesCount: -1, // Marker that this needs initialization
      selectedIndex: -1 // Marker that this needs initialization
    });
  });

  // Update rewind request with current state when it's first set
  useEffect(() => {
    if (rewindRequest && rewindRequest.userMessagesCount === -1) {
      const userMessages = state.messages.filter(m => m.role === 'user');

      // Cancel rewind if there are no user messages
      if (userMessages.length === 0) {
        setRewindRequest(undefined);
        actions.addMessage({
          role: 'assistant',
          content: 'No user messages to rewind to.',
        });
        return;
      }

      const initialIndex = Math.max(0, userMessages.length - 1);

      setRewindRequest(prev => prev ? {
        ...prev,
        userMessagesCount: userMessages.length,
        selectedIndex: initialIndex
      } : undefined);
    }
  }, [rewindRequest, state.messages, actions]);

  // Two-stage undo flow: File list request
  useActivityEvent(ActivityEventType.UNDO_FILE_LIST_REQUEST, (event) => {
    const { requestId, fileList } = event.data;

    if (!requestId || !fileList) {
      throw new Error(`UNDO_FILE_LIST_REQUEST event missing required fields. ID: ${event.id}`);
    }

    setUndoFileListRequest({
      requestId,
      fileList,
      selectedIndex: 0, // Start with first file selected
    });
  });

  // Two-stage undo flow: File selected (show diff preview)
  useActivityEvent(ActivityEventType.UNDO_FILE_SELECTED, async (event) => {
    const { patchNumber, filePath } = event.data;

    const serviceRegistry = ServiceRegistry.getInstance();
    const patchManager = serviceRegistry.get<PatchManager>('patch_manager');

    if (!patchManager) {
      actions.addMessage({
        role: 'assistant',
        content: 'Error: Patch manager not available',
      });
      return;
    }

    try {
      // Get preview for single patch
      const preview = await patchManager.previewSinglePatch(patchNumber);

      if (!preview) {
        actions.addMessage({
          role: 'assistant',
          content: `Error: Could not load preview for ${filePath}`,
        });
        return;
      }

      // Show single file diff with Confirm/Cancel options
      setUndoRequest({
        requestId: `undo_single_${patchNumber}`,
        count: 1,
        patches: [{ patch_number: patchNumber, file_path: filePath }],
        previewData: [preview],
      });
      setUndoSelectedIndex(0);
    } catch (error) {
      actions.addMessage({
        role: 'assistant',
        content: `Error loading preview: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  // Two-stage undo flow: Back to file list
  useActivityEvent(ActivityEventType.UNDO_FILE_BACK, () => {
    // Clear diff view, keep file list
    setUndoRequest(undefined);
    setUndoSelectedIndex(0);
  });

  // Two-stage undo flow: Confirm undo
  useActivityEvent(ActivityEventType.UNDO_CONFIRM, async (event) => {
    const { requestId } = event.data;

    // Extract patch number from request ID (format: "undo_single_<patch_number>")
    const patchNumber = parseInt(requestId.replace('undo_single_', ''));

    if (isNaN(patchNumber)) {
      actions.addMessage({
        role: 'assistant',
        content: 'Error: Invalid patch number',
      });
      return;
    }

    const serviceRegistry = ServiceRegistry.getInstance();
    const patchManager = serviceRegistry.get<PatchManager>('patch_manager');

    if (!patchManager) {
      actions.addMessage({
        role: 'assistant',
        content: 'Error: Patch manager not available',
      });
      return;
    }

    try {
      // Execute undo for single patch
      const result = await patchManager.undoSinglePatch(patchNumber);

      // Clear diff view
      setUndoRequest(undefined);
      setUndoSelectedIndex(0);

      if (result.success) {
        const fileList = result.reverted_files.map((f: string) => `  - ${f}`).join('\n');
        actions.addMessage({
          role: 'assistant',
          content: `Successfully undid operation:\n${fileList}`,
        });

        // Refresh file list
        const updatedFileList = await patchManager.getRecentFileList(10);
        if (updatedFileList.length > 0) {
          setUndoFileListRequest({
            requestId: `undo_${Date.now()}`,
            fileList: updatedFileList,
            selectedIndex: 0,
          });
        } else {
          // No more files to undo, close the flow
          setUndoFileListRequest(undefined);
        }
      } else {
        const errors = result.failed_operations.join('\n  - ');
        actions.addMessage({
          role: 'assistant',
          content: `Undo failed:\n  - ${errors}`,
        });
      }
    } catch (error) {
      actions.addMessage({
        role: 'assistant',
        content: `Error during undo: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  // Two-stage undo flow: Cancel entire flow
  useActivityEvent(ActivityEventType.UNDO_CANCELLED, () => {
    setUndoFileListRequest(undefined);
    setUndoRequest(undefined);
    setUndoSelectedIndex(0);
  });

  // Subscribe to rewind response events
  // Subscribe to session select response events
  useActivityEvent(ActivityEventType.SESSION_SELECT_RESPONSE, async (event) => {
    const { sessionId, cancelled } = event.data;

    // Clear selector immediately (crucial for unblocking input)
    setSessionSelectRequest(undefined);

    // Apply selection if not cancelled
    if (!cancelled && sessionId) {
      const serviceRegistry = ServiceRegistry.getInstance();
      const sessionManager = serviceRegistry.get<SessionManager>('session_manager');
      const todoManager = serviceRegistry.get('todo_manager');
      const tokenManager = serviceRegistry.get('token_manager');

      if (!sessionManager) return;

      try {
        // CRITICAL: Set current session FIRST before loading messages
        // This prevents auto-save from creating a new session
        sessionManager.setCurrentSession(sessionId);

        // Reload patches for the new session
        const patchManager = serviceRegistry.get<PatchManager>('patch_manager');
        if (patchManager) {
          await patchManager.onSessionChange();
        }

        // Load all session data in a single read (optimization)
        const sessionData = await sessionManager.getSessionData(sessionId);

        // Filter out system messages to avoid duplication
        const userMessages = sessionData.messages.filter(m => m.role !== 'system');

        // Bulk load messages into agent (setMessages doesn't trigger per-message events)
        agent.setMessages(userMessages);

        // Load todos into TodoManager (or clear if session has no todos)
        if (todoManager) {
          if (sessionData.todos.length > 0) {
            (todoManager as any).setTodos(sessionData.todos);
          } else {
            (todoManager as any).setTodos([]);
          }
        }

        // Load idle messages into IdleMessageGenerator (if switching to a session with idle messages)
        const idleMessageGenerator = serviceRegistry.get('idle_message_generator');
        if (idleMessageGenerator && sessionData.idleMessages.length > 0) {
          (idleMessageGenerator as any).setQueue(sessionData.idleMessages);
        }

        // Load project context into ProjectContextDetector
        const projectContextDetector = serviceRegistry.get('project_context_detector');
        if (projectContextDetector && sessionData.projectContext) {
          (projectContextDetector as any).setCached(sessionData.projectContext);
        }

        // Clear existing tool calls and reconstruct from message history
        actions.clearToolCalls();
        const reconstructedToolCalls = reconstructToolCallsFromMessages(userMessages, serviceRegistry);
        reconstructedToolCalls.forEach(tc => actions.addToolCall(tc));

        // Update UI state
        actions.setMessages(userMessages);

        // Force Static to remount with switched session messages
        actions.forceStaticRemount();

        // Update context usage
        if (tokenManager && typeof (tokenManager as any).updateTokenCount === 'function') {
          (tokenManager as any).updateTokenCount(agent.getMessages());
          const contextUsage = (tokenManager as any).getContextUsagePercentage();
          actions.setContextUsage(contextUsage);
        }
      } catch (error) {
        console.error('Failed to load session:', error);
      }
    }
  });

  useActivityEvent(ActivityEventType.REWIND_RESPONSE, async (event) => {
    const { selectedIndex, cancelled } = event.data;

    // Clear selector immediately (crucial for unblocking input)
    setRewindRequest(undefined);

    // Apply rewind if not cancelled
    if (!cancelled && selectedIndex !== undefined) {
      try {
        // Perform the rewind on the agent's message array
        const targetMessageContent = await agent.rewindToMessage(selectedIndex);

        // Get fresh messages from agent after rewind (filter out system messages)
        const rewindedMessages = agent.getMessages().filter(m => m.role !== 'system');

        // Reconstruct the entire conversation state from rewound messages
        // This ensures perfect consistency between messages and tool calls
        const serviceRegistry = ServiceRegistry.getInstance();

        // Clear all tool calls and reconstruct from message history
        actions.clearToolCalls();
        const reconstructedToolCalls = reconstructToolCallsFromMessages(rewindedMessages, serviceRegistry);
        reconstructedToolCalls.forEach(tc => actions.addToolCall(tc));

        // Clear todos when rewinding
        // Note: With the new todo management tools (todo_add, todo_update, todo_remove, todo_clear),
        // we can no longer reconstruct todos from messages since there's no single "snapshot" tool.
        // Todo state is preserved in session saves but not in rewind operations.
        const todoManager = serviceRegistry.get('todo_manager');
        if (todoManager && typeof (todoManager as any).setTodos === 'function') {
          (todoManager as any).setTodos([]);
        }

        // Force Static to remount FIRST (before adding notice)
        // This prevents the notice from being rendered twice
        actions.forceStaticRemount();

        // Update UI state with rewound messages
        actions.setMessages(rewindedMessages);

        // Clear any previous rewind notices to prevent duplicates
        actions.clearRewindNotices();

        // Add rewind notice to mark the rewind point
        // This happens after remount, so it will only be rendered once
        actions.addRewindNotice({
          id: `rewind_${Date.now()}`,
          timestamp: Date.now(),
          targetMessageIndex: selectedIndex,
        });

        // Pre-fill the input with the target message for editing
        setInputPrefillText(targetMessageContent);
      } catch (error) {
        actions.addMessage({
          role: 'assistant',
          content: `Error rewinding conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }
  });

  // Handle user input
  const handleInput = async (input: string) => {
    const trimmed = input.trim();

    // Check for bash shortcuts (! prefix)
    if (trimmed.startsWith('!')) {
      const bashCommand = trimmed.slice(1).trim();

      if (bashCommand) {
        try {
          // Get ToolManager from ServiceRegistry
          const serviceRegistry = ServiceRegistry.getInstance();
          const toolManager = serviceRegistry.get<ToolManager>('tool_manager');

          if (!toolManager) {
            actions.addMessage({
              role: 'assistant',
              content: 'Error: Tool manager not available',
            });
            return;
          }

          // Get BashTool
          const bashTool = toolManager.getTool('bash');

          if (!bashTool) {
            actions.addMessage({
              role: 'assistant',
              content: 'Error: Bash tool not available',
            });
            return;
          }

          // Generate unique tool call ID: bash-{timestamp}-{7-char-random} (base-36, skip '0.' prefix)
          const toolCallId = `bash-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;

          // Create assistant message that describes the bash execution
          const assistantMessage = {
            role: 'assistant' as const,
            content: '',
            tool_calls: [{
              id: toolCallId,
              type: 'function' as const,
              function: {
                name: 'bash',
                arguments: { command: bashCommand },
              },
            }],
          };

          // Add messages to Agent's conversation history
          agent.addMessage({ role: 'user', content: bashCommand });
          agent.addMessage(assistantMessage);

          // Add user message to UI
          actions.addMessage({
            role: 'user',
            content: bashCommand,
          });

          // Emit TOOL_CALL_START event to create UI element
          activityStream.emit({
            id: toolCallId,
            type: ActivityEventType.TOOL_CALL_START,
            timestamp: Date.now(),
            data: {
              toolName: 'bash',
              arguments: { command: bashCommand },
              visibleInChat: bashTool.visibleInChat ?? true,
              isTransparent: bashTool.isTransparentWrapper || false,
            },
          });

          // Execute bash command with ID for streaming output
          const result = await bashTool.execute({ command: bashCommand }, toolCallId);

          // Emit TOOL_CALL_END event to complete the tool call
          activityStream.emit({
            id: toolCallId,
            type: ActivityEventType.TOOL_CALL_END,
            timestamp: Date.now(),
            data: {
              toolName: 'bash',
              result,
              success: result.success,
              error: result.success ? undefined : result.error,
              visibleInChat: bashTool.visibleInChat ?? true,
              isTransparent: bashTool.isTransparentWrapper || false,
              collapsed: bashTool.shouldCollapse || false,
            },
          });

          // Format tool result message for Agent
          const toolResultMessage = {
            role: 'tool' as const,
            content: JSON.stringify(result),
            tool_call_id: toolCallId,
            name: 'bash',
          };

          // Add tool result to Agent's conversation history
          agent.addMessage(toolResultMessage);

          // Tool call display already shows the result, no need for additional message
          return;
        } catch (error) {
          actions.addMessage({
            role: 'assistant',
            content: `Error executing bash command: ${error instanceof Error ? error.message : 'Unknown error'}`,
          });
          return;
        }
      }
    }

    // Check for slash commands
    if (trimmed.startsWith('/') && commandHandler.current) {
      try {
        const result = await commandHandler.current.handleCommand(trimmed, state.messages);

        if (result.handled) {
          // Add user message
          actions.addMessage({
            role: 'user',
            content: trimmed,
          });

          // Add command response if provided
          if (result.response) {
            actions.addMessage({
              role: 'assistant',
              content: result.response,
              metadata: result.metadata, // Pass command metadata for styling
            });
          }


          return;
        }
      } catch (error) {
        // Add error message for failed command
        actions.addMessage({
          role: 'assistant',
          content: `Command error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
        return;
      }
    }

    // Add user message
    if (trimmed) {
      actions.addMessage({
        role: 'user',
        content: trimmed,
      });

      // Set thinking state
      actions.setIsThinking(true);

      // Cancel any ongoing background LLM tasks (idle messages, title generation)
      // This must be done BEFORE calling agent.sendMessage() to avoid resource competition
      //
      // Retry behavior:
      // - IdleMessageGenerator: Will naturally retry every 60s when idle (StatusIndicator)
      // - SessionTitleGenerator: Will retry when next new session is created (low priority)
      const serviceRegistry = ServiceRegistry.getInstance();
      const services = [
        serviceRegistry.get('idle_message_generator'),
        (serviceRegistry.get('session_manager') as any)?.titleGenerator,
      ].filter(Boolean);

      for (const service of services) {
        if (typeof (service as any).cancel === 'function') {
          (service as any).cancel();
        }
      }

      // Send to agent for processing
      try {
        const response = await agent.sendMessage(trimmed);

        // Add assistant response
        actions.addMessage({
          role: 'assistant',
          content: response,
        });

        // Update TokenManager and context usage
        const registry = ServiceRegistry.getInstance();
        const tokenManager = registry.get('token_manager');
        if (tokenManager) {
          // Recalculate tokens from agent's messages
          const agentMessages = agent.getMessages();
          if (typeof (tokenManager as any).updateTokenCount === 'function') {
            (tokenManager as any).updateTokenCount(agentMessages);
          }

          // Update context usage display
          if (typeof (tokenManager as any).getContextUsagePercentage === 'function') {
            const contextUsage = (tokenManager as any).getContextUsagePercentage();
            actions.setContextUsage(contextUsage);
          }
        }
      } catch (error) {
        // Add error message
        actions.addMessage({
          role: 'assistant',
          content: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      } finally {
        // Clear thinking state
        actions.setIsThinking(false);
      }
    }
  };

  return (
    <Box flexDirection="column" padding={1}>
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
        config={state.config}
        pluginCount={pluginCount}
      />

      {/* Config Viewer (non-modal - shown above input) */}
      {configViewerOpen && !setupWizardOpen && (
        <Box marginTop={1}>
          <ConfigViewer visible={true} />
        </Box>
      )}

      {/* Setup Wizard (modal - replaces input when active) */}
      {setupWizardOpen ? (
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
      projectWizardOpen ? (
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
      agentWizardOpen ? (
        <Box marginTop={1}>
          <AgentWizardView
            initialDescription={agentWizardData.initialDescription}
            onComplete={(agentData) => {
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
      pluginConfigRequest ? (
        <Box marginTop={1}>
          <PluginConfigView
            pluginName={pluginConfigRequest.pluginName}
            configSchema={pluginConfigRequest.schema}
            existingConfig={pluginConfigRequest.existingConfig}
            onComplete={async (config) => {
              const serviceRegistry = ServiceRegistry.getInstance();
              const pluginConfigManager = serviceRegistry.get<PluginConfigManager>('plugin_config_manager');

              if (!pluginConfigManager) {
                actions.addMessage({
                  role: 'assistant',
                  content: 'Error: Plugin configuration manager not available',
                });
                setPluginConfigRequest(undefined);
                return;
              }

              try {
                // Save the configuration
                await pluginConfigManager.saveConfig(
                  pluginConfigRequest.pluginName,
                  pluginConfigRequest.pluginPath,
                  config,
                  pluginConfigRequest.schema
                );

                // Reload the plugin immediately
                const { PluginLoader } = await import('../plugins/PluginLoader.js');
                const pluginLoader = serviceRegistry.get<InstanceType<typeof PluginLoader>>('plugin_loader');
                const toolManager = serviceRegistry.get<ToolManager>('tool_manager');

                if (pluginLoader && toolManager) {
                  try {
                    // Reload plugin to get the tools
                    const newTools = await pluginLoader.reloadPlugin(
                      pluginConfigRequest.pluginName,
                      pluginConfigRequest.pluginPath
                    );

                    // Register the new tools
                    toolManager.registerTools(newTools);

                    logger.info(`Plugin '${pluginConfigRequest.pluginName}' reloaded successfully`);
                  } catch (reloadError) {
                    logger.error(`Error reloading plugin '${pluginConfigRequest.pluginName}':`, reloadError);
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
                      pluginName: pluginConfigRequest.pluginName,
                      pluginPath: pluginConfigRequest.pluginPath,
                    },
                  });
                }

                // Clear request
                setPluginConfigRequest(undefined);

                // Add success message
                actions.addMessage({
                  role: 'assistant',
                  content: `✓ Plugin '${pluginConfigRequest.pluginName}' configured and activated!`,
                });
              } catch (error) {
                actions.addMessage({
                  role: 'assistant',
                  content: `Error saving plugin configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
                });
                setPluginConfigRequest(undefined);
              }
            }}
            onCancel={() => {
              // Emit cancel event
              if (activityStream) {
                activityStream.emit({
                  id: `plugin_config_cancel_${Date.now()}`,
                  type: ActivityEventType.PLUGIN_CONFIG_CANCEL,
                  timestamp: Date.now(),
                  data: {
                    pluginName: pluginConfigRequest.pluginName,
                  },
                });
              }

              // Clear request
              setPluginConfigRequest(undefined);

              actions.addMessage({
                role: 'assistant',
                content: `Plugin configuration cancelled. Plugin '${pluginConfigRequest.pluginName}' remains inactive.`,
              });
            }}
          />
        </Box>
      ) : /* Session Selector (replaces input when active) */
      sessionSelectRequest ? (
        <Box marginTop={1} flexDirection="column">
          {/* Reasoning Stream - shows thinking tokens */}
          <ReasoningStream config={state.config} />

          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator isProcessing={state.isThinking} isCompacting={state.isCompacting} isCancelling={isCancelling} recentMessages={state.messages.slice(-3)} sessionLoaded={sessionLoaded} isResuming={!!resumeSession} />

          <SessionSelector
            sessions={sessionSelectRequest.sessions}
            selectedIndex={sessionSelectRequest.selectedIndex}
            visible={true}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              isActive={true}
              commandHistory={commandHistory.current || undefined}
              completionProvider={completionProvider || undefined}
              sessionSelectRequest={sessionSelectRequest}
              onSessionNavigate={(newIndex) => setSessionSelectRequest(prev => prev ? { ...prev, selectedIndex: newIndex } : undefined)}
              activityStream={activityStream}
              agent={agent}
              prefillText={inputPrefillText}
              onPrefillConsumed={() => setInputPrefillText(undefined)}
              bufferValue={inputBuffer}
              onBufferChange={setInputBuffer}
            />
          </Box>
        </Box>
      ) : /* Model Selector (replaces input when active) */
      modelSelectRequest ? (
        <Box marginTop={1} flexDirection="column">
          {/* Reasoning Stream - shows thinking tokens */}
          <ReasoningStream config={state.config} />

          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator isProcessing={state.isThinking} isCompacting={state.isCompacting} isCancelling={isCancelling} recentMessages={state.messages.slice(-3)} sessionLoaded={sessionLoaded} isResuming={!!resumeSession} />

          <ModelSelector
            models={modelSelectRequest.models}
            selectedIndex={modelSelectedIndex}
            currentModel={modelSelectRequest.currentModel}
            typeName={modelSelectRequest.typeName}
            visible={true}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              isActive={true}
              commandHistory={commandHistory.current || undefined}
              completionProvider={completionProvider || undefined}
              modelSelectRequest={modelSelectRequest}
              modelSelectedIndex={modelSelectedIndex}
              onModelNavigate={setModelSelectedIndex}
              activityStream={activityStream}
              agent={agent}
              prefillText={inputPrefillText}
              onPrefillConsumed={() => setInputPrefillText(undefined)}
              bufferValue={inputBuffer}
              onBufferChange={setInputBuffer}
            />
          </Box>
        </Box>
      ) : rewindRequest ? (
        /* Rewind Selector (replaces input when active) */
        (() => {
          const userMessages = state.messages.filter(m => m.role === 'user');
          return (
            <Box marginTop={1} flexDirection="column">
              {/* Reasoning Stream - shows thinking tokens */}
              <ReasoningStream config={state.config} />

              {/* Status Indicator - always visible to show todos */}
              <StatusIndicator isProcessing={state.isThinking} isCompacting={state.isCompacting} recentMessages={state.messages.slice(-3)} sessionLoaded={sessionLoaded} isResuming={!!resumeSession} />

              <RewindSelector
                messages={userMessages}
                selectedIndex={rewindRequest.selectedIndex}
                visible={true}
              />
              {/* Hidden InputPrompt for keyboard handling only */}
              <Box height={0} overflow="hidden">
                <InputPrompt
                  onSubmit={handleInput}
                  isActive={true}
                  commandHistory={commandHistory.current || undefined}
                  completionProvider={completionProvider || undefined}
                  rewindRequest={rewindRequest}
                  onRewindNavigate={(newIndex) => setRewindRequest(prev => prev ? { ...prev, selectedIndex: newIndex } : undefined)}
                  activityStream={activityStream}
                  agent={agent}
                  prefillText={inputPrefillText}
                  onPrefillConsumed={() => setInputPrefillText(undefined)}
                  bufferValue={inputBuffer}
                  onBufferChange={setInputBuffer}
                />
              </Box>
            </Box>
          );
        })()
      ) : undoFileListRequest && !undoRequest ? (
        /* Undo File List (two-stage flow - stage 1) */
        <Box marginTop={1} flexDirection="column">
          {/* Reasoning Stream - shows thinking tokens */}
          <ReasoningStream config={state.config} />

          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator isProcessing={state.isThinking} isCompacting={state.isCompacting} isCancelling={isCancelling} recentMessages={state.messages.slice(-3)} sessionLoaded={sessionLoaded} isResuming={!!resumeSession} />

          <UndoFileList
            request={undoFileListRequest}
            visible={true}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              isActive={true}
              commandHistory={commandHistory.current || undefined}
              completionProvider={completionProvider || undefined}
              undoFileListRequest={undoFileListRequest}
              onUndoFileListNavigate={(newIndex) => setUndoFileListRequest(prev => prev ? { ...prev, selectedIndex: newIndex } : undefined)}
              activityStream={activityStream}
              agent={agent}
              prefillText={inputPrefillText}
              onPrefillConsumed={() => setInputPrefillText(undefined)}
              bufferValue={inputBuffer}
              onBufferChange={setInputBuffer}
            />
          </Box>
        </Box>
      ) : undoRequest ? (
        /* Undo Prompt (two-stage flow - stage 2, or legacy single-stage) */
        <Box marginTop={1} flexDirection="column">
          {/* Reasoning Stream - shows thinking tokens */}
          <ReasoningStream config={state.config} />

          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator isProcessing={state.isThinking} isCompacting={state.isCompacting} isCancelling={isCancelling} recentMessages={state.messages.slice(-3)} sessionLoaded={sessionLoaded} isResuming={!!resumeSession} />

          <UndoPrompt
            request={undoRequest}
            selectedIndex={undoSelectedIndex}
            visible={true}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              isActive={true}
              commandHistory={commandHistory.current || undefined}
              completionProvider={completionProvider || undefined}
              undoRequest={undoRequest}
              undoSelectedIndex={undoSelectedIndex}
              onUndoNavigate={setUndoSelectedIndex}
              activityStream={activityStream}
              agent={agent}
              prefillText={inputPrefillText}
              onPrefillConsumed={() => setInputPrefillText(undefined)}
              bufferValue={inputBuffer}
              onBufferChange={setInputBuffer}
            />
          </Box>
        </Box>
      ) : permissionRequest ? (
        /* Permission Prompt (replaces input when active) */
        <Box marginTop={1} flexDirection="column">
          {/* Reasoning Stream - shows thinking tokens */}
          <ReasoningStream config={state.config} />

          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator isProcessing={state.isThinking} isCompacting={state.isCompacting} isCancelling={isCancelling} recentMessages={state.messages.slice(-3)} sessionLoaded={sessionLoaded} isResuming={!!resumeSession} />

          <PermissionPrompt
            request={permissionRequest}
            selectedIndex={permissionSelectedIndex}
            visible={true}
          />
          {/* Hidden InputPrompt for keyboard handling only */}
          <Box height={0} overflow="hidden">
            <InputPrompt
              onSubmit={handleInput}
              isActive={true}
              commandHistory={commandHistory.current || undefined}
              completionProvider={completionProvider || undefined}
              permissionRequest={permissionRequest}
              permissionSelectedIndex={permissionSelectedIndex}
              onPermissionNavigate={setPermissionSelectedIndex}
              activityStream={activityStream}
              agent={agent}
              prefillText={inputPrefillText}
              onPrefillConsumed={() => setInputPrefillText(undefined)}
              bufferValue={inputBuffer}
              onBufferChange={setInputBuffer}
            />
          </Box>
        </Box>
      ) : (
        /* Input Group - Status Indicator + Input Prompt */
        <Box marginTop={1} flexDirection="column">
          {/* Reasoning Stream - shows thinking tokens */}
          <ReasoningStream config={state.config} />

          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator isProcessing={state.isThinking} isCompacting={state.isCompacting} isCancelling={isCancelling} recentMessages={state.messages.slice(-3)} sessionLoaded={sessionLoaded} isResuming={!!resumeSession} />

          {/* Input Prompt */}
          <InputPrompt
            onSubmit={handleInput}
            isActive={true}
            commandHistory={commandHistory.current || undefined}
            completionProvider={completionProvider || undefined}
            configViewerOpen={configViewerOpen}
            activityStream={activityStream}
            agent={agent}
            prefillText={inputPrefillText}
            onPrefillConsumed={() => setInputPrefillText(undefined)}
            onExitConfirmationChange={setIsWaitingForExitConfirmation}
            bufferValue={inputBuffer}
            onBufferChange={setInputBuffer}
          />
        </Box>
      )}

      {/* Footer / Help */}
      <Box marginTop={1}>
        <Text dimColor>
          <Text color={isWaitingForExitConfirmation ? 'yellow' : undefined}>Ctrl+C to exit</Text>{activeAgentsCount > 0 && <Text> | <Text color="cyan">{activeAgentsCount} active agent{activeAgentsCount === 1 ? '' : 's'}</Text></Text>} | Model: {state.config.model || 'none'}{currentFocus && <Text> | Focus: <Text color="magenta">{currentFocus}</Text></Text>} |{' '}
          {state.contextUsage >= CONTEXT_THRESHOLDS.WARNING ? (
            <Text color="red">Context: {CONTEXT_THRESHOLDS.MAX_PERCENT - state.contextUsage}% remaining - use /compact</Text>
          ) : state.contextUsage >= CONTEXT_THRESHOLDS.NORMAL ? (
            <Text color="yellow">Context: {CONTEXT_THRESHOLDS.MAX_PERCENT - state.contextUsage}% remaining - consider /compact</Text>
          ) : (
            <Text>Context: {CONTEXT_THRESHOLDS.MAX_PERCENT - state.contextUsage}% remaining</Text>
          )}
        </Text>
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
  return agentSame && resumeSame && setupSame;
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
export const App: React.FC<AppProps> = ({ config, activityStream, agent, resumeSession, showSetupWizard, pluginCount }) => {
  // Create activity stream if not provided
  const streamRef = useRef(activityStream || new ActivityStream());

  return (
    <ActivityProvider activityStream={streamRef.current}>
      <AppProvider initialConfig={config}>
        <AppContent agent={agent} resumeSession={resumeSession} showSetupWizard={showSetupWizard} pluginCount={pluginCount} />
      </AppProvider>
    </ActivityProvider>
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

  return (
    <ActivityProvider activityStream={streamRef.current}>
      <AppProvider initialConfig={config}>
        <AppContentWithMessages agent={agent} initialMessages={initialMessages} />
      </AppProvider>
    </ActivityProvider>
  );
};

/**
 * Inner component that accepts initial messages
 */
const AppContentWithMessages: React.FC<{ agent: Agent; initialMessages: Message[] }> = ({
  agent,
  initialMessages,
}) => {
  const { actions } = useAppContext();

  // Load initial messages on mount
  useEffect(() => {
    if (initialMessages.length > 0) {
      actions.setMessages(initialMessages);
    }
  }, []); // Only run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps

  return <AppContent agent={agent} />;
};

export default App;
