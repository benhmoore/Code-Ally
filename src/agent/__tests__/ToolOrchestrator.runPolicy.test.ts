/**
 * The disallow list is enforced at the call, not only at the schema. A tool
 * that never requires confirmation never reaches the permission manager, so a
 * call the model emits from resumed history or a skill has to be refused here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolOrchestrator } from '../ToolOrchestrator.js';
import { TrustManager } from '../TrustManager.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';

function buildOrchestrator(executeTool: ReturnType<typeof vi.fn>) {
  const stream = new ActivityStream();
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
  return new ToolOrchestrator(manager as any, stream, agent as any, {
    config: {},
    isSpecializedAgent: false,
  } as any);
}

function call(orchestrator: ToolOrchestrator, name: string) {
  return (orchestrator as any).executeSingleTool({
    id: 'call-1',
    function: { name, arguments: {} },
  });
}

function installPolicy(disallowed: string[]): void {
  const trustManager = new TrustManager(true);
  trustManager.setRunAuthorizationPolicy({ disallowed_tools: disallowed });
  ServiceRegistry.getInstance().registerInstance('trust_manager', trustManager);
}

describe('disallowed tools in ToolOrchestrator', () => {
  beforeEach(() => {
    const registry = ServiceRegistry.getInstance() as any;
    registry._services.clear();
    registry._descriptors.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('refuses a disallowed tool that does not require confirmation', async () => {
    installPolicy(['read']);
    const executeTool = vi.fn();
    const result = await call(buildOrchestrator(executeTool), 'read');

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error_type).toBe('policy_denied');
    expect(result.error).toContain('Run policy denied tool: read');
    expect(result.system_reminder).toContain('denied by the automatic run policy');
  });

  it('refuses a disallowed tool written in its Claude spelling', async () => {
    installPolicy(['WebFetch']);
    const executeTool = vi.fn();
    const result = await call(buildOrchestrator(executeTool), 'web-fetch');

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.error_type).toBe('policy_denied');
  });

  it('runs a tool the policy does not name', async () => {
    installPolicy(['read']);
    const executeTool = vi.fn().mockResolvedValue({ success: true, error: '', content: 'ok' });
    const result = await call(buildOrchestrator(executeTool), 'grep');

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it('runs every tool when no policy is installed', async () => {
    const executeTool = vi.fn().mockResolvedValue({ success: true, error: '', content: 'ok' });
    await call(buildOrchestrator(executeTool), 'read');

    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});
