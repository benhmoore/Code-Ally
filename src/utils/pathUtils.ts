/**
 * Path utilities for resolving and normalizing file paths
 */

import * as path from 'path';
import { homedir } from 'os';
import * as fs from 'fs';

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
 * Check if a string looks like a file path
 *
 * Simple pattern matching to detect path-like strings:
 * - Starts with /, ~/, ./, ../
 * - Contains / or \ (Unix or Windows path separators)
 * - Starts with drive letter (Windows: C:, D:, etc.)
 * - Has a file extension
 *
 * @param str - String to check
 * @returns true if the string resembles a file path
 */
export function looksLikePath(str: string): boolean {
  if (!str || typeof str !== 'string') {
    return false;
  }

  const trimmed = str.trim();

  // Check for common path prefixes
  if (trimmed.startsWith('/') ||
      trimmed.startsWith('~/') ||
      trimmed.startsWith('./') ||
      trimmed.startsWith('../')) {
    return true;
  }

  // Check for Windows drive letter (C:, D:, etc.)
  if (/^[a-zA-Z]:/.test(trimmed)) {
    return true;
  }

  // Check if it contains path separators (/ or \)
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return true;
  }

  // Check for file extension pattern (e.g., file.txt, script.js)
  const extensionPattern = /\.\w+$/;
  if (extensionPattern.test(trimmed)) {
    return true;
  }

  return false;
}

/**
 * Detect and validate file paths from a pasted string
 *
 * Takes input that could be:
 * - A single path
 * - Multiple space-separated paths
 * - Paths with spaces (in quotes)
 *
 * Returns only paths that exist on the filesystem.
 * Preserves original path format (relative/absolute as pasted).
 *
 * @param input - Input string containing one or more paths
 * @returns Array of valid file paths that exist on filesystem
 */
export function detectFilePaths(input: string): string[] {
  if (!input || typeof input !== 'string') {
    return [];
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return [];
  }

  // Parse quoted and unquoted tokens
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';

  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i];

    if ((char === '"' || char === "'") && !inQuotes) {
      inQuotes = true;
      quoteChar = char;
    } else if (char === quoteChar && inQuotes) {
      inQuotes = false;
      quoteChar = '';
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else if (char === ' ' && !inQuotes) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  // Add final token
  if (current) {
    tokens.push(current);
  }

  // Filter to path-like tokens and validate they exist
  const validPaths: string[] = [];

  for (const token of tokens) {
    if (looksLikePath(token)) {
      // Resolve to absolute path for existence check
      const absolutePath = resolvePath(token);

      // Check if file exists
      if (fs.existsSync(absolutePath)) {
        // Return original format (as pasted)
        validPaths.push(token);
      }
    }
  }

  return validPaths;
}
