/**
 * JavaScript syntax checker using node --check
 *
 * Checks JavaScript files for syntax errors using Node.js's built-in syntax checker.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { FileChecker, CheckResult, CheckIssue } from './types.js';
import { API_TIMEOUTS } from '../config/constants.js';
import { logger } from '../services/Logger.js';

export class JavaScriptChecker implements FileChecker {
  readonly name = 'javascript';

  private nodeAvailable: boolean | null = null;

  canCheck(filePath: string): boolean {
    return (
      filePath.endsWith('.js') ||
      filePath.endsWith('.jsx') ||
      filePath.endsWith('.mjs') ||
      filePath.endsWith('.cjs')
    );
  }

  async check(filePath: string, content: string): Promise<CheckResult> {
    const start = performance.now();
    const errors: CheckIssue[] = [];

    if (!(await this.isNodeAvailable())) {
      // Node not available, return empty result
      const elapsed = performance.now() - start;
      return {
        checker: this.name,
        passed: true, // Can't check, assume valid
        errors: [],
        warnings: [],
        checkTimeMs: elapsed,
      };
    }

    // Write content to temporary file
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-check-'));
    const ext = path.extname(filePath);
    const tmpPath = path.join(tmpDir, `check${ext}`);

    try {
      await fs.writeFile(tmpPath, content, 'utf-8');

      const { stderr } = await this.runCommand('node', ['--check', tmpPath], {
        timeout: API_TIMEOUTS.NODE_SYNTAX_CHECK_TIMEOUT,
      });

      // Parse node --check output (errors go to stderr)
      if (stderr) {
        const error = this.parseNodeError(stderr);
        if (error) {
          errors.push(error);
        }
      }
    } catch (error) {
      logger.warn(`[JavaScriptChecker] Check failed for ${filePath}:`, error);
    } finally {
      // Clean up temporary directory
      await fs.rm(tmpDir, { recursive: true, force: true }).catch((error) => {
        logger.debug(`Failed to clean up temporary directory ${tmpDir}:`, error);
      });
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
   * Check if node is available
   */
  private async isNodeAvailable(): Promise<boolean> {
    if (this.nodeAvailable !== null) {
      return this.nodeAvailable;
    }

    try {
      await this.runCommand('node', ['--version'], { timeout: API_TIMEOUTS.VERSION_CHECK });
      this.nodeAvailable = true;
    } catch {
      this.nodeAvailable = false;
    }

    return this.nodeAvailable;
  }

  /**
   * Parse node --check error output
   *
   * Format: "file.js:10\n  error message\n  ^\nSyntaxError: ..."
   */
  private parseNodeError(stderr: string): CheckIssue | null {
    try {
      // Extract line number from first line
      const lineMatch = stderr.match(/:(\d+)/);
      const lineNum = lineMatch && lineMatch[1] ? parseInt(lineMatch[1], 10) : 1;

      // Extract error message (usually after "SyntaxError:" or similar)
      const errorMatch = stderr.match(/(SyntaxError|ReferenceError|TypeError):\s*(.+)/);
      const message = errorMatch && errorMatch[2] ? errorMatch[2].trim() : stderr.split('\n')[0] || 'Unknown error';

      return {
        line: lineNum,
        message,
        severity: 'error',
        code: 'syntax-error',
      };
    } catch (error) {
      logger.warn('[JavaScriptChecker] Failed to parse error:', error);
      return null;
    }
  }

  /**
   * Run a command and capture output
   */
  private runCommand(
    command: string,
    args: string[],
    options: { cwd?: string; timeout?: number } = {}
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: options.cwd,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      const timeout = options.timeout
        ? setTimeout(() => {
            proc.kill();
            reject(new Error('Command timeout'));
          }, options.timeout)
        : null;

      proc.on('close', () => {
        if (timeout) clearTimeout(timeout);
        resolve({ stdout, stderr });
      });

      proc.on('error', (error) => {
        if (timeout) clearTimeout(timeout);
        reject(error);
      });
    });
  }
}
