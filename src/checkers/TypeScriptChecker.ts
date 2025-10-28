/**
 * TypeScript syntax and type checker using tsc --noEmit
 *
 * Checks TypeScript files for syntax and type errors using the TypeScript compiler.
 * Automatically finds and uses nearest tsconfig.json for project-aware checking.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { FileChecker, CheckResult, CheckIssue } from './types.js';
import { API_TIMEOUTS } from '../config/constants.js';

export class TypeScriptChecker implements FileChecker {
  readonly name = 'typescript';

  private tscAvailable: boolean | null = null;
  private tsconfigCache = new Map<string, string | null>();
  private readonly useProjectConfig: boolean;

  constructor(useProjectConfig: boolean = true) {
    this.useProjectConfig = useProjectConfig;
  }

  canCheck(filePath: string): boolean {
    return filePath.endsWith('.ts') || filePath.endsWith('.tsx');
  }

  async check(filePath: string, content: string): Promise<CheckResult> {
    const start = performance.now();
    const errors: CheckIssue[] = [];

    if (!(await this.isTscAvailable())) {
      // tsc not available, return empty result
      const elapsed = performance.now() - start;
      return {
        checker: this.name,
        passed: true, // Can't check, assume valid
        errors: [],
        warnings: [],
        checkTimeMs: elapsed,
      };
    }

    // Find tsconfig.json if project-aware checking is enabled
    const tsconfigPath = this.useProjectConfig ? await this.findTsconfig(filePath) : null;

    try {
      if (tsconfigPath) {
        // Project-aware checking: check entire project and filter to this file
        const projectErrors = await this.checkWithProject(filePath, tsconfigPath);
        errors.push(...projectErrors);
      } else {
        // Standalone checking: check single file
        const standaloneErrors = await this.checkStandalone(filePath, content);
        errors.push(...standaloneErrors);
      }
    } catch (error) {
      console.warn(`[TypeScriptChecker] Check failed for ${filePath}:`, error);
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
   * Check if tsc is available in PATH
   */
  private async isTscAvailable(): Promise<boolean> {
    if (this.tscAvailable !== null) {
      return this.tscAvailable;
    }

    try {
      await this.runCommand('tsc', ['--version'], { timeout: API_TIMEOUTS.VERSION_CHECK });
      this.tscAvailable = true;
    } catch {
      this.tscAvailable = false;
    }

    return this.tscAvailable;
  }

  /**
   * Find nearest tsconfig.json by walking up directory tree
   */
  private async findTsconfig(filePath: string): Promise<string | null> {
    // Check cache first
    if (this.tsconfigCache.has(filePath)) {
      return this.tsconfigCache.get(filePath)!;
    }

    let currentDir = path.dirname(path.resolve(filePath));
    const root = path.parse(currentDir).root;

    while (currentDir !== root) {
      const tsconfigPath = path.join(currentDir, 'tsconfig.json');

      try {
        await fs.access(tsconfigPath);
        this.tsconfigCache.set(filePath, tsconfigPath);
        return tsconfigPath;
      } catch {
        // File doesn't exist, continue up the tree
      }

      const parent = path.dirname(currentDir);
      if (parent === currentDir) {
        break;
      }
      currentDir = parent;
    }

    // No tsconfig found
    this.tsconfigCache.set(filePath, null);
    return null;
  }

  /**
   * Check using project tsconfig.json
   */
  private async checkWithProject(filePath: string, tsconfigPath: string): Promise<CheckIssue[]> {
    const projectDir = path.dirname(tsconfigPath);
    const absFilePath = path.resolve(filePath);

    const { stdout } = await this.runCommand(
      'tsc',
      ['--noEmit', '--pretty', 'false', '--project', tsconfigPath],
      {
        cwd: projectDir,
        timeout: API_TIMEOUTS.TSC_PROJECT_CHECK_TIMEOUT,
      }
    );

    // Parse output and filter to only this file's errors
    const errors: CheckIssue[] = [];
    for (const line of stdout.split('\n')) {
      if (line.includes(absFilePath) && line.includes(': error TS')) {
        const error = this.parseTscErrorLine(line);
        if (error) {
          errors.push(error);
        }
      }
    }

    return errors;
  }

  /**
   * Check single file without project context
   */
  private async checkStandalone(filePath: string, content: string): Promise<CheckIssue[]> {
    // Write content to temporary file
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tsc-check-'));
    const ext = path.extname(filePath);
    const tmpPath = path.join(tmpDir, `check${ext}`);

    try {
      await fs.writeFile(tmpPath, content, 'utf-8');

      const { stdout } = await this.runCommand(
        'tsc',
        ['--noEmit', '--pretty', 'false', tmpPath],
        { timeout: API_TIMEOUTS.TSC_STANDALONE_CHECK_TIMEOUT }
      );

      // Parse tsc output
      const errors: CheckIssue[] = [];
      for (const line of stdout.split('\n')) {
        if (line.includes(': error TS')) {
          const error = this.parseTscErrorLine(line);
          if (error) {
            errors.push(error);
          }
        }
      }

      return errors;
    } finally {
      // Clean up temporary directory
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Parse a tsc error line into a CheckIssue
   *
   * Format: "file.ts(10,5): error TS####: message"
   */
  private parseTscErrorLine(line: string): CheckIssue | null {
    try {
      const posMatch = line.match(/\((\d+),(\d+)\)/);
      if (!posMatch) {
        return null;
      }

      const lineNum = parseInt(posMatch[1] || '1', 10);
      const colNum = parseInt(posMatch[2] || '1', 10);

      // Extract message after ": "
      const parts = line.split(': ');
      const message = parts.length > 2 ? parts.slice(2).join(': ') : line;

      // Extract error code
      const codeMatch = message.match(/error (TS\d+)/);

      return {
        line: lineNum,
        column: colNum,
        message,
        code: codeMatch ? codeMatch[1] : undefined,
        severity: 'error',
      };
    } catch (error) {
      console.warn('[TypeScriptChecker] Failed to parse error line:', line, error);
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
        // tsc returns non-zero on errors, but we still want the output
        resolve({ stdout, stderr });
      });

      proc.on('error', (error) => {
        if (timeout) clearTimeout(timeout);
        reject(error);
      });
    });
  }
}
