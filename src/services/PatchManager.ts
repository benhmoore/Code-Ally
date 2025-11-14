/**
 * PatchManager - Manages patch storage and undo operations
 *
 * This service provides patch-based undo functionality for file operations,
 * allowing users to revert changes made through write, edit, and line-edit tools.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from './Logger.js';
import { createUnifiedDiff, createPatchFileContent, extractDiffContent, calculateDiffStats, DiffStats } from '../utils/diffUtils.js';
import { applyUnifiedDiff, simulatePatchApplication } from '../utils/patchApplier.js';
import { IService, ServiceLifecycle } from '../types/index.js';
import { resolvePath } from '../utils/pathUtils.js';
import { PatchValidator } from './PatchValidator.js';
import { PatchFileManager } from './PatchFileManager.js';
import { PatchIndexManager } from './PatchIndexManager.js';
import { PatchCleanupManager } from './PatchCleanupManager.js';
import { BUFFER_SIZES } from '../config/constants.js';

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
 * Configuration for PatchManager
 */
export interface PatchManagerConfig {
  /** Function to get current session ID */
  getSessionId: () => string | null;
  /** Maximum number of patches to keep per session (default: 100) */
  maxPatchesPerSession?: number;
  /** Maximum total size of patches directory per session in bytes (default: 10MB) */
  maxPatchesSizeBytes?: number;
}

/**
 * PatchManager service
 */
export class PatchManager implements IService {
  private getSessionId: () => string | null;
  private sessionsDir: string;
  private validator: PatchValidator;
  private fileManager: PatchFileManager;
  private indexManager: PatchIndexManager;
  private cleanupManager: PatchCleanupManager;

  constructor(config: PatchManagerConfig) {
    this.getSessionId = config.getSessionId;
    this.sessionsDir = path.join(process.cwd(), '.ally-sessions');

    // Initialize managers
    this.validator = new PatchValidator();

    const patchesDir = this.getPatchesDir();
    const indexFile = this.getIndexFile();

    this.fileManager = new PatchFileManager(patchesDir);
    this.indexManager = new PatchIndexManager(indexFile, this.validator);
    this.cleanupManager = new PatchCleanupManager(
      this.fileManager,
      this.indexManager,
      config.maxPatchesPerSession ?? BUFFER_SIZES.MAX_PATCHES_PER_SESSION,
      config.maxPatchesSizeBytes ?? BUFFER_SIZES.MAX_PATCHES_SIZE_BYTES
    );
  }

  /**
   * Get the patches directory for the current session
   */
  private getPatchesDir(): string | null {
    const sessionId = this.getSessionId();
    if (!sessionId) {
      return null;
    }
    return path.join(this.sessionsDir, sessionId, 'patches');
  }

  /**
   * Get the index file path for the current session
   */
  private getIndexFile(): string | null {
    const patchesDir = this.getPatchesDir();
    if (!patchesDir) {
      return null;
    }
    return path.join(patchesDir, 'patch_index.json');
  }

  /**
   * Initialize the patch manager
   */
  async initialize(): Promise<void> {
    // Load existing patches if we have a session
    await this.indexManager.loadIndex();
    logger.debug('PatchManager initialized');
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


  // ========== Capture Operations ==========

  /**
   * Capture a file operation and create a patch
   *
   * @param operationType - Type of operation (write, edit, line-edit, delete)
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
      // Check if we have an active session
      if (!this.getSessionId()) {
        logger.debug('No active session - skipping patch capture');
        return null;
      }

      if (!filePath || typeof filePath !== 'string') {
        logger.error('Invalid file path provided for patch capture');
        return null;
      }

      // Ensure patches directory exists
      await this.fileManager.ensurePatchesDirectory();

      const patchNumber = this.indexManager.getNextPatchNumber();
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
      const patchFile = await this.fileManager.writePatchFile(patchNumber, patchContent);
      if (!patchFile) {
        logger.error('Failed to write patch file');
        return null;
      }

      // Add to index
      const patchEntry: PatchMetadata = {
        patch_number: patchNumber,
        timestamp,
        operation_type: operationType,
        file_path: absFilePath,
        patch_file: path.basename(patchFile),
      };

      this.indexManager.addPatch(patchEntry);
      this.indexManager.incrementPatchNumber();
      await this.indexManager.saveIndex();

      // Run cleanup to enforce limits
      await this.cleanupManager.runAutomaticCleanup();

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
    if (this.indexManager.getPatchCount() === 0) {
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

    const patchesToUndo = this.indexManager.getLastPatches(count);
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
      this.indexManager.removeLastPatches(patchesToUndo.length);
      await this.indexManager.saveIndex();

      for (const patchEntry of patchesToUndo) {
        await this.fileManager.deletePatchFile(patchEntry.patch_file);
      }
    }

    const overallSuccess = revertedFiles.length > 0 && failedOperations.length === 0;
    const result: UndoResult = {
      success: overallSuccess,
      reverted_files: revertedFiles,
      failed_operations: failedOperations,
    };

    // Validate result structure before returning
    if (!this.validator.validateUndoResult(result)) {
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
      // Check if patch file exists
      const patchExists = await this.fileManager.patchExists(patchEntry.patch_file);
      if (!patchExists) {
        logger.error(`Patch file not found: ${patchEntry.patch_file}`);
        return false;
      }

      // Read patch file
      const patchContent = await this.fileManager.readPatchFile(patchEntry.patch_file);
      if (!patchContent) {
        logger.error(`Failed to read patch file: ${patchEntry.patch_file}`);
        return false;
      }

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
    if (this.indexManager.getPatchCount() === 0) {
      return null;
    }

    const actualCount = Math.min(count, this.indexManager.getPatchCount());
    if (actualCount <= 0) {
      return null;
    }

    const patchesToPreview = this.indexManager.getLastPatches(actualCount);
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

  // ========== Timestamp-Based Operations ==========

  /**
   * Get all patches created after a specific timestamp
   *
   * @param timestamp - Unix timestamp in milliseconds
   * @returns Array of patches in chronological order (oldest first), empty array if none found
   */
  async getPatchesSinceTimestamp(timestamp: number): Promise<PatchMetadata[]> {
    // Validate timestamp parameter
    if (typeof timestamp !== 'number' || isNaN(timestamp) || timestamp < 0) {
      logger.warn(`Invalid timestamp provided: ${timestamp}`);
      return [];
    }

    // Check if we have an active session
    if (!this.getSessionId()) {
      logger.debug('No active session - returning empty patch list');
      return [];
    }

    // No patches available
    if (this.indexManager.getPatchCount() === 0) {
      return [];
    }

    try {
      const filteredPatches = this.indexManager.getPatchesSinceTimestamp(timestamp);
      logger.debug(`Found ${filteredPatches.length} patches since timestamp ${timestamp}`);
      return filteredPatches;
    } catch (error) {
      logger.error('Failed to get patches since timestamp:', error);
      return [];
    }
  }

  /**
   * Undo all operations since a specific timestamp
   *
   * This method undoes the specific patches that were created after the given timestamp,
   * not just the last N patches. This ensures correct behavior even if patches are added
   * concurrently or if the patch order doesn't perfectly match timestamp order.
   *
   * @param timestamp - Unix timestamp in milliseconds
   * @returns Result with success status and affected files
   */
  async undoOperationsSinceTimestamp(timestamp: number): Promise<UndoResult> {
    // Validate timestamp parameter
    if (typeof timestamp !== 'number' || isNaN(timestamp) || timestamp < 0) {
      return {
        success: false,
        reverted_files: [],
        failed_operations: ['Invalid timestamp: must be a non-negative number'],
      };
    }

    try {
      // Get the specific patches to undo based on timestamp
      const patchesToUndo = await this.getPatchesSinceTimestamp(timestamp);

      if (patchesToUndo.length === 0) {
        return {
          success: false,
          reverted_files: [],
          failed_operations: ['No operations found since the specified timestamp'],
        };
      }

      logger.info(`Undoing ${patchesToUndo.length} operations since timestamp ${timestamp}`);

      const revertedFiles: string[] = [];
      const failedOperations: string[] = [];

      // Apply patches in reverse order (newest first)
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

      // If all succeeded, remove the specific patches from index and delete files
      if (failedOperations.length === 0) {
        const patchNumbersToRemove = new Set(patchesToUndo.map(p => p.patch_number));
        this.indexManager.removePatches(patchNumbersToRemove);
        await this.indexManager.saveIndex();

        for (const patchEntry of patchesToUndo) {
          await this.fileManager.deletePatchFile(patchEntry.patch_file);
        }
      }

      const overallSuccess = revertedFiles.length > 0 && failedOperations.length === 0;
      const result: UndoResult = {
        success: overallSuccess,
        reverted_files: revertedFiles,
        failed_operations: failedOperations,
      };

      // Validate result structure before returning
      if (!this.validator.validateUndoResult(result)) {
        logger.error('Generated invalid UndoResult structure');
        return {
          success: false,
          reverted_files: [],
          failed_operations: ['Internal error: invalid result structure'],
        };
      }

      return result;
    } catch (error) {
      logger.error('Failed to undo operations since timestamp:', error);
      return {
        success: false,
        reverted_files: [],
        failed_operations: [`Error: ${error instanceof Error ? error.message : 'Unknown error'}`],
      };
    }
  }

  /**
   * Preview what would be undone if we undo all operations since a specific timestamp
   *
   * This method generates preview data for the specific patches that were created after
   * the given timestamp, showing what files would be restored without actually applying changes.
   *
   * @param timestamp - Unix timestamp in milliseconds
   * @returns Array of preview data showing what would be undone, or null if no operations
   */
  async previewUndoSinceTimestamp(timestamp: number): Promise<UndoPreview[] | null> {
    // Validate timestamp parameter
    if (typeof timestamp !== 'number' || isNaN(timestamp) || timestamp < 0) {
      logger.warn(`Invalid timestamp provided for preview: ${timestamp}`);
      return null;
    }

    // Check if we have an active session
    if (!this.getSessionId()) {
      logger.debug('No active session - cannot preview undo');
      return null;
    }

    try {
      // Get the specific patches to preview based on timestamp
      const patchesToPreview = await this.getPatchesSinceTimestamp(timestamp);

      if (patchesToPreview.length === 0) {
        logger.debug('No patches found to preview');
        return null;
      }

      logger.debug(`Generating preview for ${patchesToPreview.length} patches since timestamp ${timestamp}`);

      // Generate preview for each patch
      const previews: UndoPreview[] = [];
      for (const patchEntry of patchesToPreview) {
        const preview = await this.previewSinglePatch(patchEntry.patch_number);
        if (preview) {
          previews.push(preview);
        } else {
          logger.warn(`Failed to generate preview for patch ${patchEntry.patch_number}`);
        }
      }

      return previews.length > 0 ? previews : null;
    } catch (error) {
      logger.error('Failed to preview undo since timestamp:', error);
      return null;
    }
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
      // Check if patch file exists
      const patchExists = await this.fileManager.patchExists(patchEntry.patch_file);
      if (!patchExists) {
        logger.error(`Patch file not found for simulation: ${patchEntry.patch_file}`);
        return null;
      }

      // Read patch file
      const patchContent = await this.fileManager.readPatchFile(patchEntry.patch_file);
      if (!patchContent) {
        logger.error(`Failed to read patch file for simulation: ${patchEntry.patch_file}`);
        return null;
      }

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
    return this.indexManager.getPatchHistory(limit);
  }

  /**
   * Clear all patch history
   *
   * @returns Result with success status and message
   */
  async clearPatchHistory(): Promise<{ success: boolean; message: string }> {
    try {
      const removedCount = await this.cleanupManager.cleanupAll();

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
    const patchCount = this.indexManager.getPatchCount();
    const operationCounts = this.indexManager.getOperationCounts();
    const patchesDir = this.fileManager.getPatchesDir();
    const totalSize = await this.fileManager.calculateTotalSize();

    return {
      patches_directory: patchesDir || 'N/A',
      total_patches: patchCount,
      operation_counts: operationCounts,
      total_size_bytes: totalSize,
      next_patch_number: this.indexManager.getNextPatchNumber(),
    };
  }

  // ========== Two-Stage Undo Support ==========


  /**
   * Get list of recent file changes with diff stats
   *
   * @param limit - Maximum number of files to return (default 10)
   * @returns Array of file entries with stats
   */
  async getRecentFileList(limit: number = 10): Promise<UndoFileEntry[]> {
    if (this.indexManager.getPatchCount() === 0) {
      return [];
    }

    if (!this.fileManager.getPatchesDir()) {
      return [];
    }

    const recentPatches = this.indexManager.getLastPatches(limit).reverse();
    const fileEntries: UndoFileEntry[] = [];

    for (const patchEntry of recentPatches) {
      try {
        const patchContent = await this.fileManager.readPatchFile(patchEntry.patch_file);
        if (!patchContent) {
          logger.warn(`Failed to read patch ${patchEntry.patch_number}`);
          continue;
        }

        const diffContent = extractDiffContent(patchContent);
        const stats = calculateDiffStats(diffContent);

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
    const patchEntry = this.indexManager.getPatch(patchNumber);

    if (!patchEntry) {
      return {
        success: false,
        reverted_files: [],
        failed_operations: [`Patch ${patchNumber} not found`],
      };
    }

    try {
      const success = await this.applyReversePatch(patchEntry);

      if (success) {
        // Remove from index
        this.indexManager.removePatch(patchNumber);
        await this.indexManager.saveIndex();

        // Delete patch file
        await this.fileManager.deletePatchFile(patchEntry.patch_file);

        const result: UndoResult = {
          success: true,
          reverted_files: [patchEntry.file_path],
          failed_operations: [],
        };

        if (!this.validator.validateUndoResult(result)) {
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
    const patchEntry = this.indexManager.getPatch(patchNumber);

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

  // ========== Session Management & Cleanup ==========

  /**
   * Validate patch integrity on session change
   *
   * Performs the following validations:
   * 1. All patches in index have corresponding .diff files
   * 2. No orphaned .diff files exist (not in index)
   * 3. Quarantines corrupted patches
   *
   * This method is graceful - it logs warnings but doesn't throw errors,
   * allowing the system to continue with valid patches.
   */
  private async validatePatchIntegrity(): Promise<void> {
    const sessionId = this.getSessionId();
    if (!sessionId) {
      logger.debug('No active session - skipping patch integrity validation');
      return;
    }

    const patchesDir = this.fileManager.getPatchesDir();
    if (!patchesDir) {
      logger.debug('No patches directory - skipping patch integrity validation');
      return;
    }

    try {
      // Check if patches directory exists
      const dirExists = await fs.access(patchesDir).then(() => true).catch(() => false);
      if (!dirExists) {
        logger.debug('Patches directory does not exist yet - skipping validation');
        return;
      }

      const allPatches = this.indexManager.getAllPatches();
      const patchFilesInIndex = new Set(allPatches.map(p => p.patch_file));

      // Get all .diff files in the patches directory
      const files = await fs.readdir(patchesDir);
      const diffFiles = files.filter(f => f.startsWith('patch_') && f.endsWith('.diff'));

      const corruptedPatches: PatchMetadata[] = [];
      const orphanedFiles: string[] = [];

      // Validation 1: Check that all patches in index have corresponding .diff files
      for (const patch of allPatches) {
        const patchExists = await this.fileManager.patchExists(patch.patch_file);
        if (!patchExists) {
          logger.warn(
            `[Patch Integrity] Missing patch file for patch #${patch.patch_number}: ${patch.patch_file} (${patch.operation_type} on ${patch.file_path})`
          );
          corruptedPatches.push(patch);
        }
      }

      // Validation 2: Check for orphaned .diff files not in index
      for (const diffFile of diffFiles) {
        if (!patchFilesInIndex.has(diffFile)) {
          logger.warn(
            `[Patch Integrity] Orphaned patch file not in index: ${diffFile}`
          );
          orphanedFiles.push(diffFile);
        }
      }

      // Quarantine corrupted patches (missing files)
      if (corruptedPatches.length > 0) {
        await this.quarantineCorruptedPatches(corruptedPatches, sessionId, 'missing_patch_file');
      }

      // Quarantine orphaned files
      if (orphanedFiles.length > 0) {
        await this.quarantineOrphanedFiles(orphanedFiles, sessionId);
      }

      // Log summary
      if (corruptedPatches.length > 0 || orphanedFiles.length > 0) {
        logger.info(
          `[Patch Integrity] Validation complete: ${corruptedPatches.length} corrupted patches quarantined, ${orphanedFiles.length} orphaned files quarantined`
        );
      } else {
        logger.debug('[Patch Integrity] Validation complete: all patches valid');
      }

    } catch (error) {
      logger.error('[Patch Integrity] Failed to validate patch integrity:', error);
      // Don't throw - allow system to continue
    }
  }

  /**
   * Quarantine corrupted patches by moving their metadata to quarantine
   * and removing them from the index
   *
   * @param patches - Array of corrupted patch metadata
   * @param sessionId - Current session ID
   * @param reason - Reason for quarantine
   */
  private async quarantineCorruptedPatches(
    patches: PatchMetadata[],
    sessionId: string,
    reason: string
  ): Promise<void> {
    const quarantineDir = path.join(this.sessionsDir, '.quarantine');

    try {
      // Ensure quarantine directory exists
      await fs.mkdir(quarantineDir, { recursive: true });

      // Create quarantine metadata file
      const timestamp = Date.now();
      const quarantineFile = path.join(
        quarantineDir,
        `patches_${sessionId}_${timestamp}.json`
      );

      const quarantineData = {
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        reason,
        patches: patches.map(p => ({
          patch_number: p.patch_number,
          timestamp: p.timestamp,
          operation_type: p.operation_type,
          file_path: p.file_path,
          patch_file: p.patch_file,
        })),
      };

      await fs.writeFile(quarantineFile, JSON.stringify(quarantineData, null, 2), 'utf-8');
      logger.warn(
        `[Patch Integrity] Quarantined ${patches.length} corrupted patches to: ${quarantineFile}`
      );

      // Remove corrupted patches from index
      const patchNumbers = new Set(patches.map(p => p.patch_number));
      const removedCount = this.indexManager.removePatches(patchNumbers);
      await this.indexManager.saveIndex();

      logger.info(
        `[Patch Integrity] Removed ${removedCount} corrupted patch entries from index`
      );

    } catch (error) {
      logger.error('[Patch Integrity] Failed to quarantine corrupted patches:', error);
      // Don't throw - continue with best effort
    }
  }

  /**
   * Quarantine orphaned patch files by moving them to quarantine directory
   *
   * @param files - Array of orphaned patch filenames
   * @param sessionId - Current session ID
   */
  private async quarantineOrphanedFiles(files: string[], sessionId: string): Promise<void> {
    const patchesDir = this.fileManager.getPatchesDir();
    if (!patchesDir) {
      return;
    }

    const quarantineDir = path.join(this.sessionsDir, '.quarantine', `orphaned_${sessionId}_${Date.now()}`);

    try {
      // Create quarantine subdirectory for orphaned files
      await fs.mkdir(quarantineDir, { recursive: true });

      let movedCount = 0;
      const movedFiles: string[] = [];
      const failedFiles: string[] = [];
      for (const file of files) {
        try {
          const sourcePath = path.join(patchesDir, file);
          const destPath = path.join(quarantineDir, file);

          await fs.rename(sourcePath, destPath);
          movedCount++;
          movedFiles.push(file);
          logger.debug(`[Patch Integrity] Moved orphaned file to quarantine: ${file}`);
        } catch (error) {
          failedFiles.push(file);
          logger.warn(`[Patch Integrity] Failed to quarantine orphaned file ${file}:`, error);
          // Continue with other files
        }
      }

      logger.warn(
        `[Patch Integrity] Quarantined ${movedCount} orphaned patch files to: ${quarantineDir}`
      );

      // Create a manifest file in quarantine directory
      const manifestPath = path.join(quarantineDir, 'MANIFEST.json');
      const manifest = {
        session_id: sessionId,
        timestamp: new Date().toISOString(),
        reason: 'orphaned_files_not_in_index',
        moved_files: movedFiles,
        failed_files: failedFiles,
        moved_count: movedCount,
        failed_count: failedFiles.length,
      };

      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');

    } catch (error) {
      logger.error('[Patch Integrity] Failed to quarantine orphaned files:', error);
      // Don't throw - continue with best effort
    }
  }

  /**
   * Reload patches when session changes
   * This should be called when switching sessions
   */
  async onSessionChange(): Promise<void> {
    // Update manager paths for new session
    const patchesDir = this.getPatchesDir();
    const indexFile = this.getIndexFile();

    this.fileManager.setPatchesDir(patchesDir);
    this.indexManager.setIndexFilePath(indexFile);

    // Reload index
    await this.indexManager.loadIndex();
    logger.debug(`Patches reloaded for session: ${this.getSessionId() || 'none'}`);

    // Validate patch integrity and quarantine corrupted patches
    await this.validatePatchIntegrity();
  }

  /**
   * Delete all patches for a specific session
   * Should be called when a session is deleted
   *
   * @param sessionId - Session ID to clean up patches for
   */
  async cleanupSessionPatches(sessionId: string): Promise<void> {
    const patchesDir = path.join(this.sessionsDir, sessionId, 'patches');

    try {
      await fs.rm(patchesDir, { recursive: true, force: true });
      logger.info(`Deleted patches directory for session: ${sessionId}`);
    } catch (error) {
      logger.warn(`Failed to delete patches for session ${sessionId}:`, error);
    }
  }
}
