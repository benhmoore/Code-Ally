/**
 * Checker utility functions
 *
 * Shared helpers for running external checker commands.
 */

import { spawn } from 'child_process';

/**
 * Run a command and capture output
 */
export function runCommand(
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
      // Checker commands may return non-zero on errors, but we still want the output
      resolve({ stdout, stderr });
    });

    proc.on('error', (error) => {
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
  });
}
