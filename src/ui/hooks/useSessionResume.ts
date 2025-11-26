/**
 * useSessionResume - Handle session resumption on mount
 *
 * This hook handles loading a session from disk when the app starts,
 * including restoring messages, todos, tool calls, and project context.
 */

import { useEffect, useRef, useState } from 'react';
import { Agent } from '@agent/Agent.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { SessionManager } from '@services/SessionManager.js';
import { PatchManager } from '@services/PatchManager.js';
import { ToolManager } from '@tools/ToolManager.js';
import { AppActions } from '../contexts/AppContext.js';
import { Message, ToolCallState } from '@shared/index.js';
import { SessionSelectRequest } from './useModalState.js';
import { setTerminalTitle } from '../../utils/terminal.js';

/**
 * Reconstruct USER_INTERJECTION events from message history
 *
 * When loading a session from disk, interjection messages have metadata with parentId,
 * but we need to re-emit USER_INTERJECTION events so ToolCallDisplay can capture them.
 *
 * @param messages - Array of messages from the session
 * @param activityStream - ActivityStream to emit events to
 */
export function reconstructInterjectionsFromMessages(messages: Message[], activityStream: ActivityStream): void {
  messages.forEach((msg) => {
    if (msg.role === 'user' && msg.metadata?.isInterjection && msg.metadata?.parentId) {
      // Re-emit USER_INTERJECTION event for this interjection
      activityStream.emit({
        id: `interjection-reconstructed-${msg.timestamp || Date.now()}`,
        type: 'USER_INTERJECTION' as any,
        timestamp: msg.timestamp || Date.now(),
        parentId: msg.metadata.parentId,
        data: {
          message: msg.content,
          reconstructed: true,
        },
      });
    }
  });
}

/**
 * Reconstruct ToolCallState objects from message history
 *
 * When loading a session from disk, we have messages with tool_calls and tool results,
 * but we don't have the ToolCallState objects that are needed for proper UI rendering.
 * This function reconstructs those states from the message history.
 *
 * Tool context data is stored in two places:
 * - Assistant messages: parentId, thinking, thinkingDuration (in metadata.tool_context)
 * - Tool result messages: executionStartTime, agentModel (in metadata.tool_context)
 *
 * @param messages - Array of messages from the session
 * @param serviceRegistry - Service registry to look up tool definitions
 * @returns Array of reconstructed ToolCallState objects
 */
export function reconstructToolCallsFromMessages(messages: Message[], serviceRegistry: ServiceRegistry): ToolCallState[] {
  const toolCalls: ToolCallState[] = [];
  const toolResultsMap = new Map<string, { output: string; error?: string; timestamp: number; metadata?: any }>();

  // Get ToolManager to look up tool visibility
  const toolManager = serviceRegistry.get<ToolManager>('tool_manager');

  // First pass: collect all tool results
  messages.forEach(msg => {
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResultsMap.set(msg.tool_call_id, {
        output: msg.content,
        error: msg.content.startsWith('Error:') ? msg.content : undefined,
        timestamp: msg.timestamp || Date.now(),
        metadata: msg.metadata,
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

        // Prefer stored metadata over current tool definitions (for backwards compatibility with version changes)
        let visibleInChat = true; // Default to visible
        let status: 'success' | 'error' | 'pending' | 'validating' | 'scheduled' | 'executing' | 'cancelled' = 'success';

        // First, try to get visibility from stored metadata
        if (msg.metadata?.tool_visibility?.[tc.id] !== undefined) {
          visibleInChat = msg.metadata.tool_visibility[tc.id] ?? true;
        } else if (toolManager) {
          // Fallback to current tool definition if no stored metadata
          const toolDef = toolManager.getTool(tc.function.name);
          if (toolDef) {
            visibleInChat = toolDef.visibleInChat ?? true;
          }
        }

        // Try to get status from stored metadata (prefer tool result message metadata over assistant message)
        // Tool result message metadata is more accurate as it's set at execution time
        if (result?.metadata?.tool_status?.[tc.id]) {
          status = result.metadata.tool_status[tc.id];
        } else if (result) {
          // Fallback to inferring from result
          status = hasError ? 'error' : 'success';
        }

        // Merge tool_context from both assistant message and tool result message
        // Assistant message contains: parentId, thinking, thinkingDuration
        // Tool result message contains: executionStartTime, agentModel
        const assistantToolContext = msg.metadata?.tool_context?.[tc.id];
        const resultToolContext = result?.metadata?.tool_context?.[tc.id];

        // Extract context data from both sources
        const parentId = assistantToolContext?.parentId;
        const thinking = assistantToolContext?.thinking;
        const thinkingDuration = assistantToolContext?.thinkingDuration;
        const executionStartTime = resultToolContext?.executionStartTime;
        const agentModel = resultToolContext?.agentModel;

        // Calculate thinking timing if we have thinking content
        let thinkingStartTime: number | undefined;
        let thinkingEndTime: number | undefined;
        if (thinking) {
          // If we have thinking duration, calculate timing based on message timestamp
          if (thinkingDuration !== undefined) {
            // Thinking ends when the message is created (baseTimestamp)
            thinkingEndTime = baseTimestamp + index;
            thinkingStartTime = thinkingEndTime - thinkingDuration;
          } else {
            // Fallback: estimate thinking occurred just before the message
            thinkingEndTime = baseTimestamp + index;
            // Without duration, we can't accurately set startTime
          }
        }

        const toolCallState: ToolCallState = {
          id: tc.id,
          status,
          toolName: tc.function.name,
          arguments: parsedArgs,
          output: result?.output,
          error: result?.error,
          startTime: baseTimestamp + index, // Slightly offset multiple calls in same message
          endTime: result?.timestamp,
          visibleInChat: visibleInChat,
          // Add reconstructed tool context fields
          ...(parentId !== undefined && { parentId }),
          ...(thinking !== undefined && { thinking }),
          ...(thinkingStartTime !== undefined && { thinkingStartTime }),
          ...(thinkingEndTime !== undefined && { thinkingEndTime }),
          ...(executionStartTime !== undefined && { executionStartTime }),
          ...(agentModel !== undefined && { agentModel }),
        };

        toolCalls.push(toolCallState);
      });
    }
  });

  return toolCalls;
}

/**
 * Result of session resume operation
 */
export interface SessionResumeResult {
  /** Whether session has been loaded */
  sessionLoaded: boolean;
}

/**
 * Core session loading logic shared between direct resume and interactive selection
 * This consolidates the duplicated logic between useSessionResume and SESSION_SELECT_RESPONSE
 */
export async function loadSessionData(
  sessionData: any,
  agent: Agent,
  actions: AppActions,
  activityStream: ActivityStream
): Promise<void> {
  const serviceRegistry = ServiceRegistry.getInstance();

  // Filter out system messages for UI
  const userMessages = sessionData.messages.filter((m: Message) => m.role !== 'system');

  // Load todos if present
  const todoManager = serviceRegistry.get('todo_manager');
  if (todoManager) {
    if (sessionData.todos?.length > 0) {
      (todoManager as any).setTodos(sessionData.todos);
    } else {
      (todoManager as any).setTodos([]);
    }
  }

  // Load idle messages if present
  const idleMessageGenerator = serviceRegistry.get('idle_message_generator');
  if (idleMessageGenerator && sessionData.idleMessages?.length > 0) {
    (idleMessageGenerator as any).setQueue(sessionData.idleMessages);
  }

  // Load project context if present
  const projectContextDetector = serviceRegistry.get('project_context_detector');
  if (projectContextDetector && sessionData.projectContext) {
    (projectContextDetector as any).setCached(sessionData.projectContext);
  }

  // Restore additional directories if present
  if (sessionData.additional_directories?.length) {
    const additionalDirsManager = serviceRegistry.get('additional_dirs_manager');
    if (additionalDirsManager && typeof (additionalDirsManager as any).addDirectory === 'function') {
      for (const dir of sessionData.additional_directories) {
        await (additionalDirsManager as any).addDirectory(dir);
      }
    }
  }

  // Initialize idle task coordinator from session metadata
  const coordinator = serviceRegistry.get('idle_task_coordinator');
  if (coordinator && typeof (coordinator as any).initializeFromSession === 'function') {
    (coordinator as any).initializeFromSession(sessionData);
  }

  // Clear tool calls first
  actions.clearToolCalls();

  // Bulk load messages into agent (doesn't trigger auto-save)
  agent.setMessages(userMessages);

  // Clean up ephemeral reminders from loaded session
  agent.removeEphemeralSystemReminders();

  // Clean up stale persistent reminders (defensive - removes persistent reminders older than 30 minutes)
  agent.cleanupStaleReminders();

  // Atomically update UI with new messages AND increment remount key
  // This prevents Static component from accumulating renders
  actions.resetConversationView(userMessages);

  // Reconstruct tool calls from message history
  // This populates activeToolCalls with completed tool calls so they appear in the timeline
  const reconstructedToolCalls = reconstructToolCallsFromMessages(userMessages, serviceRegistry);
  reconstructedToolCalls.forEach(toolCall => {
    try {
      actions.addToolCall(toolCall);
    } catch (error) {
      // Log but don't fail session resume if a tool call can't be added
      // This could happen if there are duplicate IDs in the session data
      console.warn(`Failed to add reconstructed tool call ${toolCall.id}:`, error);
    }
  });

  // Reconstruct interjection events from message history
  reconstructInterjectionsFromMessages(userMessages, activityStream);

  // Update context usage
  const tokenManager = serviceRegistry.get('token_manager');
  if (tokenManager && typeof (tokenManager as any).updateTokenCount === 'function') {
    (tokenManager as any).updateTokenCount(agent.getMessages());
    const contextUsage = (tokenManager as any).getContextUsagePercentage();
    actions.setContextUsage(contextUsage);
  }

  // Update terminal title with session title
  if (sessionData.metadata?.title) {
    setTerminalTitle(sessionData.metadata.title);
  }
}

/**
 * Handle session resumption on mount
 *
 * @param resumeSession - Session to resume (session ID, 'interactive' for selector, or null)
 * @param agent - The agent instance
 * @param actions - App context actions
 * @param activityStream - ActivityStream to emit events
 * @param setSessionSelectRequest - Callback to show session selector
 * @returns Session resume state
 *
 * @example
 * ```tsx
 * const { sessionLoaded } = useSessionResume(
 *   props.resumeSession,
 *   agent,
 *   actions,
 *   activityStream,
 *   modal.setSessionSelectRequest
 * );
 * ```
 */
export const useSessionResume = (
  resumeSession: string | 'interactive' | null | undefined,
  agent: Agent,
  actions: AppActions,
  activityStream: ActivityStream,
  setSessionSelectRequest: (request?: SessionSelectRequest) => void
): SessionResumeResult => {
  const [sessionLoaded, setSessionLoaded] = useState(!resumeSession);
  const sessionResumed = useRef(false);

  useEffect(() => {
    const handleSessionResume = async () => {
      // Only run once
      if (sessionResumed.current) {
        return;
      }

      const serviceRegistry = ServiceRegistry.getInstance();
      const sessionManager = serviceRegistry.get<SessionManager>('session_manager');

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

        // Use shared session loading logic
        await loadSessionData(sessionData, agent, actions, activityStream);

        // Mark session as loaded
        setSessionLoaded(true);
        sessionResumed.current = true;
      }
    };

    handleSessionResume();
  }, [resumeSession, agent, actions, activityStream, setSessionSelectRequest]);

  return {
    sessionLoaded,
  };
};
