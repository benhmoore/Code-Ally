import { describe, expect, it } from 'vitest';
import { analyzeShellCommandPaths } from '../shellCommandPaths.js';

describe('analyzeShellCommandPaths', () => {
  it('extracts paths across pipelines without treating quoted regex syntax as shell syntax', () => {
    expect(analyzeShellCommandPaths(
      'grep -E "Test Files|Tests +[0-9]" /project/.ally/result.txt | tail -30',
    )).toEqual({
      absolutePaths: ['/project/.ally/result.txt'],
      hasParentTraversal: false,
      hasUnresolvedExpansion: false,
    });
  });

  it('extracts assignment and redirection paths', () => {
    expect(analyzeShellCommandPaths('dd if=/tmp/in of=/dev/sda > /tmp/log').absolutePaths).toEqual([
      '/tmp/in', '/dev/sda', '/tmp/log',
    ]);
  });

  it('authorizes a glob by its literal base', () => {
    expect(analyzeShellCommandPaths('rg needle /project/src/**/*.ts').absolutePaths).toEqual(['/project/src']);
  });

  it('rejects paths whose value depends on shell expansion', () => {
    expect(analyzeShellCommandPaths('cat "$HOME/.ssh/id_rsa"').hasUnresolvedExpansion).toBe(true);
    expect(analyzeShellCommandPaths('cat "$(secret_path)"').hasUnresolvedExpansion).toBe(true);
    expect(analyzeShellCommandPaths('cat "unterminated').hasUnresolvedExpansion).toBe(true);
  });

  it('detects literal parent traversal without matching unrelated dots', () => {
    expect(analyzeShellCommandPaths('cat ../secret').hasParentTraversal).toBe(true);
    expect(analyzeShellCommandPaths('grep "version..name" file').hasParentTraversal).toBe(false);
  });
});
