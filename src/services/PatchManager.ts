/**
 * PatchManager - Manages patch storage and undo operations
 *
 * This service provides patch-based undo functionality for file operations,
 * allowing users to revert changes made through write, edit, and line_edit tools.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from './Logger.js';
import { createUnifiedDiff, createPatchFileContent, extractDiffContent } from '../utils/diffUtils.js';
import { applyUnifiedDiff, simulatePatchApplication } from '../utils/patchApplier.js';
import { IService, ServiceLifecycle } from '../types/index.js';
import { resolvePath } from '../utils/pathUtils.js';

/**
 * Metadata for a single patch
 */
export interface PatchMetadata {
  patch_number: number;
  timestamp: string;
  operation_type: string;
  file_path: string;
  patch_file: string;
}

/**
 * Patch index structure
 */
interface PatchIndex {
  next_patch_number: number;
  patches: PatchMetadata[];
}

/**
 * Preview data for undo operation
 */
export interface UndoPreview {
  operation_type: string;
  file_path: string;
  patch_number: number;
  timestamp: string;
  current_content: string;
  predicted_content: string;
}

/**
 * Diff statistics for a file
 */
export interface DiffStats {
  additions: number;
  deletions: number;
  changes: number;
}

/**
 * File entry for undo file list
 */
export interface UndoFileEntry {
  patch_number: number;
  file_path: string;
  operation_type: string;
  timestamp: string;
  stats: DiffStats;
}

/**
 * Result of undo operation
 */
export interface UndoResult {
  success: boolean;
  reverted_files: string[];
  failed_operations: string[];
}

/**
 * Validate UndoResult structure
 */
function validateUndoResult(result: any): result is UndoResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    typeof result.success === 'boolean' &&
    Array.isArray(result.reverted_files) &&
    result.reverted_files.every((f: any) => typeof f === 'string') &&
    Array.isArray(result.failed_operations) &&
    result.failed_operations.every((f: any) => typeof f === 'string')
  );
}

/**
 * Validate PatchMetadata structure
 */
function validatePatchMetadata(metadata: any): metadata is PatchMetadata {
  return (
    typeof metadata === 'object' &&
    metadata !== null &&
    typeof metadata.patch_number === 'number' &&
    typeof metadata.timestamp === 'string' &&
    typeof metadata.operation_type === 'string' &&
    typeof metadata.file_path === 'string' &&
    typeof metadata.patch_file === 'string'
  );
}

/**
 * Validate PatchIndex structure
 */
function validatePatchIndex(index: any): index is PatchIndex {
  return (
    typeof index === 'object' &&
    index !== null &&
    typeof index.next_patch_number === 'number' &&
    Array.isArray(index.patches) &&
    index.patches.every(validatePatchMetadata)
  );
}

/**
 * PatchManager service
 */
export class PatchManager implements IService {
  private patchesDir: string;
  private indexFile: string;
  private patchIndex: PatchIndex;

  constructor(patchesDir?: string) {
    // Default to ~/.code-ally/patches/
    this.patchesDir = patchesDir || path.join(process.env.HOME || process.env.USERPROFILE || '.', '.code-ally', 'patches');
    this.indexFile = path.join(this.patchesDir, 'patch_index.json');
    this.patchIndex = {
      next_patch_number: 1,
      patches: [],
    };
  }

  /**
   * Initialize the patch manager
   */
  async initialize(): Promise<void> {
    await this.ensurePatchesDirectory();
    await this.clearPreviousSessionPatches();
    this.patchIndex = {
      next_patch_number: 1,
      patches: [],
    };
    await this.savePatchIndex();
    logger.info('PatchManager initialized');
  }

  /**
   * Cleanup the patch manager
   */
  async cleanup(): Promise<void> {
    // Nothing to clean up
    logger.info('PatchManager cleaned up');
  }

  /**
   * Service lifecycle type
   */
  static readonly lifecycle = ServiceLifecycle.SINGLETON;

  // ========== Filesystem Helpers ==========

  /**
   * Ensure patches directory exists
   */
  private async ensurePatchesDirectory(): Promise<void> {
    try {
      await fs.mkdir(this.patchesDir, { recursive: true });
      logger.debug(`Patches directory ensured at: ${this.patchesDir}`);
    } catch (error) {
      logger.error('Failed to create patches directory:', error);
      throw error;
    }
  }

  /**
   * Save patch index to disk
   */
  private async savePatchIndex(): Promise<void> {
    try {
      // Validate index structure before saving
      if (!validatePatchIndex(this.patchIndex)) {
        throw new Error('Invalid patch index structure');
      }

      await fs.writeFile(this.indexFile, JSON.stringify(this.patchIndex, null, 2), 'utf-8');
      logger.debug('Patch index saved');
    } catch (error) {
      logger.error('Failed to save patch index:', error);
      throw error;
    }
  }

  /**
   * Generate patch filename for a patch number
   */
  private generatePatchFilename(patchNumber: number): string {
    return path.join(this.patchesDir, `patch_${String(patchNumber).padStart(3, '0')}.diff`);
  }

  /**
   * Clear patches from previous session
   */
  private async clearPreviousSessionPatches(): Promise<void> {
    try {
      // Remove all patch files
      const files = await fs.readdir(this.patchesDir).catch(() => []);
      for (const file of files) {
        if (file.startsWith('patch_') && file.endsWith('.diff')) {
          await fs.unlink(path.join(this.patchesDir, file)).catch(() => {});
          logger.debug(`Cleared previous session patch: ${file}`);
        }
      }

      // Remove index file
      await fs.unlink(this.indexFile).catch(() => {});
      logger.debug('Cleared previous session patch index');
    } catch (error) {
      logger.warn('Failed to clear previous session patches:', error);
    }
  }

  // ========== Capture Operations ==========

  /**
   * Capture a file operation and create a patch
   *
   * @param operationType - Type of operation (write, edit, line_edit, delete)
   * @param filePath - Path to the file being modified
   * @param originalContent - Original content before modification
   * @param newContent - New content after modification (undefined for delete)
   * @returns Patch number if successful, null otherwise
   */
  async captureOperation(
    operationType: string,
    filePath: string,
    originalContent: string,
    newContent?: string
  ): Promise<number | null> {
    try {
      if (!filePath || typeof filePath !== 'string') {
        logger.error('Invalid file path provided for patch capture');
        return null;
      }

      const patchNumber = this.patchIndex.next_patch_number;
      const patchFile = this.generatePatchFilename(patchNumber);
      const timestamp = new Date().toISOString();

      // Resolve to absolute path
      const absFilePath = resolvePath(filePath);

      // Create unified diff
      let diffContent: string;
      if (operationType === 'delete') {
        diffContent = createUnifiedDiff(originalContent, '', filePath);
      } else {
        diffContent = createUnifiedDiff(originalContent, newContent || '', filePath);
      }

      // Create patch file content with metadata
      const patchContent = createPatchFileContent(
        operationType,
        absFilePath,
        timestamp,
        diffContent
      );

      // Write patch file
      await fs.writeFile(patchFile, patchContent, 'utf-8');

      // Add to index
      const patchEntry: PatchMetadata = {
        patch_number: patchNumber,
        timestamp,
        operation_type: operationType,
        file_path: absFilePath,
        patch_file: path.basename(patchFile),
      };

      this.patchIndex.patches.push(patchEntry);
      this.patchIndex.next_patch_number += 1;
      await this.savePatchIndex();

      logger.info(`Captured ${operationType} for ${filePath} as patch ${patchNumber}`);
      return patchNumber;
    } catch (error) {
      logger.error('Failed to capture operation:', error);
      return null;
    }
  }

  // ========== Undo Operations ==========

  /**
   * Undo the last N operations
   *
   * @param count - Number of operations to undo (default: 1)
   * @returns Result with success status and affected files
   */
  async undoOperations(count: number = 1): Promise<UndoResult> {
    if (this.patchIndex.patches.length === 0) {
      return {
        success: false,
        reverted_files: [],
        failed_operations: ['No operations to undo'],
      };
    }

    if (count <= 0) {
      return {
        success: false,
        reverted_files: [],
        failed_operations: ['Invalid undo count'],
      };
    }

    const patchesToUndo = this.patchIndex.patches.slice(-count);
    if (patchesToUndo.length < count) {
      logger.warn(`Only ${patchesToUndo.length} operations available to undo`);
    }

    const revertedFiles: string[] = [];
    const failedOperations: string[] = [];

    // Apply patches in reverse order
    for (let i = patchesToUndo.length - 1; i >= 0; i--) {
      const patchEntry = patchesToUndo[i]!;
      try {
        const success = await this.applyReversePatch(patchEntry);
        if (success) {
          revertedFiles.push(patchEntry.file_path);
          logger.info(`Reverted ${patchEntry.operation_type} on ${patchEntry.file_path}`);
        } else {
          const msg = `Failed to revert ${patchEntry.operation_type} on ${patchEntry.file_path}`;
          failedOperations.push(msg);
          logger.error(`${msg} (patch #${patchEntry.patch_number})`);
        }
      } catch (error) {
        const msg = `Error reverting ${patchEntry.file_path}: ${error instanceof Error ? error.message : 'Unknown error'}`;
        failedOperations.push(msg);
        logger.error(`Exception while reverting ${patchEntry.file_path} (patch #${patchEntry.patch_number}):`, error);
      }
    }

    // If all succeeded, remove patches from index and delete files
    if (failedOperations.length === 0) {
      this.patchIndex.patches = this.patchIndex.patches.slice(0, -patchesToUndo.length);
      await this.savePatchIndex();

      for (const patchEntry of patchesToUndo) {
        try {
          const patchFile = path.join(this.patchesDir, patchEntry.patch_file);
          await fs.unlink(patchFile).catch(() => {});
        } catch (error) {
          logger.warn(`Failed to delete patch file ${patchEntry.patch_file}:`, error);
        }
      }
    }

    const overallSuccess = revertedFiles.length > 0 && failedOperations.length === 0;
    const result: UndoResult = {
      success: overallSuccess,
      reverted_files: revertedFiles,
      failed_operations: failedOperations,
    };

    // Validate result structure before returning
    if (!validateUndoResult(result)) {
      logger.error('Generated invalid UndoResult structure');
      return {
        success: false,
        reverted_files: [],
        failed_operations: ['Internal error: invalid result structure'],
      };
    }

    return result;
  }

  /**
   * Apply a stored patch in reverse
   *
   * @param patchEntry - Patch metadata entry
   * @returns True if successful, false otherwise
   */
  private async applyReversePatch(patchEntry: PatchMetadata): Promise<boolean> {
    try {
      const patchFile = path.join(this.patchesDir, patchEntry.patch_file);

      // Check if patch file exists
      const patchExists = await fs.access(patchFile).then(() => true).catch(() => false);
      if (!patchExists) {
        logger.error(`Patch file not found: ${patchFile}`);
        return false;
      }

      // Read patch file
      const patchContent = await fs.readFile(patchFile, 'utf-8');

      // Extract diff content (strip metadata)
      const diffContent = extractDiffContent(patchContent);
      if (!diffContent) {
        logger.error('No diff content found in patch file');
        return false;
      }

      // Read current file content
      const filePath = patchEntry.file_path;
      const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
      let currentContent = '';

      if (fileExists) {
        currentContent = await fs.readFile(filePath, 'utf-8');
      }

      // Apply patch in reverse
      const result = applyUnifiedDiff(diffContent, currentContent, true);

      if (!result.success) {
        logger.error(`Patch application failed: ${result.error}`);
        return false;
      }

      // Write result back to file (or delete if result is empty and was a delete operation)
      if (result.content !== undefined && result.content !== '') {
        // Ensure directory exists
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });

        // Atomic write using temp file + rename
        const tempFile = `${filePath}.tmp.${Date.now()}`;
        await fs.writeFile(tempFile, result.content, 'utf-8');
        await fs.rename(tempFile, filePath);
        logger.info(`Applied reverse patch to ${filePath}`);
      } else if (fileExists) {
        // Delete file if reverse resulted in empty content
        await fs.unlink(filePath);
        logger.info(`Removed file ${filePath}`);
      }

      return true;
    } catch (error) {
      logger.error(`Failed to apply reverse patch for ${patchEntry.file_path}:`, error);
      return false;
    }
  }

  // ========== Preview & Stats ==========

  /**
   * Preview what would happen if we undo the last N operations
   *
   * @param count - Number of operations to preview
   * @returns Array of preview data or null if no operations to undo
   */
  async previewUndoOperations(count: number = 1): Promise<UndoPreview[] | null> {
    if (this.patchIndex.patches.length === 0) {
      return null;
    }

    const actualCount = Math.min(count, this.patchIndex.patches.length);
    if (actualCount <= 0) {
      return null;
    }

    const patchesToPreview = this.patchIndex.patches.slice(-actualCount);
    const previewData: UndoPreview[] = [];

    // Process in reverse order (same as undo)
    for (let i = patchesToPreview.length - 1; i >= 0; i--) {
      const patchEntry = patchesToPreview[i]!;
      try {
        const filePath = patchEntry.file_path;

        // Read current content
        let currentContent = '';
        const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
        if (fileExists) {
          try {
            currentContent = await fs.readFile(filePath, 'utf-8');
          } catch (error) {
            logger.warn(`Could not read ${filePath} for preview:`, error);
            continue;
          }
        }

        // Simulate undo
        const predictedContent = await this.simulateUndoResult(patchEntry, currentContent);
        if (predictedContent === null) {
          continue;
        }

        previewData.push({
          operation_type: patchEntry.operation_type,
          file_path: filePath,
          patch_number: patchEntry.patch_number,
          timestamp: patchEntry.timestamp,
          current_content: currentContent,
          predicted_content: predictedContent,
        });
      } catch (error) {
        logger.error(`Failed to generate preview for patch ${patchEntry.patch_number}:`, error);
        continue;
      }
    }

    return previewData.length > 0 ? previewData : null;
  }

  /**
   * Simulate undo result for a patch
   *
   * @param patchEntry - Patch metadata
   * @param currentContent - Current file content
   * @returns Predicted content after undo or null if simulation fails
   */
  private async simulateUndoResult(
    patchEntry: PatchMetadata,
    currentContent: string
  ): Promise<string | null> {
    try {
      const patchFile = path.join(this.patchesDir, patchEntry.patch_file);

      // Check if patch file exists
      const patchExists = await fs.access(patchFile).then(() => true).catch(() => false);
      if (!patchExists) {
        logger.error(`Patch file not found for simulation: ${patchFile}`);
        return null;
      }

      // Read patch file
      const patchContent = await fs.readFile(patchFile, 'utf-8');

      // Extract diff content
      const diffContent = extractDiffContent(patchContent);
      if (!diffContent) {
        logger.error(`extractDiffContent returned empty for patch ${patchEntry.patch_file}`);
        return null;
      }

      // Simulate reverse application
      const predicted = simulatePatchApplication(diffContent, currentContent, true);
      if (predicted === null) {
        logger.error(`simulatePatchApplication returned null for patch ${patchEntry.patch_file}`);
      }
      return predicted;
    } catch (error) {
      logger.error('Failed to simulate undo result:', error);
      return null;
    }
  }

  /**
   * Get patch history
   *
   * @param limit - Maximum number of patches to return (most recent first)
   * @returns Array of patch metadata
   */
  getPatchHistory(limit?: number): PatchMetadata[] {
    const patches = [...this.patchIndex.patches].reverse();
    if (limit !== undefined && limit > 0) {
      return patches.slice(0, limit);
    }
    return patches;
  }

  /**
   * Clear all patch history
   *
   * @returns Result with success status and message
   */
  async clearPatchHistory(): Promise<{ success: boolean; message: string }> {
    try {
      let removedCount = 0;

      // Remove all patch files
      for (const patchEntry of this.patchIndex.patches) {
        try {
          const patchFile = path.join(this.patchesDir, patchEntry.patch_file);
          await fs.unlink(patchFile);
          removedCount++;
        } catch (error) {
          logger.warn(`Failed to remove patch file ${patchEntry.patch_file}:`, error);
        }
      }

      // Reset index
      this.patchIndex = { next_patch_number: 1, patches: [] };
      await this.savePatchIndex();

      logger.info(`Cleared patch history: removed ${removedCount} patch files`);
      return {
        success: true,
        message: `Cleared ${removedCount} patches from history`,
      };
    } catch (error) {
      logger.error('Failed to clear patch history:', error);
      return {
        success: false,
        message: `Failed to clear patch history: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  /**
   * Get statistics about patches
   *
   * @returns Statistics object
   */
  async getStats(): Promise<{
    patches_directory: string;
    total_patches: number;
    operation_counts: Record<string, number>;
    total_size_bytes: number;
    next_patch_number: number;
  }> {
    const patchCount = this.patchIndex.patches.length;

    // Count operations by type
    const operationCounts: Record<string, number> = {};
    for (const patch of this.patchIndex.patches) {
      const op = patch.operation_type;
      operationCounts[op] = (operationCounts[op] || 0) + 1;
    }

    // Calculate total size
    let totalSize = 0;
    try {
      const files = await fs.readdir(this.patchesDir);
      for (const file of files) {
        if (file.startsWith('patch_') && file.endsWith('.diff')) {
          const filePath = path.join(this.patchesDir, file);
          const stats = await fs.stat(filePath);
          totalSize += stats.size;
        }
      }
    } catch (error) {
      logger.warn('Failed to calculate patch files size:', error);
    }

    return {
      patches_directory: this.patchesDir,
      total_patches: patchCount,
      operation_counts: operationCounts,
      total_size_bytes: totalSize,
      next_patch_number: this.patchIndex.next_patch_number,
    };
  }

  // ========== Two-Stage Undo Support ==========

  /**
   * Calculate diff statistics from a diff string
   *
   * @param diffContent - Unified diff content
   * @returns Diff statistics (additions, deletions, changes)
   */
  private calculateDiffStats(diffContent: string): DiffStats {
    const lines = diffContent.split('\n');
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
      }
    }

    return {
      additions,
      deletions,
      changes: additions + deletions,
    };
  }

  /**
   * Get list of recent file changes with diff stats
   *
   * @param limit - Maximum number of files to return (default 10)
   * @returns Array of file entries with stats
   */
  async getRecentFileList(limit: number = 10): Promise<UndoFileEntry[]> {
    if (this.patchIndex.patches.length === 0) {
      return [];
    }

    const recentPatches = this.patchIndex.patches.slice(-limit).reverse();
    const fileEntries: UndoFileEntry[] = [];

    for (const patchEntry of recentPatches) {
      try {
        const patchFile = path.join(this.patchesDir, patchEntry.patch_file);
        const patchContent = await fs.readFile(patchFile, 'utf-8');
        const diffContent = extractDiffContent(patchContent);

        const stats = this.calculateDiffStats(diffContent);

        fileEntries.push({
          patch_number: patchEntry.patch_number,
          file_path: patchEntry.file_path,
          operation_type: patchEntry.operation_type,
          timestamp: patchEntry.timestamp,
          stats,
        });
      } catch (error) {
        logger.warn(`Failed to read patch ${patchEntry.patch_number}:`, error);
        // Continue with other patches
      }
    }

    return fileEntries;
  }

  /**
   * Undo a single patch by patch number
   *
   * @param patchNumber - Patch number to undo
   * @returns Undo result
   */
  async undoSinglePatch(patchNumber: number): Promise<UndoResult> {
    // Find the patch in the index
    const patchIndex = this.patchIndex.patches.findIndex(
      p => p.patch_number === patchNumber
    );

    if (patchIndex === -1) {
      return {
        success: false,
        reverted_files: [],
        failed_operations: [`Patch ${patchNumber} not found`],
      };
    }

    const patchEntry = this.patchIndex.patches[patchIndex]!;

    try {
      const success = await this.applyReversePatch(patchEntry);

      if (success) {
        // Remove from index
        this.patchIndex.patches.splice(patchIndex, 1);
        await this.savePatchIndex();

        // Delete patch file
        const patchFile = path.join(this.patchesDir, patchEntry.patch_file);
        await fs.unlink(patchFile).catch(() => {});

        const result: UndoResult = {
          success: true,
          reverted_files: [patchEntry.file_path],
          failed_operations: [],
        };

        if (!validateUndoResult(result)) {
          logger.error('Generated invalid UndoResult structure');
          return {
            success: false,
            reverted_files: [],
            failed_operations: ['Internal error: invalid result structure'],
          };
        }

        return result;
      } else {
        return {
          success: false,
          reverted_files: [],
          failed_operations: [`Failed to revert ${patchEntry.file_path}`],
        };
      }
    } catch (error) {
      const msg = `Error reverting patch ${patchNumber}: ${
        error instanceof Error ? error.message : 'Unknown error'
      }`;
      logger.error(msg, error);
      return {
        success: false,
        reverted_files: [],
        failed_operations: [msg],
      };
    }
  }

  /**
   * Get preview for a single patch
   *
   * @param patchNumber - Patch number to preview
   * @returns Preview data or null if not found
   */
  async previewSinglePatch(patchNumber: number): Promise<UndoPreview | null> {
    const patchEntry = this.patchIndex.patches.find(
      p => p.patch_number === patchNumber
    );

    if (!patchEntry) {
      return null;
    }

    try {
      const filePath = patchEntry.file_path;
      const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
      let currentContent = '';

      if (fileExists) {
        currentContent = await fs.readFile(filePath, 'utf-8');
      }

      const predictedContent = await this.simulateUndoResult(patchEntry, currentContent);
      if (predictedContent === null) {
        return null;
      }

      return {
        operation_type: patchEntry.operation_type,
        file_path: patchEntry.file_path,
        patch_number: patchEntry.patch_number,
        timestamp: patchEntry.timestamp,
        current_content: currentContent,
        predicted_content: predictedContent,
      };
    } catch (error) {
      logger.error(`Failed to generate preview for patch ${patchNumber}:`, error);
      return null;
    }
  }
}
