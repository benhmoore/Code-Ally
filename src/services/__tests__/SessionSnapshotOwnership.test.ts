import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it.each(['metadata', 'todos', 'fields'] as const)('updates %s without reading or rewriting archived history', async mode => {
    const transcript: Message[] = Array.from({ length: 300 }, (_, index) => ({
      id: `history-${index}`, role: 'user', content: `message ${index}`,
    }));
    const messages = transcript.slice(-2);
    expect(await manager.saveSession('owned', messages, transcript)).toBe(true);
    const readSegment = vi.spyOn(manager as any, 'readTranscriptSegment');
    const storeSegment = vi.spyOn(manager as any, 'storeTranscriptSegment');
    const todos: TodoItem[] = [{ id: 'next', task: 'continue', status: 'pending' }];
    const updated = mode === 'metadata'
      ? await manager.updateMetadata('owned', { title: 'updated' })
      : mode === 'todos'
        ? await manager.setTodos(todos)
        : await manager.updateSession('owned', { todos });
    expect(updated).toBe(true);
    expect(readSegment).not.toHaveBeenCalled();
    expect(storeSegment).not.toHaveBeenCalled();
    // Both the existing manager and a new reader must expose complete history.
    for (const reader of [manager, new SessionManager({ sessionsDir: dir })]) {
      const restored = await reader.loadSession('owned');
      expect(restored?.transcript).toEqual(transcript);
      expect(restored?.messages).toEqual(messages);
      if (mode === 'metadata') expect(restored?.metadata.title).toBe('updated');
      else expect(restored?.todos).toEqual(todos);
    }
  });

  it('reads session fields independently of archived conversation contents', async () => {
    const transcript: Message[] = Array.from({ length: 130 }, (_, index) => ({
      id: `history-${index}`, role: 'user', content: `message ${index}`,
    }));
    await manager.saveSession('owned', transcript.slice(-1), transcript);
    const todos: TodoItem[] = [{ id: 'next', task: 'continue', status: 'pending' }];
    const projectContext = {
      languages: ['Python'], frameworks: [], hasGit: false,
      scale: 'small' as const, detectedAt: new Date().toISOString(),
    };
    await manager.updateSession('owned', {
      todos, idle_messages: ['waiting'], project_context: projectContext,
    });
    const reader = new SessionManager({ sessionsDir: dir });
    reader.setCurrentSession('owned');
    const readSegment = vi.spyOn(reader as any, 'readTranscriptSegment');
    const loadedTodos = await reader.getTodos();
    expect(loadedTodos).toEqual(todos);
    expect(await reader.getIdleMessages()).toEqual(['waiting']);
    expect(await reader.getProjectContext()).toEqual(projectContext);
    expect(readSegment).not.toHaveBeenCalled();
    loadedTodos[0]!.task = 'caller mutation';
    expect(await reader.getTodos()).toEqual(todos);
    expect(await reader.getTodos('absent')).toEqual([]);
    expect(await reader.getIdleMessages('absent')).toEqual([]);
    expect(await reader.getProjectContext('absent')).toBeNull();
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

  it('retains every admitted snapshot across overlapping session switches', async () => {
    await manager.createSession('second');
    await manager.createSession('third');
    manager.setCurrentSession('owned');
    await manager.autoSave([{ role: 'user', content: 'first snapshot' }]);
    const original = (manager as any).mutateSessionIncremental.bind(manager);
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(manager as any, 'mutateSessionIncremental').mockImplementation(async (...args) => {
      if (args[0] === 'owned') {
        entered();
        await gate;
      }
      return original(...args);
    });
    manager.setCurrentSession('second');
    const second = manager.autoSave([{ role: 'user', content: 'second snapshot' }]);
    try {
      await ready;
      manager.setCurrentSession('third');
      expect(await manager.autoSave([{ role: 'user', content: 'third snapshot' }])).toBe(true);
      release();
      expect(await second).toBe(true);
      await manager.forceSave();
      const reader = new SessionManager({ sessionsDir: dir });
      for (const [name, content] of [['owned', 'first snapshot'], ['second', 'second snapshot'], ['third', 'third snapshot']] as const) {
        expect((await reader.loadSession(name))?.messages[0]?.content).toBe(content);
      }
    } finally { release(); }
  });
});
