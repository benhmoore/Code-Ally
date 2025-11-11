/**
 * Diff utilities for creating and parsing unified diffs
 *
 * This module provides utilities for creating git-style unified diffs
 * and parsing them for patch application.
 */

import { createTwoFilesPatch, parsePatch, StructuredPatch } from 'diff';
import * as path from 'path';

/**
 * Create a unified diff between original and new content
 *
 * Uses git-style headers with a/ and b/ prefixes and 3 lines of context.
 *
 * @param originalContent - Original file content
 * @param newContent - New file content
 * @param filePath - Path to the file (used in diff header)
 * @returns Unified diff string
 */
export function createUnifiedDiff(
  originalContent: string,
  newContent: string,
  filePath: string
): string {
  // Don't normalize - let the diff library handle trailing newlines correctly
  // Normalization was causing identical content after adding newlines, resulting in no hunks

  // Use basename for the diff header (matches Python implementation)
  const basename = path.basename(filePath);

  // Create unified diff with git-style a/ b/ prefixes
  const diff = createTwoFilesPatch(
    `a/${basename}`,
    `b/${basename}`,
    originalContent,
    newContent,
    undefined,
    undefined,
    { context: 3 }
  );

  return diff;
}

/**
 * Parse a unified diff string into structured format
 *
 * @param diffContent - Unified diff string
 * @returns Parsed diff object or null if parsing fails
 */
export function parseUnifiedDiff(diffContent: string): StructuredPatch | null {
  try {
    const parsed = parsePatch(diffContent);
    if (!parsed || parsed.length === 0) {
      return null;
    }
    const patch = parsed[0];
    // Check if patch has any hunks (empty hunks array = invalid diff)
    if (!patch || !patch.hunks || patch.hunks.length === 0) {
      return null;
    }
    return patch;
  } catch (error) {
    return null;
  }
}

/**
 * Extract the actual diff content from a patch file, stripping metadata header
 *
 * @param patchFileContent - Full patch file content (with metadata comments)
 * @returns Just the diff content
 */
export function extractDiffContent(patchFileContent: string): string {
  const lines: string[] = [];
  let started = false;

  for (const line of patchFileContent.split('\n')) {
    // Start collecting when we hit the diff header
    if (!started && (
      line.startsWith('diff --git ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('@@ ')
    )) {
      started = true;
    }

    if (started) {
      lines.push(line);
    }
  }

  const result = lines.join('\n');
  // Only strip the final newline if we added content (preserve original formatting)
  return result;
}

/**
 * Create a patch file with metadata header
 *
 * @param operationType - Type of operation (write, edit, delete)
 * @param filePath - Absolute path to the file
 * @param timestamp - ISO timestamp
 * @param diffContent - Unified diff content
 * @returns Full patch file content with metadata
 */
export function createPatchFileContent(
  operationType: string,
  filePath: string,
  timestamp: string,
  diffContent: string
): string {
  const header = [
    '# Code Ally Patch File',
    `# Operation: ${operationType}`,
    `# File: ${filePath}`,
    `# Timestamp: ${timestamp}`,
    '# ',
    '# To apply this patch in reverse: patch -R -p1 < this_file',
    '#',
    '===================================================================',
  ].join('\n');

  return header + '\n' + diffContent;
}

/**
 * Diff statistics
 */
export interface DiffStats {
  additions: number;
  deletions: number;
  changes: number;
}

/**
 * Calculate diff statistics from a unified diff string
 *
 * Counts the number of additions and deletions in a unified diff,
 * excluding the header lines (+++/---).
 *
 * @param diffContent - Unified diff content
 * @returns Diff statistics (additions, deletions, changes)
 */
export function calculateDiffStats(diffContent: string): DiffStats {
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
