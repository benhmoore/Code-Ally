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
import { AppActions } from '../contexts/AppContext.js';
import { Message } from '@shared/index.js';
import { reconstructToolCallsFromMessages } from '@services/conversationTools.js';
export { reconstructToolCallsFromMessages } from '@services/conversationTools.js';
import { SessionSelectRequest } from './useModalState.js';
import { setTerminalTitle } from '../../utils/terminal.js';
import { prepareConversationResume } from '@services/ConversationResume.js';
export { supplementTranscriptToolResults } from '@services/ConversationResume.js';

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

  const { state: restoredState, interruption } = prepareConversationResume(sessionData);
  const transcriptMessages = restoredState.transcript.filter((m: Message) => m.role !== 'system');

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

  // Bulk load messages into agent (doesn't trigger auto-save)
  agent.getSession().resume(restoredState);

  // If the session was interrupted mid-turn, inject a continuation prompt
  // so the model picks up where it left off on the next user message
  if (interruption === 'interrupted_turn') {
    agent.addMessage({
      role: 'user',
      content: 'Continue from where you left off. The previous turn was interrupted.',
      metadata: { ephemeral: true },
    });
  }

  // Clean up ephemeral reminders from loaded session
  agent.removeEphemeralSystemReminders();

  // Clean up stale persistent reminders (defensive - removes persistent reminders older than 30 minutes)
  agent.cleanupStaleReminders();

  // Reconstruct tool calls from message history
  // This populates activeToolCalls with completed tool calls so they appear in the timeline
  const reconstructedToolCalls = reconstructToolCallsFromMessages(transcriptMessages, serviceRegistry);

  // Restore the complete visible timeline in one state transaction. Enqueuing
  // one React update per historical tool call scales quadratically and can make
  // Ink repeatedly lay out a partially-restored conversation.
  actions.resetConversationViewWithTools(transcriptMessages, reconstructedToolCalls);

  // Reconstruct interjection events from message history
  reconstructInterjectionsFromMessages(transcriptMessages, activityStream);

  // Update context usage
  // loadConversationState already refreshed the agent-owned TokenManager. Read
  // that result directly instead of requesting a redundant full-history pass.
  actions.setContextUsage(agent.getContextUsagePercentage());

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
      const sessionManager = serviceRegistry.get('session_manager');

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
        const patchManager = serviceRegistry.get('patch_manager');
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
