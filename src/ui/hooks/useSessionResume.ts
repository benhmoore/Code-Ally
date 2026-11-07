/**
 * useSessionResume - Handle session resumption on mount
 *
 * This hook handles loading a session from disk when the app starts,
 * including restoring messages, todos, tool calls, and project context.
 */

import { useEffect, useRef, useState } from 'react';
import { Agent } from '@agent/Agent.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { AppActions } from '../contexts/AppContext.js';
export { reconstructToolCallsFromMessages } from '@services/conversationTools.js';
import { SessionSelectRequest } from './useModalState.js';
import { setTerminalTitle } from '../../utils/terminal.js';
import {
  SessionRestoreCoordinator,
  type SessionResume,
  type SessionReplayData,
  type SessionRestoreOutcome,
  type SessionListOutcome,
} from '@services/SessionRestoreCoordinator.js';
import { logger } from '@services/Logger.js';
import { prepareConversationResume } from '@services/ConversationResume.js';
export { supplementTranscriptToolResults } from '@services/ConversationResume.js';

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
  sessionData: SessionReplayData,
  agent: Agent,
  actions: AppActions,
  resume?: SessionResume
): Promise<void> {
  const serviceRegistry = ServiceRegistry.getInstance();

  const { state: restoredState, interruption } = prepareConversationResume(sessionData);
  // Reject active/queued work before changing any global session services.
  (resume ?? (state => agent.getSession().resume(state)))(restoredState);

  serviceRegistry.get('todo_manager')?.setTodos(sessionData.todos ?? []);
  serviceRegistry.get('idle_message_generator')?.setQueue(sessionData.idleMessages ?? []);
  serviceRegistry.get('project_context_detector')?.setCached(sessionData.projectContext ?? null);

  const additionalDirectories = serviceRegistry.get('additional_dirs_manager');
  if (additionalDirectories) {
    additionalDirectories.clear();
    for (const path of sessionData.additional_directories ?? []) {
      const result = await additionalDirectories.addDirectory(path);
      if (!result.success) throw new Error(`Failed to restore directory '${path}': ${result.message}`);
    }
  }

  // Initialize idle task coordinator from session metadata
  const coordinator = serviceRegistry.get('idle_task_coordinator');
  coordinator?.initializeFromSession(sessionData);

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

  // Resume already replaced the owner projection, including reconstructed tools.
  actions.repaintConversationSurface();

  // Update context usage
  // loadConversationState already refreshed the agent-owned TokenManager. Read
  // that result directly instead of requesting a redundant full-history pass.
  actions.setContextUsage(agent.getContextUsagePercentage());

  // Update terminal title with session title
  if (sessionData.metadata?.title) {
    setTerminalTitle(sessionData.metadata.title);
  }
}

/** Capture the live owner and service state for an admitted restore rollback. */
export function captureSessionRollback(agent: Agent, actions: AppActions): (resume?: SessionResume) => Promise<void> {
  const registry = ServiceRegistry.getInstance();
  const conversation = agent.getConversationManager();
  const messages = conversation.getMessages();
  const state = structuredClone({
    messages: [...messages],
    transcript: [...conversation.getTranscript()],
    checkpoint: conversation.getCheckpoint(),
    providerState: conversation.getProviderState(),
    canonicalMessages:
      conversation.getCanonicalActiveMessages(messages.map(message => message.id).filter((id): id is string => !!id)) ??
      [],
  });
  const todos = structuredClone(registry.get('todo_manager')?.getTodos());
  const idle = structuredClone(registry.get('idle_message_generator')?.getQueue());
  const project = structuredClone(registry.get('project_context_detector')?.getCached());
  const directories = registry.get('additional_dirs_manager')?.getAdditionalDirectories();
  return async resume => {
    (resume ?? (saved => agent.getSession().resume(saved)))(state);
    if (todos) registry.get('todo_manager')?.setTodos(todos);
    if (idle) registry.get('idle_message_generator')?.setQueue(idle);
    if (project !== undefined) registry.get('project_context_detector')?.setCached(project);
    const manager = registry.get('additional_dirs_manager');
    if (manager && directories) {
      manager.clear();
      for (const path of directories) {
        const result = await manager.addDirectory(path);
        if (!result.success) throw new Error(`Failed to restore directory '${path}': ${result.message}`);
      }
    }
    actions.repaintConversationSurface();
    actions.setContextUsage(agent.getContextUsagePercentage());
  };
}

/** Share one admitted restore transaction between startup and the picker. */
export function restoreSessionForAgent(
  coordinator: SessionRestoreCoordinator,
  sessionId: string,
  agent: Agent,
  actions: AppActions,
  ownsRequest: () => boolean
): Promise<SessionRestoreOutcome> {
  return coordinator.restoreSession(sessionId, (data, resume) => loadSessionData(data, agent, actions, resume), {
    ownsRequest,
    runExclusive: operation => agent.getSession().withIdleMutation(operation),
    captureRollback: () => captureSessionRollback(agent, actions),
    onRollbackFailure: () => {
      // Closing rejects queued/new work synchronously; teardown waits for the lease.
      void agent
        .getSession()
        .close()
        .catch(error => logger.error('[SessionRestore] Failed to close inconsistent owner:', error));
    },
  });
}

type StartupOutcome =
  { kind: 'list'; outcome: SessionListOutcome } | { kind: 'restore'; outcome: SessionRestoreOutcome };
interface StartupJob {
  agent: Agent;
  target: string;
  active: boolean;
  promise: Promise<StartupOutcome>;
}

/** Resume startup once per owner/target; stale completion cannot publish into a new route. */
export function useSessionResume(
  resumeSession: string | 'interactive' | null | undefined,
  agent: Agent,
  actions: AppActions,
  setSessionSelectRequest: (request?: SessionSelectRequest) => void
): SessionResumeResult {
  const [readiness, setReadiness] = useState({ agent, target: resumeSession, loaded: !resumeSession });
  const latest = useRef({ agent, target: resumeSession, actions, setSessionSelectRequest });
  latest.current = { agent, target: resumeSession, actions, setSessionSelectRequest };
  const pending = useRef<StartupJob | undefined>(undefined);

  useEffect(() => {
    if (!resumeSession) {
      setReadiness({ agent, target: resumeSession, loaded: true });
      return;
    }
    let job = pending.current;
    if (!job || job.agent !== agent || job.target !== resumeSession) {
      const registry = ServiceRegistry.getInstance();
      const coordinator = new SessionRestoreCoordinator({
        getSessionManager: () => registry.get('session_manager'),
        getPatchManager: () => registry.get('patch_manager'),
      });
      job = {
        agent,
        target: resumeSession,
        active: true,
        promise: Promise.resolve({ kind: 'list', outcome: { status: 'unavailable' } }),
      };
      const owner = job;
      const ownsRequest = () =>
        owner.active && latest.current.agent === owner.agent && latest.current.target === owner.target;
      owner.promise =
        resumeSession === 'interactive'
          ? coordinator.listSessions().then(outcome => ({ kind: 'list', outcome }))
          : restoreSessionForAgent(coordinator, resumeSession, agent, latest.current.actions, ownsRequest).then(
              outcome => ({ kind: 'restore', outcome })
            );
      pending.current = owner;
    }
    job.active = true;
    const owner = job;
    let cancelled = false;
    const current = () =>
      !cancelled && owner.active && latest.current.agent === owner.agent && latest.current.target === owner.target;
    void owner.promise
      .then(result => {
        if (!current()) return;
        if (result.kind === 'list' && result.outcome.status === 'ok') {
          latest.current.setSessionSelectRequest({
            requestId: `session_select_${Date.now()}`,
            sessions: result.outcome.sessions,
            selectedIndex: 0,
          });
        } else if (result.outcome.status === 'error') {
          latest.current.actions.addMessage({ role: 'assistant', content: result.outcome.message });
        } else if (result.outcome.status === 'unavailable') {
          latest.current.actions.addMessage({ role: 'assistant', content: 'Session restoration is unavailable.' });
        }
        setReadiness({ agent: owner.agent, target: owner.target, loaded: true });
      })
      .catch(error => {
        logger.error('[SessionRestore] Startup failed:', error);
        if (!current()) return;
        latest.current.actions.addMessage({
          role: 'assistant',
          content: `Failed to restore session: ${error instanceof Error ? error.message : String(error)}`,
        });
        setReadiness({ agent: owner.agent, target: owner.target, loaded: true });
      });
    return () => {
      cancelled = true;
      owner.active = false;
    };
  }, [agent, resumeSession]);

  return {
    sessionLoaded: readiness.agent === agent && readiness.target === resumeSession ? readiness.loaded : !resumeSession,
  };
}
