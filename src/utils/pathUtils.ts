/**
 * Path utilities for resolving and normalizing file paths
 */

import * as path from 'path';
import { homedir } from 'os';
import * as fs from 'fs';
import { isImageFile } from './imageUtils.js';

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

/**
 * Convert an absolute path to a relative path for display purposes
 *
 * If the path is outside the current working directory, returns the absolute path.
 * Otherwise, returns a path relative to cwd.
 *
 * @param absolutePath - The absolute path to convert
 * @returns Relative path for display, or absolute path if outside cwd
 */
export function getDisplayPath(absolutePath: string): string {
  const cwd = process.cwd();
  const relativePath = path.relative(cwd, absolutePath);

  // If the relative path goes up (..), it's outside cwd - show absolute
  if (relativePath.startsWith('..')) {
    return absolutePath;
  }

  return relativePath;
}

/**
 * Classify paths into directories, images, and regular files
 *
 * @param paths - Array of paths to classify
 * @returns Object with separate arrays for directories, images, and files
 */
export function classifyPaths(paths: string[]): { directories: string[], images: string[], files: string[] } {
  const directories: string[] = [];
  const images: string[] = [];
  const files: string[] = [];

  for (const pathStr of paths) {
    try {
      const resolvedPath = resolvePath(pathStr);

      // Check if path exists
      if (!fs.existsSync(resolvedPath)) {
        continue;
      }

      // Check if it's a directory
      const stats = fs.statSync(resolvedPath);
      if (stats.isDirectory()) {
        directories.push(pathStr);
      } else if (isImageFile(pathStr)) {
        images.push(pathStr);
      } else {
        files.push(pathStr);
      }
    } catch (error) {
      // Skip paths that can't be accessed
      continue;
    }
  }

  return { directories, images, files };
}
