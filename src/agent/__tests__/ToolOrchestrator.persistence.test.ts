import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolOrchestrator } from '../ToolOrchestrator.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { RunPersistenceError } from '../../services/RunSupervisor.js';
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
    const journal = { toolPrepared: vi.fn(), toolStarted: vi.fn(), toolFinished: vi.fn() };
    journal[boundary].mockRejectedValue(fault);
    ServiceRegistry.getInstance().registerInstance('run_supervisor', journal as any);
    const observed = { success: true, content: 'external effect verified', error: '' };
    const manager = {
      getTool: () => ({ runPreview: vi.fn(), requiresConfirmation: () => false, effectFor: () => 'non_idempotent', effectOutcomeFor: () => 'succeeded' }),
      executeTool: vi.fn().mockResolvedValue(observed),
    };
    const stream = new ActivityStream();
    const emit = vi.spyOn(stream, 'emit');
    const agent = { getAgentName: () => 'test', getToolAbortSignal: () => undefined, getTurnStartTime: () => undefined, generateCheckpointReminder: () => null };
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
