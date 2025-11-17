/**
 * useActivitySubscriptions - Subscribe to all ActivityStream events
 *
 * This hook centralizes all event subscriptions for the App component,
 * including tool calls, assistant responses, permissions, modals, and more.
 * It's a large hook but keeps all event handling logic in one place.
 */

import { useRef, useEffect, useState } from 'react';
import { ActivityEventType, Message, ToolCallState } from '@shared/index.js';
import { useActivityEvent } from './useActivityEvent.js';
import { AppState, AppActions } from '../contexts/AppContext.js';
import { ModalState } from './useModalState.js';
import { reconstructInterjectionsFromMessages, loadSessionData } from './useSessionResume.js';
import { Agent } from '@agent/Agent.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ConfigManager } from '@services/ConfigManager.js';
import { SessionManager } from '@services/SessionManager.js';
import { PatchManager } from '@services/PatchManager.js';
import { ToolManager } from '@tools/ToolManager.js';
import { AgentManager } from '@services/AgentManager.js';
import { PluginConfigManager } from '@plugins/PluginConfigManager.js';
import { logger } from '@services/Logger.js';

/**
 * Activity subscriptions state
 */
export interface ActivitySubscriptionsState {
  /** Number of active background agents (subagents, todo generator, etc.) */
  activeAgentsCount: number;
  /** Cancellation state for immediate visual feedback */
  isCancelling: boolean;
}

/**
 * Subscribe to all ActivityStream events
 *
 * This hook manages all event subscriptions for the App component.
 * It's intentionally kept as a single hook to maintain cohesion and
 * avoid prop drilling between multiple hooks.
 *
 * @param state - App context state
 * @param actions - App context actions
 * @param modal - Modal state and setters
 * @param agent - The agent instance
 * @param activityStream - ActivityStream instance
 * @returns Activity subscriptions state
 *
 * @example
 * ```tsx
 * const { activeAgentsCount, isCancelling } = useActivitySubscriptions(
 *   state,
 *   actions,
 *   modal,
 *   agent,
 *   activityStream
 * );
 * ```
 */
export const useActivitySubscriptions = (
  state: AppState,
  actions: AppActions,
  modal: ModalState,
  agent: Agent,
  activityStream: ActivityStream
): ActivitySubscriptionsState => {
  // Streaming content accumulator (use ref to avoid stale closure in event handlers)
  const streamingContentRef = useRef<string>('');

  // Track thinking start times (keyed by parentId or 'root' for main agent)
  const thinkingStartTimes = useRef<Map<string, number>>(new Map());

  // Track active background agents (subagents, todo generator, etc.)
  const [activeAgentsCount, setActiveAgentsCount] = useState(0);

  // Track cancellation state for immediate visual feedback
  const [isCancelling, setIsCancelling] = useState(false);

  // Batch tool call updates using setImmediate for better performance
  // Replaces setTimeout-based throttling (reduces UI overhead by 25-30%)
  // Uses setImmediate instead of requestAnimationFrame (Node.js environment)
  const pendingToolUpdates = useRef<Map<string, Partial<ToolCallState>>>(new Map());
  const immediateIdRef = useRef<NodeJS.Immediate | null>(null);
  const lastBatchFlushTime = useRef<number>(Date.now());

  // Flush pending tool call updates
  const flushToolUpdates = useRef(() => {
    if (pendingToolUpdates.current.size === 0) return;

    pendingToolUpdates.current.forEach((update, id) => {
      if (update.status === 'executing' && update.startTime) {
        actions.addToolCall(update as ToolCallState);
      } else {
        actions.updateToolCall(id, update);
      }
    });

    pendingToolUpdates.current.clear();
    lastBatchFlushTime.current = Date.now();
    immediateIdRef.current = null;
  });

  // Schedule batched update using setImmediate
  // Batches all updates that occur within the same event loop tick
  // More efficient than setTimeout as it executes after I/O operations but before timers
  const scheduleToolUpdate = useRef((id: string, update: Partial<ToolCallState>, immediate: boolean = false) => {
    if (immediate) {
      // Immediate updates bypass batching (e.g., tool completion)
      actions.updateToolCall(id, update);
      return;
    }

    // Accumulate update in the pending batch
    const existing = pendingToolUpdates.current.get(id);
    pendingToolUpdates.current.set(id, { ...existing, ...update });

    // Schedule flush if not already scheduled
    if (immediateIdRef.current === null) {
      immediateIdRef.current = setImmediate(() => {
        flushToolUpdates.current();
      });
    }
  });

  // Cleanup setImmediate on unmount
  useEffect(() => {
    return () => {
      if (immediateIdRef.current !== null) {
        clearImmediate(immediateIdRef.current);
        // Flush any pending updates before unmount
        flushToolUpdates.current();
      }
    };
  }, []);

  // Tool call start events
  useActivityEvent(ActivityEventType.TOOL_CALL_START, (event) => {
    if (event.data?.groupExecution) return;

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
      parentId: event.parentId,
      visibleInChat: event.data.visibleInChat ?? true,
      isTransparent: event.data.isTransparent || false,
      collapsed: event.data.collapsed || false,
      shouldCollapse: event.data.shouldCollapse || false,
      hideOutput: event.data.hideOutput || false,
    };

    actions.addToolCall(toolCall);
  });

  // Tool call end events
  useActivityEvent(ActivityEventType.TOOL_CALL_END, (event) => {
    if (event.data?.groupExecution) return;

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
      error_type: event.data.result?.error_type,
    };

    // Extract agent_id from result for agent delegations
    if (event.data.result?.agent_id) {
      updates.agentId = event.data.result.agent_id;
    }

    // Clear diff preview on failure (operation didn't complete)
    if (!event.data.success) {
      updates.diffPreview = undefined;
    }

    const toolCall = state.activeToolCalls.find((tc: ToolCallState) => tc.id === event.id);
    if (toolCall && !toolCall.executionStartTime) {
      updates.executionStartTime = event.timestamp;
    }

    if (event.data.shouldCollapse) {
      updates.collapsed = true;
    } else if (event.data.collapsed !== undefined) {
      updates.collapsed = event.data.collapsed;
    }

    scheduleToolUpdate.current(event.id, updates, true);
  });

  // Tool execution start events
  useActivityEvent(ActivityEventType.TOOL_EXECUTION_START, (event) => {
    if (!event.id) {
      throw new Error('TOOL_EXECUTION_START event missing required id field');
    }
    if (!event.timestamp) {
      throw new Error(`TOOL_EXECUTION_START event missing required 'timestamp' field. ID: ${event.id}`);
    }

    scheduleToolUpdate.current(event.id, {
      executionStartTime: event.timestamp,
    }, true);
  });

  // Tool output chunks
  useActivityEvent(ActivityEventType.TOOL_OUTPUT_CHUNK, (event) => {
    if (!event.id) {
      throw new Error(`TOOL_OUTPUT_CHUNK event missing required 'id' field`);
    }

    scheduleToolUpdate.current(event.id, {
      output: event.data?.chunk || '',
    }, false);
  });

  // Assistant content chunks
  useActivityEvent(ActivityEventType.ASSISTANT_CHUNK, (event) => {
    const chunk = event.data?.chunk || '';
    if (chunk) {
      streamingContentRef.current += chunk;
      actions.setStreamingContent(streamingContentRef.current);
    }
  });

  // Thinking start (track start time for duration calculation)
  useActivityEvent(ActivityEventType.THOUGHT_CHUNK, (event) => {
    // Track start time when we see the "Thinking..." indicator
    if (event.data?.thinking === true) {
      const key = event.parentId || 'root';
      // Only set if not already tracking (to capture first chunk time)
      if (!thinkingStartTimes.current.has(key)) {
        thinkingStartTimes.current.set(key, event.timestamp);
      }
    }
  });

  // Thinking complete
  useActivityEvent(ActivityEventType.THOUGHT_COMPLETE, (event) => {
    const thinking = event.data?.thinking || '';
    const key = event.parentId || 'root';
    const startTime = thinkingStartTimes.current.get(key);
    const endTime = event.timestamp;

    // Always track thinking (not just when show_thinking_in_chat is true)
    // This allows us to show truncated version when setting is false
    if (thinking) {
      // If event has parentId, associate thinking with that tool call (subagent)
      // Otherwise, add as a standalone message (root agent)
      if (event.parentId) {
        // Find the tool call and update it with thinking content
        actions.updateToolCall(event.parentId, { thinking });
      } else {
        // Root agent thinking - add as message with timing info
        actions.addMessage({
          role: 'assistant',
          content: '',
          thinking: thinking,
          thinkingStartTime: startTime,
          thinkingEndTime: endTime,
          timestamp: Date.now(),
        });
      }

      // Clear the tracked start time
      thinkingStartTimes.current.delete(key);
    }
  });

  // System prompt display
  useActivityEvent(ActivityEventType.SYSTEM_PROMPT_DISPLAY, (event) => {
    const agentType = event.data?.agentType || 'Agent';
    const systemPrompt = event.data?.systemPrompt || '';

    if (state.config?.show_system_prompt_in_chat && systemPrompt) {
      actions.addMessage({
        role: 'assistant',
        content: `**System Prompt for ${agentType}:**\n\n\`\`\`\n${systemPrompt}\n\`\`\``,
        timestamp: Date.now(),
      });
    }
  });

  // Agent start
  useActivityEvent(ActivityEventType.AGENT_START, (event) => {
    const isSpecialized = event.data?.isSpecializedAgent || false;

    if (isSpecialized) {
      setActiveAgentsCount((prev) => prev + 1);
    } else {
      streamingContentRef.current = '';
      actions.setStreamingContent(undefined);
    }
  });

  // Agent end
  useActivityEvent(ActivityEventType.AGENT_END, (event) => {
    const isSpecialized = event.data?.isSpecializedAgent || false;
    const wasInterrupted = event.data?.interrupted || false;

    if (isSpecialized) {
      setActiveAgentsCount((prev) => Math.max(0, prev - 1));
    } else {
      streamingContentRef.current = '';
      actions.setStreamingContent(undefined);

      // Clear active tool calls when main agent ends (especially if interrupted)
      if (wasInterrupted) {
        actions.clearToolCalls();
      }
    }

    setIsCancelling(false);
  });

  // User interrupt initiated
  useActivityEvent(ActivityEventType.USER_INTERRUPT_INITIATED, () => {
    setIsCancelling(true);
  });

  // Diff preview
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
    }, false);
  });

  // Error events
  useActivityEvent(ActivityEventType.ERROR, (event) => {
    if (event.data?.groupExecution) return;

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
      diffPreview: undefined, // Clear diff preview on error (operation didn't complete)
    }, true);
  });

  // Permission request events
  useActivityEvent(ActivityEventType.PERMISSION_REQUEST, (event) => {
    if (!event.id) {
      throw new Error(`PERMISSION_REQUEST event missing required 'id' field`);
    }

    const { requestId, toolName, path, command, arguments: args, sensitivity, options } = event.data || {};

    if (!requestId) {
      throw new Error(`PERMISSION_REQUEST event missing required 'requestId' field. ID: ${event.id}`);
    }

    modal.setPermissionRequest({
      requestId,
      toolName,
      path,
      command,
      arguments: args,
      sensitivity,
      options,
    });
    modal.setPermissionSelectedIndex(0);
  });

  // Permission response events
  useActivityEvent(ActivityEventType.PERMISSION_RESPONSE, () => {
    modal.setPermissionRequest(undefined);
    modal.setPermissionSelectedIndex(0);
  });

  // Model select request events
  useActivityEvent(ActivityEventType.MODEL_SELECT_REQUEST, (event) => {
    const { requestId, models, currentModel, modelType, typeName } = event.data;
    modal.setModelSelectRequest({ requestId, models, currentModel, modelType, typeName });
    modal.setModelSelectedIndex(0);
  });

  // Config view toggle events
  useActivityEvent(ActivityEventType.CONFIG_VIEW_REQUEST, () => {
    modal.setConfigViewerOpen(!modal.configViewerOpen);
  });

  // Setup wizard request events
  useActivityEvent(ActivityEventType.SETUP_WIZARD_REQUEST, () => {
    modal.setSetupWizardOpen(true);
  });

  // Setup wizard completion events
  useActivityEvent(ActivityEventType.SETUP_WIZARD_COMPLETE, async () => {
    modal.setSetupWizardOpen(false);

    const registry = ServiceRegistry.getInstance();
    const configManager = registry.get<ConfigManager>('config_manager');

    if (configManager) {
      try {
        await configManager.initialize();
        const newConfig = configManager.getConfig();

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

  // Setup wizard skip events
  useActivityEvent(ActivityEventType.SETUP_WIZARD_SKIP, () => {
    modal.setSetupWizardOpen(false);
    actions.addMessage({
      role: 'assistant',
      content: 'Setup wizard skipped. You can run /init anytime to configure Code Ally.',
    });
  });

  // Project wizard request events
  useActivityEvent(ActivityEventType.PROJECT_WIZARD_REQUEST, () => {
    modal.setProjectWizardOpen(true);
  });

  // Project wizard completion events
  useActivityEvent(ActivityEventType.PROJECT_WIZARD_COMPLETE, () => {
    modal.setProjectWizardOpen(false);
    actions.addMessage({
      role: 'assistant',
      content: '✓ ALLY.md has been created successfully!',
    });
  });

  // Project wizard skip events
  useActivityEvent(ActivityEventType.PROJECT_WIZARD_SKIP, () => {
    modal.setProjectWizardOpen(false);
    actions.addMessage({
      role: 'assistant',
      content: 'Project configuration skipped. You can run /project init anytime.',
    });
  });

  // Agent wizard request events
  useActivityEvent(ActivityEventType.AGENT_WIZARD_REQUEST, (event) => {
    const { initialDescription } = event.data || {};
    modal.setAgentWizardData({ initialDescription });
    modal.setAgentWizardOpen(true);
  });

  // Agent wizard completion events
  useActivityEvent(ActivityEventType.AGENT_WIZARD_COMPLETE, async (event) => {
    const { name, description, systemPrompt, tools, model } = event.data || {};
    modal.setAgentWizardOpen(false);

    const serviceRegistry = ServiceRegistry.getInstance();
    const agentManager = serviceRegistry.get<AgentManager>('agent_manager');

    if (agentManager && name && description && systemPrompt) {
      try {
        await agentManager.saveAgent({
          name,
          description,
          system_prompt: systemPrompt,
          tools,
          model,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });

        actions.addMessage({
          role: 'assistant',
          content: `✓ Agent '${name}' has been created successfully!\n\nYou can use it with:\n  • agent(task_prompt="...", agent_type="${name}")\n  • /agent use ${name} <task>`,
        });
      } catch (error) {
        actions.addMessage({
          role: 'assistant',
          content: `Failed to create agent: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  });

  // Agent wizard skip events
  useActivityEvent(ActivityEventType.AGENT_WIZARD_SKIP, () => {
    modal.setAgentWizardOpen(false);
    actions.addMessage({
      role: 'assistant',
      content: 'Agent creation cancelled. You can run /agent create anytime.',
    });
  });

  // Agent use request events
  useActivityEvent(ActivityEventType.AGENT_USE_REQUEST, async (event) => {
    const { agentName, taskPrompt } = event.data || {};

    if (!agentName || !taskPrompt) {
      actions.addMessage({
        role: 'assistant',
        content: 'Error: Missing agent name or task prompt',
      });
      return;
    }

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

    try {
      const result = await agentTool.execute({
        task_prompt: taskPrompt,
      });

      if (result.success) {
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

  // Plugin config request events
  useActivityEvent(ActivityEventType.PLUGIN_CONFIG_REQUEST, async (event) => {
    logger.debug('[App] Received PLUGIN_CONFIG_REQUEST event:', JSON.stringify(event.data, null, 2));
    const { pluginName, pluginPath, schema, author, description, version, tools } = event.data;

    if (!pluginName || !pluginPath || !schema) {
      logger.error('[App] PLUGIN_CONFIG_REQUEST event missing required fields');
      return;
    }

    logger.debug(`[App] Setting up config request for plugin: ${pluginName}`);

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
      }
    }

    logger.debug(`[App] Calling setPluginConfigRequest`);
    modal.setPluginConfigRequest({
      pluginName,
      pluginPath,
      schema,
      existingConfig: existingConfig || {},
      author,
      description,
      version,
      tools,
    });
    logger.debug(`[App] pluginConfigRequest state should now be set`);
  });

  // Context usage updates
  useActivityEvent(ActivityEventType.CONTEXT_USAGE_UPDATE, (event) => {
    const { contextUsage } = event.data;
    if (typeof contextUsage === 'number') {
      actions.setContextUsage(contextUsage);
    }
  });

  // Compaction start
  useActivityEvent(ActivityEventType.COMPACTION_START, () => {
    actions.setIsCompacting(true);
  });

  // Compaction complete
  useActivityEvent(ActivityEventType.COMPACTION_COMPLETE, (event) => {
    const { oldContextUsage, newContextUsage, threshold, compactedMessages } = event.data;

    // Clear tool calls first
    actions.clearToolCalls();

    if (compactedMessages) {
      // Filter out system messages EXCEPT for conversation summaries
      const uiMessages = compactedMessages.filter((m: Message) => {
        if (m.role !== 'system') return true;
        // Keep system messages that are conversation summaries
        return m.metadata?.isConversationSummary === true;
      });
      // Atomically reset conversation view (sets messages + increments remount key)
      actions.resetConversationView(uiMessages);
    }

    actions.addCompactionNotice({
      id: event.id,
      timestamp: event.timestamp,
      oldContextUsage,
      threshold,
    });

    if (typeof newContextUsage === 'number') {
      actions.setContextUsage(newContextUsage);
    }

    actions.setIsCompacting(false);
  });

  // Model select response
  useActivityEvent(ActivityEventType.MODEL_SELECT_RESPONSE, async (event) => {
    const { modelName, modelType } = event.data;

    const effectiveModelType = modelType || modal.modelSelectRequest?.modelType || 'ally';

    modal.setModelSelectRequest(undefined);
    modal.setModelSelectedIndex(0);

    if (modelName) {
      const registry = ServiceRegistry.getInstance();
      const configManager = registry.get<ConfigManager>('config_manager');

      if (configManager) {
        try {
          const configKey = effectiveModelType === 'service' ? 'service_model' : 'model';
          const clientKey = effectiveModelType === 'service' ? 'service_model_client' : 'model_client';

          await configManager.setValue(configKey, modelName);

          const modelClient = registry.get<any>(clientKey);
          if (modelClient && typeof modelClient.setModelName === 'function') {
            modelClient.setModelName(modelName);
          }

          if (effectiveModelType === 'service') {
            actions.updateConfig({ service_model: modelName });
          } else {
            actions.updateConfig({ model: modelName });
          }

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

  // Rewind request
  useActivityEvent(ActivityEventType.REWIND_REQUEST, (event) => {
    const { requestId } = event.data;

    // Check if there are any running tool calls (not just completed ones)
    const runningToolCalls = state.activeToolCalls.filter(
      (tc) => tc.status === 'executing' || tc.status === 'pending' || tc.status === 'validating'
    );

    if (state.isThinking || runningToolCalls.length > 0) {
      actions.addMessage({
        role: 'assistant',
        content: 'Cannot rewind while agent is processing. Please wait for current operation to complete.',
      });
      return;
    }

    modal.setRewindRequest({
      requestId,
      userMessagesCount: -1,
      selectedIndex: -1
    });
  });

  // Update rewind request with current state when it's first set
  useEffect(() => {
    if (modal.rewindRequest && modal.rewindRequest.userMessagesCount === -1) {
      const userMessages = state.messages.filter(m => m.role === 'user');

      if (userMessages.length === 0) {
        modal.setRewindRequest(undefined);
        actions.addMessage({
          role: 'assistant',
          content: 'No user messages to rewind to.',
        });
        return;
      }

      const initialIndex = Math.max(0, userMessages.length - 1);

      modal.setRewindRequest({
        ...modal.rewindRequest,
        userMessagesCount: userMessages.length,
        selectedIndex: initialIndex
      });
    }
  }, [modal.rewindRequest, state.messages, actions]);

  // Undo file list request
  useActivityEvent(ActivityEventType.UNDO_FILE_LIST_REQUEST, (event) => {
    const { requestId, fileList } = event.data;

    if (!requestId || !fileList) {
      throw new Error(`UNDO_FILE_LIST_REQUEST event missing required fields. ID: ${event.id}`);
    }

    modal.setUndoFileListRequest({
      requestId,
      fileList,
      selectedIndex: 0,
    });
  });

  // Undo file selected
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
      const preview = await patchManager.previewSinglePatch(patchNumber);

      if (!preview) {
        actions.addMessage({
          role: 'assistant',
          content: `Error: Could not load preview for ${filePath}`,
        });
        return;
      }

      modal.setUndoRequest({
        requestId: `undo_single_${patchNumber}`,
        count: 1,
        patches: [{ patch_number: patchNumber, file_path: filePath }],
        previewData: [preview],
      });
      modal.setUndoSelectedIndex(0);
    } catch (error) {
      actions.addMessage({
        role: 'assistant',
        content: `Error loading preview: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  // Undo file back
  useActivityEvent(ActivityEventType.UNDO_FILE_BACK, () => {
    modal.setUndoRequest(undefined);
    modal.setUndoSelectedIndex(0);
  });

  // Undo confirm
  useActivityEvent(ActivityEventType.UNDO_CONFIRM, async (event) => {
    const { requestId } = event.data;

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
      const result = await patchManager.undoSinglePatch(patchNumber);

      modal.setUndoRequest(undefined);
      modal.setUndoSelectedIndex(0);

      if (result.success) {
        const fileList = result.reverted_files.map((f: string) => `  - ${f}`).join('\n');
        actions.addMessage({
          role: 'assistant',
          content: `Successfully undid operation:\n${fileList}`,
        });

        const updatedFileList = await patchManager.getRecentFileList(10);
        if (updatedFileList.length > 0) {
          modal.setUndoFileListRequest({
            requestId: `undo_${Date.now()}`,
            fileList: updatedFileList,
            selectedIndex: 0,
          });
        } else {
          modal.setUndoFileListRequest(undefined);
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

  // Undo cancelled
  useActivityEvent(ActivityEventType.UNDO_CANCELLED, () => {
    modal.setUndoFileListRequest(undefined);
    modal.setUndoRequest(undefined);
    modal.setUndoSelectedIndex(0);
  });

  // Session select request
  useActivityEvent(ActivityEventType.SESSION_SELECT_REQUEST, async (event) => {
    const { requestId } = event.data;

    const serviceRegistry = ServiceRegistry.getInstance();
    const sessionManager = serviceRegistry.get<SessionManager>('session_manager');

    if (!sessionManager) return;

    try {
      const sessions = await sessionManager.getSessionsInfoByDirectory();

      modal.setSessionSelectRequest({
        requestId,
        sessions,
        selectedIndex: 0,
      });
    } catch (error) {
      logger.error('Failed to fetch sessions:', error);
    }
  });

  // Session select response
  useActivityEvent(ActivityEventType.SESSION_SELECT_RESPONSE, async (event) => {
    const { sessionId, cancelled } = event.data;

    modal.setSessionSelectRequest(undefined);

    if (!cancelled && sessionId) {
      const serviceRegistry = ServiceRegistry.getInstance();
      const sessionManager = serviceRegistry.get<SessionManager>('session_manager');

      if (!sessionManager) return;

      try {
        sessionManager.setCurrentSession(sessionId);

        const patchManager = serviceRegistry.get<PatchManager>('patch_manager');
        if (patchManager) {
          await patchManager.onSessionChange();
        }

        const sessionData = await sessionManager.getSessionData(sessionId);

        // Use shared session loading logic
        await loadSessionData(sessionData, agent, actions, activityStream);
      } catch (error) {
        console.error('Failed to load session:', error);
      }
    }
  });

  // Rewind response
  useActivityEvent(ActivityEventType.REWIND_RESPONSE, async (event) => {
    const { selectedIndex, cancelled, options } = event.data;

    modal.setRewindRequest(undefined);

    if (!cancelled && selectedIndex !== undefined) {
      try {
        // Get the target message BEFORE rewinding to extract its timestamp
        const userMessages = agent.getMessages().filter(m => m.role === 'user');
        const targetMessage = userMessages[selectedIndex];
        const targetTimestamp = targetMessage?.timestamp;

        // Initialize file restoration tracking
        let restoredFiles: string[] = [];
        let failedRestorations: string[] = [];

        // Attempt to restore file changes ONLY if options.restoreFiles is true
        const shouldRestoreFiles = options?.restoreFiles ?? true; // Default to true for backwards compatibility

        if (shouldRestoreFiles && targetTimestamp !== undefined) {
          const serviceRegistry = ServiceRegistry.getInstance();
          const patchManager = serviceRegistry.get<PatchManager>('patch_manager');

          if (patchManager) {
            try {
              // Check if there are patches to undo
              const patchesToUndo = await patchManager.getPatchesSinceTimestamp(targetTimestamp);

              if (patchesToUndo.length > 0) {
                logger.info(`Restoring ${patchesToUndo.length} file changes during rewind`);

                // Restore file changes
                const undoResult = await patchManager.undoOperationsSinceTimestamp(targetTimestamp);

                if (undoResult.success) {
                  restoredFiles = undoResult.reverted_files;
                  logger.info(`Successfully restored ${restoredFiles.length} files`);
                } else {
                  // Partial success
                  restoredFiles = undoResult.reverted_files;
                  failedRestorations = undoResult.failed_operations;
                  logger.warn(`Partial file restoration: ${restoredFiles.length} succeeded, ${failedRestorations.length} failed`);
                }
              } else {
                logger.debug('No file changes to restore');
              }
            } catch (error) {
              // Log but don't fail the entire rewind if patch restoration fails
              logger.error('Error restoring file changes during rewind:', error);
              failedRestorations = [`Patch restoration error: ${error instanceof Error ? error.message : 'Unknown error'}`];
            }
          }
        } else if (!shouldRestoreFiles) {
          logger.info('File restoration skipped (user opted out)');
        } else {
          logger.debug('Target message has no timestamp, skipping file restoration');
        }

        // Proceed with conversation rewind
        const targetMessageContent = await agent.rewindToMessage(selectedIndex);

        const rewindedMessages = agent.getMessages().filter(m => m.role !== 'system');

        const serviceRegistry = ServiceRegistry.getInstance();

        // Clear all state
        actions.clearToolCalls();
        actions.clearRewindNotices();

        const todoManager = serviceRegistry.get('todo_manager');
        if (todoManager && typeof (todoManager as any).setTodos === 'function') {
          (todoManager as any).setTodos([]);
        }

        // Reset conversation view (this will clear terminal and set new messages)
        actions.resetConversationView(rewindedMessages);

        // NOTE: Do NOT reconstruct completed tool calls into activeToolCalls
        // Completed tool calls already exist in the messages (as tool_calls field)
        // Reconstructing them creates duplication in the timeline rendering
        // activeToolCalls is ONLY for tracking currently-running tool calls
        // On rewind, all tool calls are completed and in message history

        reconstructInterjectionsFromMessages(rewindedMessages, activityStream);

        // Update context usage after rewind (same as session resumption)
        const tokenManager = serviceRegistry.get('token_manager');
        if (tokenManager && typeof (tokenManager as any).updateTokenCount === 'function') {
          (tokenManager as any).updateTokenCount(agent.getMessages());
          const contextUsage = (tokenManager as any).getContextUsagePercentage();
          actions.setContextUsage(contextUsage);
        }

        // CRITICAL: Defer rewind notice addition until after resetConversationView completes
        // resetConversationView uses setImmediate, so we need to wait for it to finish
        // Otherwise the notice gets added while terminal is clearing, causing rendering issues
        setImmediate(() => {
          // Add rewind notice at the target message timestamp (or slightly after if no timestamp)
          // This ensures the notice appears at the rewind point in the timeline, not at the end
          const noticeTimestamp = targetTimestamp ? targetTimestamp + 1 : Date.now();

          actions.addRewindNotice({
            id: `rewind_${Date.now()}`,
            timestamp: noticeTimestamp,
            targetMessageIndex: selectedIndex,
            restoredFiles: restoredFiles.length > 0 ? restoredFiles : undefined,
            failedRestorations: failedRestorations.length > 0 ? failedRestorations : undefined,
          });
        });

        modal.setInputPrefillText(targetMessageContent);
      } catch (error) {
        actions.addMessage({
          role: 'assistant',
          content: `Error rewinding conversation: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }
  });

  return {
    activeAgentsCount,
    isCancelling,
  };
};
