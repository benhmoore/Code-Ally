/**
 * Path utilities for resolving and normalizing file paths
 */

import * as path from 'path';
import { homedir } from 'os';

/**
 * Resolve a file path to an absolute path
 *
 * Handles:
 * - Relative paths (resolved relative to cwd)
 * - Absolute paths (returned as-is)
 * - Tilde expansion (~/... becomes home directory)
 *
 * @param pathStr - The path to resolve
 * @param basePath - Optional base path for relative paths (defaults to cwd)
 * @returns Absolute path
 */
export function resolvePath(pathStr: string, basePath?: string): string {
  // Handle tilde expansion
  if (pathStr.startsWith('~/') || pathStr === '~') {
    return path.join(homedir(), pathStr.slice(1));
  }

  // Already absolute
  if (path.isAbsolute(pathStr)) {
    return pathStr;
  }

  // Relative path - resolve relative to basePath or cwd
  return path.join(basePath ?? process.cwd(), pathStr);
}

/**
 * Resolve multiple paths to absolute paths
 *
 * @param paths - Array of paths to resolve
 * @param basePath - Optional base path for relative paths
 * @returns Array of absolute paths
 */
export function resolvePaths(paths: string[], basePath?: string): string[] {
  return paths.map(p => resolvePath(p, basePath));
}
