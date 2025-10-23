/**
 * Error handling and formatting utilities
 */

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
