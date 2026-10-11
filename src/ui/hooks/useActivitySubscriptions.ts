/**
 * useActivitySubscriptions - Subscribe to all ActivityStream events
 *
 * This hook centralizes all event subscriptions for the App component,
 * including tool calls, assistant responses, permissions, modals, and more.
 * It's a large hook but keeps all event handling logic in one place.
 */

import { useRef, useEffect, useState, useMemo } from 'react';
import { ActivityEventType, FormRequest } from '@shared/index.js';
import { useActivityEvent } from './useActivityEvent.js';
import { AppState, AppActions } from '../contexts/AppContext.js';
import { ModalState } from './useModalState.js';
import { reconstructInterjectionsFromMessages, reconstructToolCallsFromMessages, loadSessionData } from './useSessionResume.js';
import { Agent } from '@agent/Agent.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { applyRuntimeConfigUpdates } from '@services/RuntimeConfigSync.js';
import { UndoCoordinator } from '@services/UndoCoordinator.js';
import { ModelConfigCoordinator } from '@services/ModelConfigCoordinator.js';
import { SessionRestoreCoordinator } from '@services/SessionRestoreCoordinator.js';
import { logger } from '@services/Logger.js';
import { sendTerminalNotification } from '../../utils/terminal.js';
import { resolveDisplayContent } from '../../utils/toolResultContent.js';
import { probeModelCapabilities } from '@llm/ProviderAdapter.js';

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
  const isMountedRef = useRef(true);

  // Track cancellation state for immediate visual feedback
  const [isCancelling, setIsCancelling] = useState(false);

  // Undo/rewind business logic lives in a service; this hook only routes events
  // into it and pushes the results into React state.
  const undoCoordinator = useMemo(
    () =>
      new UndoCoordinator({
        getPatchManager: () => ServiceRegistry.getInstance().get('patch_manager'),
        getAgent: () => agent,
        getTodoManager: () => ServiceRegistry.getInstance().get('todo_manager'),
        getTokenManager: () => ServiceRegistry.getInstance().get('token_manager'),
      }),
    [agent]
  );

  // Model switching (capability probe, ConfigManager writes, runtime sync) lives
  // in a service; this hook only routes events into it and repaints.
  const modelConfigCoordinator = useMemo(
    () =>
      new ModelConfigCoordinator({
        getConfigManager: () => ServiceRegistry.getInstance().get('config_manager'),
        applyRuntimeConfig: (updates) =>
          applyRuntimeConfigUpdates(ServiceRegistry.getInstance(), updates),
        validatePrimaryModelSwitch: (modelName) =>
          agent.getModelIdentityChangeBlock({ model: modelName }),
        testModelCapabilities: async (_endpoint, modelName) => {
          const config = ServiceRegistry.getInstance().get('config_manager')?.getConfig();
          if (!config) return { supportsTools: true, supportsImages: true, fromCache: false };
          const capabilities = await probeModelCapabilities(config, modelName);
          return {
            supportsTools: capabilities.tools !== 'unsupported',
            supportsImages: capabilities.images !== 'unsupported',
            fromCache: capabilities.fromCache ?? false,
          };
        },
      }),
    [agent]
  );

  // Session listing/restoration likewise; the hook keeps only the modal plumbing.
  const sessionRestoreCoordinator = useMemo(
    () =>
      new SessionRestoreCoordinator({
        getSessionManager: () => ServiceRegistry.getInstance().get('session_manager'),
        getPatchManager: () => ServiceRegistry.getInstance().get('patch_manager'),
      }),
    []
  );

  // Clear the "Cancelling" indicator once the agent has actually stopped working.
  // isCancelling is set on USER_INTERRUPT_INITIATED; isThinking is reset in the
  // turn handler's finally block on every completion *and* interrupt, so tying
  // the clear to it guarantees the indicator can't get stuck if no AGENT_END
  // event follows the interrupt (e.g. interrupting between turns).
  useEffect(() => {
    if (!state.isThinking && isCancelling) {
      setIsCancelling(false);
    }
  }, [state.isThinking, isCancelling]);

  // Runtime owns conversation projection. Keep terminal-specific history and modal effects here.
  useActivityEvent(ActivityEventType.TOOL_CALL_END, (event) => {
    if (event.data?.groupExecution) return;
    const call = agent.getConversationView().getSnapshot().activeToolCalls.find(item => item.id === event.id);
    if (call) ServiceRegistry.getInstance().getToolCallHistory()?.addCall({
      ...call,
      status: event.data.success ? 'success' : 'error',
      endTime: event.timestamp,
      output: resolveDisplayContent(event.data.result) || event.data.output || call.output,
      error: event.data.error,
      result: event.data.result,
    });
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

  useActivityEvent(ActivityEventType.AGENT_START, (event) => {
    if (event.data?.isSpecializedAgent && event.data.agentName) actions.addSubAgent(event.data.agentName);
  });

  useActivityEvent(ActivityEventType.AGENT_END, (event) => {
    if (event.data?.isSpecializedAgent && event.data.agentName) actions.removeSubAgent(event.data.agentName);
  });

  useActivityEvent(ActivityEventType.USER_INTERRUPT_INITIATED, () => {
    setIsCancelling(true);
    state.activeSubAgents.forEach(agentName => actions.removeSubAgent(agentName));
    modal.clearTransientModals();
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

  // Plan approval request - show plan approval modal
  useActivityEvent(ActivityEventType.PLAN_APPROVAL_REQUEST, (event) => {
    const { planFilePath, planContent } = event.data || {};

    if (!planFilePath || !planContent) {
      logger.warn('[useActivitySubscriptions] Invalid PLAN_APPROVAL_REQUEST: missing required fields');
      return;
    }

    modal.setPlanApprovalRequest({ planFilePath, planContent });
    modal.setPlanApprovalSelectedIndex(0);
    modal.setPlanApprovalFeedbackText('');
    modal.setPlanApprovalCursorPosition(0);
    sendTerminalNotification();
  });

  // Plan approval response - close modal
  useActivityEvent(ActivityEventType.PLAN_APPROVAL_RESPONSE, () => {
    modal.setPlanApprovalRequest(undefined);
    modal.setPlanApprovalSelectedIndex(0);
    modal.setPlanApprovalFeedbackText('');
    modal.setPlanApprovalCursorPosition(0);
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
    const configManager = registry.get('config_manager');

    if (configManager) {
      try {
        await configManager.initialize();
        const newConfig = configManager.getConfig();

        applyRuntimeConfigUpdates(registry, newConfig);

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
    const agentManager = serviceRegistry.get('agent_manager');

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
    const toolManager = serviceRegistry.get('tool_manager');
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

  // Context usage updates
  useActivityEvent(ActivityEventType.CONTEXT_USAGE_UPDATE, (event) => {
    const { contextUsage, parentCallId } = event.data;
    if (typeof contextUsage === 'number') {
      if (parentCallId) {
        // Update tool call context usage for specialized agents
        actions.updateToolCall(parentCallId, { contextUsage });
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
      actions.updateToolCall(parentId, { isCompacting: true });
    } else {
      // Show global compacting indicator for main agent
      actions.setIsCompacting(true);
    }
  });

  // Compaction complete (success or error)
  useActivityEvent(ActivityEventType.COMPACTION_COMPLETE, (event) => {
    const { oldContextUsage, newContextUsage, threshold, parentId, error, errorMessage, interrupted } = event.data;

    // Terminal non-commit outcomes only clear the in-progress surface. Owner
    // cancellation (usually a queued interjection) is expected control flow;
    // the agent immediately rebuilds from the newer conversation.
    if (error || interrupted) {
      if (parentId) {
        actions.updateToolCall(parentId, { isCompacting: false });
      } else {
        actions.setIsCompacting(false);
      }
      if (error) {
        // Error will be shown via Agent error handling; just unstick the UI.
        logger.debug('[useActivitySubscriptions] Compaction error:', errorMessage);
      }
      return;
    }

    // For delegated agent compaction, only add the notice and clear compacting state
    // Don't touch main agent's conversation or tool calls
    if (parentId) {
      actions.updateToolCall(parentId, { isCompacting: false });
      actions.addCompactionNotice({
        id: event.id,
        timestamp: event.timestamp,
        oldContextUsage,
        threshold,
        parentId,
      });
      return;
    }

    // The visible transcript is append-only. Compaction replaces only the
    // model-facing window, so the UI needs a marker rather than a reset.
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

    const slot = modelConfigCoordinator.resolveModelSlot(
      modelType,
      modal.modelSelectRequest?.modelType
    );

    // If cancelled (no model selected), just clear the UI
    if (!modelName) {
      modal.setModelSelectRequest(undefined);
      modal.setModelSelectedIndex(0);
      return;
    }

    // Show loading state while testing capabilities
    modal.setModelSelectLoading(true);

    const outcome = await modelConfigCoordinator.switchModel(modelName, slot);

    // Config state first, modal second, messages last: the picker must not
    // close before the new model is in state, or the UI repaints from stale config.
    if (outcome.configUpdate) {
      actions.updateConfig(outcome.configUpdate);
    }

    modal.setModelSelectLoading(false);
    modal.setModelSelectRequest(undefined);
    modal.setModelSelectedIndex(0);

    for (const content of outcome.messages) {
      actions.addMessage({ role: 'assistant', content });
    }
  });

  // Config updated (from commands that directly change config)
  useActivityEvent(ActivityEventType.CONFIG_UPDATED, (event) => {
    const updates = modelConfigCoordinator.normalizeConfigUpdates(event.data);
    if (!updates) return;

    // UI state first, runtime services second.
    actions.updateConfig(updates);
    modelConfigCoordinator.applyRuntimeUpdates(updates);
  });

  // Rewind request
  useActivityEvent(ActivityEventType.REWIND_REQUEST, (event) => {
    const { requestId } = event.data;

    const readiness = undoCoordinator.checkRewindReadiness(state.isThinking, state.activeToolCalls);
    if (!readiness.allowed) {
      actions.addMessage({
        role: 'assistant',
        content: readiness.message ?? '',
      });
      return;
    }

    modal.setRewindRequest({
      requestId,
      targets: null,
      selectedIndex: -1
    });
  });

  // Update rewind request with current state when it's first set
  const setRewindRequest = modal.setRewindRequest;
  useEffect(() => {
    if (modal.rewindRequest && modal.rewindRequest.targets === null) {
      // Derived from the agent's history (the array the rewind truncates), not
      // from the React transcript — the two can disagree, and acting on the
      // wrong one reverts the user's files to the wrong point.
      const selection = undoCoordinator.resolveRewindSelection();

      if (!selection) {
        setRewindRequest(undefined);
        actions.addMessage({
          role: 'assistant',
          content: undoCoordinator.noUserMessagesMessage,
        });
        return;
      }

      setRewindRequest({
        ...modal.rewindRequest,
        targets: selection.targets,
        selectedIndex: selection.selectedIndex
      });
    }
  }, [modal.rewindRequest, actions, setRewindRequest, undoCoordinator]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
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

    const outcome = await undoCoordinator.previewPatch(patchNumber, filePath);

    if (outcome.status === 'error') {
      actions.addMessage({
        role: 'assistant',
        content: outcome.message,
      });
      return;
    }

    modal.setUndoRequest({
      requestId: undoCoordinator.buildUndoRequestId(outcome.patchNumber),
      count: 1,
      patches: [{ patch_number: outcome.patchNumber, file_path: outcome.filePath }],
      previewData: [outcome.preview],
    });
    modal.setUndoSelectedIndex(0);
  });

  // Undo file back
  useActivityEvent(ActivityEventType.UNDO_FILE_BACK, () => {
    modal.setUndoRequest(undefined);
    modal.setUndoSelectedIndex(0);
  });

  // Undo confirm
  useActivityEvent(ActivityEventType.UNDO_CONFIRM, async (event) => {
    const { requestId } = event.data;

    const outcome = await undoCoordinator.applyUndo(requestId);

    // The confirm modal is only dismissed once the undo has actually settled,
    // so a rejected undo leaves the prompt up instead of half-closing the flow.
    if (outcome.closeUndoRequest) {
      modal.setUndoRequest(undefined);
      modal.setUndoSelectedIndex(0);
    }

    for (const content of outcome.messages) {
      actions.addMessage({ role: 'assistant', content });
    }

    if (outcome.fileList) {
      if (outcome.fileList.length > 0) {
        modal.setUndoFileListRequest({
          requestId: `undo_${Date.now()}`,
          fileList: outcome.fileList,
          selectedIndex: 0,
        });
      } else {
        modal.setUndoFileListRequest(undefined);
      }
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

    // Both failure modes (no session manager, listing threw) are deliberately
    // silent for the user; the coordinator logs them.
    const outcome = await sessionRestoreCoordinator.listSessions();
    if (outcome.status !== 'ok') return;

    modal.setSessionSelectRequest({
      requestId,
      sessions: outcome.sessions,
      selectedIndex: 0,
    });
  });

  // Session select response
  useActivityEvent(ActivityEventType.SESSION_SELECT_RESPONSE, async (event) => {
    const { sessionId, cancelled } = event.data;

    modal.setSessionSelectRequest(undefined);

    if (!cancelled && sessionId) {
      // The loader closes over the currently foreground agent, so it is passed
      // per call rather than injected once.
      const outcome = await sessionRestoreCoordinator.restoreSession(sessionId, (sessionData) =>
        loadSessionData(sessionData, agent, actions, activityStream)
      );

      if (outcome.status === 'error') {
        // Surface the failure instead of leaving the UI in an indeterminate
        // state with no feedback about why the session didn't load.
        actions.addMessage({
          role: 'assistant',
          content: outcome.message,
          timestamp: Date.now(),
        });
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

    if (cancelled || selectedIndex === undefined) {
      // Drop the presented targets so a later event-driven rewind can't resolve
      // its index against an abandoned selection.
      undoCoordinator.cancelRewindSelection();
    }

    if (!cancelled && selectedIndex !== undefined) {
      try {
        // Restore files and rewind conversation history (all business logic
        // lives in UndoCoordinator; this handler only repaints the UI).
        const {
          targetTimestamp,
          targetMessageContent,
          rewindedMessages,
          restoredFiles,
          failedRestorations,
        } = await undoCoordinator.performRewind(selectedIndex, options);

        const serviceRegistry = ServiceRegistry.getInstance();

        // Clear all state
        actions.clearToolCalls();
        actions.clearRewindNotices();

        undoCoordinator.clearTodos();

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
            // This could happen if there are duplicate IDs in the session data.
            // Use logger (not console) — raw stdout writes corrupt the Ink frame.
            logger.warn(`Failed to add reconstructed tool call ${toolCall.id}:`, error);
          }
        });

        reconstructInterjectionsFromMessages(rewindedMessages, activityStream);

        // Update context usage after rewind (same as session resumption)
        const contextUsage = undoCoordinator.refreshContextUsage();
        if (contextUsage !== undefined) {
          actions.setContextUsage(contextUsage);
        }

        // CRITICAL: Defer rewind notice addition until after resetConversationView completes
        // resetConversationView uses setImmediate, so we need to wait for it to finish
        // Otherwise the notice gets added while terminal is clearing, causing rendering issues
        setImmediate(() => {
          // Bail if the component unmounted while the conversation view was clearing.
          if (!isMountedRef.current) return;

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
