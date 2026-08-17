import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { collectImportIssues } from '../moduleImports.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * The defect this exists for, observed in a live 16k run: after compaction the
 * model wrote `import { keyOf } from './chunk.js'` for a module that never
 * exported `keyOf`. Every per-file check passed; the app crashed on load.
 */
describe('collectImportIssues', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'module-imports-'));
    await fs.writeFile(path.join(dir, 'chunk.js'), [
      'export const CHUNK_SIZE = 16;',
      'export const WORLD_HEIGHT = 64;',
      'export class Chunk {}',
    ].join('\n'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('reports a named import the target does not export, and lists what it does', async () => {
    const file = path.join(dir, 'world.js');
    const content = "import { Chunk, CHUNK_SIZE, keyOf } from './chunk.js';\n";

    const issues = collectImportIssues(file, content);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain("does not export 'keyOf'");
    // The correction has to be actionable, so name the real exports.
    expect(issues[0]!.message).toContain('CHUNK_SIZE');
    expect(issues[0]!.severity).toBe('error');
    expect(issues[0]!.line).toBe(1);
  });

  it('accepts imports that do exist', async () => {
    const file = path.join(dir, 'world.js');
    const content = "import { Chunk, CHUNK_SIZE, WORLD_HEIGHT } from './chunk.js';\n";

    expect(collectImportIssues(file, content)).toEqual([]);
  });

  it('reports an unresolvable relative import', async () => {
    const file = path.join(dir, 'world.js');
    const content = "import { Mesher } from './mesher.js';\n";

    const issues = collectImportIssues(file, content);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('IMPORT_UNRESOLVED');
  });

  it('reports a default import from a module without one', async () => {
    const file = path.join(dir, 'world.js');
    const content = "import Chunk from './chunk.js';\n";

    const issues = collectImportIssues(file, content);

    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe('IMPORT_NO_DEFAULT');
  });

  it('ignores bare specifiers, which belong to the package manager', async () => {
    const file = path.join(dir, 'world.js');
    const content = "import * as THREE from 'three';\nimport { thing } from 'some-pkg';\n";

    expect(collectImportIssues(file, content)).toEqual([]);
  });

  it('stays silent when the target re-exports an open-ended surface', async () => {
    await fs.writeFile(path.join(dir, 'barrel.js'), "export * from './chunk.js';\n");
    const file = path.join(dir, 'world.js');
    const content = "import { anything, keyOf } from './barrel.js';\n";

    // `export *` means the surface cannot be refuted from this file alone;
    // a false accusation here would be worse than a missed one.
    expect(collectImportIssues(file, content)).toEqual([]);
  });

  it('handles aliased and default+named combinations', async () => {
    await fs.writeFile(path.join(dir, 'mod.js'), 'export default class M {}\nexport const helper = 1;\n');
    const file = path.join(dir, 'world.js');

    expect(collectImportIssues(file, "import M, { helper as h } from './mod.js';\n")).toEqual([]);
    expect(collectImportIssues(file, "import M, { missing } from './mod.js';\n")).toHaveLength(1);
  });

  it('resolves extensionless and directory-index specifiers', async () => {
    await fs.mkdir(path.join(dir, 'systems'));
    await fs.writeFile(path.join(dir, 'systems', 'index.js'), 'export const boot = 1;\n');
    const file = path.join(dir, 'world.js');

    expect(collectImportIssues(file, "import { boot } from './systems';\n")).toEqual([]);
    expect(collectImportIssues(file, "import { CHUNK_SIZE } from './chunk';\n")).toEqual([]);
  });
});
