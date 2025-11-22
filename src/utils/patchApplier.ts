/**
 * Patch applier for applying unified diffs to file content
 *
 * This module provides functionality to apply unified diffs (both forward and reverse)
 * to file content, supporting the undo system.
 */

import { applyPatch, StructuredPatch } from 'diff';
import { parseUnifiedDiff } from './diffUtils.js';
import { logger } from '../services/Logger.js';

/**
 * Result of a patch application attempt
 */
export interface PatchResult {
  success: boolean;
  content?: string;
  error?: string;
  /** Structured error details (if patch failed) */
  error_details?: {
    message: string;
    operation: string;
  };
}

/**
 * Create a structured patch error
 *
 * @param message - Human-readable error message
 * @param operation - Operation that failed
 * @returns PatchResult with error details
 */
function createPatchError(message: string, operation: string): PatchResult {
  return {
    success: false,
    error: message,
    error_details: {
      message,
      operation,
    },
  };
}

/**
 * Apply a unified diff to content
 *
 * @param diffContent - Unified diff string
 * @param currentContent - Current file content to apply diff to
 * @param reverse - If true, apply the diff in reverse (for undo)
 * @returns Result with new content or error
 */
export function applyUnifiedDiff(
  diffContent: string,
  currentContent: string,
  reverse: boolean = false
): PatchResult {
  try {
    if (!diffContent || !diffContent.trim()) {
      return createPatchError('Empty diff content', 'applyUnifiedDiff');
    }

    // Parse the diff
    const parsed = parseUnifiedDiff(diffContent);
    if (!parsed) {
      return createPatchError('Failed to parse diff content', 'applyUnifiedDiff');
    }

    // If reverse, swap the hunks' operations
    let patchToApply = diffContent;
    if (reverse) {
      patchToApply = reverseDiff(parsed);
    }

    // Apply the patch
    let result = applyPatch(currentContent, patchToApply);

    if (result === false || result === undefined) {
      return createPatchError('Failed to apply patch - content mismatch or invalid patch', 'applyUnifiedDiff');
    }

    // Fix a bug in the diff library where applying patches to empty strings adds a leading newline
    // When reversing a deletion (currentContent is empty, result should not start with newline)
    if (currentContent === '' && result.startsWith('\n')) {
      result = result.substring(1) + '\n';
    }

    return { success: true, content: result };
  } catch (error) {
    logger.error('Failed to apply patch:', error);
    return createPatchError(
      error instanceof Error ? error.message : 'Unknown error',
      'applyUnifiedDiff'
    );
  }
}

/**
 * Reverse a parsed diff (swap additions and deletions)
 *
 * @param parsed - Parsed diff object
 * @returns Reversed diff as string
 */
function reverseDiff(parsed: StructuredPatch): string {
  const lines: string[] = [];

  // Add header - swap oldFileName and newFileName
  lines.push(`--- ${parsed.newFileName}`);
  lines.push(`+++ ${parsed.oldFileName}`);

  // Process each hunk
  for (const hunk of parsed.hunks) {
    // Swap old and new ranges
    const oldStart = hunk.newStart;
    const oldLines = hunk.newLines;
    const newStart = hunk.oldStart;
    const newLines = hunk.oldLines;

    // Create reversed hunk header
    lines.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);

    // Reverse the lines (swap + and -)
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        lines.push('-' + line.substring(1));
      } else if (line.startsWith('-')) {
        lines.push('+' + line.substring(1));
      } else {
        // Context line (starts with space or is empty)
        lines.push(line);
      }
    }
  }

  // Ensure we end with a newline for proper patch format
  return lines.join('\n') + '\n';
}

/**
 * Simulate applying a patch without actually modifying anything
 *
 * Used for preview functionality in the undo system.
 *
 * @param diffContent - Unified diff string
 * @param currentContent - Current file content
 * @param reverse - If true, simulate reverse application
 * @returns Simulated result content or null if simulation fails
 */
export function simulatePatchApplication(
  diffContent: string,
  currentContent: string,
  reverse: boolean = false
): string | null {
  const result = applyUnifiedDiff(diffContent, currentContent, reverse);
  // Use nullish coalescing (??) instead of || to allow empty strings
  return result.success ? (result.content ?? null) : null;
}
