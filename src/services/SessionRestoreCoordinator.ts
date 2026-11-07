/**
 * SessionRestoreCoordinator - Business logic behind the session picker
 *
 * Owns the two non-rendering halves of the session-select cluster:
 *   - listing the sessions recorded for the current working directory
 *   - switching the active session and replaying its data into the app
 *
 * The UI layer keeps only event plumbing: it opens/closes the picker modal and
 * pushes the returned outcome into React state. No SessionManager access, no
 * PatchManager rebinding and no error formatting happens in the hook.
 *
 * Collaborators are constructor-injected as suppliers (matching
 * {@link UndoCoordinator}) so the coordinator can be built before the underlying
 * services exist and never touches ServiceRegistry itself.
 */

import type { SessionManager } from './SessionManager.js';
import type { SessionResumeState } from './SessionRuntime.js';
import type { SessionInfo } from '../types/index.js';
import { logger } from './Logger.js';

export type SessionReplayData = SessionResumeState &
  Partial<
    Pick<
      Awaited<ReturnType<SessionManager['getSessionData']>>,
      'todos' | 'idleMessages' | 'projectContext' | 'metadata' | 'additional_directories'
    >
  >;

/** Subset of SessionManager the session picker depends on */
export interface RestorableSessionManager {
  getSessionsInfoByDirectory(workingDir?: string): Promise<SessionInfo[]>;
  setCurrentSession(sessionName: string | null): void;
  getCurrentSession(): string | null;
  forceSave(): Promise<boolean>;
  getSessionData(sessionName: string): Promise<SessionReplayData>;
}

/** Subset of PatchManager notified when the active session changes */
export interface SessionAwarePatchManager {
  onSessionChange(): Promise<void>;
}

/**
 * Replays a loaded session into the conversation + UI.
 *
 * Passed per call rather than constructor-injected because it closes over the
 * currently foreground agent, which is swapped at runtime.
 */
export type SessionResume = (state: SessionResumeState) => void;
export type SessionDataLoader = (sessionData: SessionReplayData, resume?: SessionResume) => Promise<void>;
export interface SessionRestoreOptions {
  ownsRequest?: () => boolean;
  runExclusive?: (
    operation: (resume: SessionResume) => Promise<SessionRestoreOutcome>
  ) => Promise<SessionRestoreOutcome>;
  captureRollback?: () => (resume?: SessionResume) => Promise<void>;
  onRollbackFailure?: (error: Error) => void;
}
const restoreQueues = new WeakMap<RestorableSessionManager, Promise<void>>();

export interface SessionRestoreCoordinatorDeps {
  getSessionManager: () => RestorableSessionManager | null | undefined;
  getPatchManager: () => SessionAwarePatchManager | null | undefined;
}

/**
 * Result of listing sessions for the picker.
 *
 * Both `unavailable` and `error` are silent for the user: the failure is logged,
 * the modal never opens, and no chat message appears, so pressing the shortcut
 * looks like nothing happened. They are distinct statuses rather than one error
 * message so the oddity stays visible in the type.
 */
export type SessionListOutcome =
  { status: 'ok'; sessions: SessionInfo[] } | { status: 'unavailable' } | { status: 'error'; message: string };

/** A failed admission/read leaves ownership untouched; an admitted failure is rolled back. */
export type SessionRestoreOutcome =
  | { status: 'ok' }
  | { status: 'unavailable' }
  | { status: 'superseded' }
  | { status: 'error'; message: string; sessionSwitched: boolean };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export class SessionRestoreCoordinator {
  constructor(private readonly deps: SessionRestoreCoordinatorDeps) {}

  /**
   * Load the session list shown by the picker, most-recent-first ordering being
   * the session manager's concern.
   */
  async listSessions(): Promise<SessionListOutcome> {
    const sessionManager = this.deps.getSessionManager();
    if (!sessionManager) {
      return { status: 'unavailable' };
    }

    try {
      const sessions = await sessionManager.getSessionsInfoByDirectory();
      return { status: 'ok', sessions };
    } catch (error) {
      logger.error('Failed to fetch sessions:', error);
      return { status: 'error', message: describeError(error) };
    }
  }

  /** Stage reads without changing ownership, then commit under the session's idle lease. */
  async restoreSession(
    sessionId: string,
    loadSession: SessionDataLoader,
    options: SessionRestoreOptions = {}
  ): Promise<SessionRestoreOutcome> {
    const manager = this.deps.getSessionManager();
    if (!manager) return { status: 'unavailable' };
    const ownsRequest = options.ownsRequest ?? (() => true);
    let sessionSwitched = false;
    try {
      if (!ownsRequest()) return { status: 'superseded' };
      const previous = restoreQueues.get(manager) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>(resolve => {
        release = resolve;
      });
      restoreQueues.set(manager, tail);
      try {
        await previous;
        if (!ownsRequest()) return { status: 'superseded' };
        const commit = async (resume?: SessionResume): Promise<SessionRestoreOutcome> => {
          if (!ownsRequest()) return { status: 'superseded' };
          if (!(await manager.forceSave())) throw new Error('Session snapshot could not be persisted before restore');
          const data = await manager.getSessionData(sessionId);
          if (!ownsRequest()) return { status: 'superseded' };
          const previousSession = manager.getCurrentSession();
          const rollback = options.captureRollback?.();
          const patchManager = this.deps.getPatchManager();
          try {
            manager.setCurrentSession(sessionId);
            sessionSwitched = true;
            await patchManager?.onSessionChange();
            // Admission is irrevocable: navigation can suppress picker effects,
            // but the selected binding and owner replay must complete together.
            await loadSession(data, resume);
            return { status: 'ok' };
          } catch (error) {
            if (!sessionSwitched) throw error;
            try {
              manager.setCurrentSession(previousSession);
              await rollback?.(resume);
              await patchManager?.onSessionChange();
              sessionSwitched = false;
            } catch (rollbackError) {
              const failure = new AggregateError([error, rollbackError], 'Session restore and rollback failed', {
                cause: error,
              });
              options.onRollbackFailure?.(failure);
              throw failure;
            }
            throw error;
          }
        };
        return options.runExclusive ? await options.runExclusive(commit) : await commit();
      } finally {
        release();
        if (restoreQueues.get(manager) === tail) restoreQueues.delete(manager);
      }
    } catch (error) {
      logger.error('[ACTIVITY] Failed to load selected session:', error);
      return { status: 'error', message: `Failed to load session: ${describeError(error)}`, sessionSwitched };
    }
  }
}
