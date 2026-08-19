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
  /** Updated-file ranges fully represented by patch context and additions. */
  updatedReadRanges?: Array<{ start: number; end: number }>;
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

function leadingWhitespace(value: string): string {
  return value.match(/^\s*/)?.[0] ?? '';
}

/**
 * Reconcile a hunk whose old-side text differs from the source only in its
 * outer whitespace. Model-authored diffs occasionally shift every line by one
 * indentation column even immediately after reading the target. Accept that
 * only when the target is unambiguous and every nonblank old line describes
 * the same indentation shift. Context and removals are then anchored to the
 * exact source text, while additions inherit that shift.
 */
function alignHunkWhitespace(
  hunk: StructuredPatch['hunks'][number],
  sourceLines: string[],
  actualStart: number
): boolean {
  let sourceOffset = 0;
  const indentationDeltas = new Set<number>();
  const oldLogicalLines = hunk.lines
    .filter(line => line.startsWith(' ') || line.startsWith('-'))
    .map(line => line.slice(1).trim());
  const newLogicalLines = hunk.lines
    .filter(line => line.startsWith(' ') || line.startsWith('+'))
    .map(line => line.slice(1).trim());
  const changesOnlyOuterWhitespace = oldLogicalLines.length === newLogicalLines.length
    && oldLogicalLines.every((line, index) => line === newLogicalLines[index]);

  for (const line of hunk.lines) {
    if (!line.startsWith(' ') && !line.startsWith('-')) continue;
    const authored = line.slice(1);
    const source = sourceLines[actualStart + sourceOffset]!;
    if (authored.trim().length > 0) {
      indentationDeltas.add(leadingWhitespace(source).length - leadingWhitespace(authored).length);
    }
    sourceOffset++;
  }

  if (indentationDeltas.size > 1) return false;
  const indentationDelta = indentationDeltas.values().next().value ?? 0;
  sourceOffset = 0;
  hunk.lines = hunk.lines.map(line => {
    if (line.startsWith(' ') || line.startsWith('-')) {
      return line[0] + sourceLines[actualStart + sourceOffset++]!;
    }
    if (
      !line.startsWith('+')
      || line.slice(1).trim().length === 0
      || indentationDelta === 0
      // When the hunk's actual purpose is indentation, its added whitespace is
      // the desired result. Translating it by the old-side anchor drift would
      // silently undo or overshoot that repair.
      || changesOnlyOuterWhitespace
    ) {
      return line;
    }

    const body = line.slice(1);
    if (indentationDelta > 0) return `+${' '.repeat(indentationDelta)}${body}`;
    const indent = leadingWhitespace(body);
    if (indent.length < -indentationDelta) return line;
    return `+${body.slice(-indentationDelta)}`;
  });
  return true;
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
 * text before applying so callers can enforce read-before-write against the
 * lines the patch actually targets, even when a hunk's line-number hint drifted.
 */
export function applyModelPatch(
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
  const updatedReadRanges: Array<{ start: number; end: number }> = [];
  let precedingLineDelta = 0;

  for (const [index, hunk] of patch.hunks.entries()) {
    const oldLines = hunk.lines
      .filter(line => line.startsWith(' ') || line.startsWith('-'))
      .map(line => line.slice(1));

    if (oldLines.length === 0) {
      if (normalizedSource.length !== 0) {
        return createPatchError(
          `Hunk ${index + 1} has no original-file context. Include unchanged or removed lines so the target is unambiguous`,
          'applyModelPatch'
        );
      }
      const addedLines = hunk.lines.filter(line => line.startsWith('+')).length;
      if (addedLines > 0) updatedReadRanges.push({ start: 1, end: addedLines });
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
    let actualStart = candidates.includes(declaredStart)
      ? declaredStart
      : candidates.length === 1
        ? candidates[0]!
        : null;

    if (actualStart === null && candidates.length === 0) {
      const whitespaceCandidates: number[] = [];
      for (let start = 0; start + oldLines.length <= sourceLines.length; start++) {
        if (oldLines.every((line, offset) => sourceLines[start + offset]!.trim() === line.trim())) {
          whitespaceCandidates.push(start);
        }
      }
      const whitespaceStart = whitespaceCandidates.includes(declaredStart)
        ? declaredStart
        : whitespaceCandidates.length === 1
          ? whitespaceCandidates[0]!
          : null;
      if (
        whitespaceStart !== null
        && alignHunkWhitespace(hunk, sourceLines, whitespaceStart)
      ) {
        actualStart = whitespaceStart;
      }
    }

    if (actualStart === null) {
      const reason = candidates.length === 0
        ? 'its original lines were not found'
        : `its original lines match ${candidates.length} locations and the @@ line number does not disambiguate them`;
      // Hunk line numbers authored from memory are often stale. When the full
      // context misses, surface exact, unique lines that still exist so the
      // caller can read the right region instead of trusting the stale header
      // or rereading the whole file.
      const uniqueAnchorLines = oldLines
        .filter(line => line.trim().length >= 8)
        .flatMap(line => {
          const matches = sourceLines
            .map((sourceLine, sourceIndex) => sourceLine === line ? sourceIndex + 1 : 0)
            .filter(Boolean);
          return matches.length === 1 ? matches : [];
        });
      const anchors = [...new Set(uniqueAnchorLines)].sort((a, b) => a - b).slice(0, 4);
      const anchorHint = anchors.length > 0
        ? ` Exact unique context from this hunk exists near current file line${anchors.length === 1 ? '' : 's'} ${anchors.join(', ')}.`
        : '';
      return createPatchError(
        `Cannot apply hunk ${index + 1}: ${reason}.${anchorHint} Re-read that narrow region and retry only this hunk with current surrounding context`,
        'applyModelPatch'
      );
    }

    readRanges.push({
      start: actualStart + 1,
      end: actualStart + oldLines.length,
    });
    const newLineCount = hunk.lines
      .filter(line => line.startsWith(' ') || line.startsWith('+'))
      .length;
    if (newLineCount > 0) {
      const updatedStart = actualStart + 1 + precedingLineDelta;
      updatedReadRanges.push({
        start: updatedStart,
        end: updatedStart + newLineCount - 1,
      });
    }
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
    updatedReadRanges,
    hunkCount: patch.hunks.length,
  };
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
