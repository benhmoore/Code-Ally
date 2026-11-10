import { ReadTool } from '../../tools/ReadTool.js';
import { getBehaviorFixture } from '../../evals/behaviorFixtures.js';
import { MULTILINE_REQUEST_BUG } from '../../evals/multilineEditFixture.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApplyPatchTool } from '../../tools/ApplyPatchTool.js';
import { HistoricalUnifiedDiffTool } from '../../tools/HistoricalUnifiedDiffTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { ReadStateManager } from '../../services/ReadStateManager.js';
import { fileMutationCoordinator } from '../../services/FileMutationCoordinator.js';
import { PatchManager } from '../../services/PatchManager.js';
import { ActivityEventType } from '../../types/index.js';
import type { ToolExecutionContext } from '../../types/index.js';

const registry = ServiceRegistry.getInstance();
describe('production exact editing', () => {
  let root: string;
  let file: string;
  let reads: ReadStateManager;
  let tool: ApplyPatchTool;
  let stream: ActivityStream;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'ally-exact-edit-test-'));
    file = join(root, 'source.txt');
    registry['_services'].clear();
    registry['_descriptors'].clear();
    reads = new ReadStateManager();
    registry.registerInstance('read_state_manager', reads);
    stream = new ActivityStream();
    tool = new ApplyPatchTool(stream);
    await writeFile(file, 'alpha\nbeta\ngamma\n');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    registry['_services'].clear();
    registry['_descriptors'].clear();
    await rm(root, { recursive: true, force: true });
  });
  const args = (file_path: string, old_text = 'beta', new_text = 'BETA') => ({
    file_path,
    old_text,
    new_text,
  });
  it('exposes an isolated exact schema and successful-only payload compaction contract', () => {
    expect(tool.getFunctionDefinition().function.parameters.required).toEqual(['file_path', 'old_text', 'new_text']);
    expect(new HistoricalUnifiedDiffTool(stream).getFunctionDefinition().function.parameters.required).toEqual([
      'file_path',
      'patch',
    ]);
    expect(tool.argumentCompaction).toEqual({
      payloadPaths: [['patch'], ['old_text'], ['new_text']],
      durableReceipt: 'successful-tool-result',
    });
  });
  it('initializes an existing empty file only after real scoped ReadTool observation and supports undo', async () => {
    await writeFile(file, '');
    const context: ToolExecutionContext = { agentId: 'empty-editor' };
    const input = args(file, '', 'export const café = "東京";\n');
    expect((await tool.execute(input, undefined, undefined, false, false, context)).success).toBe(false);
    tool.releasePreparedInvocation(input);
    const read = new ReadTool(stream);
    expect((await read.execute({ file_path: file }, undefined, undefined, false, false, context)).success).toBe(true);
    expect(reads.validateLinesRead(file, 1, 1, 'empty-editor').success).toBe(true);
    expect(reads.validateLinesRead(file, 1, 1, 'other-agent').success).toBe(false);
    const sessions = join(root, 'empty-sessions');
    const patches = new PatchManager({
      getSessionId: () => 'empty-test',
      sessionsDir: sessions,
    });
    await patches.initialize();
    registry.registerInstance('patch_manager', patches);
    const result = await tool.execute(input, undefined, undefined, false, false, context);
    expect(result.success, result.error).toBe(true);
    expect(result.patch_number).toBeTypeOf('number');
    expect(await readFile(file, 'utf8')).toBe(input.new_text);
    expect((await patches.undoOperations()).success).toBe(true);
    expect(await readFile(file)).toEqual(Buffer.alloc(0));
  });
  it('does not borrow another agent’s observation of an empty file', async () => {
    await writeFile(file, '');
    const read = new ReadTool(stream);
    await read.execute({ file_path: file }, undefined, undefined, false, false, { agentId: 'reader' });
    const result = await tool.execute(args(file, '', 'new'), undefined, undefined, false, false, { agentId: 'other' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('unread');
    expect(await readFile(file, 'utf8')).toBe('');
  });
  it('rejects a no-op empty initialization and preserves concurrent writes after empty-file preparation', async () => {
    await writeFile(file, '');
    const read = new ReadTool(stream);
    await read.execute({ file_path: file });
    expect((await tool.execute(args(file, '', ''))).success).toBe(false);
    const input = args(file, '', 'intended');
    expect(await tool.validateBeforePermission(input)).toBeNull();
    await writeFile(file, 'concurrent');
    const result = await tool.execute(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain('File changed');
    expect(await readFile(file, 'utf8')).toBe('concurrent');
  });
  it('edits only an observed line without requiring reads of neighboring lines', async () => {
    reads.trackRead(file, 2, 2);
    expect((await tool.execute(args(file))).success).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('alpha\nBETA\ngamma\n');
  });
  it.each([
    { old_text: 'missing', new_text: 'new', error: 'not found' },
    { old_text: 'beta', new_text: 'beta', error: 'no changes' },
    { old_text: '', new_text: 'new', error: 'only for an empty file' },
    { old_text: 12, new_text: 'new', error: 'must be a string' },
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
  it('retains original external arguments during preparation and preview', async () => {
    reads.trackRead(file, 2, 2);
    const input = args(file);
    const before = JSON.stringify(input);
    expect(await tool.validateBeforePermission(input)).toBeNull();
    await tool.runPreview(input, 'original-args');
    expect(JSON.stringify(input)).toBe(before);
    expect(input).not.toHaveProperty('patch');
  });
  it('previews through the active call ID, scoped stream, and agent read scope', async () => {
    reads.trackRead(file, 2, 2, 'preview-agent');
    const scopedEvents: any[] = [];
    const globalEmit = vi.spyOn(stream, 'emit');
    const context: ToolExecutionContext = {
      agentId: 'preview-agent',
      activityStream: { emit: event => scopedEvents.push(event) },
    };
    await tool.runPreview(args(file), 'preview-call', context);
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
  it('does not emit a preview for an interrupted scoped turn', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: unknown[] = [];
    await tool.runPreview(args(file), 'cancelled', {
      turnInterruptionSignal: controller.signal,
      activityStream: { emit: event => events.push(event) },
    });
    expect(events).toHaveLength(0);
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
    expect(result.error).toContain('File changed');
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
    expect((await tool.execute(input)).error).toContain('arguments changed');
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
    const patches = new PatchManager({
      getSessionId: () => 'session-test',
      sessionsDir: sessions,
    });
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

describe('prepared exact editor lifecycle and publication', () => {
  let directory: string;
  let file: string;
  let tool: ApplyPatchTool;
  let reads: ReadStateManager;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'prepared-edit-'));
    file = join(directory, 'file.txt');
    registry['_services'].clear();
    registry['_descriptors'].clear();
    reads = new ReadStateManager();
    registry.registerInstance('read_state_manager', reads);
    tool = new ApplyPatchTool(new ActivityStream());
    await writeFile(file, 'alpha\nbeta\ngamma\n');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    registry['_services'].clear();
    registry['_descriptors'].clear();
    await rm(directory, { recursive: true, force: true });
  });
  it('prepares source once across preview, validation, and execution, then releases it', async () => {
    const input = { file_path: file, old_text: 'beta', new_text: 'BETA' };
    reads.trackRead(file, 2, 2);
    const decode = vi.spyOn(tool as any, 'decodeSource');
    await tool.runPreview(input, 'same-invocation');
    expect(await tool.validateBeforePermission(input)).toBeNull();
    expect((await tool.execute(input)).success).toBe(true);
    expect(decode).toHaveBeenCalledTimes(1);
    input.old_text = 'BETA';
    input.new_text = 'new operation';
    expect(await tool.validateBeforePermission(input)).toBeNull();
    expect(decode).toHaveBeenCalledTimes(2);
    tool.releasePreparedInvocation(input);
  });
  it('rejects argument mutation while the initial source await is in flight', async () => {
    const input = { file_path: file, old_text: 'beta', new_text: 'BETA' };
    reads.trackRead(file, 2, 2);
    const decode = (tool as any).decodeSource.bind(tool);
    vi.spyOn(tool as any, 'decodeSource').mockImplementationOnce((bytes: Uint8Array) => {
      input.new_text = 'not the proposed replacement';
      return decode(bytes);
    });
    const result = await tool.execute(input);
    expect(result.success).toBe(false);
    expect(result.error).toContain('arguments changed during preparation');
    expect(await readFile(file, 'utf8')).toContain('beta');
  });
  it('requires both boundary lines before deleting a newline that joins unseen text', async () => {
    const input = { file_path: file, old_text: 'beta\n', new_text: 'BETA' };
    reads.trackRead(file, 2, 2, 'owner');
    const context = { agentId: 'owner' };
    expect((await tool.execute(input, undefined, undefined, false, false, context)).success).toBe(false);
    reads.trackRead(file, 3, 3, 'owner');
    expect((await tool.execute(input, undefined, undefined, false, false, context)).success).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('alpha\nBETAgamma\n');
  });
  it('supports a pure line insertion using only read credit for its replaced anchor', async () => {
    reads.trackRead(file, 2, 2, 'owner');
    reads.trackRead(file, 1, 3, 'other');
    const invalidated = vi.fn();
    registry.registerInstance('read_cache', { invalidate: invalidated } as any);
    const result = await tool.execute(
      { file_path: file, old_text: 'beta', new_text: 'BETA\ninserted' },
      undefined,
      undefined,
      false,
      false,
      { agentId: 'owner' }
    );
    expect(result.success, result.error).toBe(true);
    expect(result.content).toBe(`Updated ${file}`);
    expect(result.system_reminder).toContain('through this edit');
    expect(reads.getReadState(file, 'owner')).toEqual([{ start: 2, end: 3 }]);
    expect(reads.getReadState(file, 'other')).toBeNull();
    expect(invalidated).toHaveBeenCalledWith(file);
    expect(await readFile(file, 'utf8')).toBe('alpha\nBETA\ninserted\ngamma\n');
  });
  it('releases preparation after an aborted direct execute without writing', async () => {
    const input = { file_path: file, old_text: 'beta', new_text: 'BETA' };
    reads.trackRead(file, 2, 2);
    expect(await tool.validateBeforePermission(input)).toBeNull();
    const released = vi.spyOn(tool, 'releasePreparedInvocation');
    const controller = new AbortController();
    controller.abort();
    expect((await tool.execute(input, undefined, controller.signal)).success).toBe(false);
    expect(released).toHaveBeenCalledWith(input);
    expect(await readFile(file, 'utf8')).toContain('beta');
  });
  it('does not rebase a second prepared edit when another concurrent invocation wins', async () => {
    reads.trackRead(file, 1, 3);
    const first = { file_path: file, old_text: 'beta', new_text: 'BETA' };
    const second = { file_path: file, old_text: 'gamma', new_text: 'GAMMA' };
    expect(await tool.validateBeforePermission(first)).toBeNull();
    expect(await tool.validateBeforePermission(second)).toBeNull();
    const results = await Promise.all([tool.execute(first), tool.execute(second)]);
    expect(results.filter(result => result.success)).toHaveLength(1);
    expect(results.find(result => !result.success)?.error).toContain('File changed');
    expect(await readFile(file, 'utf8')).toBe(results[0]!.success ? 'alpha\nBETA\ngamma\n' : 'alpha\nbeta\nGAMMA\n');
  });
  it('checks interruption again inside the final CAS gate before any write', async () => {
    reads.trackRead(file, 2, 2);
    const controller = new AbortController();
    const run = fileMutationCoordinator.run.bind(fileMutationCoordinator);
    vi.spyOn(fileMutationCoordinator, 'run').mockImplementationOnce(async (path, operation) => {
      controller.abort();
      return run(path, operation);
    });
    const result = await tool.execute(
      { file_path: file, old_text: 'beta', new_text: 'BETA' },
      undefined,
      controller.signal
    );
    expect(result.success).toBe(false);
    expect(result.error_type).toBe('interrupted');
    expect(await readFile(file, 'utf8')).toBe('alpha\nbeta\ngamma\n');
  });
  it('edits the real CRLF multiline fixture without a diff conversion and passes the unchanged verifier', async () => {
    const fixture = getBehaviorFixture('multiline-edit');
    await fixture.setup(directory);
    const target = join(directory, 'src/client-options.js');
    const source = await readFile(target, 'utf8');
    reads.trackRead(target, 1, source.split('\n').length);
    const input = {
      file_path: target,
      old_text: MULTILINE_REQUEST_BUG,
      new_text: `export function normalizeRequestOptions(options = {}, defaults = REQUEST_DEFAULTS) {
  const retry = options.retry === undefined ? {} : options.retry;
  const choose = (value, fallback) => value === undefined ? fallback : value;
  return {
    enabled: choose(options.enabled, defaults.enabled),
    label: choose(options.label, defaults.label),
    timeoutMs: choose(options.timeoutMs, defaults.timeoutMs),
    retry: {
      attempts: choose(retry.attempts, defaults.retry.attempts),
      delayMs: choose(retry.delayMs, defaults.retry.delayMs),
    },
    headers: { ...defaults.headers, ...options.headers },
  };
}`,
    };
    await tool.runPreview(input, 'multiline');
    expect(await tool.validateBeforePermission(input)).toBeNull();
    const result = await tool.execute(input);
    expect(result.success, result.error).toBe(true);
    expect(await fixture.verify(directory)).toMatchObject({ passed: true });
  });
});
