import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExactEditExperimentTool, PinnedApplyPatchTool } from '../ExactEditExperimentTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { ReadStateManager } from '../../services/ReadStateManager.js';
import { fileMutationCoordinator } from '../../services/FileMutationCoordinator.js';
import { PatchManager } from '../../services/PatchManager.js';
import { ActivityEventType } from '../../types/index.js';
import type { ToolExecutionContext } from '../../types/index.js';

const registry = ServiceRegistry.getInstance();
describe('runtime-only exact editing candidate', () => {
  let root: string;
  let file: string;
  let reads: ReadStateManager;
  let tool: ExactEditExperimentTool;
  let delegate: PinnedApplyPatchTool;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ally-exact-edit-test-'));
    file = join(root, 'source.txt');
    registry['_services'].clear();
    registry['_descriptors'].clear();
    reads = new ReadStateManager();
    registry.registerInstance('read_state_manager', reads);
    const stream = new ActivityStream();
    delegate = new PinnedApplyPatchTool(stream);
    tool = new ExactEditExperimentTool(stream, delegate);
    await writeFile(file, 'alpha\nbeta\ngamma\n');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    registry['_services'].clear();
    registry['_descriptors'].clear();
    await rm(root, { recursive: true, force: true });
  });
  const args = (file_path: string, old_text = 'beta', new_text = 'BETA') => ({ file_path, old_text, new_text });
  it('exposes an isolated exact schema and successful-only payload compaction contract', () => {
    expect(tool.getFunctionDefinition().function.parameters.required).toEqual(['file_path', 'old_text', 'new_text']);
    expect(delegate.getFunctionDefinition().function.parameters.required).toEqual(['file_path', 'patch']);
    expect(tool.argumentCompaction).toEqual({
      payloadPaths: [['old_text'], ['new_text']],
      durableReceipt: 'successful-tool-result',
    });
  });
  it('edits only an observed line without requiring reads of neighboring lines', async () => {
    reads.trackRead(file, 2, 2);
    expect((await tool.execute(args(file))).success).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('alpha\nBETA\ngamma\n');
  });
  it.each([
    { old_text: 'missing', new_text: 'new', error: 'not found' },
    { old_text: 'beta', new_text: 'beta', error: 'no changes' },
    { old_text: '', new_text: 'new', error: 'nonempty' },
    { old_text: 12, new_text: 'new', error: 'nonempty' },
    { old_text: 'beta', new_text: null, error: 'must be a string' },
  ])('rejects malformed or invalid edits without writes: $error', async input => {
    reads.trackRead(file, 1, 3);
    const { error, ...edit } = input;
    const result = await tool.execute({ file_path: file, ...edit });
    expect(result.success).toBe(false);
    expect(result.error).toContain(error);
    expect(await readFile(file, 'utf8')).toBe('alpha\nbeta\ngamma\n');
  });
  it.each([
    ['beta beta', 'beta'],
    ['aaa', 'aa'],
  ])('rejects duplicate and overlapping exact matches', async (source, old_text) => {
    await writeFile(file, source);
    reads.trackRead(file, 1, 1);
    expect((await tool.execute(args(file, old_text, 'new'))).error).toContain('multiple locations');
    expect(await readFile(file, 'utf8')).toBe(source);
  });
  it('rejects old unified-diff arguments instead of silently accepting a mixed interface', async () => {
    const result = await tool.execute({ ...args(file), patch: '@@ -1 +1 @@' });
    expect(result.error).toContain('do not send unified diff');
  });
  it('preserves exact Unicode and CRLF bytes', async () => {
    const original = 'α\r\nconst café = "界";\r\nΩ\r\n';
    await writeFile(file, original);
    reads.trackRead(file, 2, 2);
    const result = await tool.execute(args(file, '"界"', '"🦊"'));
    expect(result.success, result.error).toBe(true);
    expect(await readFile(file, 'utf8')).toBe(original.replace('"界"', '"🦊"'));
  });
  it('accepts logical LF source snippets for a CRLF target while retaining surrounding bytes', async () => {
    const original = 'prefix\r\nalpha\r\nbeta\r\nsuffix\r\n';
    await writeFile(file, original);
    reads.trackRead(file, 2, 3);
    const result = await tool.execute(args(file, 'alpha\nbeta', 'ALPHA\nBETA'));
    expect(result.success, result.error).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('prefix\r\nALPHA\r\nBETA\r\nsuffix\r\n');
  });
  it('retains mixed newline bytes outside the replaced region', async () => {
    const original = 'before\nalpha\r\nbeta\nafter\r\n';
    await writeFile(file, original);
    reads.trackRead(file, 2, 3);
    const result = await tool.execute(args(file, 'alpha\nbeta', 'ALPHA\nBETA'));
    expect(result.success, result.error).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('before\nALPHA\r\nBETA\nafter\r\n');
  });
  it('rejects invalid UTF-8 source without replacing the invalid bytes', async () => {
    const original = Buffer.from([0x61, 0xc3, 0x28, 0x62]);
    await writeFile(file, original);
    reads.trackRead(file, 1, 1);
    const result = await tool.execute(args(file, 'a', 'A'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('valid UTF-8');
    expect(await readFile(file)).toEqual(original);
  });
  it('rejects duplicate logical matches even when their raw EOL bytes differ', async () => {
    const original = 'alpha\nbeta\nalpha\r\nbeta\r\n';
    await writeFile(file, original);
    reads.trackRead(file, 1, 4);
    expect((await tool.execute(args(file, 'alpha\nbeta', 'new'))).error).toContain('multiple locations');
    expect(await readFile(file, 'utf8')).toBe(original);
  });
  it('never normalizes whitespace or Unicode to find an approximate match', async () => {
    await writeFile(file, 'const x = "café";\n');
    reads.trackRead(file, 1, 1);
    for (const old of ['const  x = "café";', 'const x = "café";'])
      expect((await tool.execute(args(file, old, 'new'))).success).toBe(false);
  });
  it('retains original external arguments while delegating validation and preview', async () => {
    reads.trackRead(file, 2, 2);
    const input = args(file);
    const before = JSON.stringify(input);
    const validate = vi.spyOn(delegate, 'validateBeforePermission');
    const preview = vi.spyOn(delegate, 'previewChanges');
    expect(await tool.validateBeforePermission(input)).toBeNull();
    await tool.previewChanges(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(validate.mock.calls[0][0]).toHaveProperty('patch');
    expect(preview.mock.calls[0][0]).toHaveProperty('patch');
    expect(input).not.toHaveProperty('patch');
  });
  it('previews through the active call ID, scoped stream, and agent read scope', async () => {
    reads.trackRead(file, 2, 2, 'preview-agent');
    const scopedEvents: any[] = [];
    const globalEmit = vi.spyOn((delegate as any).activityStream, 'emit');
    const context: ToolExecutionContext = {
      agentId: 'preview-agent',
      activityStream: { emit: event => scopedEvents.push(event) },
    };
    const preview = vi.spyOn(delegate, 'runPreview');
    await tool.runPreview(args(file), 'preview-call', context);
    expect(preview.mock.calls[0][1]).toBe('preview-call');
    expect(preview.mock.calls[0][2]).toBe(context);
    const event = scopedEvents.find(event => event.type === ActivityEventType.DIFF_PREVIEW);
    expect(event?.id).toBe('preview-call');
    expect(event?.data.newContent).toBe('alpha\nBETA\ngamma\n');
    expect(globalEmit).not.toHaveBeenCalled();
    const deniedEvents: any[] = [];
    await tool.runPreview(args(file), 'unread-call', {
      agentId: 'other-agent',
      activityStream: { emit: event => deniedEvents.push(event) },
    });
    expect(deniedEvents).toHaveLength(0);
  });
  it('does not preview an interrupted scoped turn', async () => {
    const controller = new AbortController();
    controller.abort();
    const preview = vi.spyOn(delegate, 'runPreview');
    await expect(
      tool.runPreview(args(file), 'cancelled', { turnInterruptionSignal: controller.signal })
    ).rejects.toThrow('interrupted');
    expect(preview).not.toHaveBeenCalled();
  });
  it('releases prepared source after a terminal execution failure', async () => {
    reads.trackRead(file, 2, 2);
    const input = args(file);
    expect(await tool.validateBeforePermission(input)).toBeNull();
    input.new_text = 'changed';
    expect((await tool.execute(input)).success).toBe(false);
    // A new operation with this argument object must not retain the failed snapshot.
    expect(await tool.validateBeforePermission(input)).toBeNull();
    expect((await tool.execute(input)).success).toBe(true);
  });
  it('rejects target mutation between permission validation and execution without rebasing', async () => {
    reads.trackRead(file, 1, 3);
    const input = args(file);
    expect(await tool.validateBeforePermission(input)).toBeNull();
    await writeFile(file, 'externally changed\nbeta\ngamma\n');
    const result = await tool.execute(input);
    expect(result.error).toContain('target changed after preparation');
    expect(await readFile(file, 'utf8')).toBe('externally changed\nbeta\ngamma\n');
  });
  it('retains the reviewed CAS baseline if the source changes during delegated execution', async () => {
    reads.trackRead(file, 1, 3);
    const input = args(file);
    expect(await tool.validateBeforePermission(input)).toBeNull();
    const execute = delegate.execute.bind(delegate);
    vi.spyOn(delegate, 'execute').mockImplementationOnce(async (...parameters) => {
      await writeFile(file, 'externally changed\nbeta\ngamma\n');
      return execute(...parameters);
    });
    const result = await tool.execute(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain('target changed after preparation');
    expect(await readFile(file, 'utf8')).toBe('externally changed\nbeta\ngamma\n');
  });
  it('retains the final atomic CAS when a concurrent writer wins after preparation', async () => {
    reads.trackRead(file, 1, 3);
    const run = fileMutationCoordinator.run.bind(fileMutationCoordinator);
    vi.spyOn(fileMutationCoordinator, 'run').mockImplementationOnce(async (path, operation) => {
      await writeFile(file, 'concurrent writer\n');
      return run(path, operation);
    });
    const result = await tool.execute(args(file));
    expect(result.success).toBe(false);
    expect(result.error).toContain('File changed');
    expect(await readFile(file, 'utf8')).toBe('concurrent writer\n');
  });
  it('rejects changed replacement args after the original action was validated', async () => {
    reads.trackRead(file, 2, 2);
    const input = args(file);
    expect(await tool.validateBeforePermission(input)).toBeNull();
    input.new_text = 'different';
    expect((await tool.execute(input)).error).toContain('arguments or target changed');
    expect(await readFile(file, 'utf8')).toBe('alpha\nbeta\ngamma\n');
  });
  it('requires read evidence owned by the executing agent', async () => {
    reads.trackRead(file, 2, 2, 'agent-a');
    const context = { agentId: 'agent-b' } as ToolExecutionContext;
    expect((await tool.execute(args(file), undefined, undefined, false, false, context)).success).toBe(false);
    const allowed = { agentId: 'agent-a' } as ToolExecutionContext;
    expect((await tool.execute(args(file), undefined, undefined, false, false, allowed)).success).toBe(true);
  });
  it('uses the real journal and supports undo through the underlying mutation pipeline', async () => {
    const sessions = join(root, 'sessions');
    await mkdir(sessions);
    const patches = new PatchManager({ getSessionId: () => 'session-test', sessionsDir: sessions });
    await patches.initialize();
    registry.registerInstance('patch_manager', patches);
    reads.trackRead(file, 2, 2);
    const result = await tool.execute(args(file));
    expect(result.success, result.error).toBe(true);
    expect(result.patch_number).toBeTypeOf('number');
    expect((await patches.undoOperations()).success).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('alpha\nbeta\ngamma\n');
  });
});
