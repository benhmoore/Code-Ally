import { describe, expect, it, vi } from 'vitest';
import { IdleMessageGenerator } from '../IdleMessageGenerator.js';
import { SessionTitleGenerator } from '../SessionTitleGenerator.js';
import { AutoToolCleanupService } from '../AutoToolCleanupService.js';
import type { ModelClient, LLMResponse, SendOptions } from '../../llm/ModelClient.js';
import type { SessionManager } from '../SessionManager.js';
import type { Message } from '../../types/index.js';

const messages: Message[] = [{ role: 'user', content: 'start' }];
for (let index = 0; index < 10; index++) {
  messages.push({ role: 'assistant', content: '', tool_calls: [{ id: `call-${index}`, type: 'function', function: { name: 'read', arguments: {} } }] });
  messages.push({ role: 'tool', tool_call_id: `call-${index}`, content: 'result' });
}
messages.push({ role: 'user', content: 'continue' });

describe('auxiliary background ownership', () => {
  it.each(['idle', 'title', 'cleanup'] as const)('%s cancels, awaits actual settlement, and refuses new work after cleanup', async kind => {
    let finish!: (response: LLMResponse) => void;
    let signal!: AbortSignal;
    const send = vi.fn((_messages: readonly Message[], options: SendOptions) => {
      signal = options.signal;
      return new Promise<LLMResponse>(resolve => { finish = resolve; });
    });
    const client = { send } as unknown as ModelClient;
    const save = vi.fn();
    const sessions = { updateMetadata: save, loadSession: vi.fn().mockResolvedValue({ metadata: {} }) } as unknown as SessionManager;
    const idle = new IdleMessageGenerator(client);
    const title = new SessionTitleGenerator(client, sessions);
    const cleanup = new AutoToolCleanupService(client, sessions);
    const owner = kind === 'idle' ? idle : kind === 'title' ? title : cleanup;
    const start = () => {
      if (kind === 'idle') idle.generateMessageBackground([], undefined, true);
      else if (kind === 'title') title.generateTitleBackground('session', 'request');
      else cleanup.cleanupBackground('session', messages);
    };
    start();
    expect(send).toHaveBeenCalledOnce();
    let settled = false;
    const closing = owner.cleanup().then(() => { settled = true; });
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(owner.isActive).toBe(true);
    finish({ role: 'assistant', content: kind === 'cleanup' ? '{"irrelevant_ids":["call-0"]}' : 'late answer' });
    await closing;
    expect(owner.isActive).toBe(false);
    expect(save).not.toHaveBeenCalled();
    start();
    expect(send).toHaveBeenCalledOnce();
  });
});
