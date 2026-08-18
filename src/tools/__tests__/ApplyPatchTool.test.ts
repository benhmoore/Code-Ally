import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ApplyPatchTool } from '../ApplyPatchTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ReadStateManager } from '../../services/ReadStateManager.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';

describe('ApplyPatchTool', () => {
  let directory: string;
  let tool: ApplyPatchTool;
  let reads: ReadStateManager;
  let registry: ServiceRegistry;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ally-apply-patch-'));
    registry = ServiceRegistry.getInstance();
    registry['_services'].clear();
    registry['_descriptors'].clear();
    reads = new ReadStateManager();
    registry.registerInstance('read_state_manager', reads);
    tool = new ApplyPatchTool(new ActivityStream());
  });

  afterEach(async () => {
    registry['_services'].clear();
    registry['_descriptors'].clear();
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function fixture(content = 'alpha\nbeta\ngamma\n'): Promise<string> {
    const file = path.join(directory, 'file.txt');
    await fs.writeFile(file, content);
    return file;
  }

  it('applies a patch after the exact target region was read', async () => {
    const file = await fixture();
    reads.trackRead(file, 1, 3);

    const result = await tool.execute({
      file_path: file,
      patch: '@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma',
    });

    expect(result.success).toBe(true);
    expect(result.hunks_applied).toBe(1);
    expect(result.diff).toContain('+BETA');
    expect(await fs.readFile(file, 'utf-8')).toBe('alpha\nBETA\ngamma\n');
  });

  it('rejects an unread target without changing the file', async () => {
    const file = await fixture();
    reads.trackRead(file, 1, 1);

    const result = await tool.execute({
      file_path: file,
      patch: '@@ -2,1 +2,1 @@\n-beta\n+BETA',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('unread lines 2-2');
    expect(result.suggestion).toContain('offset=2');
    expect(await fs.readFile(file, 'utf-8')).toBe('alpha\nbeta\ngamma\n');
  });

  it('validates the actual context location rather than trusting a stale line hint', async () => {
    const file = await fixture('prefix\ntarget\nold\n');
    reads.trackRead(file, 1, 1);

    const result = await tool.execute({
      file_path: file,
      patch: '@@ -1,2 +1,2 @@\n target\n-old\n+new',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('unread lines 2-3');
  });

  it('invalidates old reads and can deliberately track returned updated content', async () => {
    const file = await fixture();
    reads.trackRead(file, 1, 3, 'agent-a');
    reads.trackRead(file, 1, 3, 'agent-b');

    const first = await tool.execute(
      {
        file_path: file,
        patch: '@@ -2,1 +2,1 @@\n-beta\n+BETA',
        show_updated_context: true,
      },
      undefined,
      undefined,
      false,
      false,
      { agentId: 'agent-a' }
    );

    expect(first.success).toBe(true);
    expect(first.updated_content).toBe('alpha\nBETA\ngamma\n');
    expect(reads.getReadState(file, 'agent-a')).toEqual([{ start: 1, end: 4 }]);
    expect(reads.getReadState(file, 'agent-b')).toBeNull();
  });

  it('retains evidence for patch-authored lines so focused follow-up patches do not need a reread', async () => {
    const file = await fixture();
    reads.trackRead(file, 1, 3, 'agent-a');
    reads.trackRead(file, 1, 3, 'agent-b');

    const executeAsAgent = (patch: string) => tool.execute(
      { file_path: file, patch },
      undefined,
      undefined,
      false,
      false,
      { agentId: 'agent-a' }
    );
    const first = await executeAsAgent('@@ -2,1 +2,1 @@\n-beta\n+BETA');
    expect(first.success).toBe(true);
    expect(reads.getReadState(file, 'agent-a')).toEqual([{ start: 2, end: 2 }]);
    expect(reads.getReadState(file, 'agent-b')).toBeNull();

    const second = await executeAsAgent('@@ -2,1 +2,1 @@\n-BETA\n+final');
    expect(second.success).toBe(true);
    expect(await fs.readFile(file, 'utf-8')).toBe('alpha\nfinal\ngamma\n');
  });

  it('has one compact existing-file mutation contract', () => {
    const definition = tool.getFunctionDefinition().function;
    expect(tool.name).toBe('apply-patch');
    expect(definition.parameters.required).toEqual(['file_path', 'patch']);
    expect(definition.parameters.properties).not.toHaveProperty('edits');
    expect(definition.parameters.properties).not.toHaveProperty('overwrite');
  });

  it('rejects missing files and points creation to write', async () => {
    const result = await tool.execute({
      file_path: path.join(directory, 'missing.txt'),
      patch: '@@ -0,0 +1,1 @@\n+new',
    });
    expect(result.success).toBe(false);
    expect(result.suggestion).toContain('write');
  });
});
