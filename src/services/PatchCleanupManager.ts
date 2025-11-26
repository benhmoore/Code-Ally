/**
 * PatchCleanupManager - Clean up old patches based on policies
 *
 * This service handles automatic cleanup of patches based on various policies
 * including age, count limits, and size limits.
 */

import { logger } from './Logger.js';
import { PatchMetadata } from './PatchManager.js';
import { PatchFileManager } from './PatchFileManager.js';
import { PatchIndexManager } from './PatchIndexManager.js';
import { BUFFER_SIZES } from '../config/constants.js';

/**
 * PatchCleanupManager class
 * Handles cleanup of old patches based on various policies
 */
export class PatchCleanupManager {
  private fileManager: PatchFileManager;
  private indexManager: PatchIndexManager;
  private maxPatchesPerSession: number;
  private maxPatchesSizeBytes: number;

  /**
   * Create a new PatchCleanupManager
   *
   * @param fileManager - PatchFileManager instance for file operations
   * @param indexManager - PatchIndexManager instance for index operations
   * @param maxPatchesPerSession - Maximum number of patches to keep (default: 100)
   * @param maxPatchesSizeBytes - Maximum total size in bytes (default: 10MB)
   */
  constructor(
    fileManager: PatchFileManager,
    indexManager: PatchIndexManager,
    maxPatchesPerSession: number = BUFFER_SIZES.MAX_PATCHES_PER_SESSION,
    maxPatchesSizeBytes: number = BUFFER_SIZES.MAX_PATCHES_SIZE_BYTES
  ) {
    this.fileManager = fileManager;
    this.indexManager = indexManager;
    this.maxPatchesPerSession = maxPatchesPerSession;
    this.maxPatchesSizeBytes = maxPatchesSizeBytes;
  }

  /**
   * Clean up patches by count - remove oldest patches if over limit
   *
   * @returns Number of patches removed
   */
  async cleanupByCount(): Promise<number> {
    const patchCount = this.indexManager.getPatchCount();

    if (patchCount <= this.maxPatchesPerSession) {
      return 0;
    }

    const toRemove = patchCount - this.maxPatchesPerSession;
    const removedPatches = this.indexManager.removeOldestPatches(toRemove);

    // Delete patch files
    let deletedCount = 0;
    for (const patch of removedPatches) {
      const deleted = await this.fileManager.deletePatchFile(patch.patch_file);
      if (deleted) {
        deletedCount++;
      }
    }

    await this.indexManager.saveIndex();
    logger.info(`Cleaned up ${deletedCount} old patches (count limit)`);

    return deletedCount;
  }

  /**
   * Clean up patches by total directory size - remove oldest until under limit
   *
   * @returns Number of patches removed
   */
  async cleanupBySize(): Promise<number> {
    const patchesDir = this.fileManager.getPatchesDir();
    if (!patchesDir) {
      return 0;
    }

    try {
      let totalSize = await this.fileManager.calculateTotalSize();

      // If under limit, nothing to do
      if (totalSize <= this.maxPatchesSizeBytes) {
        return 0;
      }

      logger.info(`Patches directory size (${totalSize} bytes) exceeds limit (${this.maxPatchesSizeBytes} bytes)`);

      let removedCount = 0;
      const allPatches = this.indexManager.getAllPatches();

      // Remove oldest patches one by one until under limit
      for (const patch of allPatches) {
        if (totalSize <= this.maxPatchesSizeBytes) {
          break;
        }

        // Get file size before deleting
        const fileSize = await this.fileManager.getPatchFileSize(patch.patch_file);

        // Delete the patch file
        const deleted = await this.fileManager.deletePatchFile(patch.patch_file);
        if (deleted) {
          totalSize -= fileSize;
          this.indexManager.removePatch(patch.patch_number);
          removedCount++;
        }
      }

      if (removedCount > 0) {
        await this.indexManager.saveIndex();
        logger.info(`Cleaned up ${removedCount} old patches (size limit)`);
      }

      return removedCount;
    } catch (error) {
      logger.warn('Failed to cleanup patches by size:', error);
      return 0;
    }
  }

  /**
   * Clean up patches older than a specific age
   *
   * @param maxAgeMs - Maximum age in milliseconds
   * @returns Number of patches removed
   */
  async cleanupByAge(maxAgeMs: number): Promise<number> {
    const now = Date.now();
    const cutoffTime = now - maxAgeMs;
    const allPatches = this.indexManager.getAllPatches();

    const patchesToRemove: PatchMetadata[] = [];

    for (const patch of allPatches) {
      try {
        const patchTime = new Date(patch.timestamp).getTime();
        if (patchTime < cutoffTime) {
          patchesToRemove.push(patch);
        }
      } catch (error) {
        logger.warn(`Failed to parse timestamp for patch ${patch.patch_number}:`, error);
      }
    }

    if (patchesToRemove.length === 0) {
      return 0;
    }

    // Delete patch files
    let deletedCount = 0;
    const patchNumbersToRemove = new Set<number>();

    for (const patch of patchesToRemove) {
      const deleted = await this.fileManager.deletePatchFile(patch.patch_file);
      if (deleted) {
        patchNumbersToRemove.add(patch.patch_number);
        deletedCount++;
      }
    }

    // Remove from index
    if (deletedCount > 0) {
      this.indexManager.removePatches(patchNumbersToRemove);
      await this.indexManager.saveIndex();
      logger.info(`Cleaned up ${deletedCount} old patches (age limit)`);
    }

    return deletedCount;
  }

  /**
   * Clean up all patches (clear history)
   *
   * @returns Number of patches removed
   */
  async cleanupAll(): Promise<number> {
    const allPatches = this.indexManager.getAllPatches();
    let removedCount = 0;

    // Delete all patch files
    for (const patch of allPatches) {
      const deleted = await this.fileManager.deletePatchFile(patch.patch_file);
      if (deleted) {
        removedCount++;
      }
    }

    // Clear index
    this.indexManager.clearIndex();
    await this.indexManager.saveIndex();

    logger.info(`Cleared patch history: removed ${removedCount} patch files`);
    return removedCount;
  }

  /**
   * Run automatic cleanup based on configured policies
   * This checks both count and size limits
   *
   * @returns Total number of patches removed
   */
  async runAutomaticCleanup(): Promise<number> {
    try {
      let totalRemoved = 0;

      // First cleanup by count
      const countRemoved = await this.cleanupByCount();
      totalRemoved += countRemoved;

      // Then cleanup by size (if still needed)
      const sizeRemoved = await this.cleanupBySize();
      totalRemoved += sizeRemoved;

      if (totalRemoved > 0) {
        logger.info(`Automatic cleanup removed ${totalRemoved} patches total`);
      }

      return totalRemoved;
    } catch (error) {
      logger.warn('Failed to run automatic cleanup:', error);
      return 0;
    }
  }

  /**
   * Update cleanup configuration
   *
   * @param maxPatchesPerSession - New max patches per session
   * @param maxPatchesSizeBytes - New max size in bytes
   */
  updateConfig(maxPatchesPerSession?: number, maxPatchesSizeBytes?: number): void {
    if (maxPatchesPerSession !== undefined) {
      this.maxPatchesPerSession = maxPatchesPerSession;
    }
    if (maxPatchesSizeBytes !== undefined) {
      this.maxPatchesSizeBytes = maxPatchesSizeBytes;
    }
  }

  /**
   * Get current cleanup configuration
   *
   * @returns Cleanup configuration
   */
  getConfig(): { maxPatchesPerSession: number; maxPatchesSizeBytes: number } {
    return {
      maxPatchesPerSession: this.maxPatchesPerSession,
      maxPatchesSizeBytes: this.maxPatchesSizeBytes,
    };
  }
}
