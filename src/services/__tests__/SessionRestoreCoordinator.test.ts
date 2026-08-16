/**
 * Tests for SessionRestoreCoordinator - the session picker logic extracted from
 * useActivitySubscriptions.
 *
 * Restoring a session re-points where subsequent conversation and patch writes
 * land, so the tests pin down the ordering of the switch and exactly how much
 * of it has already happened when a later step fails.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionRestoreCoordinator } from '../SessionRestoreCoordinator.js';
import type {
  RestorableSessionManager,
  SessionAwarePatchManager,
} from '../SessionRestoreCoordinator.js';
import type { SessionInfo } from '../../types/index.js';

vi.mock('../Logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function makeSessionInfo(name: string): SessionInfo {
  return { name, messageCount: 2 } as SessionInfo;
}

function makeSessionManager(
  overrides: Partial<RestorableSessionManager> = {}
): RestorableSessionManager & {
  setCurrentSession: ReturnType<typeof vi.fn>;
  getSessionData: ReturnType<typeof vi.fn>;
} {
  return {
    getSessionsInfoByDirectory: vi.fn(async () => [makeSessionInfo('yesterday')]),
    setCurrentSession: vi.fn(),
    getSessionData: vi.fn(async () => ({ messages: [] })),
    ...overrides,
  } as RestorableSessionManager & {
    setCurrentSession: ReturnType<typeof vi.fn>;
    getSessionData: ReturnType<typeof vi.fn>;
  };
}

function makeCoordinator(
  sessionManager: RestorableSessionManager | null,
  patchManager: SessionAwarePatchManager | null = { onSessionChange: vi.fn(async () => {}) }
) {
  return new SessionRestoreCoordinator({
    getSessionManager: () => sessionManager,
    getPatchManager: () => patchManager,
  });
}

describe('SessionRestoreCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('listSessions', () => {
    it('returns the sessions for the working directory', async () => {
      const sessions = [makeSessionInfo('one'), makeSessionInfo('two')];
      const coordinator = makeCoordinator(
        makeSessionManager({ getSessionsInfoByDirectory: vi.fn(async () => sessions) })
      );

      expect(await coordinator.listSessions()).toEqual({ status: 'ok', sessions });
    });

    // Both failures are silent for the user - the picker simply never opens.
    // They stay distinct statuses so callers can tell them apart.
    it('reports a missing session manager', async () => {
      expect(await makeCoordinator(null).listSessions()).toEqual({ status: 'unavailable' });
    });

    it('reports a listing failure', async () => {
      const coordinator = makeCoordinator(
        makeSessionManager({
          getSessionsInfoByDirectory: vi.fn(async () => {
            throw new Error('sessions dir missing');
          }),
        })
      );

      expect(await coordinator.listSessions()).toEqual({
        status: 'error',
        message: 'sessions dir missing',
      });
    });
  });

  describe('restoreSession', () => {
    it('switches, rebinds patches and replays the session in order', async () => {
      const order: string[] = [];
      const sessionData = { messages: [{ role: 'user', content: 'hi' }] };
      const sessionManager = makeSessionManager({
        setCurrentSession: vi.fn(() => {
          order.push('switch');
        }),
        getSessionData: vi.fn(async () => {
          order.push('read');
          return sessionData;
        }),
      });
      const patchManager = {
        onSessionChange: vi.fn(async () => {
          order.push('rebind');
        }),
      };
      const loadSession = vi.fn(async () => {
        order.push('replay');
      });

      const outcome = await makeCoordinator(sessionManager, patchManager).restoreSession(
        'yesterday',
        loadSession
      );

      expect(outcome).toEqual({ status: 'ok' });
      expect(order).toEqual(['switch', 'rebind', 'read', 'replay']);
      expect(sessionManager.setCurrentSession).toHaveBeenCalledWith('yesterday');
      expect(sessionManager.getSessionData).toHaveBeenCalledWith('yesterday');
      expect(loadSession).toHaveBeenCalledWith(sessionData);
    });

    it('restores without a patch manager registered', async () => {
      const loadSession = vi.fn(async () => {});

      const outcome = await makeCoordinator(makeSessionManager(), null).restoreSession(
        'yesterday',
        loadSession
      );

      expect(outcome).toEqual({ status: 'ok' });
      expect(loadSession).toHaveBeenCalled();
    });

    it('reports a missing session manager without replaying anything', async () => {
      const loadSession = vi.fn(async () => {});

      const outcome = await makeCoordinator(null).restoreSession('yesterday', loadSession);

      expect(outcome).toEqual({ status: 'unavailable' });
      expect(loadSession).not.toHaveBeenCalled();
    });

    // The session pointer moves before the data is read, so
    // a later failure leaves the app pointed at the new session while the
    // visible transcript still belongs to the old one. Nothing rolls that back;
    // `sessionSwitched` is how the caller learns it happened.
    it('reports that the session already switched when reading fails', async () => {
      const sessionManager = makeSessionManager({
        getSessionData: vi.fn(async () => {
          throw new Error('session file corrupt');
        }),
      });

      const outcome = await makeCoordinator(sessionManager).restoreSession(
        'yesterday',
        vi.fn(async () => {})
      );

      expect(outcome).toEqual({
        status: 'error',
        message: 'Failed to load session: session file corrupt',
        sessionSwitched: true,
      });
      expect(sessionManager.setCurrentSession).toHaveBeenCalledWith('yesterday');
    });

    it('reports that the session already switched when the replay fails', async () => {
      const outcome = await makeCoordinator(makeSessionManager()).restoreSession(
        'yesterday',
        vi.fn(async () => {
          throw new Error('recovery pipeline blew up');
        })
      );

      expect(outcome).toEqual({
        status: 'error',
        message: 'Failed to load session: recovery pipeline blew up',
        sessionSwitched: true,
      });
    });

    it('reports that nothing switched when the switch itself fails', async () => {
      const sessionManager = makeSessionManager({
        setCurrentSession: vi.fn(() => {
          throw new Error('unknown session');
        }),
      });

      const outcome = await makeCoordinator(sessionManager).restoreSession(
        'yesterday',
        vi.fn(async () => {})
      );

      expect(outcome).toEqual({
        status: 'error',
        message: 'Failed to load session: unknown session',
        sessionSwitched: false,
      });
    });

    it('describes a non-Error rejection', async () => {
      const outcome = await makeCoordinator(makeSessionManager()).restoreSession(
        'yesterday',
        vi.fn(async () => {
          throw 'boom';
        })
      );

      expect(outcome).toMatchObject({ message: 'Failed to load session: Unknown error' });
    });
  });
});
