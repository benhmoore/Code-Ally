/**
 * Git utility functions
 */

import { execSync } from 'child_process';

/**
 * Get the current git branch name
 *
 * @returns The current branch name, or null if not in a git repo
 */
export function getGitBranch(): string | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return branch || null;
  } catch (error) {
    return null;
  }
}
