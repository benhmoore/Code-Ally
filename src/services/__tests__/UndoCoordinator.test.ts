/**
 * Tests for UndoCoordinator - the undo/rewind business logic extracted from
 * useActivitySubscriptions.
 *
 * This is a destructive, user-facing path (undo rewrites files on disk), so the
 * tests pin down exactly what is applied, what is reported, and what state is
 * left behind on failure.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UndoCoordinator } from '../UndoCoordinator.js';
import type { UndoPatchManager, RewindableAgent } from '../UndoCoordinator.js';
import type { Message } from '../../types/index.js';
import type { UndoFileEntry, UndoPreview, UndoResult } from '../PatchManager.js';

vi.mock('../Logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function makeFileEntry(patchNumber: number, filePath: string): UndoFileEntry {
  return {
    patch_number: patchNumber,
    file_path: filePath,
    operation_type: 'edit',
    timestamp: new Date(patchNumber).toISOString(),
    stats: { additions: 1, deletions: 0 } as UndoFileEntry['stats'],
  };
}

function makePreview(patchNumber: number, filePath: string): UndoPreview {
  return {
    operation_type: 'edit',
    file_path: filePath,
    patch_number: patchNumber,
    timestamp: new Date(patchNumber).toISOString(),
    current_content: 'after',
    predicted_content: 'before',
  };
}

function makeResult(overrides: Partial<UndoResult> = {}): UndoResult {
  return {
    success: true,
    reverted_files: [],
    failed_operations: [],
    ...overrides,
  };
}

function makePatchManager(overrides: Partial<UndoPatchManager> = {}): UndoPatchManager {
  return {
    previewSinglePatch: vi.fn(async () => null),
    undoSinglePatch: vi.fn(async () => makeResult()),
    getRecentFileList: vi.fn(async () => []),
    getPatchesSinceTimestamp: vi.fn(async () => []),
    undoOperationsSinceTimestamp: vi.fn(async () => makeResult()),
    ...overrides,
  };
}

function userMessage(content: string, timestamp: number): Message {
  return { role: 'user', content, timestamp } as Message;
}

function makeAgent(messages: Message[]): RewindableAgent & { rewindToMessage: ReturnType<typeof vi.fn> } {
  const state = { messages };
  const agent = {
    getMessages: () => state.messages,
    rewindToMessage: vi.fn(async (index: number) => {
      const target = state.messages.filter((m) => m.role === 'user')[index];
      if (!target) throw new Error(`Invalid message index: ${index}`);
      const cutoff = state.messages.indexOf(target);
      state.messages = state.messages.slice(0, cutoff);
      return String(target.content);
    }),
  };
  return agent as RewindableAgent & { rewindToMessage: ReturnType<typeof vi.fn> };
}

function makeCoordinator(
  patchManager: UndoPatchManager | null,
  agent: RewindableAgent = makeAgent([]),
  extra: { todoManager?: unknown; tokenManager?: unknown } = {}
) {
  return new UndoCoordinator({
    getPatchManager: () => patchManager,
    getAgent: () => agent,
    getTodoManager: () => extra.todoManager as never,
    getTokenManager: () => extra.tokenManager as never,
  });
}

describe('UndoCoordinator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('previewPatch (file selected)', () => {
    it('returns the preview for the selected patch', async () => {
      const preview = makePreview(7, 'src/a.ts');
      const patchManager = makePatchManager({
        previewSinglePatch: vi.fn(async () => preview),
      });
      const coordinator = makeCoordinator(patchManager);

      const outcome = await coordinator.previewPatch(7, 'src/a.ts');

      expect(outcome).toEqual({ status: 'ok', patchNumber: 7, filePath: 'src/a.ts', preview });
      expect(patchManager.previewSinglePatch).toHaveBeenCalledWith(7);
    });

    it('reports a missing preview without throwing', async () => {
      const coordinator = makeCoordinator(makePatchManager());

      const outcome = await coordinator.previewPatch(3, 'src/b.ts');

      expect(outcome).toEqual({
        status: 'error',
        message: 'Error: Could not load preview for src/b.ts',
      });
    });

    it('reports preview failures', async () => {
      const coordinator = makeCoordinator(
        makePatchManager({
          previewSinglePatch: vi.fn(async () => {
            throw new Error('disk on fire');
          }),
        })
      );

      const outcome = await coordinator.previewPatch(3, 'src/b.ts');

      expect(outcome).toEqual({ status: 'error', message: 'Error loading preview: disk on fire' });
    });

    it('reports when the patch manager is unavailable', async () => {
      const coordinator = makeCoordinator(null);

      const outcome = await coordinator.previewPatch(3, 'src/b.ts');

      expect(outcome).toEqual({ status: 'error', message: 'Error: Patch manager not available' });
    });
  });

  describe('buildFileList', () => {
    it('returns the recent file list from the patch manager', async () => {
      const entries = [makeFileEntry(2, 'src/b.ts'), makeFileEntry(1, 'src/a.ts')];
      const patchManager = makePatchManager({ getRecentFileList: vi.fn(async () => entries) });
      const coordinator = makeCoordinator(patchManager);

      await expect(coordinator.buildFileList()).resolves.toEqual(entries);
      expect(patchManager.getRecentFileList).toHaveBeenCalledWith(10);
    });

    it('honours an explicit limit', async () => {
      const patchManager = makePatchManager();
      await makeCoordinator(patchManager).buildFileList(3);
      expect(patchManager.getRecentFileList).toHaveBeenCalledWith(3);
    });

    it('returns an empty list when no patch manager is registered', async () => {
      await expect(makeCoordinator(null).buildFileList()).resolves.toEqual([]);
    });
  });

  describe('request id round-trip', () => {
    it('builds and parses single-patch request ids', () => {
      const coordinator = makeCoordinator(null);
      const id = coordinator.buildUndoRequestId(12);
      expect(id).toBe('undo_single_12');
      expect(coordinator.parsePatchNumber(id)).toBe(12);
    });

    it('rejects ids without a patch number', () => {
      expect(makeCoordinator(null).parsePatchNumber('undo_single_oops')).toBeNull();
    });
  });

  describe('applyUndo', () => {
    it('applies the undo, reports the reverted files and refreshes the list', async () => {
      const entries = [makeFileEntry(1, 'src/a.ts')];
      const patchManager = makePatchManager({
        undoSinglePatch: vi.fn(async () =>
          makeResult({ reverted_files: ['src/a.ts', 'src/b.ts'] })
        ),
        getRecentFileList: vi.fn(async () => entries),
      });
      const coordinator = makeCoordinator(patchManager);

      const outcome = await coordinator.applyUndo('undo_single_5');

      expect(patchManager.undoSinglePatch).toHaveBeenCalledWith(5);
      expect(outcome.status).toBe('reverted');
      expect(outcome.closeUndoRequest).toBe(true);
      expect(outcome.messages).toEqual([
        'Successfully undid operation:\n  - src/a.ts\n  - src/b.ts',
      ]);
      expect(outcome.fileList).toEqual(entries);
    });

    it('signals an empty refreshed list so the UI can close the file list', async () => {
      const patchManager = makePatchManager({
        undoSinglePatch: vi.fn(async () => makeResult({ reverted_files: ['src/a.ts'] })),
      });

      const outcome = await makeCoordinator(patchManager).applyUndo('undo_single_1');

      expect(outcome.fileList).toEqual([]);
    });

    it('reports a patch manager failure result without closing the file list', async () => {
      const patchManager = makePatchManager({
        undoSinglePatch: vi.fn(async () =>
          makeResult({ success: false, failed_operations: ['bad hunk', 'missing file'] })
        ),
      });

      const outcome = await makeCoordinator(patchManager).applyUndo('undo_single_2');

      expect(outcome.status).toBe('failed');
      expect(outcome.closeUndoRequest).toBe(true);
      expect(outcome.messages).toEqual(['Undo failed:\n  - bad hunk\n  - missing file']);
      expect(outcome.fileList).toBeUndefined();
      expect(patchManager.getRecentFileList).not.toHaveBeenCalled();
    });

    it('tells the UI and leaves no partial state when undoSinglePatch rejects', async () => {
      const patchManager = makePatchManager({
        undoSinglePatch: vi.fn(async () => {
          throw new Error('patch file corrupted');
        }),
      });

      const outcome = await makeCoordinator(patchManager).applyUndo('undo_single_9');

      expect(outcome.status).toBe('error');
      expect(outcome.messages).toEqual(['Error during undo: patch file corrupted']);
      // The confirm modal must stay open and the file list untouched: nothing
      // was applied, so no part of the flow may advance.
      expect(outcome.closeUndoRequest).toBe(false);
      expect(outcome.fileList).toBeUndefined();
      expect(patchManager.getRecentFileList).not.toHaveBeenCalled();
    });

    it('still reports the success when only the list refresh fails', async () => {
      const patchManager = makePatchManager({
        undoSinglePatch: vi.fn(async () => makeResult({ reverted_files: ['src/a.ts'] })),
        getRecentFileList: vi.fn(async () => {
          throw new Error('index unreadable');
        }),
      });

      const outcome = await makeCoordinator(patchManager).applyUndo('undo_single_4');

      expect(outcome.messages).toEqual([
        'Successfully undid operation:\n  - src/a.ts',
        'Error during undo: index unreadable',
      ]);
      expect(outcome.closeUndoRequest).toBe(true);
      expect(outcome.fileList).toBeUndefined();
    });

    it('rejects a malformed request id before touching the patch manager', async () => {
      const patchManager = makePatchManager();

      const outcome = await makeCoordinator(patchManager).applyUndo('not_an_undo_request');

      expect(outcome.status).toBe('invalid-request');
      expect(outcome.closeUndoRequest).toBe(false);
      expect(outcome.messages).toEqual(['Error: Invalid patch number']);
      expect(patchManager.undoSinglePatch).not.toHaveBeenCalled();
    });

    it('reports a missing patch manager without closing the prompt', async () => {
      const outcome = await makeCoordinator(null).applyUndo('undo_single_1');

      expect(outcome.status).toBe('unavailable');
      expect(outcome.closeUndoRequest).toBe(false);
      expect(outcome.messages).toEqual(['Error: Patch manager not available']);
    });

    it('applies nothing when the user selects a file but cancels before confirming', async () => {
      // The cancelled path (UNDO_CANCELLED) only resets modal state and never
      // reaches the coordinator. This pins the invariant that browsing and
      // previewing are read-only: nothing is written until applyUndo is called.
      const patchManager = makePatchManager({
        getRecentFileList: vi.fn(async () => [makeFileEntry(1, 'src/a.ts')]),
        previewSinglePatch: vi.fn(async () => makePreview(1, 'src/a.ts')),
      });
      const coordinator = makeCoordinator(patchManager);

      await coordinator.buildFileList();
      const preview = await coordinator.previewPatch(1, 'src/a.ts');
      expect(preview.status).toBe('ok');

      // ...user cancels here.
      expect(patchManager.undoSinglePatch).not.toHaveBeenCalled();
      expect(patchManager.undoOperationsSinceTimestamp).not.toHaveBeenCalled();
    });
  });

  describe('checkRewindReadiness', () => {
    it('allows a rewind when idle', () => {
      const readiness = makeCoordinator(null).checkRewindReadiness(false, [
        { status: 'completed' },
        { status: 'error' },
      ]);
      expect(readiness).toEqual({ allowed: true });
    });

    it('blocks while the agent is thinking', () => {
      const readiness = makeCoordinator(null).checkRewindReadiness(true, []);
      expect(readiness.allowed).toBe(false);
      expect(readiness.message).toBe(
        'Cannot rewind while agent is processing. Please wait for current operation to complete.'
      );
    });

    it.each(['executing', 'pending', 'validating'])('blocks on a %s tool call', (status) => {
      const readiness = makeCoordinator(null).checkRewindReadiness(false, [{ status }]);
      expect(readiness.allowed).toBe(false);
    });
  });

  describe('resolveRewindSelection', () => {
    it('selects the most recent user message from the agent history', () => {
      const history = [
        userMessage('one', 1),
        { role: 'assistant', content: 'hi' } as Message,
        userMessage('two', 2),
      ];
      const agent = makeAgent(history);

      const selection = makeCoordinator(null, agent).resolveRewindSelection();

      expect(selection).toEqual({
        targets: [history[0], history[2]],
        selectedIndex: 1,
      });
    });

    it('returns null when there is nothing to rewind to', () => {
      expect(makeCoordinator(null, makeAgent([])).resolveRewindSelection()).toBeNull();
    });
  });

  // The selector hands back a position in the list it was shown. If the history
  // shifts in between, that position no longer means the same message - and a
  // wrong target reverts the user's files to the wrong point in time.
  describe('rewind target identity', () => {
    it('follows the selected message when earlier history is dropped', async () => {
      const agent = makeAgent([userMessage('one', 1), userMessage('two', 2), userMessage('three', 3)]);
      const coordinator = makeCoordinator(makePatchManager(), agent);

      // User is offered three messages and picks the last one.
      expect(coordinator.resolveRewindSelection()?.selectedIndex).toBe(2);

      // Compaction drops the oldest message before the rewind is confirmed.
      agent.getMessages = () => [userMessage('two', 2), userMessage('three', 3)];

      const outcome = await coordinator.performRewind(2);

      // Index 2 no longer exists; the target is found at its new position.
      expect(agent.rewindToMessage).toHaveBeenCalledWith(1);
      expect(outcome.targetTimestamp).toBe(3);
    });

    it('refuses to rewind when the selected message is gone', async () => {
      const agent = makeAgent([userMessage('one', 1), userMessage('two', 2)]);
      const coordinator = makeCoordinator(makePatchManager(), agent);

      coordinator.resolveRewindSelection();
      agent.getMessages = () => [userMessage('one', 1)];

      await expect(coordinator.performRewind(1)).rejects.toThrow(
        'no longer in the conversation history'
      );
      expect(agent.rewindToMessage).not.toHaveBeenCalled();
    });

    it('keeps duplicate prompts distinguishable', async () => {
      const agent = makeAgent([
        userMessage('continue', 1),
        userMessage('continue', 2),
        userMessage('continue', 3),
      ]);
      const coordinator = makeCoordinator(makePatchManager(), agent);

      coordinator.resolveRewindSelection();
      const outcome = await coordinator.performRewind(1);

      // The second "continue", not the first or third.
      expect(agent.rewindToMessage).toHaveBeenCalledWith(1);
      expect(outcome.targetTimestamp).toBe(2);
    });

    it('rejects a position that was never offered', async () => {
      const agent = makeAgent([userMessage('one', 1)]);
      const coordinator = makeCoordinator(makePatchManager(), agent);

      coordinator.resolveRewindSelection();

      await expect(coordinator.performRewind(4)).rejects.toThrow('Invalid rewind selection: 4');
    });

    it('bounds-checks against live history when no selection was presented', async () => {
      const agent = makeAgent([userMessage('one', 1)]);

      await expect(makeCoordinator(makePatchManager(), agent).performRewind(3)).rejects.toThrow(
        'Invalid message index: 3'
      );
    });

    it('falls back to live history after a cancelled selection', async () => {
      const agent = makeAgent([userMessage('one', 1), userMessage('two', 2)]);
      const coordinator = makeCoordinator(makePatchManager(), agent);

      coordinator.resolveRewindSelection();
      coordinator.cancelRewindSelection();

      // Without the stale targets, the position is read against live history.
      await coordinator.performRewind(0);
      expect(agent.rewindToMessage).toHaveBeenCalledWith(0);
    });

    it('does not reuse targets across two rewinds', async () => {
      const agent = makeAgent([userMessage('one', 1), userMessage('two', 2)]);
      const coordinator = makeCoordinator(makePatchManager(), agent);

      coordinator.resolveRewindSelection();
      await coordinator.performRewind(1);

      // The first rewind consumed the presented targets; a second rewind driven
      // straight from an event is bounds-checked, not resolved by identity.
      await expect(coordinator.performRewind(5)).rejects.toThrow('Invalid message index: 5');
    });
  });

  describe('performRewind', () => {
    it('restores files since the target timestamp and rewinds history', async () => {
      const messages = [
        userMessage('first', 100),
        { role: 'assistant', content: 'ok' } as Message,
        userMessage('second', 200),
        { role: 'assistant', content: 'done' } as Message,
      ];
      const agent = makeAgent([...messages]);
      const patchManager = makePatchManager({
        getPatchesSinceTimestamp: vi.fn(async () => [{ patch_number: 1 } as never]),
        undoOperationsSinceTimestamp: vi.fn(async () =>
          makeResult({ reverted_files: ['src/a.ts'] })
        ),
      });
      const coordinator = makeCoordinator(patchManager, agent);

      const outcome = await coordinator.performRewind(1);

      expect(patchManager.getPatchesSinceTimestamp).toHaveBeenCalledWith(200);
      expect(patchManager.undoOperationsSinceTimestamp).toHaveBeenCalledWith(200);
      expect(agent.rewindToMessage).toHaveBeenCalledWith(1);
      expect(outcome.targetTimestamp).toBe(200);
      expect(outcome.targetMessageContent).toBe('second');
      expect(outcome.restoredFiles).toEqual(['src/a.ts']);
      expect(outcome.failedRestorations).toEqual([]);
      expect(outcome.rewindedMessages.map((m) => m.content)).toEqual(['first', 'ok']);
    });

    it('skips file restoration when the user opted out', async () => {
      const agent = makeAgent([userMessage('first', 100), userMessage('second', 200)]);
      const patchManager = makePatchManager();

      const outcome = await makeCoordinator(patchManager, agent).performRewind(0, {
        restoreFiles: false,
      });

      expect(patchManager.getPatchesSinceTimestamp).not.toHaveBeenCalled();
      expect(patchManager.undoOperationsSinceTimestamp).not.toHaveBeenCalled();
      expect(outcome.restoredFiles).toEqual([]);
      expect(agent.rewindToMessage).toHaveBeenCalledWith(0);
    });

    it('reports partial restoration failures without aborting the rewind', async () => {
      const agent = makeAgent([userMessage('first', 100)]);
      const patchManager = makePatchManager({
        getPatchesSinceTimestamp: vi.fn(async () => [{ patch_number: 1 } as never]),
        undoOperationsSinceTimestamp: vi.fn(async () =>
          makeResult({
            success: false,
            reverted_files: ['src/a.ts'],
            failed_operations: ['src/b.ts'],
          })
        ),
      });

      const outcome = await makeCoordinator(patchManager, agent).performRewind(0);

      expect(outcome.restoredFiles).toEqual(['src/a.ts']);
      expect(outcome.failedRestorations).toEqual(['src/b.ts']);
      expect(agent.rewindToMessage).toHaveBeenCalled();
    });

    it('surfaces a restoration crash but still rewinds the conversation', async () => {
      const agent = makeAgent([userMessage('first', 100)]);
      const patchManager = makePatchManager({
        getPatchesSinceTimestamp: vi.fn(async () => {
          throw new Error('index gone');
        }),
      });

      const outcome = await makeCoordinator(patchManager, agent).performRewind(0);

      expect(outcome.failedRestorations).toEqual(['Patch restoration error: index gone']);
      expect(agent.rewindToMessage).toHaveBeenCalledWith(0);
    });

    it('propagates a history rewind failure to the caller', async () => {
      const agent = makeAgent([userMessage('first', 100)]);

      await expect(makeCoordinator(makePatchManager(), agent).performRewind(9)).rejects.toThrow(
        'Invalid message index: 9'
      );
    });
  });

  describe('post-rewind cleanup', () => {
    it('clears todos when a todo manager is registered', () => {
      const setTodos = vi.fn();
      makeCoordinator(null, makeAgent([]), { todoManager: { setTodos } }).clearTodos();
      expect(setTodos).toHaveBeenCalledWith([]);
    });

    it('is a no-op without a todo manager', () => {
      expect(() => makeCoordinator(null).clearTodos()).not.toThrow();
    });

    it('recomputes context usage from the rewound history', () => {
      const agent = makeAgent([userMessage('first', 100)]);
      const tokenManager = {
        updateTokenCount: vi.fn(),
        getContextUsagePercentage: vi.fn(() => 42),
      };

      const usage = makeCoordinator(null, agent, { tokenManager }).refreshContextUsage();

      expect(tokenManager.updateTokenCount).toHaveBeenCalledWith(agent.getMessages());
      expect(usage).toBe(42);
    });

    it('returns undefined without a token manager', () => {
      expect(makeCoordinator(null).refreshContextUsage()).toBeUndefined();
    });
  });
});
