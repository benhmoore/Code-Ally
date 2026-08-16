import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';

/**
 * The slice of FocusManager this scope needs. Narrow on purpose: the scope is a
 * lifecycle, not a focus implementation, and tests supply a plain object.
 */
export interface FocusTarget {
  getFocusDirectory(): string | null;
  setFocus(inputPath: string): Promise<{ success: boolean; message: string }>;
  clearFocus(): unknown;
  setExcludedFiles(filePaths: string[]): void;
  clearExcludedFiles(): void;
}

export interface FocusScopeOptions {
  /**
   * Resolved lazily on every acquire/release: the focus manager is a globally
   * registered service that may not exist yet (or at all) when the owner is
   * constructed.
   */
  resolveTarget: () => FocusTarget | null | undefined;
  /** Identifier for log lines (the owning agent's instance id). */
  label?: string;
}

/**
 * Acquire/release lifecycle for a scoped working-directory focus.
 *
 * Focus is process-global state borrowed for the lifetime of one agent: the
 * previous focus must come back exactly once, even when acquisition fails
 * halfway through. Two failure modes this guards against:
 *
 * 1. Partial acquire. Excluded files are registered before `setFocus` runs. If
 *    `setFocus` then fails or throws, the exclusions used to stay installed
 *    forever, because release keyed off "did we set focus" and bailed out.
 *    Acquire now rolls back everything it installed before rethrowing inward.
 * 2. Double release. `release()` is called from more than one path (explicit
 *    restore before pool release, then cleanup). Re-applying the saved focus a
 *    second time re-borrows state this scope no longer owns, so release is
 *    idempotent: the first one wins and the scope is empty afterwards.
 */
export class FocusScope {
  private readonly resolveTarget: () => FocusTarget | null | undefined;
  private readonly label: string;

  private previousFocus: string | null = null;
  private focusHeld = false;
  private exclusionsHeld = false;

  constructor(options: FocusScopeOptions) {
    this.resolveTarget = options.resolveTarget;
    this.label = options.label ?? '';
  }

  /** Whether this scope currently owns focus state that release() must undo. */
  isHeld(): boolean {
    return this.focusHeld || this.exclusionsHeld;
  }

  /** The focus directory captured at acquire time, or null. */
  getPreviousFocus(): string | null {
    return this.previousFocus;
  }

  /**
   * Borrow focus for `directory`, optionally installing file exclusions.
   * Never throws: focus is best-effort context narrowing, and an agent that
   * cannot narrow still runs.
   */
  async acquire(directory: string, excludeFiles?: string[]): Promise<void> {
    let installedExclusions = false;
    try {
      const target = this.resolveTarget();
      if (!target) {
        logger.debug('[AGENT_FOCUS]', this.label, 'FocusManager not available, skipping focus setup');
        return;
      }

      const previousFocus = target.getFocusDirectory();

      if (excludeFiles && excludeFiles.length > 0) {
        target.setExcludedFiles(excludeFiles);
        installedExclusions = true;
        logger.debug('[AGENT_FOCUS]', this.label, 'Excluded', excludeFiles.length, 'files from access');
      }

      const result = await target.setFocus(directory);

      if (result.success) {
        this.previousFocus = previousFocus;
        this.focusHeld = true;
        this.exclusionsHeld = installedExclusions;
        logger.debug('[AGENT_FOCUS]', this.label, 'Focus set to:', directory);
        return;
      }

      logger.warn('[AGENT_FOCUS]', this.label, 'Failed to set focus:', result.message);
      this.rollbackExclusions(target, installedExclusions);
    } catch (error) {
      logger.warn('[AGENT_FOCUS]', this.label, 'Error setting up focus:', error);
      try {
        this.rollbackExclusions(this.resolveTarget(), installedExclusions);
      } catch (rollbackError) {
        logger.warn('[AGENT_FOCUS]', this.label, 'Error rolling back exclusions:', formatError(rollbackError));
      }
    }
  }

  /**
   * Give the borrowed focus back. Idempotent and never throws; a no-op when
   * nothing was acquired.
   */
  async release(): Promise<void> {
    if (!this.isHeld()) {
      return; // Nothing to restore
    }

    const hadFocus = this.focusHeld;
    const hadExclusions = this.exclusionsHeld;
    const previousFocus = this.previousFocus;

    // Drop ownership up front so a failure mid-restore cannot leave this scope
    // claiming state it will try to restore again on the next release.
    this.reset();

    try {
      const target = this.resolveTarget();
      if (!target) {
        return;
      }

      if (hadExclusions) {
        target.clearExcludedFiles();
        logger.debug('[AGENT_FOCUS]', this.label, 'Cleared excluded files');
      }

      if (!hadFocus) {
        return;
      }

      if (previousFocus) {
        await target.setFocus(previousFocus);
        logger.debug('[AGENT_FOCUS]', this.label, 'Restored previous focus:', previousFocus);
      } else {
        target.clearFocus();
        logger.debug('[AGENT_FOCUS]', this.label, 'Cleared focus');
      }
    } catch (error) {
      logger.warn('[AGENT_FOCUS]', this.label, 'Error restoring focus:', error);
    }
  }

  /**
   * Forget any ownership without touching the focus manager.
   *
   * For pooled reuse, where the owner has already released (or is deliberately
   * abandoning) the scope and must not restore stale state into the next task.
   */
  reset(): void {
    this.previousFocus = null;
    this.focusHeld = false;
    this.exclusionsHeld = false;
  }

  private rollbackExclusions(target: FocusTarget | null | undefined, installed: boolean): void {
    if (!installed || !target) return;
    target.clearExcludedFiles();
    logger.debug('[AGENT_FOCUS]', this.label, 'Rolled back excluded files after failed focus setup');
  }
}
