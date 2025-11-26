/**
 * JSON syntax checker using native JSON.parse
 *
 * Checks JSON files for syntax errors using Node.js's built-in JSON parser.
 */

import { FileChecker, CheckResult, CheckIssue } from './types.js';

export class JSONChecker implements FileChecker {
  readonly name = 'json';

  canCheck(filePath: string): boolean {
    return filePath.endsWith('.json');
  }

  async check(_filePath: string, content: string): Promise<CheckResult> {
    const start = performance.now();
    const errors: CheckIssue[] = [];

    try {
      JSON.parse(content);
    } catch (error) {
      if (error instanceof SyntaxError) {
        const issue = this.parseJSONError(error, content);
        if (issue) {
          errors.push(issue);
        }
      }
    }

    const elapsed = performance.now() - start;

    return {
      checker: this.name,
      passed: errors.length === 0,
      errors,
      warnings: [],
      checkTimeMs: elapsed,
    };
  }

  /**
   * Parse JSON.parse error into CheckIssue
   *
   * Extracts line/column information from SyntaxError message
   */
  private parseJSONError(error: SyntaxError, content: string): CheckIssue | null {
    const message = error.message;

    // Try to extract position from error message
    // Format varies: "Unexpected token } in JSON at position 123"
    const posMatch = message.match(/position (\d+)/);

    let line = 1;
    let column: number | undefined;

    if (posMatch && posMatch[1]) {
      const position = parseInt(posMatch[1], 10);
      // Calculate line and column from position
      const beforeError = content.substring(0, position);
      line = (beforeError.match(/\n/g) || []).length + 1;
      const lastNewline = beforeError.lastIndexOf('\n');
      column = position - lastNewline;
    }

    return {
      line,
      column,
      message: message || 'JSON syntax error',
      severity: 'error',
      code: 'json-syntax-error',
    };
  }
}
