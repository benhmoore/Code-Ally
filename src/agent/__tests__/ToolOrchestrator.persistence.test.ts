import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolOrchestrator } from '../ToolOrchestrator.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { RunSupervisor, RunPersistenceError } from '../../services/RunSupervisor.js';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ActivityEventType } from '../../types/index.js';

describe.each(['single', 'concurrent', 'sequential'])('%s tool execution persistence faults', mode => {
  beforeEach(() => {
    const registry = ServiceRegistry.getInstance() as any;
    registry._services.clear();
    registry._descriptors.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['toolPrepared', 'toolStarted', 'toolFinished'] as const)('stops on %s failure without rewriting the observed effect', async boundary => {
    const fault = new RunPersistenceError(new Error('disk failed'));
    const journal = { toolPrepared: vi.fn(), toolStarted: vi.fn(), toolFinished: vi.fn(), release: vi.fn() };
    journal[boundary].mockRejectedValue(fault);
    ServiceRegistry.getInstance().registerInstance('run_supervisor', { acquireExecution: () => journal } as any);
    const observed = { success: true, content: 'external effect verified', error: '' };
    const manager = {
      getTool: () => ({ runPreview: vi.fn(), requiresConfirmation: () => false, effectFor: () => 'non_idempotent', effectOutcomeFor: () => 'succeeded' }),
      executeTool: vi.fn().mockResolvedValue(observed),
    };
    const stream = new ActivityStream();
    const emit = vi.spyOn(stream, 'emit');
    const agent = { getAgentName: () => 'test', getToolAbortSignal: () => undefined, getTurnStartTime: () => undefined, generateCheckpointReminder: () => null, resetToolCallActivity: () => {} };
    const orchestrator = new ToolOrchestrator(manager as any, stream, agent as any, { config: {}, isSpecializedAgent: false } as any);
    const call = { id: 'call', function: { name: 'publish', arguments: {} } };
    const execution = mode === 'single' ? (orchestrator as any).executeSingleTool(call)
      : mode === 'concurrent' ? (orchestrator as any).executeConcurrent([call])
      : (orchestrator as any).executeSequential([call, { ...call, id: 'must-not-start' }]);
    await expect(execution).rejects.toBe(fault);
    expect(manager.executeTool).toHaveBeenCalledTimes(boundary === 'toolFinished' ? 1 : 0);
    expect(journal.toolFinished).toHaveBeenCalledTimes(boundary === 'toolFinished' ? 1 : 0);
    const events = emit.mock.calls.map(([event]) => event);
    const ends = events.filter(event => event.type === ActivityEventType.TOOL_CALL_END && event.id === 'call');
    expect(ends).toHaveLength(1);
    if (boundary === 'toolFinished') expect(ends[0].data.result).toBe(observed);
    else expect(ends[0].data.error).toContain('persistence failed');
    if (mode === 'concurrent') {
      const groupEnds = events.filter(event => event.type === ActivityEventType.TOOL_CALL_END && event.data.groupExecution);
      expect(groupEnds).toHaveLength(1);
      expect(groupEnds[0].data.success).toBe(false);
    }
  });
});

describe('execution-scoped run ownership', () => {
  it.each(['preview', 'execution'])('keeps replacement isolated while %s is pending', async boundary => {
    const registry = ServiceRegistry.getInstance() as any;
    registry._services.clear();
    registry._descriptors.clear();
    const directory = await fs.mkdtemp(join(tmpdir(), 'ally-execution-owner-'));
    const supervisor = new RunSupervisor(directory);
    registry.registerInstance('run_supervisor', supervisor);
    const policy = { interaction: 'none', execution: 'headless', completion: 'durable_objective', authorizationPresetId: 'auto-confirm' } as const;
    let unblock!: () => void;
    let arrived!: () => void;
    const pending = new Promise<void>(resolve => { unblock = resolve; });
    const ready = new Promise<void>(resolve => { arrived = resolve; });
    const pause = async () => { arrived(); await pending; };
    const manager = {
      getTool: () => ({ runPreview: boundary === 'preview' ? pause : async () => {}, requiresConfirmation: () => false,
        effectFor: () => 'non_idempotent', effectOutcomeFor: () => 'succeeded' }),
      executeTool: vi.fn(async () => { if (boundary === 'execution') await pause(); return { success: true, content: 'observed' }; }),
    };
    const agent = { getAgentName: () => 'test', getToolAbortSignal: () => undefined, getTurnStartTime: () => undefined, generateCheckpointReminder: () => null, resetToolCallActivity: () => {} };
    const orchestrator = new ToolOrchestrator(manager as any, new ActivityStream(), agent as any, { config: {}, isSpecializedAgent: false } as any);
    try {
      const first = await supervisor.startRun('first', policy);
      const execution = (orchestrator as any).executeSingleTool({ id: 'old-call', function: { name: 'publish', arguments: {} } });
      await ready;
      await supervisor.cancel('replacement');
      const second = await supervisor.startRun('second', policy);
      const before = await fs.readFile(join(directory, second.runId, 'journal.jsonl'), 'utf8');
      unblock();
      const result = await execution;
      expect(result.success, result.error).toBe(boundary === 'execution');
      expect(manager.executeTool).toHaveBeenCalledTimes(boundary === 'execution' ? 1 : 0);
      expect(await fs.readFile(join(directory, second.runId, 'journal.jsonl'), 'utf8')).toBe(before);
      const original = await fs.readFile(join(directory, first.runId, 'journal.jsonl'), 'utf8');
      expect(original.includes('tool_succeeded')).toBe(boundary === 'execution');
      expect(original).not.toContain('tool_unknown');
    } finally {
      unblock();
      await supervisor.interruptForShutdown('test cleanup');
      await fs.rm(directory, { recursive: true, force: true });
      registry._services.clear();
    }
  });
});
