/**
 * SessionPersistence - Handles automatic session saving
 *
 * Core responsibilities:
 * - Coordinate session auto-save
 * - Gather session data from multiple sources (messages, todos, project context)
 * - Handle session creation when needed
 * - Error handling for save failures
 *
 * This class extracts session persistence logic from Agent to maintain
 * separation of concerns and improve testability.
 */

import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ConversationManager } from './ConversationManager.js';
import { logger } from '../services/Logger.js';

/**
 * Coordinates automatic session saving with multiple data sources
 */
export class SessionPersistence {
  constructor(
    private conversationManager: ConversationManager,
    private instanceId: string
  ) {}

  /**
   * Auto-save session to disk (messages and todos)
   *
   * This is a non-blocking fire-and-forget operation that saves:
   * - Conversation messages
   * - Todo list (if available)
   * - Idle message queue (if available)
   * - Project context (if available)
   *
   * Creates a new session if none exists and we have user messages.
   */
  async autoSave(): Promise<void> {
    const registry = ServiceRegistry.getInstance();
    const sessionManager = registry.get('session_manager');
    const todoManager = registry.get('todo_manager');

    if (!sessionManager || typeof (sessionManager as any).autoSave !== 'function') {
      return; // Session manager not available
    }

    // Get current session
    const currentSession = (sessionManager as any).getCurrentSession();

    // Create a new session if none exists and we have user messages
    if (!currentSession) {
      const hasUserMessages = this.conversationManager.getMessages().some(m => m.role === 'user');
      if (hasUserMessages && typeof (sessionManager as any).generateSessionName === 'function') {
        const sessionName = (sessionManager as any).generateSessionName();
        await (sessionManager as any).createSession(sessionName);
        (sessionManager as any).setCurrentSession(sessionName);
        logger.debug('[AGENT_SESSION]', this.instanceId, 'Created new session:', sessionName);

        // Notify PatchManager about the new session
        const patchManager = registry.get('patch_manager');
        if (patchManager && typeof (patchManager as any).onSessionChange === 'function') {
          await (patchManager as any).onSessionChange();
        }
      } else {
        return; // No user messages yet, don't create session
      }
    }

    // Get todos if TodoManager is available
    let todos: any[] | undefined;
    if (todoManager && typeof (todoManager as any).getTodos === 'function') {
      todos = (todoManager as any).getTodos();
    }

    // Get idle messages if IdleMessageGenerator is available
    let idleMessages: string[] | undefined;
    const idleMessageGenerator = registry.get('idle_message_generator');
    if (idleMessageGenerator && typeof (idleMessageGenerator as any).getQueue === 'function') {
      idleMessages = (idleMessageGenerator as any).getQueue();
    }

    // Get project context if ProjectContextDetector is available
    let projectContext: any | undefined;
    const projectContextDetector = registry.get('project_context_detector');
    if (projectContextDetector && typeof (projectContextDetector as any).getCached === 'function') {
      projectContext = (projectContextDetector as any).getCached();
    }

    // Auto-save (non-blocking, fire and forget)
    (sessionManager as any).autoSave(this.conversationManager.getMessages(), todos, idleMessages, projectContext).catch((error: Error) => {
      logger.error('[AGENT_SESSION]', this.instanceId, 'Failed to auto-save session:', error);
    });
  }
}
