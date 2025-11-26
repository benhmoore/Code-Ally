/**
 * Utility functions for automatic file checking after modifications
 *
 * Mirrors the FileCheckMixin pattern from Python CodeAlly
 */

import * as fs from 'fs/promises';
import { ensureRegistryInitialized, getDefaultRegistry } from '../checkers/CheckerRegistry.js';
import { BUFFER_SIZES } from '../config/constants.js';
import { logger } from '../services/Logger.js';

/**
 * Result of checking a file after modification
 */
export interface PostModificationCheckResult {
  checker: string;
  passed: boolean;
  errors: Array<{
    line: number;
    column?: number;
    message: string;
    source?: string;
    marker?: string;
  }>;
  additional_errors?: number;
  message?: string;
}

/**
 * Check a file after modification and return concise results
 *
 * Only includes errors (not warnings) and limits output to conserve context.
 * Matches Python CodeAlly's FileCheckMixin._check_file_after_modification()
 *
 * @param filePath - Path to file that was modified
 * @param enableChecking - Whether to run checking (default: true)
 * @returns Check results if checker available, null otherwise
 */
export async function checkFileAfterModification(
  filePath: string,
  enableChecking: boolean = true
): Promise<PostModificationCheckResult | null> {
  if (!enableChecking) {
    return null;
  }

  try {
    // Ensure registry is initialized
    await ensureRegistryInitialized();

    // Read current content
    const content = await fs.readFile(filePath, 'utf-8');

    // Get checker and run check
    const registry = getDefaultRegistry();
    const result = await registry.checkFile(filePath, content);

    if (!result) {
      // No checker available for this file type
      return null;
    }

    // Only include errors, not warnings (context optimization)
    // Limit to first 10 errors to avoid context overflow
    const errors = result.errors.slice(0, BUFFER_SIZES.MAX_ERROR_DISPLAY);
    const additionalErrorCount = Math.max(0, result.errors.length - BUFFER_SIZES.MAX_ERROR_DISPLAY);

    // Read content for error context
    const contentLines = content.split('\n');

    const formattedErrors = errors.map((error) => {
      const formatted: any = {
        line: error.line,
        message: error.message,
      };

      if (error.column) {
        formatted.column = error.column;
      }

      // Add source code context
      if (error.line && error.line >= 1 && error.line <= contentLines.length) {
        const errorLine = contentLines[error.line - 1];
        if (errorLine) {
          formatted.source = errorLine.trim();

          // Add column marker
          if (error.column && error.column > 0) {
            const originalLine = contentLines[error.line - 1];
            if (originalLine) {
              const leadingSpaces = originalLine.length - originalLine.trimStart().length;
              const markerPos = Math.max(0, error.column - leadingSpaces - 1);
              formatted.marker = ' '.repeat(markerPos) + '^';
            }
          }
        }
      }

      return formatted;
    });

    const checkResult: PostModificationCheckResult = {
      checker: result.checker,
      passed: result.passed,
      errors: formattedErrors,
    };

    // Add count of additional errors if truncated
    if (additionalErrorCount > 0) {
      checkResult.additional_errors = additionalErrorCount;
      checkResult.message = `Showing ${errors.length} of ${result.errors.length} errors. Fix these first.`;
    }

    return checkResult;
  } catch (error) {
    logger.warn('[fileCheckUtils] Error checking file after modification:', error);
    return null;
  }
}
