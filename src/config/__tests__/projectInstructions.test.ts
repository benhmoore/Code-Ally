/**
 * Tests for project instructions file resolution (ALLY.md > CLAUDE.md > AGENTS.md)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PROJECT_INSTRUCTION_FILES,
  resolveProjectInstructionsFile,
} from '../paths.js';

describe('resolveProjectInstructionsFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ally-instructions-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when no instructions file exists', () => {
    expect(resolveProjectInstructionsFile(dir)).toBeNull();
  });

  it('declares precedence as ALLY.md > CLAUDE.md > AGENTS.md', () => {
    expect(PROJECT_INSTRUCTION_FILES).toEqual(['ALLY.md', 'CLAUDE.md', 'AGENTS.md']);
  });

  it('resolves ALLY.md over CLAUDE.md and AGENTS.md', () => {
    writeFileSync(join(dir, 'ALLY.md'), 'ally');
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude');
    writeFileSync(join(dir, 'AGENTS.md'), 'agents');
    expect(resolveProjectInstructionsFile(dir)).toBe(join(dir, 'ALLY.md'));
  });

  it('falls back to CLAUDE.md when ALLY.md is absent', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude');
    writeFileSync(join(dir, 'AGENTS.md'), 'agents');
    expect(resolveProjectInstructionsFile(dir)).toBe(join(dir, 'CLAUDE.md'));
  });

  it('falls back to AGENTS.md when it is the only file present', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'agents');
    expect(resolveProjectInstructionsFile(dir)).toBe(join(dir, 'AGENTS.md'));
  });
});
