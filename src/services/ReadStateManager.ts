/**
 * ReadStateManager - Line-level read state tracking
 *
 * Tracks which lines of files have been read and validates that lines
 * were read before editing. Invalidates read state when edits shift
 * line numbers to maintain consistency.
 */

export interface ReadRange {
  /** Starting line number (1-indexed) */
  start: number;
  /** Ending line number (1-indexed, inclusive) */
  end: number;
}

export interface FileReadState {
  /** Scope that owns this read state (usually an agent instance ID) */
  scopeId: string;
  /** Absolute path to the file */
  filePath: string;
  /** Array of read ranges, kept sorted and merged */
  readRanges: ReadRange[];
}

export interface ValidationResult {
  /** Whether the validation succeeded */
  success: boolean;
  /** Human-readable message describing the result */
  message: string;
  /** Formatted string of missing ranges (if validation failed) */
  missingRanges?: string;
  /** Structured error details (if validation failed) */
  error_details?: {
    message: string;
    operation: string;
    missingRanges?: string;
  };
}

const DEFAULT_SCOPE_ID = 'default';

export class ReadStateManager {
  private fileStates: Map<string, FileReadState>;

  constructor() {
    this.fileStates = new Map();
  }

  /**
   * Create a structured validation error
   *
   * @param message - Human-readable error message
   * @param operation - Operation that failed
   * @param missingRanges - Formatted string of missing ranges (optional)
   * @returns ValidationResult with error details
   */
  private createValidationError(
    message: string,
    operation: string,
    missingRanges?: string
  ): ValidationResult {
    return {
      success: false,
      message,
      missingRanges,
      error_details: {
        message,
        operation,
        missingRanges,
      },
    };
  }

  /**
   * Build state key from read owner and file path.
   */
  private key(filePath: string, scopeId?: string): string {
    return `${scopeId ?? DEFAULT_SCOPE_ID}:${filePath}`;
  }

  /**
   * Track that a range of lines has been read
   *
   * @param filePath - Absolute path to the file
   * @param startLine - Starting line number (1-indexed)
   * @param endLine - Ending line number (1-indexed, inclusive)
   * @param scopeId - Read owner scope (usually an agent instance ID)
   */
  trackRead(filePath: string, startLine: number, endLine: number, scopeId?: string): void {
    // Validate inputs - fail fast for programming errors
    if (startLine < 1) {
      throw new Error(`Invalid start line ${startLine} for ${filePath}. Line numbers must be >= 1.`);
    }
    if (endLine < startLine) {
      throw new Error(`Invalid line range for ${filePath}: end line ${endLine} is before start line ${startLine}.`);
    }

    // Get or create file state
    const stateKey = this.key(filePath, scopeId);
    let fileState = this.fileStates.get(stateKey);
    if (!fileState) {
      fileState = {
        scopeId: scopeId ?? DEFAULT_SCOPE_ID,
        filePath,
        readRanges: [],
      };
      this.fileStates.set(stateKey, fileState);
    }

    // Add new range and merge with existing ranges
    const newRange: ReadRange = { start: startLine, end: endLine };
    fileState.readRanges = this.addRange(fileState.readRanges, newRange);
  }

  /**
   * Validate that a range of lines has been read
   *
   * @param filePath - Absolute path to the file
   * @param startLine - Starting line number (1-indexed)
   * @param endLine - Ending line number (1-indexed, inclusive)
   * @param scopeId - Read owner scope (usually an agent instance ID)
   * @returns Validation result with success status and message
   */
  validateLinesRead(
    filePath: string,
    startLine: number,
    endLine: number,
    scopeId?: string
  ): ValidationResult {
    const fileState = this.fileStates.get(this.key(filePath, scopeId));

    // If file has no read state, validation fails
    if (!fileState || fileState.readRanges.length === 0) {
      return this.createValidationError(
        `File has not been read: ${filePath}`,
        'validateLinesRead',
        `${startLine}-${endLine}`
      );
    }

    // Check if requested range is fully covered by read ranges
    const missingRanges: ReadRange[] = [];
    let currentLine = startLine;

    for (const range of fileState.readRanges) {
      // If there's a gap before this range
      if (currentLine < range.start && currentLine <= endLine) {
        // Add the gap as a missing range
        missingRanges.push({
          start: currentLine,
          end: Math.min(endLine, range.start - 1),
        });
      }

      // Move current line past this range
      if (range.end >= currentLine) {
        currentLine = range.end + 1;
      }

      // If we've covered the entire requested range, we're done
      if (currentLine > endLine) {
        break;
      }
    }

    // Check if there's a missing range at the end
    if (currentLine <= endLine) {
      missingRanges.push({
        start: currentLine,
        end: endLine,
      });
    }

    // Return result based on whether there are missing ranges
    if (missingRanges.length > 0) {
      const missingRangesStr = missingRanges
        .map(r => (r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`))
        .join(', ');

      return this.createValidationError(
        `Lines not read in ${filePath}: ${missingRangesStr}`,
        'validateLinesRead',
        missingRangesStr
      );
    }

    return {
      success: true,
      message: 'All lines have been read',
    };
  }

  /**
   * Invalidate read state after an edit that shifts line numbers
   *
   * Conservative approach:
   * - Ranges entirely before edit line are kept
   * - Ranges that include edit line are truncated
   * - Ranges entirely at or after edit line are removed
   *
   * @param filePath - Absolute path to the file
   * @param editLine - Line number where edit occurred (1-indexed)
   * @param lineDelta - Number of lines added (positive) or removed (negative)
   * @param scopeId - Read owner scope to invalidate
   */
  invalidateAfterEdit(filePath: string, editLine: number, lineDelta: number, scopeId?: string): void {
    // If no line shift, nothing to invalidate
    if (lineDelta === 0) {
      return;
    }

    const stateKey = this.key(filePath, scopeId);
    const fileState = this.fileStates.get(stateKey);
    if (!fileState) {
      return;
    }

    const newRanges: ReadRange[] = [];

    for (const range of fileState.readRanges) {
      if (range.end < editLine) {
        // Range is entirely before edit line - keep it
        newRanges.push(range);
      } else if (range.start < editLine && range.end >= editLine) {
        // Range includes edit line - truncate to before edit line
        newRanges.push({
          start: range.start,
          end: editLine - 1,
        });
      }
      // Ranges at or after edit line are removed (invalidated)
    }

    if (newRanges.length === 0) {
      // All ranges were invalidated - remove file state
      this.fileStates.delete(stateKey);
    } else {
      fileState.readRanges = newRanges;
    }
  }

  /**
   * Clear read state for a file.
   *
   * If no scope is provided, all scoped states for that file are cleared. This is
   * used after writes/edits because every agent's prior view of that file is stale.
   *
   * @param filePath - Absolute path to the file
   * @param scopeId - Optional read owner scope to clear
   */
  clearFile(filePath: string, scopeId?: string): void {
    if (scopeId) {
      this.fileStates.delete(this.key(filePath, scopeId));
      return;
    }

    for (const [key, state] of this.fileStates) {
      if (state.filePath === filePath) {
        this.fileStates.delete(key);
      }
    }
  }

  /**
   * Clear all read state for all files
   */
  reset(): void {
    this.fileStates.clear();
  }

  /**
   * Get the current read state for a file
   *
   * @param filePath - Absolute path to the file
   * @param scopeId - Read owner scope (usually an agent instance ID)
   * @returns Array of read ranges, or null if file has no read state
   */
  getReadState(filePath: string, scopeId?: string): ReadRange[] | null {
    const fileState = this.fileStates.get(this.key(filePath, scopeId));
    return fileState ? [...fileState.readRanges] : null;
  }

  /**
   * Add a range to an array of ranges, merging overlapping and adjacent ranges
   *
   * @param ranges - Existing array of ranges (must be sorted)
   * @param newRange - New range to add
   * @returns New array with merged ranges
   */
  private addRange(ranges: ReadRange[], newRange: ReadRange): ReadRange[] {
    if (ranges.length === 0) {
      return [newRange];
    }

    const result: ReadRange[] = [];
    let merged = false;
    let currentRange = { ...newRange };

    for (const range of ranges) {
      if (merged) {
        // Already merged, just add remaining ranges
        result.push(range);
      } else if (range.end < currentRange.start - 1) {
        // Range is entirely before current range (no overlap or adjacency)
        result.push(range);
      } else if (range.start > currentRange.end + 1) {
        // Range is entirely after current range (no overlap or adjacency)
        result.push(currentRange);
        result.push(range);
        merged = true;
      } else {
        // Ranges overlap or are adjacent - merge them
        currentRange = {
          start: Math.min(range.start, currentRange.start),
          end: Math.max(range.end, currentRange.end),
        };
      }
    }

    if (!merged) {
      result.push(currentRange);
    }

    return result;
  }
}
