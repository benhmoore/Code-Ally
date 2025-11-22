/**
 * Error handling and formatting utilities
 */

import type { ToolResult, ErrorType } from '../types/index.js';

/**
 * Format an unknown error value to a string message
 *
 * @param error - The error to format (can be Error, string, or any value)
 * @returns Formatted error message
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Create a structured error ToolResult
 * This enforces that all errors have error_details for clean extraction
 *
 * @param errorMessage - The error message
 * @param errorType - Type of error
 * @param toolName - Name of the tool that errored
 * @param parameters - Optional parameters that were passed
 * @returns Structured ToolResult with error_details
 */
export function createStructuredError(
  errorMessage: string | null | undefined,
  errorType: ErrorType,
  toolName: string | null | undefined,
  parameters?: Record<string, any>
): ToolResult {
  // Input validation: ensure non-empty errorMessage and toolName
  const safeErrorMessage = errorMessage?.trim() || 'Unknown error';
  const safeToolName = toolName?.trim() || 'unknown_tool';

  // Sanitize parameters to prevent circular reference issues in storage
  const sanitizedParams = parameters && Object.keys(parameters).length > 0
    ? Object.fromEntries(
        Object.entries(parameters).map(([k, v]) => {
          try {
            JSON.stringify(v); // Test if serializable
            return [k, v];
          } catch {
            // Replace non-serializable values with placeholder
            return [k, '[non-serializable]'];
          }
        })
      )
    : undefined;

  // Build formatted error string for backward compatibility
  let formattedError = safeErrorMessage;
  if (sanitizedParams) {
    // Format parameters for display
    const paramStr = Object.entries(sanitizedParams)
      .map(([k, v]) => {
        try {
          return `${k}=${JSON.stringify(v)}`;
        } catch {
          // Should not happen after sanitization, but defensive
          return `${k}=[error]`;
        }
      })
      .join(', ');
    formattedError = `${safeToolName}(${paramStr}): ${safeErrorMessage}`;
  } else {
    formattedError = `${safeToolName}(): ${safeErrorMessage}`;
  }

  return {
    success: false,
    error: formattedError,
    error_type: errorType,
    error_details: {
      message: safeErrorMessage,
      tool_name: safeToolName,
      parameters: sanitizedParams,
    },
  };
}

/**
 * Format an error with stack trace information
 *
 * @param error - The error to format
 * @returns Object with message and optional stack trace
 */
export function formatErrorWithStack(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

/**
 * Check if an error is a file not found error
 *
 * @param error - The error to check
 * @returns True if the error is ENOENT
 */
export function isFileNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Check if an error is a permission error
 *
 * @param error - The error to check
 * @returns True if the error is EACCES or EPERM
 */
export function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * Check if an error is a network error
 *
 * @param error - The error to check
 * @returns True if the error indicates network failure
 */
export function isNetworkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENOTFOUND';
}
