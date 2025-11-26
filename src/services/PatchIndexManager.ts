/**
 * PatchIndexManager - Manages the patch index (patchIndex.json)
 *
 * This service handles all operations related to the patch index file,
 * including reading, writing, and updating patch metadata.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from './Logger.js';
import { PatchMetadata } from './PatchManager.js';
import { PatchValidator, PatchIndex } from './PatchValidator.js';

/**
 * PatchIndexManager class
 * Handles all operations on the patch index
 */
export class PatchIndexManager {
  private indexFilePath: string | null;
  private patchIndex: PatchIndex;
  private validator: PatchValidator;

  /**
   * Create a new PatchIndexManager
   *
   * @param indexFilePath - Path to patch index file (null if no active session)
   * @param validator - PatchValidator instance for validation
   */
  constructor(indexFilePath: string | null, validator: PatchValidator) {
    this.indexFilePath = indexFilePath;
    this.validator = validator;
    this.patchIndex = {
      next_patch_number: 1,
      patches: [],
    };
  }

  /**
   * Update the index file path (e.g., when session changes)
   *
   * @param indexFilePath - New index file path (null if no active session)
   */
  setIndexFilePath(indexFilePath: string | null): void {
    this.indexFilePath = indexFilePath;
  }

  /**
   * Get the current index file path
   *
   * @returns Index file path or null if no active session
   */
  getIndexFilePath(): string | null {
    return this.indexFilePath;
  }

  /**
   * Load patch index from disk
   */
  async loadIndex(): Promise<void> {
    if (!this.indexFilePath) {
      // No session active - reset to empty index
      this.patchIndex = {
        next_patch_number: 1,
        patches: [],
      };
      return;
    }

    try {
      const content = await fs.readFile(this.indexFilePath, 'utf-8');
      const loaded = JSON.parse(content);
      if (this.validator.validatePatchIndex(loaded)) {
        this.patchIndex = loaded;
        logger.debug(`Loaded ${loaded.patches.length} patches from index`);
      } else {
        logger.warn('Invalid patch index structure, resetting');
        this.patchIndex = {
          next_patch_number: 1,
          patches: [],
        };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Index doesn't exist yet - start fresh
        this.patchIndex = {
          next_patch_number: 1,
          patches: [],
        };
      } else {
        logger.error('Failed to load patch index:', error);
        this.patchIndex = {
          next_patch_number: 1,
          patches: [],
        };
      }
    }
  }

  /**
   * Save patch index to disk
   */
  async saveIndex(): Promise<void> {
    if (!this.indexFilePath) {
      return; // No session active
    }

    try {
      // Validate index structure before saving
      if (!this.validator.validatePatchIndex(this.patchIndex)) {
        throw new Error('Invalid patch index structure');
      }

      // Ensure directory exists
      const dir = path.dirname(this.indexFilePath);
      await fs.mkdir(dir, { recursive: true });

      await fs.writeFile(this.indexFilePath, JSON.stringify(this.patchIndex, null, 2), 'utf-8');
      logger.debug('Patch index saved');
    } catch (error) {
      logger.error('Failed to save patch index:', error);
      throw error;
    }
  }

  /**
   * Add a patch to the index
   *
   * @param patch - Patch metadata to add
   * @returns The patch number assigned
   */
  addPatch(patch: PatchMetadata): number {
    this.patchIndex.patches.push(patch);
    return patch.patch_number;
  }

  /**
   * Remove a patch from the index by patch number
   *
   * @param patchNumber - Patch number to remove
   * @returns True if removed, false if not found
   */
  removePatch(patchNumber: number): boolean {
    const initialLength = this.patchIndex.patches.length;
    this.patchIndex.patches = this.patchIndex.patches.filter(
      p => p.patch_number !== patchNumber
    );
    return this.patchIndex.patches.length < initialLength;
  }

  /**
   * Remove multiple patches from the index
   *
   * @param patchNumbers - Set of patch numbers to remove
   * @returns Number of patches removed
   */
  removePatches(patchNumbers: Set<number>): number {
    const initialLength = this.patchIndex.patches.length;
    this.patchIndex.patches = this.patchIndex.patches.filter(
      p => !patchNumbers.has(p.patch_number)
    );
    return initialLength - this.patchIndex.patches.length;
  }

  /**
   * Remove the last N patches from the index
   *
   * @param count - Number of patches to remove from the end
   * @returns Array of removed patches
   */
  removeLastPatches(count: number): PatchMetadata[] {
    const removed = this.patchIndex.patches.splice(-count);
    return removed;
  }

  /**
   * Remove the first N patches from the index (oldest)
   *
   * @param count - Number of patches to remove from the beginning
   * @returns Array of removed patches
   */
  removeOldestPatches(count: number): PatchMetadata[] {
    const removed = this.patchIndex.patches.splice(0, count);
    return removed;
  }

  /**
   * Update patch metadata in the index
   *
   * @param patchNumber - Patch number to update
   * @param updates - Partial patch metadata to update
   * @returns True if updated, false if not found
   */
  updatePatch(patchNumber: number, updates: Partial<PatchMetadata>): boolean {
    const patch = this.patchIndex.patches.find(p => p.patch_number === patchNumber);
    if (!patch) {
      return false;
    }
    Object.assign(patch, updates);
    return true;
  }

  /**
   * Get the current patch index
   *
   * @returns Current patch index
   */
  getIndex(): PatchIndex {
    return this.patchIndex;
  }

  /**
   * Get all patches in the index
   *
   * @returns Array of all patches
   */
  getAllPatches(): PatchMetadata[] {
    return [...this.patchIndex.patches];
  }

  /**
   * Get a specific patch by patch number
   *
   * @param patchNumber - Patch number to find
   * @returns Patch metadata or undefined if not found
   */
  getPatch(patchNumber: number): PatchMetadata | undefined {
    return this.patchIndex.patches.find(p => p.patch_number === patchNumber);
  }

  /**
   * Get the last N patches from the index
   *
   * @param count - Number of patches to get
   * @returns Array of last N patches
   */
  getLastPatches(count: number): PatchMetadata[] {
    return this.patchIndex.patches.slice(-count);
  }

  /**
   * Get patches created after a specific timestamp
   *
   * @param timestamp - Unix timestamp in milliseconds
   * @returns Array of patches in chronological order (oldest first)
   */
  getPatchesSinceTimestamp(timestamp: number): PatchMetadata[] {
    return this.patchIndex.patches.filter(patch => {
      try {
        const patchTime = new Date(patch.timestamp).getTime();
        return patchTime >= timestamp;
      } catch (error) {
        logger.warn(`Failed to parse timestamp for patch ${patch.patch_number}: ${patch.timestamp}`);
        return false;
      }
    });
  }

  /**
   * Get the next patch number
   *
   * @returns Next patch number
   */
  getNextPatchNumber(): number {
    return this.patchIndex.next_patch_number;
  }

  /**
   * Increment the next patch number
   *
   * @returns The new next patch number
   */
  incrementPatchNumber(): number {
    this.patchIndex.next_patch_number += 1;
    return this.patchIndex.next_patch_number;
  }

  /**
   * Get the total number of patches
   *
   * @returns Number of patches in the index
   */
  getPatchCount(): number {
    return this.patchIndex.patches.length;
  }

  /**
   * Clear all patches from the index and reset
   */
  clearIndex(): void {
    this.patchIndex = {
      next_patch_number: 1,
      patches: [],
    };
  }

  /**
   * Get operation counts by type
   *
   * @returns Record of operation types to counts
   */
  getOperationCounts(): Record<string, number> {
    const operationCounts: Record<string, number> = {};
    for (const patch of this.patchIndex.patches) {
      const op = patch.operation_type;
      operationCounts[op] = (operationCounts[op] || 0) + 1;
    }
    return operationCounts;
  }

  /**
   * Get patch history (most recent first)
   *
   * @param limit - Maximum number of patches to return
   * @returns Array of patch metadata
   */
  getPatchHistory(limit?: number): PatchMetadata[] {
    const patches = [...this.patchIndex.patches].reverse();
    if (limit !== undefined && limit > 0) {
      return patches.slice(0, limit);
    }
    return patches;
  }
}
