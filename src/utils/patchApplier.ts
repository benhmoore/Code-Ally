/**
 * Patch applier for applying unified diffs to file content
 *
 * This module provides functionality to apply unified diffs (both forward and reverse)
 * to file content, supporting the undo system.
 */

import { applyPatch, parsePatch, StructuredPatch } from 'diff';
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

export interface AppliedModelPatch extends PatchResult {
  /** Original-file line ranges whose exact text anchors the patch. */
  readRanges?: Array<{ start: number; end: number }>;
  /** Old-to-new line mappings for each applied hunk, in source order. */
  editRanges?: Array<{
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
  }>;
  hunkCount?: number;
}

/**
 * Treat hunk ranges as location hints, not model-authored bookkeeping.
 * Unified diff parsers require their counts to exactly match the body even
 * though the body already contains that information. Recompute the counts so
 * a correct contextual edit is not rejected for an arithmetic mistake.
 */
function normalizeModelPatchHunkCounts(diffContent: string): string {
  const lines = diffContent.replace(/\r\n/g, '\n').split('\n');
  const bodyEnd = lines.at(-1) === '' ? lines.length - 1 : lines.length;
  const headerPattern = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@(.*)$/;

  for (let index = 0; index < bodyEnd; index++) {
    const match = headerPattern.exec(lines[index]!);
    if (!match) continue;

    let oldLines = 0;
    let newLines = 0;
    for (let bodyIndex = index + 1; bodyIndex < bodyEnd; bodyIndex++) {
      let line = lines[bodyIndex]!;
      if (line.startsWith('@@ ')) break;
      if (line.startsWith('--- ') && lines[bodyIndex + 1]?.startsWith('+++ ')) break;
      if (line.startsWith('\\ No newline at end of file')) continue;

      // Models commonly omit the single context marker on an unchanged blank
      // line. Its location inside a hunk makes the intended meaning unambiguous.
      if (line === '') {
        line = ' ';
        lines[bodyIndex] = line;
      }

      if (!line.startsWith('+')) oldLines++;
      if (!line.startsWith('-')) newLines++;
    }

    lines[index] = `@@ -${match[1]},${oldLines} +${match[2]},${newLines} @@${match[3]}`;
  }

  return lines.join('\n');
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
 * Validate and apply a model-authored, single-file unified diff.
 *
 * Hunk headers may be provided without file headers. Every hunk that targets a
 * non-empty file must carry old-side context or removals. We locate that exact
 * text, including whitespace, before applying. Added text is never reindented
 * or otherwise inferred from the source. Callers can enforce read-before-write against the
 * lines the patch actually targets, even when a hunk's line-number hint drifted.
 */
function applyModelPatchExact(
  diffContent: string,
  currentContent: string
): AppliedModelPatch {
  if (!diffContent || !diffContent.trim()) {
    return createPatchError('Patch cannot be empty', 'applyModelPatch');
  }

  let patches: StructuredPatch[];
  try {
    patches = parsePatch(normalizeModelPatchHunkCounts(diffContent));
  } catch (error) {
    return createPatchError(
      `Invalid unified diff: ${error instanceof Error ? error.message : 'unable to parse patch'}`,
      'applyModelPatch'
    );
  }

  if (patches.length !== 1 || !patches[0] || patches[0].hunks.length === 0) {
    return createPatchError(
      'Patch must contain exactly one file patch with at least one numeric unified-diff hunk header, for example: @@ -12,3 +12,4 @@. A bare @@ header is invalid.',
      'applyModelPatch'
    );
  }

  const patch = patches[0];
  if (patch.oldFileName === '/dev/null' || patch.newFileName === '/dev/null') {
    return createPatchError(
      'apply-patch only modifies existing files; use write to create files',
      'applyModelPatch'
    );
  }

  const normalizedSource = currentContent.replace(/\r\n/g, '\n');
  const sourceLines = normalizedSource.split('\n');
  const readRanges: Array<{ start: number; end: number }> = [];
  const editRanges: NonNullable<AppliedModelPatch['editRanges']> = [];
  let precedingLineDelta = 0;
  let previousSourceEnd = 0;

  for (const [index, hunk] of patch.hunks.entries()) {
    const oldLines = hunk.lines
      .filter(line => line.startsWith(' ') || line.startsWith('-'))
      .map(line => line.slice(1));

    if (oldLines.length === 0) {
      if (patch.hunks.length !== 1) {
        return createPatchError('An empty-file insertion must use one combined hunk', 'applyModelPatch');
      }
      if (normalizedSource.length !== 0) {
        return createPatchError(
          `Hunk ${index + 1} has no original-file context. Include unchanged or removed lines so the target is unambiguous`,
          'applyModelPatch'
        );
      }
      const addedLines = hunk.lines.filter(line => line.startsWith('+')).length;
      editRanges.push({ oldStart: 1, oldEnd: 0, newStart: 1, newEnd: addedLines });
      precedingLineDelta += hunk.newLines;
      continue;
    }

    const candidates: number[] = [];
    for (let start = 0; start + oldLines.length <= sourceLines.length; start++) {
      if (oldLines.every((line, offset) => sourceLines[start + offset] === line)) {
        candidates.push(start);
      }
    }

    const declaredStart = Math.max(0, hunk.oldStart - 1);
    const actualStart = candidates.includes(declaredStart)
      ? declaredStart
      : candidates.length === 1
        ? candidates[0]!
        : null;

    if (actualStart === null) {
      const reason = candidates.length === 0
        ? 'its original lines were not found'
        : `its original lines match ${candidates.length} locations and the @@ line number does not disambiguate them`;
      // Hunk line numbers authored from memory are often stale. When the full
      // context misses, surface exact, unique lines that still exist so the
      // caller can read the right region instead of trusting the stale header
      // or rereading the whole file.
      const uniqueAnchors = oldLines
        .map((line, offset) => ({ line, offset }))
        .filter(({ line }) => line.trim().length >= 8)
        .flatMap(({ line, offset }) => {
          const matches = sourceLines
            .map((sourceLine, sourceIndex) => sourceLine === line ? sourceIndex + 1 : 0)
            .filter(Boolean);
          return matches.length === 1 ? [{ line: matches[0]!, start: matches[0]! - 1 - offset }] : [];
        });
      const anchors = [...new Set(uniqueAnchors.map(anchor => anchor.line))].sort((a, b) => a - b).slice(0, 4);
      const anchorHint = anchors.length > 0
        ? ` Exact unique context from this hunk exists near current file line${anchors.length === 1 ? '' : 's'} ${anchors.join(', ')}.`
        : '';
      // Diagnostic only: never use a partial match to authorize a mutation.
      // Compare text only when every surviving unique anchor agrees on one
      // candidate position; conflicting anchors cannot identify a mismatch.
      const starts = [...new Set(uniqueAnchors.map(anchor => anchor.start))];
      let mismatchHint = '';
      if (starts.length === 1) {
        const start = starts[0]!;
        if (start >= 0 && start + oldLines.length <= sourceLines.length) {
          const offset = oldLines.findIndex((line, i) => line !== sourceLines[start + i]);
          if (offset >= 0) {
            const expected = Array.from(oldLines[offset]!);
            const actual = Array.from(sourceLines[start + offset]!);
            let column = 0;
            while (column < expected.length && column < actual.length && expected[column] === actual[column]) column++;
            const from = Math.max(0, column - 30);
            const excerpt = (characters: string[]) => JSON.stringify(
              `${from > 0 ? '…' : ''}${characters.slice(from, from + 90).join('')}${characters.length > from + 90 ? '…' : ''}`,
            );
            mismatchHint = ` At candidate file line ${start + offset + 1}, column ${column + 1}: patch expects ${excerpt(expected)}; file contains ${excerpt(actual)}.`;
          }
        }
      }
      return createPatchError(
        `Cannot apply hunk ${index + 1}: ${reason}.${anchorHint}${mismatchHint} Re-read that narrow region and correct this hunk before resubmitting the patch.`,
        'applyModelPatch'
      );
    }

    // The diff engine consumes source in ascending order. Exact individual
    // matches do not make overlapping or reversed hunks safe: passing them
    // through can duplicate already-consumed source instead of rejecting it.
    if (actualStart < previousSourceEnd) {
      return createPatchError(
        `Hunk ${index + 1} overlaps or precedes an earlier hunk. Combine overlapping changes and order hunks by their source positions. No hunks were applied.`,
        'applyModelPatch',
      );
    }
    previousSourceEnd = actualStart + oldLines.length;
    readRanges.push({
      start: actualStart + 1,
      end: actualStart + oldLines.length,
    });
    const newLineCount = hunk.lines
      .filter(line => line.startsWith(' ') || line.startsWith('+'))
      .length;
    const updatedStart = actualStart + 1 + precedingLineDelta;
    editRanges.push({
      oldStart: actualStart + 1,
      oldEnd: actualStart + oldLines.length,
      newStart: updatedStart,
      newEnd: updatedStart + newLineCount - 1,
    });
    hunk.oldStart = actualStart + 1;
    hunk.newStart = actualStart + 1 + precedingLineDelta;
    precedingLineDelta += hunk.newLines - hunk.oldLines;
  }

  const result = applyPatch(currentContent, patch);
  if (result === false || result === undefined) {
    return createPatchError(
      'Patch context does not match the current file. Re-read the target region and regenerate the hunk',
      'applyModelPatch'
    );
  }
  if (result === currentContent) {
    return createPatchError('Patch makes no changes', 'applyModelPatch');
  }

  return {
    success: true,
    content: result,
    readRanges,
    editRanges,
    hunkCount: patch.hunks.length,
  };
}

/**
 * Apply a model-authored patch. Exact text always wins. The only accepted
 * decoding fallback is a complete JSON-string payload: it must contain no
 * physical line breaks, parse as one JSON string, and round-trip byte-for-byte
 * through JSON encoding. Partially decoded multiline payloads are necessarily
 * ambiguous with intentional source escapes and are rejected rather than
 * guessed at.
 */
export function applyModelPatch(
  diffContent: string,
  currentContent: string
): AppliedModelPatch {
  const exact = applyModelPatchExact(diffContent, currentContent);
  if (exact.success) return exact;

  // Some providers double-encode the complete JSON string argument, leaving a
  // one-line value whose diff separators are literal `\n` sequences. Only a
  // complete, canonical JSON-string encoding is safe to decode here.
  if (!/[\r\n]/.test(diffContent) && diffContent.includes('\\n')) {
    try {
      const decoded = JSON.parse(`"${diffContent}"`);
      const roundTrip = typeof decoded === 'string'
        ? JSON.stringify(decoded).slice(1, -1)
        : '';
      if (roundTrip === diffContent && /[\r\n]/.test(decoded)) {
        const repaired = applyModelPatchExact(decoded, currentContent);
        if (repaired.success) return repaired;
      }
    } catch {
      // Not a complete JSON-string payload; keep the exact diagnostic.
    }
  }
  return exact;
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
