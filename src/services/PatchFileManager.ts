/**
 * PatchFileManager - Manages patch files on disk
 *
 * This service handles all file system operations for patch files,
 * including reading, writing, and deleting patch files.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { logger } from './Logger.js';
import { BUFFER_SIZES } from '../config/constants.js';

/**
 * PatchFileManager class
 * Handles all file system operations for patch files
 */
export class PatchFileManager {
  private patchesDir: string | null;

  /**
   * Create a new PatchFileManager
   *
   * @param patchesDir - Directory where patch files are stored (null if no active session)
   */
  constructor(patchesDir: string | null) {
    this.patchesDir = patchesDir;
  }

  /**
   * Update the patches directory (e.g., when session changes)
   *
   * @param patchesDir - New patches directory path (null if no active session)
   */
  setPatchesDir(patchesDir: string | null): void {
    this.patchesDir = patchesDir;
  }

  /**
   * Get the current patches directory
   *
   * @returns Patches directory path or null if no active session
   */
  getPatchesDir(): string | null {
    return this.patchesDir;
  }

  /**
   * Ensure patches directory exists
   */
  async ensurePatchesDirectory(): Promise<void> {
    if (!this.patchesDir) {
      return; // No session active
    }

    try {
      await fs.mkdir(this.patchesDir, { recursive: true });
      logger.debug(`Patches directory ensured at: ${this.patchesDir}`);
    } catch (error) {
      logger.error('Failed to create patches directory:', error);
      throw error;
    }
  }

  /**
   * Generate patch filename for a patch number
   *
   * @param patchNumber - Patch number
   * @returns Full path to patch file or null if no active session
   */
  generatePatchFilename(patchNumber: number): string | null {
    if (!this.patchesDir) {
      return null;
    }
    return path.join(this.patchesDir, `patch_${String(patchNumber).padStart(BUFFER_SIZES.PATCH_NUMBER_PADDING, '0')}.diff`);
  }

  /**
   * Write patch content to file
   *
   * @param patchNumber - Patch number
   * @param content - Patch content to write
   * @returns Full path to written file or null if no active session
   */
  async writePatchFile(patchNumber: number, content: string): Promise<string | null> {
    const patchFile = this.generatePatchFilename(patchNumber);
    if (!patchFile) {
      return null;
    }

    try {
      await fs.writeFile(patchFile, content, 'utf-8');
      logger.debug(`Wrote patch file: ${patchFile}`);
      return patchFile;
    } catch (error) {
      logger.error(`Failed to write patch file ${patchFile}:`, error);
      throw error;
    }
  }

  /**
   * Read patch content from file
   *
   * @param patchFileName - Name of the patch file (e.g., 'patch_001.diff')
   * @returns Patch content or null if file doesn't exist or no active session
   */
  async readPatchFile(patchFileName: string): Promise<string | null> {
    if (!this.patchesDir) {
      return null;
    }

    const patchFile = path.join(this.patchesDir, patchFileName);

    try {
      const exists = await this.patchExists(patchFileName);
      if (!exists) {
        logger.error(`Patch file not found: ${patchFile}`);
        return null;
      }

      const content = await fs.readFile(patchFile, 'utf-8');
      return content;
    } catch (error) {
      logger.error(`Failed to read patch file ${patchFile}:`, error);
      return null;
    }
  }

  /**
   * Delete patch file
   *
   * @param patchFileName - Name of the patch file to delete
   * @returns True if successful, false otherwise
   */
  async deletePatchFile(patchFileName: string): Promise<boolean> {
    if (!this.patchesDir) {
      return false;
    }

    const patchFile = path.join(this.patchesDir, patchFileName);

    try {
      await fs.unlink(patchFile);
      logger.debug(`Deleted patch file: ${patchFile}`);
      return true;
    } catch (error) {
      logger.debug(`Failed to delete patch file ${patchFile}:`, error);
      return false;
    }
  }

  /**
   * Check if patch file exists
   *
   * @param patchFileName - Name of the patch file to check
   * @returns True if exists, false otherwise
   */
  async patchExists(patchFileName: string): Promise<boolean> {
    if (!this.patchesDir) {
      return false;
    }

    const patchFile = path.join(this.patchesDir, patchFileName);
    return fs.access(patchFile).then(() => true).catch(() => false);
  }

  /**
   * Get the full path to a patch file
   *
   * @param patchFileName - Name of the patch file
   * @returns Full path or null if no active session
   */
  getPatchPath(patchFileName: string): string | null {
    if (!this.patchesDir) {
      return null;
    }
    return path.join(this.patchesDir, patchFileName);
  }

  /**
   * Calculate total size of all patch files in directory
   *
   * @returns Total size in bytes
   */
  async calculateTotalSize(): Promise<number> {
    if (!this.patchesDir) {
      return 0;
    }

    try {
      let totalSize = 0;
      const files = await fs.readdir(this.patchesDir);

      for (const file of files) {
        if (file.startsWith('patch_') && file.endsWith('.diff')) {
          const filePath = path.join(this.patchesDir, file);
          const stats = await fs.stat(filePath).catch(() => null);
          if (stats && stats.isFile()) {
            totalSize += stats.size;
          }
        }
      }

      return totalSize;
    } catch (error) {
      logger.warn('Failed to calculate patch files size:', error);
      return 0;
    }
  }

  /**
   * Get size of a specific patch file
   *
   * @param patchFileName - Name of the patch file
   * @returns Size in bytes or 0 if file doesn't exist
   */
  async getPatchFileSize(patchFileName: string): Promise<number> {
    if (!this.patchesDir) {
      return 0;
    }

    const patchFile = path.join(this.patchesDir, patchFileName);

    try {
      const stats = await fs.stat(patchFile);
      return stats.size;
    } catch (error) {
      return 0;
    }
  }
}
