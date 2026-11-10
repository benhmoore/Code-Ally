import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolOrchestrator } from '../ToolOrchestrator.js';
import { TrustManager } from '../TrustManager.js';
import { ApplyPatchTool } from '../../tools/ApplyPatchTool.js';
import { ToolManager } from '../../tools/ToolManager.js';
import { PermissionManager } from '../../security/PermissionManager.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ReadStateManager } from '../../services/ReadStateManager.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { FormCancelledError } from '../../services/FormManager.js';
import {
  ActivityEventType,
  type ActivityEvent,
  type Message,
  type PermissionDecision,
  type ToolCall,
} from '../../types/index.js';

const original = 'alpha\nbeta\ngamma\n';
describe('prepared editor through real orchestration and permission', () => {
  let directory: string;
  let file: string;
  let stream: ActivityStream;
  let reads: ReadStateManager;
  let tool: ApplyPatchTool;
  let manager: ToolManager;
  let trust: TrustManager;
  let permissions: PermissionManager;
  let orchestrator: ToolOrchestrator;
  let events: ActivityEvent[];
  let approve: (args: Record<string, unknown>) => Promise<'allow' | 'deny'>;
  const registry = ServiceRegistry.getInstance();
  beforeEach(async () => {
    registry['_services'].clear();
    registry['_descriptors'].clear();
    directory = await mkdtemp(join(tmpdir(), 'orchestrated-edit-'));
    file = join(directory, 'target.txt');
    await writeFile(file, original);
    reads = new ReadStateManager();
    reads.trackRead(file, 1, 3, 'scoped-owner');
    registry.registerInstance('read_state_manager', reads);
    stream = new ActivityStream().createScoped('fleet-parent');
    events = [];
    stream.subscribe('*', event => events.push(event));
    tool = new ApplyPatchTool(stream);
    manager = new ToolManager([tool]);
    trust = new TrustManager('auto', stream);
    approve = async () => 'allow';
    trust.setPermissionPolicy({
      getSnapshot: () => ({ requestedMode: 'auto', effectiveMode: 'auto' }),
      evaluate: async ({ toolName, args }: any): Promise<PermissionDecision> => ({
        toolName,
        verdict: await approve(args),
        reason: 'Fixture decision',
        source: 'reviewer',
        timestamp: Date.now(),
      }),
    } as any);
    permissions = new PermissionManager(trust);
    const messages: Message[] = [];
    const agent = {
      getInstanceId: () => 'scoped-owner',
      getAgentName: () => 'test',
      addMessage: (message: Message) => messages.push(message),
      getMaxDuration: () => undefined,
      getAgentDepth: () => 0,
      getToolAbortSignal: () => undefined,
      getTurnStartTime: () => undefined,
      generateCheckpointReminder: () => null,
      getTokenManager: () => ({ trackToolResult: () => null }),
      resetToolCallActivity: () => {},
    };
    orchestrator = new ToolOrchestrator(
      manager,
      stream,
      agent as any,
      { config: { parallel_tools: true }, isSpecializedAgent: false } as any,
      undefined,
      permissions
    );
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    trust.cleanup();
    registry['_services'].clear();
    registry['_descriptors'].clear();
    await rm(directory, { recursive: true, force: true });
  });
  const call = (file_path: string): ToolCall => ({
    id: 'edit-call',
    type: 'function',
    function: { name: 'apply-patch', arguments: { file_path, old_text: 'beta', new_text: 'BETA' } },
  });
  const previews = () => events.filter(event => event.type === ActivityEventType.DIFF_PREVIEW);

  it('pins the preview source across approval even when old_text still matches an external edit', async () => {
    const external = 'external prefix\nbeta\ngamma\n';
    approve = async () => {
      expect(previews()).toHaveLength(1);
      await writeFile(file, external);
      return 'allow';
    };
    const result = (await orchestrator.executeToolCalls([call(file)]))[0]!;
    expect(result.success).toBe(false);
    expect(result.error).toContain('File changed');
    expect(await readFile(file, 'utf8')).toBe(external);
    expect(previews()[0]?.id).toBe('edit-call');
    expect(previews()[0]?.parentId).toBe('fleet-parent');
    expect(previews()[0]?.data.oldContent).toBe(original);
  });
  it('uses one frozen argument identity for preview, validation, permission, execution and terminal release', async () => {
    const preview = vi.spyOn(tool, 'runPreview');
    const validate = vi.spyOn(tool, 'validateBeforePermission');
    const permission = vi.spyOn(permissions, 'checkPermission');
    const execute = vi.spyOn(tool, 'execute');
    const release = vi.spyOn(tool, 'releasePreparedInvocation');
    const decode = vi.spyOn(tool as any, 'decodeSource');
    const input = call(file);
    const result = (await orchestrator.executeToolCalls([input]))[0]!;
    expect(result.success, result.error).toBe(true);
    const args = preview.mock.calls[0]![0];
    expect(args).not.toBe(input.function.arguments);
    expect(Object.isFrozen(args)).toBe(true);
    expect(validate.mock.calls[0]![0]).toBe(args);
    expect(permission.mock.calls[0]![1]).toBe(args);
    expect(execute.mock.calls[0]![0]).toBe(args);
    expect(release.mock.calls.every(([released]) => released === args)).toBe(true);
    expect(decode).toHaveBeenCalledTimes(1);
  });
  it('releases the exact preview preparation after permission denial', async () => {
    approve = async () => 'deny';
    const preview = vi.spyOn(tool, 'runPreview');
    const release = vi.spyOn(tool, 'releasePreparedInvocation');
    const decode = vi.spyOn(tool as any, 'decodeSource');
    const result = (await orchestrator.executeToolCalls([call(file)]))[0]!;
    expect(result.success).toBe(false);
    const args = preview.mock.calls[0]![0];
    expect(release).toHaveBeenCalledExactlyOnceWith(args);
    expect(await tool.validateBeforePermission(args, preview.mock.calls[0]![2])).toBeNull();
    expect(decode).toHaveBeenCalledTimes(2);
    tool.releasePreparedInvocation(args);
    expect(await readFile(file, 'utf8')).toBe(original);
  });
  it('previews and validates only the final hook-selected target', async () => {
    const changed = join(directory, 'hook-target.txt');
    await writeFile(changed, 'hook prefix\nbeta\n');
    reads.trackRead(changed, 1, 2, 'scoped-owner');
    registry.registerInstance('hook_runner', {
      hasHooks: (name: string) => name === 'PreToolUse',
      run: vi.fn(async () => ({
        kind: 'proceed',
        updatedInput: { file_path: changed, old_text: 'beta', new_text: 'HOOK' },
      })),
    } as any);
    const validate = vi.spyOn(tool, 'validateBeforePermission');
    const result = (await orchestrator.executeToolCalls([call(file)]))[0]!;
    expect(result.success, result.error).toBe(true);
    expect(previews()).toHaveLength(1);
    expect(previews()[0]?.data.filePath).toBe(changed);
    expect(previews()[0]?.data.oldContent).toBe('hook prefix\nbeta\n');
    expect(validate.mock.calls[0]![0].file_path).toBe(changed);
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readFile(changed, 'utf8')).toBe('hook prefix\nHOOK\n');
  });
  it('rejects an unread hook-selected target before permission or writing', async () => {
    const changed = join(directory, 'unread.txt');
    await writeFile(changed, 'beta\n');
    registry.registerInstance('hook_runner', {
      hasHooks: (name: string) => name === 'PreToolUse',
      run: async () => ({ kind: 'proceed', updatedInput: { file_path: changed, old_text: 'beta', new_text: 'HOOK' } }),
    } as any);
    const permission = vi.spyOn(permissions, 'checkPermission');
    const result = (await orchestrator.executeToolCalls([call(file)]))[0]!;
    expect(result.success).toBe(false);
    expect(result.error).toContain('unread');
    expect(permission).not.toHaveBeenCalled();
    expect(previews()).toHaveLength(0);
    expect(await readFile(changed, 'utf8')).toBe('beta\n');
  });
  it('resolves a form replacement before preview, validation, and approval', async () => {
    Object.defineProperty(tool, 'supportsInteractiveForm', { value: true });
    Object.defineProperty(tool, 'formSchema', { value: { title: 'edit', fields: [] } });
    registry.registerInstance('form_manager', { requestForm: vi.fn(async () => ({ new_text: 'FORM' })) } as any);
    const validate = vi.spyOn(tool, 'validateBeforePermission');
    const result = (await orchestrator.executeToolCalls([call(file)]))[0]!;
    expect(result.success, result.error).toBe(true);
    expect(previews()[0]?.data.newContent).toBe('alpha\nFORM\ngamma\n');
    expect(validate.mock.calls[0]![0].new_text).toBe('FORM');
    expect(await readFile(file, 'utf8')).toBe('alpha\nFORM\ngamma\n');
  });
  it.each(['disallowed', 'hook', 'form'] as const)(
    'does not prepare or request approval after %s rejection',
    async mode => {
      if (mode === 'disallowed') {
        trust.setRunAuthorizationPolicy({ disallowed_tools: ['apply-patch'] });
        registry.registerInstance('trust_manager', trust);
      }
      if (mode === 'hook')
        registry.registerInstance('hook_runner', {
          hasHooks: (name: string) => name === 'PreToolUse',
          run: async () => ({ kind: 'block', reason: 'Blocked edit' }),
        } as any);
      if (mode === 'form') {
        Object.defineProperty(tool, 'supportsInteractiveForm', { value: true });
        Object.defineProperty(tool, 'formSchema', { value: { title: 'edit', fields: [] } });
        registry.registerInstance('form_manager', {
          requestForm: async () => {
            throw new FormCancelledError('apply-patch');
          },
        } as any);
      }
      const preview = vi.spyOn(tool, 'runPreview');
      const permission = vi.spyOn(permissions, 'checkPermission');
      const result = (await orchestrator.executeToolCalls([call(file)]))[0]!;
      expect(result.success).toBe(false);
      expect(preview).not.toHaveBeenCalled();
      expect(permission).not.toHaveBeenCalled();
      expect(await readFile(file, 'utf8')).toBe(original);
    }
  );
});
