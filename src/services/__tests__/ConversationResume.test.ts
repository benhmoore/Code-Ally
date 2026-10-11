import { describe, expect, it } from 'vitest';
import { prepareConversationResume } from '../ConversationResume.js';
import type { Message } from '../../types/index.js';
import { emptySemanticCheckpoint, type ConversationCheckpointV1 } from '../../agent/compaction/types.js';

const call: Message = { id: 'call-message', role: 'assistant', content: '', tool_calls: [
  { id: 'unfinished', type: 'function', function: { name: 'bash', arguments: '{"command":"npm test"}' } },
] };
const checkpoint: ConversationCheckpointV1 = {
  schemaVersion: 1, id: 'checkpoint', generation: 1, createdAt: '2026-10-10T00:00:00.000Z',
  trigger: 'automatic', phase: 'mid-turn', strategy: 'openai-native', portability: 'extractive',
  provider: 'test', model: 'test', source: { firstMessageId: 'old', lastMessageId: 'old', messageIds: ['old'], digest: 'hash' },
  retainedMessageIds: ['call-message'], semanticState: emptySemanticCheckpoint(),
  providerState: { kind: 'openai-responses', items: [{ type: 'compaction' }], coveredMessageIds: ['old'] },
  replacementMessages: [], budget: { contextWindow: 1000, estimatedBefore: 900, triggerBudget: 800,
    targetBudget: 500, outputReserve: 100, safetyReserve: 100, after: 400 },
};

describe('portable session recovery', () => {
  it('repairs interrupted outcomes in both histories and invalidates opaque provider replay', () => {
    const original = structuredClone(checkpoint);
    const { state } = prepareConversationResume({ messages: [call],
      transcript: [{ id: 'old', role: 'user', content: 'Original objective' }, call], checkpoint });
    expect(state.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'unfinished', is_error: true });
    expect(state.transcript.at(-1)).toEqual(state.messages.at(-1));
    expect(state.transcript[0]?.content).toBe('Original objective');
    expect(state.providerState).toEqual({ kind: 'chat' });
    expect(state.checkpoint).toMatchObject({ strategy: 'local-extractive', providerState: { kind: 'chat' } });
    expect(checkpoint).toEqual(original);
    const repeated = prepareConversationResume(state).state;
    expect(repeated.transcript).toEqual(state.transcript);
  });

  it('retains opaque replay when the corresponding wire history needs no repair', () => {
    const { state } = prepareConversationResume({ messages: [{ role: 'user', content: 'Continue' }], checkpoint });
    expect(state.providerState).toEqual(checkpoint.providerState);
    expect(state.checkpoint?.strategy).toBe('openai-native');
  });
});
