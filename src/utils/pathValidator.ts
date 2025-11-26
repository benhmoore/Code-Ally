/**
 * Path validation utilities for checking file system access
 */

import { promises as fs } from 'fs';

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Check if a path exists and is accessible
 *
 * @param pathStr - The path to validate
 * @returns Validation result with error message if invalid
 */
export async function validateExists(pathStr: string): Promise<ValidationResult> {
  try {
    await fs.access(pathStr);
    return { valid: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { valid: false, error: `Path not found: ${pathStr}` };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return { valid: false, error: `Permission denied: ${pathStr}` };
    }
    return { valid: false, error: `Cannot access path: ${pathStr}` };
  }
}

/**
 * Check if a path exists and is a file
 *
 * @param pathStr - The path to validate
 * @returns Validation result with error message if invalid
 */
export async function validateIsFile(pathStr: string): Promise<ValidationResult> {
  try {
    const stats = await fs.stat(pathStr);
    if (!stats.isFile()) {
      return { valid: false, error: `Not a file: ${pathStr}` };
    }
    return { valid: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { valid: false, error: `File not found: ${pathStr}` };
    }
    return { valid: false, error: `Cannot access file: ${pathStr}` };
  }
}

/**
 * Check if a path exists and is a directory
 *
 * @param pathStr - The path to validate
 * @returns Validation result with error message if invalid
 */
export async function validateIsDirectory(pathStr: string): Promise<ValidationResult> {
  try {
    const stats = await fs.stat(pathStr);
    if (!stats.isDirectory()) {
      return { valid: false, error: `Not a directory: ${pathStr}` };
    }
    return { valid: true };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { valid: false, error: `Directory not found: ${pathStr}` };
    }
    return { valid: false, error: `Cannot access directory: ${pathStr}` };
  }
}

/**
 * Check if multiple paths exist and are accessible
 *
 * @param paths - Array of paths to validate
 * @returns Array of validation results
 */
export async function validateMultiplePaths(paths: string[]): Promise<ValidationResult[]> {
  return Promise.all(paths.map(p => validateExists(p)));
}
