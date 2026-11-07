import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '../SessionManager.js';
import { ServiceRegistry } from '../ServiceRegistry.js';
import { ConversationManager } from '../../agent/ConversationManager.js';
import { SessionPersistence } from '../../agent/SessionPersistence.js';
import type { Message } from '../../types/index.js';

describe('durable append ownership', () => {
  let directory: string;
  let sessions: SessionManager;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ally-outbox-'));
    sessions = new SessionManager({ sessionsDir: directory });
    await sessions.initialize();
    ServiceRegistry.getInstance().registerInstance('session_manager', sessions);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await sessions.forceSave();
    await sessions.cleanup();
    ServiceRegistry.getInstance()['_services'].delete('session_manager');
    await rm(directory, { recursive: true, force: true });
  });

  it('persists every startup append beyond the visible tail before a session exists', async () => {
    const conversation = new ConversationManager();
    const persistence = new SessionPersistence(conversation, 'root');
    const admissions: Promise<void>[] = [];
    conversation.setMessageAddedObserver(() => admissions.push(persistence.autoSave()));
    for (let index = 0; index < 650; index++) conversation.addMessage({ id: `m-${index}`, role: index === 0 ? 'user' : 'assistant', content: `record ${index}` });
    await Promise.all(admissions);
    await sessions.forceSave();
    expect(conversation.getTranscript()).toHaveLength(500);
    expect(conversation.captureTranscriptAppends().messages).toHaveLength(0);
    const restored = new SessionManager({ sessionsDir: directory });
    const name = sessions.getCurrentSession()!;
    const all: Message[] = [];
    let cursor: number | undefined;
    do {
      const page = await restored.getTranscriptPage(name, cursor, 53, 1024 * 1024);
      all.unshift(...page.messages);
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    } while (true);
    expect(all.map(message => message.id)).toEqual(Array.from({ length: 650 }, (_, index) => `m-${index}`));
  });

  it('retries failed appends before newer state and does not regress the active model window', async () => {
    const name = await sessions.createSession('retry');
    sessions.setCurrentSession(name);
    const write = vi.spyOn(sessions as never as { mutateSessionIncremental: (...args: unknown[]) => Promise<boolean> }, 'mutateSessionIncremental');
    write.mockRejectedValueOnce(new Error('disk unavailable')).mockRejectedValueOnce(new Error('disk still unavailable'));
    await sessions.autoSave([{ id: 'a', role: 'user', content: 'old' }]);
    await expect(sessions.forceSave()).rejects.toThrow('persistence failed');
    await sessions.autoSave([{ id: 'b', role: 'assistant', content: 'new' }]);
    await sessions.forceSave();
    const loaded = await sessions.loadSession(name);
    expect(loaded?.messages.map(message => message.id)).toEqual(['b']);
    expect(loaded?.transcript?.map(message => message.id)).toEqual(['a', 'b']);
  });

  it('captures an owner window once per write and freezes it before branch replacement', async () => {
    const name = await sessions.createSession('owner');
    sessions.setCurrentSession(name);
    const conversation = new ConversationManager();
    const persistence = new SessionPersistence(conversation, 'root');
    conversation.addMessage({ id: 'a', role: 'user', content: 'old branch' });
    const reader = vi.fn(() => conversation.getMessages());
    for (let index = 0; index < 100; index++) {
      await sessions.autoSaveFromOwner(reader, undefined, undefined, undefined, undefined, conversation.captureTranscriptAppends().messages);
    }
    expect(reader).not.toHaveBeenCalled();
    conversation.setMessages([{ id: 'replacement', role: 'user', content: 'new branch' }]);
    expect(reader).toHaveBeenCalledOnce();
    await sessions.forceSave();
    expect((await sessions.loadSession(name))?.messages[0]?.id).toBe('a');
    expect(await persistence.replaceConversation([], [], { kind: 'chat' })).toBe(true);
    conversation.setMessages([]);
    conversation.addMessage({ id: 'b', role: 'user', content: 'after clear' });
    await persistence.autoSave();
    await sessions.forceSave();
    const loaded = await sessions.loadSession(name);
    expect(loaded?.messages.map(message => message.id)).toEqual(['b']);
    expect(loaded?.transcript?.map(message => message.id)).toEqual(['b']);
  });

  it('does not retain an outbox for nonpersisting conversation owners', () => {
    const conversation = new ConversationManager();
    new SessionPersistence(conversation, 'child', 1);
    for (let index = 0; index < 650; index++) conversation.addMessage({ role: 'assistant', content: `${index}` });
    expect(conversation.captureTranscriptAppends().messages).toEqual([]);
  });
});
