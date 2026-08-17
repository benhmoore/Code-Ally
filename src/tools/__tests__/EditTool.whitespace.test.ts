import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EditTool } from '@tools/EditTool.js';
import { ActivityStream } from '@services/ActivityStream.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ReadStateManager } from '@services/ReadStateManager.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/**
 * A multi-line old_string that differs from the file only in whitespace is the
 * single most common way an edit fails for a small model. Reporting the failure
 * without the file's real text sends it into a retry loop, which is exactly
 * what was observed in live 16k runs.
 */
describe('EditTool whitespace mismatch guidance', () => {
  let tool: EditTool;
  let dir: string;
  let file: string;
  let registry: ServiceRegistry;

  beforeEach(async () => {
    registry = ServiceRegistry.getInstance();
    registry['_services'].clear();
    registry['_descriptors'].clear();
    registry.registerInstance('read_state_manager', new ReadStateManager());
    tool = new EditTool(new ActivityStream());
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edit-ws-'));
    file = path.join(dir, 'World.js');
    await fs.writeFile(file, [
      'export default class World {',
      '  getBlock(x, y, z) {',
      '     return this.blocks[x];',
      '   }',
      '}',
      '',
    ].join('\n'));
    registry.get('read_state_manager')!.trackRead(file, 1, 6);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    registry['_services'].clear();
    registry['_descriptors'].clear();
  });

  it('quotes the file\'s exact text when only whitespace differs', async () => {
    const result = await tool.execute({
      file_path: file,
      edits: [{
        // Same code, conventional indentation — differs only in whitespace.
        old_string: '  getBlock(x, y, z) {\n    return this.blocks[x];\n  }',
        new_string: '  getBlock(x, y, z) {\n    return this.blocks[x] ?? 0;\n  }',
      }],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('copy this verbatim');
    // The file's real text, with its actual indentation, must be quoted back.
    expect(result.error).toContain('     return this.blocks[x];');
    expect(result.error).toContain('   }');
  });

  it('re-applying with the quoted text succeeds', async () => {
    const failure = await tool.execute({
      file_path: file,
      edits: [{
        old_string: '  getBlock(x, y, z) {\n    return this.blocks[x];\n  }',
        new_string: 'replaced',
      }],
    });
    const quoted = /- "([\s\S]*?)" \(exact text/.exec(failure.error ?? '')?.[1];
    expect(quoted).toBeTruthy();

    const retry = await tool.execute({
      file_path: file,
      edits: [{ old_string: quoted!, new_string: '  getBlock() { return 0; }' }],
    });

    expect(retry.success).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toContain('getBlock() { return 0; }');
  });

  it('stays silent when the whitespace-insensitive match is ambiguous', async () => {
    await fs.writeFile(file, [
      'const a = {',
      '  x: 1,',
      '};',
      'const b = {',
      '  x: 1,',
      '};',
      '',
    ].join('\n'));
    registry.get('read_state_manager')!.trackRead(file, 1, 7);

    const result = await tool.execute({
      file_path: file,
      edits: [{ old_string: '{\n      x: 1,\n}', new_string: '{ x: 2 }' }],
    });

    expect(result.success).toBe(false);
    // Two candidate spans: guessing one would edit code the caller never meant.
    expect(result.error).not.toContain('copy this verbatim');
  });
});
