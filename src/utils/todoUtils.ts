/**
 * Utility functions for todo management
 */

import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { TodoItem } from '../services/TodoManager.js';
import { logger } from '../services/Logger.js';

/**
 * Auto-save todos to session
 * Handles all the boilerplate of getting services and calling autoSave
 */
export async function autoSaveTodos(todos: TodoItem[]): Promise<void> {
  try {
    const registry = ServiceRegistry.getInstance();
    const sessionManager = registry.get('session_manager');

    if (!sessionManager || typeof (sessionManager as any).autoSave !== 'function') {
      logger.debug('[autoSaveTodos] SessionManager not available or autoSave not implemented');
      return;
    }

    // Gather all required context for session save
    const agent = registry.get('agent');
    const messages =
      agent && typeof (agent as any).getMessages === 'function'
        ? (agent as any).getMessages()
        : [];

    const idleMessageGenerator = registry.get('idle_message_generator');
    const idleMessages =
      idleMessageGenerator && typeof (idleMessageGenerator as any).getQueue === 'function'
        ? (idleMessageGenerator as any).getQueue()
        : undefined;

    const projectContextDetector = registry.get('project_context_detector');
    const projectContext =
      projectContextDetector && typeof (projectContextDetector as any).getCached === 'function'
        ? (projectContextDetector as any).getCached()
        : undefined;

    await (sessionManager as any).autoSave(messages, todos, idleMessages, projectContext);
  } catch (error) {
    logger.error('[autoSaveTodos] Failed to auto-save session:', error);
  }
}
