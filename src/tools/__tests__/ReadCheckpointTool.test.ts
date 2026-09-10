import { describe, it, expect } from 'vitest';
import { ReadCheckpointTool } from '../ReadCheckpointTool.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { emptySemanticCheckpoint, type ConversationCheckpointV1 } from '../../agent/compaction/types.js';
import { tokenCounter } from '../../services/TokenCounter.js';
import { SessionManager } from '../../services/SessionManager.js';
import { ConversationManager } from '../../agent/ConversationManager.js';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fixture() {
  const semanticState = emptySemanticCheckpoint();
  semanticState.userConstraints = Array.from({ length: 40 }, (_, index) => ({
    text: `Requirement ${index}: preserve 😀 and Ελληνικά exactly.`, sourceMessageIds: [`u-${index}`],
  }));
  let checkpoint = { id: 'generation-one', generation: 1, semanticState };
  const registryScope = { get(name: string) {
    if (name === 'agent') return {
      getInstanceId: () => 'child', getConversationManager: () => ({ getCheckpoint: () => checkpoint }),
    };
    if (name === 'context_budget') return { get: () => ({ maxToolResultTokens: 300 }) };
    return null;
  } };
  return {
    tool: new ReadCheckpointTool(new ActivityStream()), registryScope,
    checkpoint, change: () => { checkpoint = { ...checkpoint, id: 'generation-two', generation: 2 }; },
  };
}

describe('ReadCheckpointTool', () => {
  it('reads the same durable requirements after session persistence and reload', async () => {
    const source = fixture();
    const checkpoint: ConversationCheckpointV1 = {
      ...source.checkpoint, schemaVersion: 1, createdAt: new Date().toISOString(),
      trigger: 'manual', phase: 'manual', strategy: 'local-structured', portability: 'model-validated',
      provider: 'test', model: 'test',
      source: { firstMessageId: 'u-0', lastMessageId: 'u-0', messageIds: ['u-0'], digest: 'test' },
      retainedMessageIds: [], providerState: { kind: 'chat' }, replacementMessages: [],
      budget: { contextWindow: 32768, estimatedBefore: 100, triggerBudget: 100, targetBudget: 50,
        outputReserve: 10, safetyReserve: 10, after: 40 },
    };
    const dir = await fs.mkdtemp(join(tmpdir(), 'ally-checkpoint-reader-'));
    const sessions = new SessionManager({ sessionsDir: dir });
    try {
      await sessions.initialize();
      await sessions.createSession('restored');
      expect(await sessions.saveSession('restored', [], [], checkpoint)).toBe(true);
      const restored = await new SessionManager({ sessionsDir: dir }).loadSession('restored');
      const conversation = new ConversationManager({ initialCheckpoint: restored!.conversation_checkpoint });
      const registryScope = { get: (name: string) => name === 'agent'
        ? { getInstanceId: () => 'restored', getConversationManager: () => conversation }
        : source.registryScope.get(name) };
      const args = { section: 'userConstraints' };
      const before = await source.tool.execute(args, 'page', undefined, false, false,
        { registryScope: source.registryScope });
      const after = await new ReadCheckpointTool(new ActivityStream()).execute(args,
        'page', undefined, false, false, { registryScope });
      expect(after).toEqual(before);
      expect(after.success).toBe(true);
      expect(conversation.getCheckpoint()?.semanticState.userConstraints).toHaveLength(40);
    } finally {
      await sessions.cleanup();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('pages the scoped checkpoint exactly within the output budget', async () => {
    const { tool, registryScope, checkpoint } = fixture();
    let offset = 0;
    let content = '';
    do {
      const result = await tool.execute({ section: 'userConstraints', offset, limit: 8000,
        checkpoint_id: checkpoint.id }, 'page', undefined, false, false, { registryScope });
      expect(result.success).toBe(true);
      const { _non_truncatable, ...wire } = result;
      expect(_non_truncatable).toBe(true);
      expect(tokenCounter.count(JSON.stringify(wire))).toBeLessThanOrEqual(300);
      content += result.content;
      if (result.next_offset === null) break;
      expect(result.next_offset).toBeGreaterThan(offset);
      offset = result.next_offset;
    } while (offset < 100_000);
    expect(content).toBe(JSON.stringify(checkpoint.semanticState.userConstraints, null, 2));
  });

  it('rejects stale generations and unidentified continuation pages', async () => {
    const { tool, registryScope, change } = fixture();
    change();
    const stale = await tool.execute({ section: 'userConstraints', checkpoint_id: 'generation-one', offset: 10 },
      'page', undefined, false, false, { registryScope });
    expect(stale.success).toBe(false);
    expect(stale.error).toContain('changed');
    const unidentified = await tool.execute({ section: 'userConstraints', offset: 10 },
      'page', undefined, false, false, { registryScope });
    expect(unidentified.success).toBe(false);
  });

  it('honors a narrower batch allowance without returning incomplete page metadata', async () => {
    const { tool, registryScope } = fixture();
    const result = await tool.execute({ section: 'userConstraints' }, 'page', undefined, false, false, {
      registryScope, outputBudget: { limitTokens: 1, maxResultTokensByCallId: new Map([['page', 1]]) },
    });
    expect(result.success).toBe(false);
    expect(result.next_offset).toBeUndefined();
  });
});
