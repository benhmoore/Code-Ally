/**
 * What a hook verdict does to a tool call: a block never reaches the tool and
 * still closes the UI exactly once, an updatedInput replaces the arguments,
 * and PostToolUse context reaches the model on the result.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolOrchestrator } from '../../agent/ToolOrchestrator.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { ActivityEventType } from '../../types/index.js';
import { STRUCTURED_OUTPUT_TOOL } from '../../tools/StructuredOutputTool.js';
import type { HookEvent, HookVerdict } from '../types.js';

function stubRunner(verdicts: Partial<Record<HookEvent, HookVerdict>>) {
  return {
    hasHooks: (event: HookEvent) => event in verdicts,
    run: vi.fn(async (event: HookEvent) => verdicts[event]),
  };
}

function buildOrchestrator(executeTool: ReturnType<typeof vi.fn>) {
  const stream = new ActivityStream();
  const emit = vi.spyOn(stream, 'emit');
  const manager = {
    getTool: () => ({
      runPreview: vi.fn(),
      requiresConfirmation: () => false,
      effectFor: () => undefined,
      effectOutcomeFor: () => 'succeeded',
    }),
    executeTool,
    validateBeforePermission: vi.fn(),
  };
  const agent = {
    getAgentName: () => 'test',
    getToolAbortSignal: () => undefined,
    getTurnStartTime: () => undefined,
    generateCheckpointReminder: () => null,
    resetToolCallActivity: () => {},
  };
  const orchestrator = new ToolOrchestrator(manager as any, stream, agent as any, {
    config: {},
    isSpecializedAgent: false,
  } as any);
  return { orchestrator, emit };
}

function callBash(orchestrator: ToolOrchestrator, args: Record<string, unknown>) {
  return (orchestrator as any).executeSingleTool({
    id: 'call-1',
    function: { name: 'bash', arguments: args },
  });
}

describe('PreToolUse verdicts in ToolOrchestrator', () => {
  beforeEach(() => {
    const registry = ServiceRegistry.getInstance() as any;
    registry._services.clear();
    registry._descriptors.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns a policy_denied error, emits one TOOL_CALL_END, and never runs the tool', async () => {
    ServiceRegistry.getInstance().registerInstance(
      'hook_runner',
      stubRunner({
        PreToolUse: { kind: 'block', reason: 'remote writes are blocked', source: 'settings' },
      }) as any,
    );
    const executeTool = vi.fn();
    const { orchestrator, emit } = buildOrchestrator(executeTool);

    const result = await callBash(orchestrator, { command: 'git push' });

    expect(result.success).toBe(false);
    expect(result.error_type).toBe('policy_denied');
    expect(result.error).toBe('remote writes are blocked');
    expect(executeTool).not.toHaveBeenCalled();

    const ends = emit.mock.calls
      .map(([event]) => event)
      .filter(event => event.type === ActivityEventType.TOOL_CALL_END);
    expect(ends).toHaveLength(1);
    expect(ends[0].data.success).toBe(false);
  });

  it('runs the tool with the arguments a hook substituted', async () => {
    ServiceRegistry.getInstance().registerInstance(
      'hook_runner',
      stubRunner({
        PreToolUse: {
          kind: 'proceed',
          additionalContext: [],
          systemMessages: [],
          updatedInput: { command: 'git status' },
        },
      }) as any,
    );
    const executeTool = vi.fn().mockResolvedValue({ success: true, error: '', content: 'clean' });
    const { orchestrator } = buildOrchestrator(executeTool);

    await callBash(orchestrator, { command: 'git push' });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool.mock.calls[0][1]).toEqual({ command: 'git status' });
  });

  it('exempts the structured-output tool from a blanket block hook', async () => {
    const runner = stubRunner({
      PreToolUse: { kind: 'block', reason: 'everything is blocked', source: 'settings' },
    });
    ServiceRegistry.getInstance().registerInstance('hook_runner', runner as any);
    const executeTool = vi.fn().mockResolvedValue({ success: true, error: '', content: 'recorded' });
    const { orchestrator } = buildOrchestrator(executeTool);

    const result = await (orchestrator as any).executeSingleTool({
      id: 'call-1',
      function: { name: STRUCTURED_OUTPUT_TOOL, arguments: { answer: 'done' } },
    });

    expect(result.success).toBe(true);
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(runner.run).not.toHaveBeenCalledWith('PreToolUse', expect.anything(), expect.anything());
  });

  it('appends PostToolUse context to the tool result', async () => {
    ServiceRegistry.getInstance().registerInstance(
      'hook_runner',
      stubRunner({
        PostToolUse: {
          kind: 'proceed',
          additionalContext: ['formatter rewrote two files'],
          systemMessages: [],
        },
      }) as any,
    );
    const executeTool = vi.fn().mockResolvedValue({ success: true, error: '', content: 'done' });
    const { orchestrator } = buildOrchestrator(executeTool);

    const result = await callBash(orchestrator, { command: 'make fmt' });

    expect(result.content).toBe('done\n\nformatter rewrote two files');
  });
});
