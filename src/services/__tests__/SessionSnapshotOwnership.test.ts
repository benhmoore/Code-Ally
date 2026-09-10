import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../SessionManager.js';
import type { Message } from '../../types/index.js';
import type { TodoItem } from '../TodoManager.js';
import { emptySemanticCheckpoint, type ConversationCheckpointV1 } from '../../agent/compaction/types.js';

describe('explicit session snapshot ownership', () => {
  let dir: string;
  let manager: SessionManager;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'ally-session-snapshot-'));
    manager = new SessionManager({ sessionsDir: dir });
    await manager.initialize();
    await manager.createSession('owned');
  });

  afterEach(async () => {
    await manager.cleanup();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it.each(['save', 'replace', 'checkpoint'] as const)('owns messages and related state at %s admission', async mode => {
    const messages: Message[] = [{ id: 'm1', role: 'user', content: 'submitted' }];
    const transcript = structuredClone(messages);
    const checkpoint: ConversationCheckpointV1 = {
      schemaVersion: 1, id: 'checkpoint', generation: 1, createdAt: new Date().toISOString(),
      trigger: 'manual', phase: 'manual', strategy: 'local-structured', portability: 'model-validated',
      provider: 'ollama', model: 'test',
      source: { firstMessageId: 'm1', lastMessageId: 'm1', messageIds: ['m1'], digest: 'digest' },
      retainedMessageIds: ['m1'], semanticState: emptySemanticCheckpoint(),
      providerState: { kind: 'openai-responses', items: [{ text: 'submitted' }], coveredMessageIds: ['m1'] },
      replacementMessages: messages,
      budget: { contextWindow: 32768, estimatedBefore: 100, triggerBudget: 200, targetBudget: 100,
        outputReserve: 20, safetyReserve: 20, after: 80 },
    };
    const expected = structuredClone({ messages, transcript, checkpoint });
    const saving = mode === 'save'
      ? manager.saveSession('owned', messages, transcript, checkpoint)
      : mode === 'replace'
        ? manager.replaceConversation(messages, transcript, checkpoint.providerState)
        : manager.commitConversationCheckpoint(messages, transcript, checkpoint);
    messages[0]!.content = 'later mutation';
    transcript[0]!.content = 'later transcript';
    checkpoint.retainedMessageIds.push('later');
    if (checkpoint.providerState.kind === 'openai-responses') checkpoint.providerState.items.push('later');
    expect(await saving).toBe(true);
    const restored = await new SessionManager({ sessionsDir: dir }).loadSession('owned');
    expect(restored?.messages).toEqual(expected.messages);
    expect(restored?.transcript).toEqual(expected.transcript);
    if (mode !== 'replace') expect(restored?.conversation_checkpoint).toEqual(expected.checkpoint);
    if (mode !== 'save') expect(restored?.provider_state).toEqual(expected.checkpoint.providerState);
  });

  it.each(['update', 'todos'] as const)('owns nested values at %s admission', async mode => {
    const todos: TodoItem[] = [{ id: 'todo', task: 'submitted', status: 'pending' }];
    const expected = structuredClone(todos);
    const saving = mode === 'update'
      ? manager.updateSession('owned', { todos })
      : manager.setTodos(todos);
    todos[0]!.task = 'later mutation';
    expect(await saving).toBe(true);
    expect((await new SessionManager({ sessionsDir: dir }).loadSession('owned'))?.todos).toEqual(expected);
  });

  it('captures metadata before a pending autosave is drained and preserves unrelated fields', async () => {
    await manager.updateMetadata('owned', { title: 'existing title' });
    await manager.autoSave([{ id: 'pending', role: 'user', content: 'pending message' }]);
    const metadata = { tags: ['submitted'] };
    const saving = manager.updateMetadata('owned', metadata);
    metadata.tags.push('later mutation');
    expect(await saving).toBe(true);
    const restored = await new SessionManager({ sessionsDir: dir }).loadSession('owned');
    expect(restored?.metadata).toMatchObject({ title: 'existing title', tags: ['submitted'] });
    expect(restored?.messages[0]?.content).toBe('pending message');
  });
});
