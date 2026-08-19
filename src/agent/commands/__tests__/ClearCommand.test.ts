import { describe, expect, it, vi } from 'vitest';
import { ActivityEventType } from '@shared/index.js';
import { ClearCommand } from '../ClearCommand.js';

describe('ClearCommand', () => {
  it('clears through the agent before resetting the UI', async () => {
    const order: string[] = [];
    const agent = {
      clearConversation: vi.fn(async () => { order.push('persisted'); }),
    };
    const activityStream = {
      emit: vi.fn(() => { order.push('emitted'); }),
    };
    const registry = {
      get: (name: string) => name === 'agent' ? agent : activityStream,
    };

    const result = await new ClearCommand().execute([], [], registry as never);

    expect(result.handled).toBe(true);
    expect(agent.clearConversation).toHaveBeenCalledOnce();
    expect(activityStream.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: ActivityEventType.CONVERSATION_CLEAR,
    }));
    expect(order).toEqual(['persisted', 'emitted']);
  });

  it('does not clear the UI when durable replacement fails', async () => {
    const activityStream = { emit: vi.fn() };
    const registry = {
      get: (name: string) => name === 'agent'
        ? { clearConversation: vi.fn(async () => { throw new Error('save failed'); }) }
        : activityStream,
    };

    await expect(
      new ClearCommand().execute([], [], registry as never)
    ).rejects.toThrow('save failed');
    expect(activityStream.emit).not.toHaveBeenCalled();
  });
});
