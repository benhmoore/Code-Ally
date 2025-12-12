/**
 * useActivitySubscriptions - Subscribe to all ActivityStream events
 *
 * This hook centralizes all event subscriptions for the App component,
 * including tool calls, assistant responses, permissions, modals, and more.
 * It's a large hook but keeps all event handling logic in one place.
 */

import { useRef, useEffect, useState } from 'react';
import { ActivityEventType, Message, ToolCallState, FormRequest } from '@shared/index.js';
import { useActivityEvent } from './useActivityEvent.js';
import { AppState, AppActions } from '../contexts/AppContext.js';
import { ModalState } from './useModalState.js';
import { reconstructInterjectionsFromMessages, reconstructToolCallsFromMessages, loadSessionData } from './useSessionResume.js';
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
import { UI_DELAYS } from '@config/constants.js';
import { sendTerminalNotification } from '../../utils/terminal.js';

/**
 * Activity subscriptions state
 */
export interface ActivitySubscriptionsState {
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
 * const { isCancelling } = useActivitySubscriptions(
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

  // Track cancellation state for immediate visual feedback
  const [isCancelling, setIsCancelling] = useState(false);

  // Chunk batching: Accumulate tool output chunks to reduce render frequency
  // Maps tool call ID -> array of pending chunks
  const pendingChunks = useRef<Map<string, string[]>>(new Map());

  // Timer reference for debounced flush
  const flushTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Streaming content batching: Accumulate assistant streaming chunks to reduce render frequency
  const pendingStreamingChunks = useRef<string>('');

  // Timer reference for streaming content flush
  const streamingFlushTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Remove setImmediate batching - AppContext already batches with setTimeout(16ms)
  // Double batching was causing unnecessary delays
  const scheduleToolUpdate = useRef((id: string, update: Partial<ToolCallState>) => {
    // All updates go directly to AppContext, which handles batching
    if (update.status === 'executing' && update.startTime) {
      actions.addToolCall(update as ToolCallState);
    } else {
      actions.updateToolCall(id, update);
    }
  });

  // Flush accumulated chunks for a specific tool (or all tools if no ID provided)
  const flushChunks = useRef((toolId?: string) => {
    if (toolId) {
      // Flush specific tool
      const chunks = pendingChunks.current.get(toolId);
      if (chunks && chunks.length > 0) {
        // Combine all chunks into single output update
        const combinedOutput = chunks.join('');
        scheduleToolUpdate.current(toolId, { output: combinedOutput });
        // Clear this tool's chunks
        pendingChunks.current.delete(toolId);
      }
    } else {
      // Flush all tools
      pendingChunks.current.forEach((chunks, id) => {
        if (chunks.length > 0) {
          const combinedOutput = chunks.join('');
          scheduleToolUpdate.current(id, { output: combinedOutput });
        }
      });
      pendingChunks.current.clear();
    }
  });

  // Debounced flush - batches chunks over 100ms window
  const scheduleDebouncedFlush = useRef(() => {
    // Cancel existing timer
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
    }

    // Schedule new flush after 100ms
    flushTimerRef.current = setTimeout(() => {
      flushChunks.current(); // Flush all pending chunks
      flushTimerRef.current = null;
    }, 100);
  });

  // Flush accumulated streaming content to state
  const flushStreamingContent = useRef(() => {
    const pending = pendingStreamingChunks.current;
    if (pending) {
      actions.setStreamingContent(streamingContentRef.current);
      pendingStreamingChunks.current = '';
    }
  });

  // Throttled flush for streaming content updates
  // Flushes at most once per interval; doesn't reset timer on new chunks
  const scheduleStreamingFlush = useRef(() => {
    // If timer already running, let it complete (throttle behavior)
    if (streamingFlushTimerRef.current) {
      return;
    }

    streamingFlushTimerRef.current = setTimeout(() => {
      flushStreamingContent.current();
      streamingFlushTimerRef.current = null;
    }, UI_DELAYS.STREAMING_CONTENT_BATCH_FLUSH);
  });

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
      alwaysShowFullOutput: event.data.alwaysShowFullOutput || false,
      isLinkedPlugin: event.data.isLinkedPlugin || false,
      displayColor: event.data.displayColor,
      displayIcon: event.data.displayIcon,
      hideToolName: event.data.hideToolName || false,
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

    // Flush any pending chunks for this tool immediately when it ends
    // This ensures no chunks are lost and final output is complete
    flushChunks.current(event.id);

    const updates: Partial<ToolCallState> = {
      status: event.data.success ? 'success' : 'error',
      endTime: event.timestamp,
      error: event.data.error,
      error_type: event.data.result?.error_type,
      result: event.data.result,
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

    // Skip collapse for linked plugin agents (dev mode) to keep tool calls visible
    const isLinkedPluginAgent = event.data.result?._isLinkedPluginAgent === true;
    if (event.data.shouldCollapse && !isLinkedPluginAgent) {
      updates.collapsed = true;
    } else if (event.data.collapsed !== undefined) {
      updates.collapsed = event.data.collapsed;
    }

    scheduleToolUpdate.current(event.id, updates);

    // Record completed tool call in history
    if (toolCall) {
      const completedCall: ToolCallState = {
        ...toolCall,
        ...updates,
        output: event.data.result?.content || event.data.output,
      };

      const serviceRegistry = ServiceRegistry.getInstance();
      const toolCallHistory = serviceRegistry.getToolCallHistory();
      if (toolCallHistory) {
        toolCallHistory.addCall(completedCall);
      }
    }
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
    });
  });

  // Tool output chunks - accumulate and batch for performance
  useActivityEvent(ActivityEventType.TOOL_OUTPUT_CHUNK, (event) => {
    if (!event.id) {
      throw new Error(`TOOL_OUTPUT_CHUNK event missing required 'id' field`);
    }

    const chunk = event.data?.chunk || '';

    // Skip empty chunks
    if (!chunk) return;

    // Get or create chunk array for this tool
    let chunks = pendingChunks.current.get(event.id);
    if (!chunks) {
      chunks = [];
      pendingChunks.current.set(event.id, chunks);
    }

    // Accumulate chunk
    chunks.push(chunk);

    // Schedule debounced flush (batches chunks over 100ms window)
    scheduleDebouncedFlush.current();
  });

  // Assistant content chunks
  useActivityEvent(ActivityEventType.ASSISTANT_CHUNK, (event) => {
    const chunk = event.data?.chunk || '';
    if (chunk) {
      // Update the source of truth immediately
      streamingContentRef.current += chunk;
      // Accumulate chunk for batched state update
      pendingStreamingChunks.current += chunk;
      // Schedule batched flush (100ms throttle window)
      scheduleStreamingFlush.current();
    }
  });

  // Assistant message complete (text blocks ready to display)
  useActivityEvent(ActivityEventType.ASSISTANT_MESSAGE_COMPLETE, (event) => {
    const content = event.data?.content || '';

    // Flush any pending streaming chunks immediately before clearing
    // This ensures no content is lost when the message completes
    flushStreamingContent.current();

    // Clear streaming content since it's now finalized as a message
    streamingContentRef.current = '';
    actions.setStreamingContent(undefined);

    if (content && !event.parentId) {
      // Root agent message - add to message history for chronological display
      // Subagent messages are not added here as they're handled via tool output
      actions.addMessage({
        role: 'assistant',
        content: content,
        timestamp: event.timestamp || Date.now(),
      });
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
        // Find the tool call and update it with thinking content and timing
        actions.updateToolCall(event.parentId, {
          thinking,
          thinkingStartTime: startTime,
          thinkingEndTime: endTime,
        });
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
    const agentName = event.data?.agentName;

    if (isSpecialized) {
      // Track sub-agent name if available
      if (agentName) {
        actions.addSubAgent(agentName);
      }
    } else {
      // Flush any pending streaming content before clearing
      flushStreamingContent.current();

      // Cancel any pending streaming flush timer (already flushed above)
      if (streamingFlushTimerRef.current) {
        clearTimeout(streamingFlushTimerRef.current);
        streamingFlushTimerRef.current = null;
      }

      // Clear both streaming refs atomically to prevent accumulation bugs
      streamingContentRef.current = '';
      pendingStreamingChunks.current = '';
      actions.setStreamingContent(undefined);
    }

    // Capture agent model for the tool call (event.id is the tool call ID)
    if (event.id && event.data?.model) {
      scheduleToolUpdate.current(event.id, {
        agentModel: event.data.model,
      });
    }
  });

  // Agent end
  useActivityEvent(ActivityEventType.AGENT_END, (event) => {
    const isSpecialized = event.data?.isSpecializedAgent || false;
    const wasInterrupted = event.data?.interrupted || false;
    const agentName = event.data?.agentName;
    const contextUsage = event.data?.contextUsage;

    if (isSpecialized) {
      // Remove sub-agent from tracking if available
      if (agentName) {
        actions.removeSubAgent(agentName);
      }

      // Record delegation tool call in history (AGENT_END fires before TOOL_CALL_END for delegations)
      // This ensures delegation tools are captured in ToolCallHistory for /debug agent
      if (event.id) {
        const toolCall = state.activeToolCalls.find((tc: ToolCallState) => tc.id === event.id);
        if (toolCall) {
          const completedCall: ToolCallState = {
            ...toolCall,
            status: wasInterrupted ? 'error' : 'success',
            endTime: event.timestamp || Date.now(),
            output: event.data?.result || event.data?.output,
            contextUsage,
          };

          const serviceRegistry = ServiceRegistry.getInstance();
          const toolCallHistory = serviceRegistry.getToolCallHistory();
          if (toolCallHistory) {
            toolCallHistory.addCall(completedCall);
          }
        }
      }
    } else {
      // Flush any pending streaming content before clearing
      flushStreamingContent.current();

      // Cancel any pending streaming flush timer (already flushed above)
      if (streamingFlushTimerRef.current) {
        clearTimeout(streamingFlushTimerRef.current);
        streamingFlushTimerRef.current = null;
      }

      // Clear both streaming refs atomically to prevent accumulation bugs
      streamingContentRef.current = '';
      pendingStreamingChunks.current = '';
      actions.setStreamingContent(undefined);

      // Clear active tool calls when main agent ends (especially if interrupted)
      if (wasInterrupted) {
        actions.clearToolCalls();
      }
    }

    // Capture context usage for the tool call (event.id is the tool call ID)
    if (event.id && typeof contextUsage === 'number') {
      scheduleToolUpdate.current(event.id, {
        contextUsage,
      });
    }

    setIsCancelling(false);
  });

  /**
   * Interrupt handler - clears UI state defensively.
   *
   * IDEMPOTENCY CONTRACT:
   * These operations are safe to call multiple times:
   * - clearToolCalls(): Sets array to empty (idempotent)
   * - removeSubAgent(): Filters by name, no-op if already removed
   *
   * This defensive approach ensures UI cleanup even if AGENT_END events
   * are delayed or lost. Late-arriving AGENT_END events will safely
   * attempt to remove already-cleared state with no adverse effects.
   */
  useActivityEvent(ActivityEventType.USER_INTERRUPT_INITIATED, () => {
    setIsCancelling(true);
    // Flush any pending streaming content before clearing state
    flushStreamingContent.current();
    actions.clearToolCalls();
    state.activeSubAgents.forEach(agentName => {
      actions.removeSubAgent(agentName);
    });
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
        editsCount: event.data?.editsCount,
      },
    });
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
    });
  });

  // Status message events (connection retries, etc.)
  useActivityEvent(ActivityEventType.STATUS_MESSAGE, (event) => {
    if (!event.id || !event.timestamp) {
      return;
    }

    actions.addStatusMessage({
      id: event.id,
      timestamp: event.timestamp,
      message: event.data?.message || '',
    });
  });

  // Permission request events - enqueue to support concurrent permission prompts
  useActivityEvent(ActivityEventType.PERMISSION_REQUEST, (event) => {
    if (!event.id) {
      throw new Error(`PERMISSION_REQUEST event missing required 'id' field`);
    }

    const { requestId, toolName, path, command, arguments: args, sensitivity, options } = event.data || {};

    if (!requestId) {
      throw new Error(`PERMISSION_REQUEST event missing required 'requestId' field. ID: ${event.id}`);
    }

    modal.addPermissionRequest({
      requestId,
      toolName,
      path,
      command,
      arguments: args,
      sensitivity,
      options,
    });

    // Send terminal bell to notify user of permission prompt
    sendTerminalNotification();
  });

  // Permission response events - dequeue by ID to show next pending request
  useActivityEvent(ActivityEventType.PERMISSION_RESPONSE, (event) => {
    const { requestId } = event.data || {};
    if (requestId) {
      modal.removePermissionRequest(requestId);
    } else {
      // Fallback: clear current if no requestId provided
      modal.setPermissionRequest(undefined);
    }
  });

  // Tool form request - add to queue and track start time for duration exclusion
  useActivityEvent(ActivityEventType.TOOL_FORM_REQUEST, (event) => {
    const { requestId, toolName, schema, initialValues, callId } = event.data || {};

    // Validate required fields
    if (!requestId || !toolName || !schema) {
      logger.warn('[useActivitySubscriptions] Invalid TOOL_FORM_REQUEST: missing required fields', {
        hasRequestId: !!requestId,
        hasToolName: !!toolName,
        hasSchema: !!schema,
      });
      return;
    }

    const formRequest: FormRequest = {
      requestId,
      toolName,
      schema,
      initialValues: initialValues || {},
      callId,
    };
    modal.addToolFormRequest(formRequest);
    sendTerminalNotification();
  });

  // Tool form response - remove from queue
  useActivityEvent(ActivityEventType.TOOL_FORM_RESPONSE, (event) => {
    const { requestId } = event.data;
    if (requestId) {
      modal.removeToolFormRequest(requestId);
    }
  });

  // Tool form cancel - remove from queue
  useActivityEvent(ActivityEventType.TOOL_FORM_CANCEL, (event) => {
    const { requestId } = event.data;
    if (requestId) {
      modal.removeToolFormRequest(requestId);
    }
  });

  // Model select request events
  useActivityEvent(ActivityEventType.MODEL_SELECT_REQUEST, (event) => {
    const { requestId, models, currentModel, modelType, typeName } = event.data;
    modal.setModelSelectRequest({ requestId, models, currentModel, modelType, typeName });
    modal.setModelSelectedIndex(0);
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
    const { pluginName, pluginPath, schema, author, description, version, tools, agents } = event.data;

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
      agents,
    });
    logger.debug(`[App] pluginConfigRequest state should now be set`);
  });

  // Context usage updates
  useActivityEvent(ActivityEventType.CONTEXT_USAGE_UPDATE, (event) => {
    const { contextUsage, parentCallId } = event.data;
    if (typeof contextUsage === 'number') {
      if (parentCallId) {
        // Update tool call context usage for specialized agents
        scheduleToolUpdate.current(parentCallId, { contextUsage });
      } else {
        // Update global context usage for main agent
        actions.setContextUsage(contextUsage);
      }
    }
  });

  // Compaction start
  useActivityEvent(ActivityEventType.COMPACTION_START, (event) => {
    const { parentId } = event.data || {};
    if (parentId) {
      // Mark the tool call as compacting for delegated agents
      scheduleToolUpdate.current(parentId, { isCompacting: true });
    } else {
      // Show global compacting indicator for main agent
      actions.setIsCompacting(true);
    }
  });

  // Compaction complete (success or error)
  useActivityEvent(ActivityEventType.COMPACTION_COMPLETE, (event) => {
    const { oldContextUsage, newContextUsage, threshold, compactedMessages, parentId, error, errorMessage } = event.data;

    // Handle error case - just clear compacting state without resetting conversation
    if (error) {
      if (parentId) {
        scheduleToolUpdate.current(parentId, { isCompacting: false });
      } else {
        actions.setIsCompacting(false);
      }
      // Error will be shown via Agent error handling, just unstick the UI
      logger.debug('[useActivitySubscriptions] Compaction error:', errorMessage);
      return;
    }

    // For delegated agent compaction, only add the notice and clear compacting state
    // Don't touch main agent's conversation or tool calls
    if (parentId) {
      scheduleToolUpdate.current(parentId, { isCompacting: false });
      actions.addCompactionNotice({
        id: event.id,
        timestamp: event.timestamp,
        oldContextUsage,
        threshold,
        parentId,
      });
      return;
    }

    // Main agent compaction - full reset
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
      parentId,
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

    // If cancelled (no model selected), just clear the UI
    if (!modelName) {
      modal.setModelSelectRequest(undefined);
      modal.setModelSelectedIndex(0);
      return;
    }

    // Show loading state while testing capabilities
    modal.setModelSelectLoading(true);

    const clearModalState = () => {
      modal.setModelSelectLoading(false);
      modal.setModelSelectRequest(undefined);
      modal.setModelSelectedIndex(0);
    };

    const registry = ServiceRegistry.getInstance();
    const configManager = registry.get<ConfigManager>('config_manager');

    if (!configManager) {
      clearModalState();
      return;
    }

    try {
      const config = configManager.getConfig();
      const endpoint = config.endpoint || 'http://localhost:11434';

      // Test model capabilities before switching
      const { testModelCapabilities } = await import('@llm/ModelValidation.js');
      const capabilities = await testModelCapabilities(endpoint, modelName);

      // For ally model, require tool support
      if (effectiveModelType === 'ally' && !capabilities.supportsTools) {
        clearModalState();
        actions.addMessage({
          role: 'assistant',
          content: `Model '${modelName}' does not support tools. Ally model requires tool support.`,
        });
        return;
      }

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

      clearModalState();

      const typeName = effectiveModelType === 'service' ? 'Service model' : 'Model';
      const capInfo = capabilities.fromCache ? ' (cached)' : '';
      const imageNote = capabilities.supportsImages ? '' : ' (no image support)';
      actions.addMessage({
        role: 'assistant',
        content: `${typeName} changed to: ${modelName}${capInfo}${imageNote}`,
      });
    } catch (error) {
      clearModalState();
      actions.addMessage({
        role: 'assistant',
        content: `Error changing model: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  // Config updated (from commands that directly change config)
  useActivityEvent(ActivityEventType.CONFIG_UPDATED, (event) => {
    const updates = event.data;
    if (!updates || typeof updates !== 'object') return;

    // Update UI state
    actions.updateConfig(updates);

    // Sync runtime model client settings
    const registry = ServiceRegistry.getInstance();
    const modelClient = registry.get<any>('model_client');
    const serviceModelClient = registry.get<any>('service_model_client');

    // Model changes are handled by ModelCommand directly, but other settings need syncing
    if ('context_size' in updates && updates.context_size !== undefined) {
      if (modelClient?.setContextSize) modelClient.setContextSize(updates.context_size);
      if (serviceModelClient?.setContextSize) serviceModelClient.setContextSize(updates.context_size);
    }
    if ('temperature' in updates && updates.temperature !== undefined) {
      if (modelClient?.setTemperature) modelClient.setTemperature(updates.temperature);
      if (serviceModelClient?.setTemperature) serviceModelClient.setTemperature(updates.temperature);
    }
    if ('max_tokens' in updates && updates.max_tokens !== undefined) {
      if (modelClient?.setMaxTokens) modelClient.setMaxTokens(updates.max_tokens);
      if (serviceModelClient?.setMaxTokens) serviceModelClient.setMaxTokens(updates.max_tokens);
    }
    if ('service_model' in updates && updates.service_model !== undefined) {
      if (serviceModelClient?.setModelName) serviceModelClient.setModelName(updates.service_model);
    }
    if ('reasoning_effort' in updates) {
      if (modelClient?.setReasoningEffort) modelClient.setReasoningEffort(updates.reasoning_effort);
      if (serviceModelClient?.setReasoningEffort) serviceModelClient.setReasoningEffort(updates.reasoning_effort);
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

  // Cleanup on unmount: flush pending chunks and cancel timers
  useEffect(() => {
    return () => {
      // Flush any remaining chunks
      flushChunks.current();

      // Cancel pending flush timer
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }

      // Flush any pending streaming content
      flushStreamingContent.current();

      // Cancel pending streaming flush timer
      if (streamingFlushTimerRef.current) {
        clearTimeout(streamingFlushTimerRef.current);
        streamingFlushTimerRef.current = null;
      }
    };
  }, []);

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
        // Error handled silently - session loading is optional
      }
    }
  });

  // Library select request
  useActivityEvent(ActivityEventType.LIBRARY_SELECT_REQUEST, async () => {
    const serviceRegistry = ServiceRegistry.getInstance();
    const promptLibraryManager = serviceRegistry.getPromptLibraryManager();

    if (!promptLibraryManager) return;

    try {
      const prompts = await promptLibraryManager.getPrompts();

      modal.setLibrarySelectRequest({
        requestId: `library_select_${Date.now()}`,
        prompts,
        selectedIndex: 0,
      });
    } catch (error) {
      logger.error('Failed to fetch prompts:', error);
    }
  });

  // Library select response
  useActivityEvent(ActivityEventType.LIBRARY_SELECT_RESPONSE, async (event) => {
    const { promptId, cancelled } = event.data;

    modal.setLibrarySelectRequest(undefined);

    if (!cancelled && promptId) {
      const serviceRegistry = ServiceRegistry.getInstance();
      const promptLibraryManager = serviceRegistry.getPromptLibraryManager();

      if (!promptLibraryManager) return;

      try {
        const prompt = await promptLibraryManager.getPrompt(promptId);

        if (prompt) {
          // Insert prompt content into input field and mark as prefilled
          modal.setInputPrefillText(prompt.content);
          modal.setPromptPrefilled(true);
        } else {
          // Log error but don't add to chat
          logger.error(`Prompt '${promptId}' not found`);
        }
      } catch (error) {
        // Log error but don't add to chat
        logger.error('Failed to load prompt:', error);
      }
    }
  });

  // Message select request (show message selector for prompt creation)
  useActivityEvent(ActivityEventType.PROMPT_MESSAGE_SELECT_REQUEST, (event) => {
    const { requestId, messages, selectedIndex } = event.data;

    modal.setMessageSelectRequest({
      requestId,
      messages,
      selectedIndex,
    });
  });

  // Message select response (show wizard with optional pre-filled content)
  useActivityEvent(ActivityEventType.PROMPT_MESSAGE_SELECT_RESPONSE, (event) => {
    const { selectedMessage, cancelled } = event.data;

    // Close message selector
    modal.setMessageSelectRequest(undefined);

    if (cancelled) {
      // User pressed Escape - cancel entire flow
      return;
    }

    // Show prompt add wizard with optional pre-filled content
    modal.setPromptAddRequest({
      requestId: `prompt_add_${Date.now()}`,
      title: '',
      content: selectedMessage?.content || '', // Pre-filled or empty
      tags: '',
      focusedField: 'title', // Start on title field
    });
  });

  // Prompt add request (show wizard)
  useActivityEvent(ActivityEventType.PROMPT_ADD_REQUEST, (event) => {
    const { requestId, promptId, title, content, tags, focusedField } = event.data;

    modal.setPromptAddRequest({
      requestId,
      promptId, // Optional: present when editing
      title: title || '',
      content: content || '',
      tags: tags || '',
      focusedField: focusedField || 'title',
    });
  });

  // Library clear confirmation request (show confirmation dialog)
  useActivityEvent(ActivityEventType.LIBRARY_CLEAR_CONFIRM_REQUEST, (event) => {
    const { requestId, promptCount, selectedIndex } = event.data;

    modal.setLibraryClearConfirmRequest({
      requestId,
      promptCount,
      selectedIndex: selectedIndex ?? 1, // Default to "Cancel" option (safer)
    });
  });

  // Library clear confirmation response (actually clear or cancel)
  useActivityEvent(ActivityEventType.LIBRARY_CLEAR_CONFIRM_RESPONSE, async (event) => {
    const { confirmed, cancelled } = event.data;

    modal.setLibraryClearConfirmRequest(undefined);

    if (cancelled || !confirmed) {
      // User cancelled - do nothing
      return;
    }

    // User confirmed - clear all prompts
    const serviceRegistry = ServiceRegistry.getInstance();
    const promptLibraryManager = serviceRegistry.getPromptLibraryManager();

    if (!promptLibraryManager) return;

    try {
      const count = await promptLibraryManager.clearAllPrompts();

      actions.addMessage({
        role: 'assistant',
        content: `Cleared ${count} saved prompt(s).`,
      });
    } catch (error) {
      logger.error('Failed to clear prompts:', error);
      actions.addMessage({
        role: 'assistant',
        content: `Error clearing prompts: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  });

  // Prompt add response (save new or update existing prompt)
  useActivityEvent(ActivityEventType.PROMPT_ADD_RESPONSE, async (event) => {
    const { promptId, title, content, tags, cancelled } = event.data;

    modal.setPromptAddRequest(undefined);

    if (!cancelled && title && content) {
      const serviceRegistry = ServiceRegistry.getInstance();
      const promptLibraryManager = serviceRegistry.getPromptLibraryManager();

      if (!promptLibraryManager) return;

      try {
        // Parse tags from comma-separated string
        const tagArray = tags
          ? tags.split(',').map((t: string) => t.trim()).filter((t: string) => t.length > 0)
          : undefined;

        if (promptId) {
          // Edit existing prompt
          await promptLibraryManager.updatePrompt(promptId, {
            title,
            content,
            tags: tagArray,
          });

          actions.addMessage({
            role: 'assistant',
            content: `Prompt updated: ${title}`,
          });
        } else {
          // Create new prompt
          const newPrompt = await promptLibraryManager.addPrompt(title, content, tagArray);

          actions.addMessage({
            role: 'assistant',
            content: `Prompt saved: ${newPrompt.title} (ID: ${newPrompt.id})`,
          });
        }
      } catch (error) {
        logger.error('Failed to save prompt:', error);
        actions.addMessage({
          role: 'assistant',
          content: `Error saving prompt: ${error instanceof Error ? error.message : 'Unknown error'}`,
        });
      }
    }
  });

  // Agent switched event
  useActivityEvent(ActivityEventType.AGENT_SWITCHED, (event) => {
    const { agentName, agentModel } = event.data || {};
    if (agentName) {
      actions.setCurrentAgent(agentName, agentModel);
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

        // Reconstruct tool calls from message history
        // This populates activeToolCalls with completed tool calls so they appear in the timeline
        const reconstructedToolCalls = reconstructToolCallsFromMessages(rewindedMessages, serviceRegistry);
        reconstructedToolCalls.forEach(toolCall => {
          try {
            actions.addToolCall(toolCall);
          } catch (error) {
            // Log but don't fail rewind if a tool call can't be added
            // This could happen if there are duplicate IDs in the session data
            console.warn(`Failed to add reconstructed tool call ${toolCall.id}:`, error);
          }
        });

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

  // Conversation clear - reset UI to initial state
  useActivityEvent(ActivityEventType.CONVERSATION_CLEAR, () => {
    const serviceRegistry = ServiceRegistry.getInstance();

    // Clear all UI state
    actions.clearToolCalls();
    actions.clearCompactionNotices();
    actions.clearRewindNotices();

    // Clear todos
    const todoManager = serviceRegistry.get('todo_manager');
    if (todoManager && typeof (todoManager as any).setTodos === 'function') {
      (todoManager as any).setTodos([]);
    }

    // Reset conversation view to empty (like initial app load)
    actions.resetConversationView([]);

    // Reset context usage
    actions.setContextUsage(0);
  });

  return {
    isCancelling,
  };
};
