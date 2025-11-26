/**
 * PatchValidator - Validates patch and metadata structures
 *
 * This service provides validation functions for patch-related data structures,
 * ensuring type safety and data integrity throughout the patch management system.
 */

import { PatchMetadata, UndoResult } from './PatchManager.js';

/**
 * Patch index structure
 */
export interface PatchIndex {
  next_patch_number: number;
  patches: PatchMetadata[];
}

/**
 * PatchValidator class
 * Handles validation of all patch-related data structures
 */
export class PatchValidator {
  /**
   * Validate UndoResult structure
   *
   * @param result - Data to validate
   * @returns True if valid UndoResult structure
   */
  validateUndoResult(result: any): result is UndoResult {
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
   *
   * @param metadata - Data to validate
   * @returns True if valid PatchMetadata structure
   */
  validatePatchMetadata(metadata: any): metadata is PatchMetadata {
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
   *
   * @param index - Data to validate
   * @returns True if valid PatchIndex structure
   */
  validatePatchIndex(index: any): index is PatchIndex {
    return (
      typeof index === 'object' &&
      index !== null &&
      typeof index.next_patch_number === 'number' &&
      Array.isArray(index.patches) &&
      index.patches.every((patch: any) => this.validatePatchMetadata(patch))
    );
  }
}
