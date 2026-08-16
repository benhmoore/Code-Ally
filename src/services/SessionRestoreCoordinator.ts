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

import type { SessionInfo } from '../types/index.js';
import { logger } from './Logger.js';

/** Subset of SessionManager the session picker depends on */
export interface RestorableSessionManager {
  getSessionsInfoByDirectory(workingDir?: string): Promise<SessionInfo[]>;
  setCurrentSession(sessionName: string | null): void;
  getSessionData(sessionName: string): Promise<unknown>;
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
export type SessionDataLoader = (sessionData: unknown) => Promise<void>;

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
  | { status: 'ok'; sessions: SessionInfo[] }
  | { status: 'unavailable' }
  | { status: 'error'; message: string };

/**
 * Result of restoring a session.
 *
 * `sessionSwitched` reports a hazard in the ordering: `setCurrentSession()` and
 * the patch manager rebind happen before the session data is read, so a failure
 * while reading or replaying leaves the app pointed at the newly selected
 * session while the visible transcript still belongs to the previous one.
 * Nothing rolls that back, because a rollback would change which session
 * subsequent writes land in - so the caller is told instead.
 */
export type SessionRestoreOutcome =
  | { status: 'ok' }
  | { status: 'unavailable' }
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

  /**
   * Switch the active session and replay it.
   *
   * Order is load-bearing:
   *   1. point the session manager at the selected session
   *   2. let the patch manager rebind to that session's patch history
   *   3. read the session data
   *   4. replay it into the conversation/UI via `loadSession`
   */
  async restoreSession(
    sessionId: string,
    loadSession: SessionDataLoader
  ): Promise<SessionRestoreOutcome> {
    const sessionManager = this.deps.getSessionManager();
    if (!sessionManager) {
      return { status: 'unavailable' };
    }

    let sessionSwitched = false;
    try {
      sessionManager.setCurrentSession(sessionId);
      sessionSwitched = true;

      const patchManager = this.deps.getPatchManager();
      if (patchManager) {
        await patchManager.onSessionChange();
      }

      const sessionData = await sessionManager.getSessionData(sessionId);

      await loadSession(sessionData);

      return { status: 'ok' };
    } catch (error) {
      // Surface the failure instead of leaving the UI in an indeterminate
      // state with no feedback about why the session didn't load.
      logger.error('[ACTIVITY] Failed to load selected session:', error);
      return {
        status: 'error',
        message: `Failed to load session: ${describeError(error)}`,
        sessionSwitched,
      };
    }
  }
}
