/**
 * UndoCoordinator - Business logic for the undo and rewind flows
 *
 * Owns every decision and side effect behind the undo/rewind cluster that used
 * to live inline in `useActivitySubscriptions`:
 *   - previewing a single patch before the user confirms an undo
 *   - applying a single-patch undo and rebuilding the recent-file list
 *   - deciding whether a rewind is currently allowed
 *   - restoring files and rewinding conversation history
 *
 * The UI layer keeps only event plumbing: it hands the coordinator the request,
 * then pushes the returned outcome into React state. No patch manager access,
 * no history manipulation and no filesystem work happens in the hook.
 *
 * Collaborators are constructor-injected as suppliers so the coordinator can be
 * constructed before the underlying services exist (matching the previous
 * late-binding lookup semantics) without ever calling ServiceRegistry itself.
 */

import type { Message } from '../types/index.js';
import type {
  PatchMetadata,
  UndoFileEntry,
  UndoPreview,
  UndoResult,
} from './PatchManager.js';
import { logger } from './Logger.js';

/** Subset of PatchManager the undo/rewind flows depend on */
export interface UndoPatchManager {
  previewSinglePatch(patchNumber: number): Promise<UndoPreview | null>;
  undoSinglePatch(patchNumber: number): Promise<UndoResult>;
  getRecentFileList(limit?: number): Promise<UndoFileEntry[]>;
  getPatchesSinceTimestamp(timestamp: number): Promise<PatchMetadata[]>;
  undoOperationsSinceTimestamp(timestamp: number): Promise<UndoResult>;
}

/** Subset of Agent the rewind flow depends on */
export interface RewindableAgent {
  getMessages(): readonly Message[];
  rewindToMessage(userMessageIndex: number): Promise<string>;
}

/**
 * Subset of TodoManager used when clearing state after a rewind.
 * Declared with method syntax so concrete managers with narrower element types
 * (e.g. `TodoItem[]`) remain assignable.
 */
export interface TodoResettable {
  setTodos?(todos: unknown[]): void;
}

/** Subset of TokenManager used when recomputing context usage after a rewind */
export interface TokenRecomputable {
  updateTokenCount?(messages: readonly Message[]): void;
  getContextUsagePercentage?(): number;
}

export interface UndoCoordinatorDeps {
  getPatchManager: () => UndoPatchManager | null | undefined;
  getAgent: () => RewindableAgent;
  getTodoManager?: () => TodoResettable | null | undefined;
  getTokenManager?: () => TokenRecomputable | null | undefined;
}

/** Result of previewing a patch selected from the undo file list */
export type UndoPreviewOutcome =
  | { status: 'ok'; patchNumber: number; filePath: string; preview: UndoPreview }
  | { status: 'error'; message: string };

/**
 * Result of applying a single-patch undo.
 *
 * `closeUndoRequest` mirrors the original inline behavior exactly: the confirm
 * modal is only dismissed once `undoSinglePatch` has actually settled. If the
 * request is malformed, the patch manager is missing, or the undo call itself
 * rejects, the modal is deliberately left open.
 *
 * `fileList` is `undefined` when the recent-file list must be left untouched,
 * an empty array when it must be closed, and a populated array when it must be
 * reopened with fresh entries.
 */
export interface UndoApplyOutcome {
  status: 'invalid-request' | 'unavailable' | 'reverted' | 'failed' | 'error';
  closeUndoRequest: boolean;
  /** Assistant messages to surface, in order */
  messages: string[];
  fileList?: UndoFileEntry[];
}

/** Whether a rewind may start right now */
export interface RewindReadiness {
  allowed: boolean;
  message?: string;
}

/** Initial selection state for the rewind selector */
export interface RewindSelection {
  userMessagesCount: number;
  selectedIndex: number;
}

/**
 * Stable identity for one rewind target.
 *
 * Agent-side user messages do not reliably carry an `id` (see
 * `Agent.sendMessage`, which builds them from role/content/timestamp only), so
 * the identity falls back to `timestamp::content` and is disambiguated by
 * occurrence so two identical messages never collapse onto each other.
 */
type RewindTargetId = string;

/** Options carried by REWIND_RESPONSE */
export interface RewindOptions {
  restoreFiles?: boolean;
}

/** Everything the UI needs to repaint itself after a successful rewind */
export interface RewindOutcome {
  targetTimestamp?: number;
  targetMessageContent: string;
  rewindedMessages: Message[];
  restoredFiles: string[];
  failedRestorations: string[];
}

/** Tool call statuses that block a rewind */
const BLOCKING_TOOL_STATUSES = new Set(['executing', 'pending', 'validating']);

const REWIND_BUSY_MESSAGE =
  'Cannot rewind while agent is processing. Please wait for current operation to complete.';
const NO_USER_MESSAGES_MESSAGE = 'No user messages to rewind to.';
const NO_PATCH_MANAGER_MESSAGE = 'Error: Patch manager not available';

const UNDO_SINGLE_REQUEST_PREFIX = 'undo_single_';

const STALE_REWIND_TARGET_MESSAGE =
  'The message selected for rewind is no longer in the conversation history ' +
  '(it may have been compacted or cleared). Rewind cancelled.';

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

function contentKey(content: Message['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * Build a stable identity per user message, disambiguated by occurrence so
 * duplicate prompts ("continue" twice) stay distinguishable.
 */
function identifyTargets(userMessages: ReadonlyArray<Message>): RewindTargetId[] {
  const seen = new Map<string, number>();
  return userMessages.map((message) => {
    const base =
      message.id ?? `${message.timestamp ?? 'no-timestamp'}::${contentKey(message.content)}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return `${base}#${occurrence}`;
  });
}

export class UndoCoordinator {
  /**
   * Identities of the rewind targets presented to the user, captured when the
   * selector was opened. The selector hands back a position in *this* list, so
   * the position is translated back through the identity at the moment of the
   * rewind rather than being trusted as an index into whatever the history
   * happens to look like by then.
   */
  private pendingRewindTargets: RewindTargetId[] | null = null;

  constructor(private readonly deps: UndoCoordinatorDeps) {}

  // ---------------------------------------------------------------- undo ---

  /**
   * Load the preview for a patch the user picked from the undo file list.
   */
  async previewPatch(patchNumber: number, filePath: string): Promise<UndoPreviewOutcome> {
    const patchManager = this.deps.getPatchManager();
    if (!patchManager) {
      return { status: 'error', message: NO_PATCH_MANAGER_MESSAGE };
    }

    try {
      const preview = await patchManager.previewSinglePatch(patchNumber);
      if (!preview) {
        return { status: 'error', message: `Error: Could not load preview for ${filePath}` };
      }
      return { status: 'ok', patchNumber, filePath, preview };
    } catch (error) {
      return { status: 'error', message: `Error loading preview: ${describeError(error)}` };
    }
  }

  /**
   * Build the list of currently undoable file changes, most recent first.
   */
  async buildFileList(limit: number = 10): Promise<UndoFileEntry[]> {
    const patchManager = this.deps.getPatchManager();
    if (!patchManager) return [];
    return patchManager.getRecentFileList(limit);
  }

  /**
   * Extract the patch number encoded in an undo request id.
   * Returns null when the id does not carry a usable patch number.
   */
  parsePatchNumber(requestId: string): number | null {
    const patchNumber = parseInt(requestId.replace(UNDO_SINGLE_REQUEST_PREFIX, ''));
    return Number.isNaN(patchNumber) ? null : patchNumber;
  }

  /** Build the request id for a single-patch undo confirmation. */
  buildUndoRequestId(patchNumber: number): string {
    return `${UNDO_SINGLE_REQUEST_PREFIX}${patchNumber}`;
  }

  /**
   * Apply the undo the user confirmed, then rebuild the recent-file list.
   *
   * This is the destructive path: it rewrites files on disk via the patch
   * manager. Failures are reported to the UI and never leave the confirm modal
   * closed on a half-applied undo.
   */
  async applyUndo(requestId: string): Promise<UndoApplyOutcome> {
    const patchNumber = this.parsePatchNumber(requestId);
    if (patchNumber === null) {
      return {
        status: 'invalid-request',
        closeUndoRequest: false,
        messages: ['Error: Invalid patch number'],
      };
    }

    const patchManager = this.deps.getPatchManager();
    if (!patchManager) {
      return {
        status: 'unavailable',
        closeUndoRequest: false,
        messages: [NO_PATCH_MANAGER_MESSAGE],
      };
    }

    let result: UndoResult;
    try {
      result = await patchManager.undoSinglePatch(patchNumber);
    } catch (error) {
      // The undo never settled: leave the confirm modal exactly as it was.
      return {
        status: 'error',
        closeUndoRequest: false,
        messages: [`Error during undo: ${describeError(error)}`],
      };
    }

    if (!result.success) {
      const errors = result.failed_operations.join('\n  - ');
      return {
        status: 'failed',
        closeUndoRequest: true,
        messages: [`Undo failed:\n  - ${errors}`],
      };
    }

    const revertedList = result.reverted_files.map((file) => `  - ${file}`).join('\n');
    const successMessage = `Successfully undid operation:\n${revertedList}`;

    try {
      const fileList = await this.buildFileList(10);
      return {
        status: 'reverted',
        closeUndoRequest: true,
        messages: [successMessage],
        fileList,
      };
    } catch (error) {
      // The undo itself succeeded; only the refreshed list is unavailable, so
      // the existing list is left untouched and the error surfaces after the
      // success notice.
      return {
        status: 'error',
        closeUndoRequest: true,
        messages: [successMessage, `Error during undo: ${describeError(error)}`],
      };
    }
  }

  // -------------------------------------------------------------- rewind ---

  /**
   * A rewind may not start while the agent is mid-turn or tools are in flight.
   */
  checkRewindReadiness(
    isThinking: boolean,
    toolCalls: ReadonlyArray<{ status: string }>
  ): RewindReadiness {
    const runningToolCalls = toolCalls.filter((tc) => BLOCKING_TOOL_STATUSES.has(tc.status));
    if (isThinking || runningToolCalls.length > 0) {
      return { allowed: false, message: REWIND_BUSY_MESSAGE };
    }
    return { allowed: true };
  }

  /**
   * Resolve the initial rewind selector position.
   *
   * The agent's conversation history is the single source of truth here: it is
   * the array the rewind actually truncates, and the array whose timestamps
   * drive file restoration. Deriving the selector from the React transcript
   * instead lets the two disagree (slash commands and tool-routed interjections
   * add UI-only user messages; compaction and ephemeral cleanup drop agent-side
   * messages), and a mismatch means rewinding to the wrong message and
   * restoring files to the wrong timestamp.
   *
   * Returns null when there is nothing to rewind to.
   */
  resolveRewindSelection(): RewindSelection | null {
    const userMessages = this.deps.getAgent().getMessages().filter((m) => m.role === 'user');
    if (userMessages.length === 0) {
      this.pendingRewindTargets = null;
      return null;
    }
    this.pendingRewindTargets = identifyTargets(userMessages);
    return {
      userMessagesCount: userMessages.length,
      selectedIndex: Math.max(0, userMessages.length - 1),
    };
  }

  /** Forget the presented targets (rewind cancelled or superseded). */
  cancelRewindSelection(): void {
    this.pendingRewindTargets = null;
  }

  /** Message shown when a rewind is requested with no user messages present. */
  get noUserMessagesMessage(): string {
    return NO_USER_MESSAGES_MESSAGE;
  }

  /**
   * Restore files (when requested) and rewind conversation history.
   *
   * File restoration failures are logged and reported but never abort the
   * rewind — matching the previous behavior. A failure of the history rewind
   * itself propagates to the caller.
   */
  async performRewind(selectedIndex: number, options?: RewindOptions): Promise<RewindOutcome> {
    const agent = this.deps.getAgent();

    // Read the target BEFORE rewinding, since rewinding truncates. The index is
    // resolved against the same array the selector was built from, via the
    // target's stable identity, so a history that shifted in between is
    // rejected instead of silently truncating at the wrong point.
    const userMessages = agent.getMessages().filter((m) => m.role === 'user');
    const targetIndex = this.resolveTargetIndex(selectedIndex, userMessages);
    this.pendingRewindTargets = null;

    const targetMessage = userMessages[targetIndex];
    const targetTimestamp = targetMessage?.timestamp;

    let restoredFiles: string[] = [];
    let failedRestorations: string[] = [];

    // Default to true for backwards compatibility with older events.
    const shouldRestoreFiles = options?.restoreFiles ?? true;

    if (shouldRestoreFiles && targetTimestamp !== undefined) {
      const patchManager = this.deps.getPatchManager();
      if (patchManager) {
        try {
          const patchesToUndo = await patchManager.getPatchesSinceTimestamp(targetTimestamp);

          if (patchesToUndo.length > 0) {
            logger.info(`Restoring ${patchesToUndo.length} file changes during rewind`);

            const undoResult = await patchManager.undoOperationsSinceTimestamp(targetTimestamp);

            if (undoResult.success) {
              restoredFiles = undoResult.reverted_files;
              logger.info(`Successfully restored ${restoredFiles.length} files`);
            } else {
              restoredFiles = undoResult.reverted_files;
              failedRestorations = undoResult.failed_operations;
              logger.warn(
                `Partial file restoration: ${restoredFiles.length} succeeded, ${failedRestorations.length} failed`
              );
            }
          } else {
            logger.debug('No file changes to restore');
          }
        } catch (error) {
          // Log but don't fail the entire rewind if patch restoration fails
          logger.error('Error restoring file changes during rewind:', error);
          failedRestorations = [`Patch restoration error: ${describeError(error)}`];
        }
      }
    } else if (!shouldRestoreFiles) {
      logger.info('File restoration skipped (user opted out)');
    } else {
      logger.debug('Target message has no timestamp, skipping file restoration');
    }

    const targetMessageContent = await agent.rewindToMessage(targetIndex);
    const rewindedMessages = agent.getMessages().filter((m) => m.role !== 'system');

    return {
      targetTimestamp,
      targetMessageContent,
      rewindedMessages,
      restoredFiles,
      failedRestorations,
    };
  }

  /**
   * Translate the selector position back into a position in the agent's
   * current history.
   *
   * With a presented selection in hand the position is resolved by identity, so
   * the rewind lands on the message the user actually looked at even if the
   * history shifted underneath. Without one (a rewind driven straight from an
   * event), the position is bounds-checked against the live history.
   *
   * @throws when the position is out of range or its target has since vanished.
   */
  private resolveTargetIndex(
    selectedIndex: number,
    userMessages: ReadonlyArray<Message>
  ): number {
    const pending = this.pendingRewindTargets;

    if (pending) {
      const targetId = pending[selectedIndex];
      if (targetId === undefined) {
        this.pendingRewindTargets = null;
        throw new Error(
          `Invalid rewind selection: ${selectedIndex}. ` +
            `Only ${pending.length} message(s) were offered.`
        );
      }

      const currentIndex = identifyTargets(userMessages).indexOf(targetId);
      if (currentIndex === -1) {
        this.pendingRewindTargets = null;
        throw new Error(STALE_REWIND_TARGET_MESSAGE);
      }
      return currentIndex;
    }

    if (
      !Number.isInteger(selectedIndex) ||
      selectedIndex < 0 ||
      selectedIndex >= userMessages.length
    ) {
      throw new Error(
        `Invalid message index: ${selectedIndex}. ` +
          `Must be between 0 and ${userMessages.length - 1}`
      );
    }
    return selectedIndex;
  }

  /** Drop any todos carried over from the rewound portion of the session. */
  clearTodos(): void {
    const todoManager = this.deps.getTodoManager?.();
    if (todoManager && typeof todoManager.setTodos === 'function') {
      todoManager.setTodos([]);
    }
  }

  /**
   * Recompute context usage from the agent's current history.
   * Returns undefined when no token manager is available.
   */
  refreshContextUsage(): number | undefined {
    const tokenManager = this.deps.getTokenManager?.();
    if (
      !tokenManager ||
      typeof tokenManager.updateTokenCount !== 'function' ||
      typeof tokenManager.getContextUsagePercentage !== 'function'
    ) {
      return undefined;
    }
    tokenManager.updateTokenCount(this.deps.getAgent().getMessages());
    return tokenManager.getContextUsagePercentage();
  }
}
