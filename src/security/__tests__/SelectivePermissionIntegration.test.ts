import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrustManager, PermissionChoice, TrustScope } from '../../agent/TrustManager.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ActivityEventType as E } from '../../types/index.js';
import { PermissionManager } from '../PermissionManager.js';
import { PermissionDeniedError, PolicyDeniedError } from '../PathSecurity.js';
import type { BaseTool } from '../../tools/BaseTool.js';
import type { PermissionPolicyService } from '../../services/PermissionPolicyService.js';
import { RunPolicyManager } from '../../services/RunPolicyManager.js';
import { AskUserQuestionTool } from '../../tools/AskUserQuestionTool.js';
import { classifyAutoAction } from '../AutoActionPolicy.js';
import { createBuiltInTools } from '../../tools/createBuiltInTools.js';
import { DEFAULT_CONFIG } from '../../config/defaults.js';
import { ToolCapability } from '../../tools/ToolCapability.js';
const owners: TrustManager[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.cleanup();
});
function fixture() {
  const stream = new ActivityStream();
  const trust = new TrustManager('auto', stream);
  owners.push(trust);
  const evaluate = vi.fn(async () => ({ verdict: 'allow', reason: 'bounded' }));
  trust.setPermissionPolicy({
    getSnapshot: () => ({ requestedMode: 'auto', effectiveMode: 'auto' }),
    evaluate,
  } as unknown as PermissionPolicyService);
  return { stream, trust, evaluate };
}
const context = { requiresConfirmation: true, workspaceRoot: process.cwd(), task: 'Update src/example.ts.' };

function useClassifier(evaluate: ReturnType<typeof vi.fn>) {
  evaluate.mockImplementation(async (input: Parameters<typeof classifyAutoAction>[0]) => {
    const decision = await classifyAutoAction(input);
    return { verdict: decision.kind === 'review' ? 'ask' : decision.kind, reason: decision.reason };
  });
}

function denyPrompts(stream: ActivityStream) {
  const prompt = vi.fn(event => stream.emit({ id: 'deny', type: E.PERMISSION_RESPONSE, timestamp: Date.now(),
    data: { requestId: event.data.requestId, choice: PermissionChoice.DENY } }));
  stream.subscribe(E.PERMISSION_REQUEST, prompt);
  return prompt;
}

describe('one permission authority across modes and tools', () => {
  it.each(['agent', 'explore', 'plan', 'ask-user-question', 'todo-write', 'read-history', 'read-checkpoint', 'sessions', 'list-agents'])('preserves baseline admission for real %s tool capabilities', async name => {
    const { trust, stream, evaluate } = fixture();
    useClassifier(evaluate);
    const prompt = denyPrompts(stream);
    const tool = createBuiltInTools(stream, DEFAULT_CONFIG).find(candidate => candidate.name === name);
    expect(tool, `missing real tool ${name}`).toBeDefined();
    await expect(new PermissionManager(trust).checkPermission(name, {}, tool!)).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(evaluate.mock.calls[0]?.[0].toolMetadata.capabilities).toEqual(tool!.capabilitiesFor({}));
  });

  it('admits delegation without transferring authority to a child write and retains explicit agent denials', async () => {
    const { trust, stream, evaluate } = fixture();
    useClassifier(evaluate);
    const prompt = denyPrompts(stream);
    const tools = createBuiltInTools(stream, DEFAULT_CONFIG);
    const manager = new PermissionManager(trust);
    await expect(manager.checkPermission('agent', {}, tools.find(tool => tool.name === 'agent')!)).resolves.toBe(true);
    await expect(manager.checkPermission('write', { file_path: 'new-file-for-permission-test.ts', content: 'bounded change' }, tools.find(tool => tool.name === 'write')!, { task: 'Update UI' })).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(prompt).toHaveBeenCalledOnce();
    trust.setRunAuthorizationPolicy({ disallowed_tools: ['agent'] });
    await expect(manager.checkPermission('agent', {}, tools.find(tool => tool.name === 'agent')!)).rejects.toBeInstanceOf(PolicyDeniedError);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('derives metadata from code, rejects spoofed metadata and checks declared nested paths', async () => {
    const { trust, stream, evaluate } = fixture();
    useClassifier(evaluate);
    const prompt = denyPrompts(stream);
    const manager = new PermissionManager(trust);
    const tool = { name: 'custom-reader', requiresConfirmation: () => false, getShellCommand: () => null,
      capabilitiesFor: () => [ToolCapability.FsRead],
      getFunctionDefinition: () => ({ function: { parameters: { type: 'object', properties: {
        targets: { type: 'array', items: { type: 'object', properties: { location: { type: 'string', format: 'local-path' } } } },
      } } } }),
    } as unknown as BaseTool;
    await expect(manager.checkPermission(tool.name, { targets: [{ location: '.' }] }, tool)).resolves.toBe(true);
    await expect(manager.checkPermission(tool.name, { targets: [{ location: '/etc/passwd' }], toolMetadata: { capabilities: [], localPaths: [] } }, tool,
      { toolMetadata: { capabilities: [], localPaths: [] } } as any)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(evaluate.mock.calls.at(-1)?.[0].toolMetadata).toEqual({ capabilities: [ToolCapability.FsRead], localPaths: ['/etc/passwd'] });
    expect(prompt).toHaveBeenCalledOnce();
    const effectTool = { ...tool, name: 'custom-effect', capabilitiesFor: () => [ToolCapability.RemoteEffect] } as unknown as BaseTool;
    await expect(manager.checkPermission(effectTool.name, { toolMetadata: { capabilities: [] } }, effectTool,
      { toolMetadata: { capabilities: [], localPaths: [] } } as any)).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(prompt).toHaveBeenCalledTimes(2);
  });
  it('admits the built-in question tool without asking permission to ask a question', async () => {
    const { trust, stream, evaluate } = fixture();
    const prompt = vi.fn();
    stream.subscribe(E.PERMISSION_REQUEST, prompt);
    evaluate.mockImplementation(async (input: unknown) => {
      const decision = await classifyAutoAction(input as Parameters<typeof classifyAutoAction>[0]);
      return { verdict: decision.kind, reason: decision.reason };
    });
    const tool = new AskUserQuestionTool(stream);
    const args = { questions: [{ header: 'Scope', question: 'Which component should I update?' }] };
    await expect(new PermissionManager(trust).checkPermission(tool.name, args, tool)).resolves.toBe(true);
    expect(prompt).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('enforces run denials before previously granted trust', async () => {
    const { trust, evaluate } = fixture();
    trust.trustTool('write', TrustScope.GLOBAL);
    trust.setRunAuthorizationPolicy({ disallowed_tools: ['write'] });
    const manager = new PermissionManager(trust);
    const tool = { getShellCommand: () => null, requiresConfirmation: () => true,
      capabilitiesFor: () => [ToolCapability.FsWrite],
      getFunctionDefinition: () => ({ function: { parameters: { type: 'object', properties: {} } } }),
    } as unknown as BaseTool;
    await expect(manager.checkPermission('write', { file_path: 'file.ts' }, tool)).rejects.toBeInstanceOf(
      PolicyDeniedError
    );
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not turn an Auto ask on a normally read-only tool into silent approval', async () => {
    const { trust, stream, evaluate } = fixture();
    evaluate.mockResolvedValue({ verdict: 'ask', reason: 'Outside workspace file' });
    const requests: unknown[] = [];
    stream.subscribe(E.PERMISSION_REQUEST, event => {
      requests.push(event.data);
      stream.emit({
        id: 'deny',
        type: E.PERMISSION_RESPONSE,
        timestamp: Date.now(),
        data: { requestId: event.data.requestId, choice: PermissionChoice.DENY },
      });
    });
    await expect(
      trust.checkPermission('read', { file_path: '/outside/credentials' }, '/outside/credentials', { ...context, requiresConfirmation: false })
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(requests).toEqual([expect.objectContaining({ decisionReason: 'Outside workspace file' })]);
  });

  it('does not lose an outside-read ask if another review concurrently triggers Manual fallback', async () => {
    const { trust, stream } = fixture();
    let effectiveMode = 'auto';
    trust.setPermissionPolicy({
      getSnapshot: () => ({ requestedMode: 'auto', effectiveMode }),
      evaluate: async () => {
        effectiveMode = 'manual';
        return { verdict: 'ask', reason: 'Outside workspace file' };
      },
    } as unknown as PermissionPolicyService);
    const prompt = vi.fn(event =>
      stream.emit({
        id: 'deny',
        type: E.PERMISSION_RESPONSE,
        timestamp: Date.now(),
        data: { requestId: event.data.requestId, choice: PermissionChoice.DENY },
      })
    );
    stream.subscribe(E.PERMISSION_REQUEST, prompt);
    await expect(
      trust.checkPermission('read', { file_path: '/outside/credentials' }, '/outside/credentials', { ...context, requiresConfirmation: false })
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('allows deterministic approval without emitting a human prompt', async () => {
    const { trust, stream } = fixture();
    const prompt = vi.fn();
    stream.subscribe(E.PERMISSION_REQUEST, prompt);
    expect(
      await trust.checkPermission('bash', { command: 'ls' }, { command: 'ls', path: process.cwd() }, context)
    ).toBe(true);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('aborts a delayed review without admitting the operation or opening a stale prompt', async () => {
    const { trust, stream, evaluate } = fixture();
    let finish!: (value: { verdict: string; reason: string }) => void;
    evaluate.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const controller = new AbortController();
    const prompt = vi.fn();
    stream.subscribe(E.PERMISSION_REQUEST, prompt);
    const pending = trust.checkPermission('write', {}, null, { ...context, signal: controller.signal });
    controller.abort();
    finish({ verdict: 'allow', reason: 'late' });
    await expect(pending).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('binds human command trust to its complete command and working directory', async () => {
    const stream = new ActivityStream();
    const trust = new TrustManager('manual', stream);
    owners.push(trust);
    const prompt = vi.fn(event =>
      stream.emit({
        id: 'allow',
        type: E.PERMISSION_RESPONSE,
        timestamp: Date.now(),
        data: { requestId: event.data.requestId, choice: PermissionChoice.ALWAYS_ALLOW },
      })
    );
    stream.subscribe(E.PERMISSION_REQUEST, prompt);
    const command = 'npm test';
    await trust.checkPermission('bash', { command }, { command, path: '/workspace/a' });
    await trust.checkPermission('bash', { command }, { command, path: '/workspace/a' });
    expect(prompt).toHaveBeenCalledOnce();
    await trust.checkPermission('bash', { command }, { command, path: '/workspace/b' });
    expect(prompt).toHaveBeenCalledTimes(2);
  });

  it('keeps noninteractive runs fail-closed when review asks', async () => {
    const { trust, evaluate } = fixture();
    evaluate.mockResolvedValue({ verdict: 'ask', reason: 'Unknown side effects' });
    trust.setRunPolicyManager(
      new RunPolicyManager({
        interaction: 'none',
        execution: 'headless',
        completion: 'chat',
        authorizationPresetId: 'test',
      })
    );
    await expect(trust.checkPermission('bash', { command: 'npm test' }, null, context)).rejects.toBeInstanceOf(
      PolicyDeniedError
    );
  });
});
