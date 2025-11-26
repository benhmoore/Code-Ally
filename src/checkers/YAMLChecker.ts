/**
 * YAML syntax checker using yaml library
 *
 * Checks YAML files for syntax errors using the yaml parsing library.
 */

import { FileChecker, CheckResult, CheckIssue } from './types.js';

export class YAMLChecker implements FileChecker {
  readonly name = 'yaml';

  private yamlAvailable: boolean | null = null;

  canCheck(filePath: string): boolean {
    return filePath.endsWith('.yaml') || filePath.endsWith('.yml');
  }

  async check(_filePath: string, content: string): Promise<CheckResult> {
    const start = performance.now();
    const errors: CheckIssue[] = [];

    // Check if yaml library is available
    if (!(await this.isYamlAvailable())) {
      const elapsed = performance.now() - start;
      return {
        checker: this.name,
        passed: true, // Can't check, assume valid
        errors: [],
        warnings: [],
        checkTimeMs: elapsed,
      };
    }

    try {
      // Dynamically import yaml library
      const yaml = await import('yaml');
      yaml.parse(content);
    } catch (error: any) {
      const issue = this.parseYAMLError(error);
      if (issue) {
        errors.push(issue);
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
   * Check if yaml library is available
   */
  private async isYamlAvailable(): Promise<boolean> {
    if (this.yamlAvailable !== null) {
      return this.yamlAvailable;
    }

    try {
      await import('yaml');
      this.yamlAvailable = true;
    } catch {
      this.yamlAvailable = false;
    }

    return this.yamlAvailable;
  }

  /**
   * Parse YAML error into CheckIssue
   */
  private parseYAMLError(error: any): CheckIssue | null {
    try {
      // yaml library errors have linePos property
      const line = error.linePos?.[0]?.line ?? 1;
      const column = error.linePos?.[0]?.col ?? undefined;
      const message = error.message || String(error);

      return {
        line,
        column,
        message,
        severity: 'error',
        code: 'yaml-syntax-error',
      };
    } catch {
      return {
        line: 1,
        message: String(error),
        severity: 'error',
        code: 'yaml-syntax-error',
      };
    }
  }
}
