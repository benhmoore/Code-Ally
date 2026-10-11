import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRuntime } from '../SessionRuntime.js';
import { ConversationInputQueue } from '../ConversationInputQueue.js';
import { ConversationViewStore } from '../ConversationViewStore.js';
import { ActivityStream } from '../ActivityStream.js';
import type { Message } from '../../types/index.js';

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function setup() {
  let busy = false;
  const messages: Message[] = [];
  const view = new ConversationViewStore(new ActivityStream(), () => messages, () => []);
  const input = new ConversationInputQueue(() => busy);
  const execute = vi.fn(async (text: string) => text);
  const resume = vi.fn((state: { messages: Message[] }) => {
    messages.splice(0, messages.length, ...state.messages);
    view.refresh(true);
  });
  const cancel = vi.fn();
  const close = vi.fn(async () => { input.close(); await input.whenIdle(); view.close(); });
  const runtime = new SessionRuntime({ view, input, execute, resume, cancel, close,
    isProcessing: () => busy, steer: () => busy });
  cleanup.push(() => { input.close(); runtime.dispose(); view.close(); });
  return { runtime, execute, input, resume, cancel, close, setBusy: (value: boolean) => { busy = value; } };
}

describe('SessionRuntime', () => {
  it('steers active work and holds explicit follow-ups through final publication', async () => {
    const { runtime, setBusy, input, execute } = setup();
    let release!: () => void;
    const publishing = new Promise<void>(resolve => { release = resolve; });
    const first = runtime.submit('first', { execute: async () => {
      setBusy(true);
      await tick();
      setBusy(false);
      await publishing;
      return 'published';
    } });
    await tick();
    expect(await runtime.submit('direction')).toEqual({ kind: 'steered' });
    const next = runtime.submit('next', { mode: 'follow_up' });
    await tick();
    expect(execute).not.toHaveBeenCalled();
    const pending = runtime.getSnapshot().pendingInputs[0]!;
    expect(runtime.editPending(pending.id, 'edited')).toBe(true);
    expect(runtime.getSnapshot().pendingInputs[0]?.text).toBe('edited');
    const idle = vi.fn();
    const waiting = runtime.whenIdle().then(idle);
    input.drain();
    await tick();
    expect(idle).not.toHaveBeenCalled();
    release();
    expect(await first).toEqual({ kind: 'completed', value: 'published' });
    expect(await next).toEqual({ kind: 'completed', value: 'edited' });
    await waiting;
    expect(execute).toHaveBeenCalledExactlyOnceWith('edited', undefined);
  });

  it('cancels queued preparation without changing a neighboring session', async () => {
    const one = setup();
    const two = setup();
    two.setBusy(true);
    const other = two.runtime.submit('other', { mode: 'follow_up' });
    const first = one.runtime.submit('one');
    const second = one.runtime.submit('two');
    one.runtime.cancel();
    expect(await first).toEqual({ kind: 'not_sent' });
    expect(await second).toEqual({ kind: 'not_sent' });
    expect(one.execute).not.toHaveBeenCalled();
    expect(one.cancel).not.toHaveBeenCalled();
    expect(two.runtime.getSnapshot().pendingInputs).toHaveLength(1);
    two.runtime.cancel();
    expect(two.cancel).toHaveBeenCalledOnce();
    await other;
  });

  it('restores isolated state, guards active work, and closes idempotently', async () => {
    const { runtime, resume, close, cancel, setBusy } = setup();
    const state = { messages: [{ role: 'user' as const, content: 'restored' }] };
    runtime.resume(state);
    state.messages[0]!.content = 'external mutation';
    expect(runtime.getSnapshot().messages[0]?.content).toBe('restored');
    expect(resume).toHaveBeenCalledOnce();
    setBusy(true);
    expect(() => runtime.resume(state)).toThrow('Wait for active');
    setBusy(false);
    const listener = vi.fn();
    runtime.subscribe(listener);
    await Promise.all([runtime.close(), runtime.close()]);
    const notificationsAtClose = listener.mock.calls.length;
    await expect(runtime.submit('late')).rejects.toThrow('Session is closed');
    expect(() => runtime.resume(state)).toThrow('Session is closed');
    setBusy(true);
    runtime.cancel();
    expect(cancel).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledTimes(notificationsAtClose);
  });
});
