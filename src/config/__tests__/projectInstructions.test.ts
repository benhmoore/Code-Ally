/**
 * Tests for project instructions file resolution (ALLY.md > CLAUDE.md > AGENTS.md)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  PROJECT_INSTRUCTION_FILES,
  resolveProjectInstructionFiles,
} from '../paths.js';

describe('resolveProjectInstructionFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ally-instructions-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty list when no instructions file exists', () => {
    expect(resolveProjectInstructionFiles(dir)).toEqual([]);
  });

  it('declares precedence as ALLY.md > CLAUDE.md > AGENTS.md', () => {
    expect(PROJECT_INSTRUCTION_FILES).toEqual(['ALLY.md', 'CLAUDE.md', 'AGENTS.md']);
  });

  it('resolves ALLY.md over CLAUDE.md and AGENTS.md', () => {
    writeFileSync(join(dir, 'ALLY.md'), 'ally');
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude');
    writeFileSync(join(dir, 'AGENTS.md'), 'agents');
    expect(resolveProjectInstructionFiles(dir)).toEqual([join(dir, 'ALLY.md')]);
  });

  it('falls back to CLAUDE.md when ALLY.md is absent', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'claude');
    writeFileSync(join(dir, 'AGENTS.md'), 'agents');
    expect(resolveProjectInstructionFiles(dir)).toEqual([join(dir, 'CLAUDE.md')]);
  });

  it('falls back to AGENTS.md when it is the only file present', () => {
    writeFileSync(join(dir, 'AGENTS.md'), 'agents');
    expect(resolveProjectInstructionFiles(dir)).toEqual([join(dir, 'AGENTS.md')]);
  });

  it('loads scoped instructions from repository root to the active directory', () => {
    mkdirSync(join(dir, '.git'));
    const nested = join(dir, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, 'ALLY.md'), 'root');
    writeFileSync(join(dir, 'packages', 'AGENTS.md'), 'package');
    writeFileSync(join(nested, 'CLAUDE.md'), 'app');

    expect(resolveProjectInstructionFiles(nested)).toEqual([
      join(dir, 'ALLY.md'),
      join(dir, 'packages', 'AGENTS.md'),
      join(nested, 'CLAUDE.md'),
    ]);
  });
});
