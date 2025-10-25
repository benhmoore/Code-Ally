/**
 * App - Root React component for Code Ally UI
 *
 * This is the main entry point for the Ink-based terminal UI. It sets up
 * the context providers, manages global state, and coordinates the overall
 * application structure.
 */

import React, { useEffect, useRef, useState } from 'react';
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
import { RewindSelector } from './components/RewindSelector.js';
import { SessionSelector } from './components/SessionSelector.js';
import { StatusIndicator } from './components/StatusIndicator.js';
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
}

/**
 * Inner app component that uses contexts
 *
 * This component is wrapped by providers and has access to all context values.
 * It subscribes to activity events and updates the app state accordingly.
 * Memoized to prevent unnecessary re-renders when children update.
 */
const AppContentComponent: React.FC<{ agent: Agent; resumeSession?: string | 'interactive' | null }> = ({ agent, resumeSession }) => {
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
  const [modelSelectRequest, setModelSelectRequest] = useState<{ requestId: string; models: ModelOption[]; currentModel?: string } | undefined>(undefined);
  const [modelSelectedIndex, setModelSelectedIndex] = useState(0);

  // Config viewer state (non-modal - stays open while user interacts)
  const [configViewerOpen, setConfigViewerOpen] = useState(false);

  // Setup wizard state
  const [setupWizardOpen, setSetupWizardOpen] = useState(false);

  // Project wizard state
  const [projectWizardOpen, setProjectWizardOpen] = useState(false);

  // Rewind selector state
  const [rewindRequest, setRewindRequest] = useState<{ requestId: string; userMessagesCount: number; selectedIndex: number } | undefined>(undefined);
  const [inputPrefillText, setInputPrefillText] = useState<string | undefined>(undefined);

  // Session selector state
  const [sessionSelectRequest, setSessionSelectRequest] = useState<{ requestId: string; sessions: import('../types/index.js').SessionInfo[]; selectedIndex: number } | undefined>(undefined);

  // Track if we've already processed session resume to prevent duplicate runs
  const sessionResumed = useRef(false);

  // Track active background agents (subagents, todo generator, etc.)
  const [activeAgentsCount, setActiveAgentsCount] = useState(0);

  // Track cancellation state for immediate visual feedback
  const [isCancelling, setIsCancelling] = useState(false);

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

    // If last update was > 2s ago, flush immediately
    const timeSinceLastUpdate = Date.now() - lastUpdateTime.current;
    if (timeSinceLastUpdate >= 2000) {
      flushToolUpdates.current();
    } else {
      // Otherwise schedule flush in remaining time
      const delay = 2000 - timeSinceLastUpdate;
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

  // Initialize services on mount
  useEffect(() => {
    const initializeServices = async () => {
      try {
        // Create and load command history
        const history = new CommandHistory();
        await history.load();
        commandHistory.current = history;

        // Create completion provider with agent manager
        const agentManager = new AgentManager();
        const provider = new CompletionProvider(agentManager);
        setCompletionProvider(provider);

        // Create command handler with service registry and config manager
        const serviceRegistry = ServiceRegistry.getInstance();
        const configManager = serviceRegistry.get<ConfigManager>('config_manager');

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

        const sessionMessages = await sessionManager.getSessionMessages(resumeSession);
        const sessionTodos = await sessionManager.getTodos(resumeSession);
        const sessionIdleMessages = await sessionManager.getIdleMessages(resumeSession);

        // Filter out system messages to avoid duplication
        const userMessages = sessionMessages.filter(m => m.role !== 'system');

        // Load idle messages into IdleMessageGenerator
        const idleMessageGenerator = serviceRegistry.get('idle_message_generator');
        if (idleMessageGenerator && sessionIdleMessages.length > 0) {
          (idleMessageGenerator as any).setQueue(sessionIdleMessages);
        }

        // Load todos into TodoManager
        if (todoManager && sessionTodos.length > 0) {
          (todoManager as any).setTodos(sessionTodos);
        }

        // Bulk load messages (setMessages doesn't trigger auto-save)
        agent.setMessages(userMessages);

        // Load project context into ProjectContextDetector
        const projectContextDetector = serviceRegistry.get('project_context_detector');
        const sessionProjectContext = await sessionManager.getProjectContext(resumeSession);
        if (projectContextDetector && sessionProjectContext) {
          (projectContextDetector as any).setCached(sessionProjectContext);
        }

        // Mark session as loaded
        setSessionLoaded(true);

        // Update UI state
        actions.setMessages(userMessages);

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

    // If tool has shouldCollapse, collapse it on completion (takes priority)
    if (event.data.shouldCollapse) {
      updates.collapsed = true;
    } else if (event.data.collapsed !== undefined) {
      // Only use explicit collapsed state if shouldCollapse is not set
      updates.collapsed = event.data.collapsed;
    }

    scheduleToolUpdate.current(event.id, updates, true); // Immediate update for completion
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
    const { requestId, models, currentModel } = event.data;
    setModelSelectRequest({ requestId, models, currentModel });
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
  useActivityEvent(ActivityEventType.SETUP_WIZARD_COMPLETE, () => {
    setSetupWizardOpen(false);
    actions.addMessage({
      role: 'assistant',
      content: 'Setup completed successfully! Code Ally is ready to use.',
    });
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
    const { modelName } = event.data;

    // Clear selector immediately (crucial for unblocking input)
    setModelSelectRequest(undefined);
    setModelSelectedIndex(0);

    // Apply selection if not cancelled
    if (modelName) {
      const registry = ServiceRegistry.getInstance();
      const configManager = registry.get<ConfigManager>('config_manager');

      if (configManager) {
        try {
          // Update config
          await configManager.setValue('model', modelName);

          // Update the active ModelClient to use the new model
          const modelClient = registry.get<any>('model_client');
          if (modelClient && typeof modelClient.setModelName === 'function') {
            modelClient.setModelName(modelName);
          }

          // Update state config for UI display
          actions.updateConfig({ model: modelName });

          // Add confirmation message
          actions.addMessage({
            role: 'assistant',
            content: `Model changed to: ${modelName}`,
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
      const initialIndex = Math.max(0, userMessages.length - 1);

      setRewindRequest(prev => prev ? {
        ...prev,
        userMessagesCount: userMessages.length,
        selectedIndex: initialIndex
      } : undefined);
    }
  }, [rewindRequest, state.messages]);

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

        // Load session data
        const sessionMessages = await sessionManager.getSessionMessages(sessionId);
        const sessionTodos = await sessionManager.getTodos(sessionId);

        // Filter out system messages to avoid duplication
        const userMessages = sessionMessages.filter(m => m.role !== 'system');

        // Load messages into agent (auto-save will now use the correct session)
        userMessages.forEach(message => agent.addMessage(message));

        // Load todos into TodoManager
        if (todoManager && sessionTodos.length > 0) {
          (todoManager as any).setTodos(sessionTodos);
        }

        // Update UI state
        actions.setMessages(userMessages);

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
        const targetMessageContent = await agent.rewindToMessage(selectedIndex);

        // Update UI state - get fresh messages from agent, filter out system messages
        const newMessages = agent.getMessages().filter(m => m.role !== 'system');
        actions.setMessages(newMessages);

        // Force Static to remount with new message list
        actions.forceStaticRemount();

        // Find the timestamp of the rewind target message
        const allMessages = agent.getMessages();
        const targetMessage = allMessages[selectedIndex];
        const rewindTimestamp = (targetMessage as any)?.timestamp || Date.now();

        // Clear only tool calls that occurred AFTER the rewind point
        // Keep tool calls that happened before to preserve conversation history
        const currentToolCalls = state.activeToolCalls;
        const toolCallsToKeep = currentToolCalls.filter(tc => tc.startTime < rewindTimestamp);

        // Remove all, then add back the ones we want to keep
        actions.clearToolCalls();
        toolCallsToKeep.forEach(tc => actions.addToolCall(tc));

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

          // Generate unique tool call ID
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

    // Check for slash commands first
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
        staticRemountKey={state.staticRemountKey}
        config={state.config}
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
      ) : /* Session Selector (replaces input when active) */
      sessionSelectRequest ? (
        <Box marginTop={1} flexDirection="column">
          {/* Reasoning Stream - shows thinking tokens */}
          <ReasoningStream />

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
            />
          </Box>
        </Box>
      ) : /* Model Selector (replaces input when active) */
      modelSelectRequest ? (
        <Box marginTop={1} flexDirection="column">
          {/* Reasoning Stream - shows thinking tokens */}
          <ReasoningStream />

          {/* Status Indicator - always visible to show todos */}
          <StatusIndicator isProcessing={state.isThinking} isCompacting={state.isCompacting} isCancelling={isCancelling} recentMessages={state.messages.slice(-3)} sessionLoaded={sessionLoaded} isResuming={!!resumeSession} />

          <ModelSelector
            models={modelSelectRequest.models}
            selectedIndex={modelSelectedIndex}
            currentModel={modelSelectRequest.currentModel}
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
              <ReasoningStream />

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
                />
              </Box>
            </Box>
          );
        })()
      ) : permissionRequest ? (
        /* Permission Prompt (replaces input when active) */
        <Box marginTop={1} flexDirection="column">
          {/* Reasoning Stream - shows thinking tokens */}
          <ReasoningStream />

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
            />
          </Box>
        </Box>
      ) : (
        /* Input Group - Status Indicator + Input Prompt */
        <Box marginTop={1} flexDirection="column">
          {/* Reasoning Stream - shows thinking tokens */}
          <ReasoningStream />

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
          />
        </Box>
      )}

      {/* Footer / Help */}
      <Box marginTop={1}>
        <Text dimColor>
          Ctrl+C to exit{activeAgentsCount > 0 && <Text> | <Text color="cyan">{activeAgentsCount} active agent{activeAgentsCount === 1 ? '' : 's'}</Text></Text>} | Model: {state.config.model || 'none'} |{' '}
          {state.contextUsage >= 85 ? (
            <Text color="red">Context: {100 - state.contextUsage}% remaining - use /compact</Text>
          ) : state.contextUsage >= 70 ? (
            <Text color="yellow">Context: {100 - state.contextUsage}% remaining - consider /compact</Text>
          ) : (
            <Text>Context: {100 - state.contextUsage}% remaining</Text>
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
  return agentSame && resumeSame;
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
export const App: React.FC<AppProps> = ({ config, activityStream, agent, resumeSession }) => {
  // Create activity stream if not provided
  const streamRef = useRef(activityStream || new ActivityStream());

  return (
    <ActivityProvider activityStream={streamRef.current}>
      <AppProvider initialConfig={config}>
        <AppContent agent={agent} resumeSession={resumeSession} />
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
