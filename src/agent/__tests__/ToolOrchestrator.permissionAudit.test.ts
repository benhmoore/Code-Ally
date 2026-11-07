import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolOrchestrator } from '../ToolOrchestrator.js';
import { TrustManager, PermissionChoice } from '../TrustManager.js';
import { PermissionManager } from '../../security/PermissionManager.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { SessionManager } from '../../services/SessionManager.js';
import { reconstructToolCallsFromMessages } from '../../services/conversationTools.js';
import { persistentMessages } from '../../utils/messagePersistence.js';
import { boundToolCalls } from '../../services/conversationBounds.js';
import { ActivityEventType as E, type Message, type PermissionDecision, type ToolCall } from '../../types/index.js';

afterEach(() => vi.restoreAllMocks());

it.each(['allow', 'ask', 'deny'] as const)('persists exact concurrent %s audits through session reload without model-wire contamination', async verdict => {
  const registry = ServiceRegistry.getInstance() as any;
  registry._services.clear();
  registry._descriptors.clear();
  const stream = new ActivityStream();
  const trust = new TrustManager('auto', stream);
  trust.setPermissionPolicy({ getSnapshot: () => ({ requestedMode: 'auto', effectiveMode: 'auto' }),
    evaluate: async ({ toolName, args }: any): Promise<PermissionDecision> => {
      // Resolve in reverse order to exercise exact request attribution.
      if (args.marker === 'first') await new Promise(resolve => setTimeout(resolve, 5));
      return { toolName, verdict, reason: `Reviewed ${args.marker}`, source: 'reviewer', reviewerModel: 'decision:4b', timestamp: 100 };
    },
  } as any);
  const audits: Array<{ id: string; decision: PermissionDecision }> = [];
  stream.subscribe(E.TOOL_PERMISSION_DECISION, event => audits.push({ id: event.id, decision: event.data.decision }));
  stream.subscribe(E.PERMISSION_REQUEST, event => {
    stream.emit({ id: 'response', type: E.PERMISSION_RESPONSE, timestamp: 101,
      data: { requestId: event.data.requestId, choice: PermissionChoice.DENY } });
  });
  const calls: ToolCall[] = ['first', 'second'].map(marker => ({ id: marker, type: 'function', function: { name: 'read', arguments: { marker } } }));
  const messages: Message[] = [{ id: 'assistant', role: 'assistant', content: '', tool_calls: calls }];
  const tool = { runPreview: async () => {}, requiresConfirmation: () => true, effectFor: () => undefined,
    effectOutcomeFor: () => 'succeeded', getShellCommand: () => undefined };
  const manager = { getTool: () => tool, validateBeforePermission: async () => undefined,
    executeTool: vi.fn(async () => ({ success: true, error: '', content: 'tool content' })) };
  const agent = { addMessage: (message: Message) => messages.push(message), getAgentName: () => 'test',
    getMaxDuration: () => undefined, getAgentDepth: () => 0,
    getToolAbortSignal: () => undefined, getTurnStartTime: () => undefined, generateCheckpointReminder: () => null,
    getTokenManager: () => ({ trackToolResult: () => null }), resetToolCallActivity: () => {} };
  const orchestrator = new ToolOrchestrator(manager as any, stream, agent as any,
    { config: { parallel_tools: true }, isSpecializedAgent: false } as any, undefined, new PermissionManager(trust));
  const directory = await fs.mkdtemp(join(tmpdir(), 'ally-permission-audit-'));
  const sessions = new SessionManager();
  (sessions as any).sessionsDir = directory;
  try {
    const execution = orchestrator.executeToolCalls(calls);
    if (verdict === 'ask') await expect(execution).rejects.toThrow();
    else await execution;
    expect(audits).toHaveLength(2);
    for (const call of calls) {
      const results = messages.filter(message => message.tool_call_id === call.id);
      expect(results).toHaveLength(1);
      expect(results[0]?.metadata?.tool_permission?.[call.id]).toMatchObject({ verdict, reason: `Reviewed ${call.id}`, reviewerModel: 'decision:4b' });
      expect(results[0]?.content).not.toContain('decision:4b');
      expect(results[0]?.content).not.toContain('tool_permission');
    }
    // Ephemeral payload reclamation must retain the audit too.
    const persisted = persistentMessages(messages.map(message => message.role === 'tool'
      ? { ...message, metadata: { ...message.metadata, ephemeral: true } } : message));
    await sessions.initialize();
    await sessions.createSession('audit');
    expect(await sessions.saveSession('audit', persisted)).toBe(true);
    const loaded = await sessions.loadSession('audit');
    const restored = reconstructToolCallsFromMessages(loaded!.messages, { get: () => null });
    for (const call of restored) {
      expect(call.permissionDecision?.reason).toBe(`Reviewed ${call.id}`);
      expect(boundToolCalls([{ ...call, output: 'x'.repeat(100000) }])[0]?.permissionDecision).toEqual(call.permissionDecision);
    }
    expect(restored).toHaveLength(2);
  } finally {
    trust.cleanup();
    await sessions.cleanup();
    await fs.rm(directory, { recursive: true, force: true });
    registry._services.clear();
  }
});
