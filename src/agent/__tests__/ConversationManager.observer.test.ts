/**
 * The message-added observer is how token accounting, the context-usage event,
 * and session autosave stay in step with history.
 *
 * Those side effects used to live only in `Agent.addMessage`, while Agent and
 * ResponseProcessor between them appended 26 messages straight through
 * ConversationManager — so the token count that the auto-compaction threshold
 * reads went stale on every one of those writes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConversationManager } from '../ConversationManager.js';
import { Message } from '../../types/index.js';

const user = (content: string): Message => ({ role: 'user', content });

describe('ConversationManager message-added observer', () => {
  let manager: ConversationManager;

  beforeEach(() => {
    manager = new ConversationManager({ instanceId: 'test' });
  });

  it('fires for every appended message', () => {
    const seen: string[] = [];
    manager.setMessageAddedObserver(m => seen.push(m.content));

    manager.addMessage(user('one'));
    manager.addMessage(user('two'));

    expect(seen).toEqual(['one', 'two']);
  });

  it('fires for messages added through any helper, not just addMessage', () => {
    const observer = vi.fn();
    manager.setMessageAddedObserver(observer);

    // addMessages and the gap-filler both route through addMessage, so a caller
    // cannot append without the side effects running.
    manager.addMessages([user('a'), user('b')]);
    manager.addMissingToolResults([{ id: 'c1', function: { name: 'read' } }], { error: 'x' });

    expect(observer).toHaveBeenCalledTimes(3);
  });

  it('sees the message already present in history', () => {
    let countAtNotify = -1;
    manager.setMessageAddedObserver(() => {
      countAtNotify = manager.getMessageCount();
    });

    manager.addMessage(user('one'));

    expect(countAtNotify).toBe(1);
  });

  it('receives the message with id and timestamp already applied', () => {
    let received: Message | undefined;
    manager.setMessageAddedObserver(m => {
      received = m;
    });

    manager.addMessage(user('one'));

    expect(received?.id).toBeTruthy();
    expect(received?.timestamp).toBeTypeOf('number');
  });

  it('does NOT fire for setMessages', () => {
    // Bulk replacement (compaction, rewind, session load) is followed by a full
    // token recount; an incremental observer here would double-count.
    const observer = vi.fn();
    manager.setMessageAddedObserver(observer);

    manager.setMessages([user('a'), user('b')]);

    expect(observer).not.toHaveBeenCalled();
    expect(manager.getMessageCount()).toBe(2);
  });

  it('can be detached', () => {
    const observer = vi.fn();
    manager.setMessageAddedObserver(observer);
    manager.addMessage(user('one'));

    manager.setMessageAddedObserver(null);
    manager.addMessage(user('two'));

    expect(observer).toHaveBeenCalledTimes(1);
    expect(manager.getMessageCount()).toBe(2);
  });

  it('appends normally with no observer registered', () => {
    expect(() => manager.addMessage(user('one'))).not.toThrow();
    expect(manager.getMessageCount()).toBe(1);
  });
});
