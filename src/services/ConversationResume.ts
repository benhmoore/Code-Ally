import type { Message } from '../types/index.js';
import type { SessionResumeState } from './SessionRuntime.js';
import { recoverConversation } from '../utils/conversationRecovery.js';
import { isPersistentMessage } from '../utils/messagePersistence.js';

/**
 * Add results repaired in the active conversation to the full transcript used
 * for UI reconstruction. Session recovery repairs the provider-facing active
 * window, while the immutable transcript can still end at the interrupted call.
 */
export function supplementTranscriptToolResults(
  transcriptMessages: Message[],
  recoveredMessages: Message[]
): Message[] {
  const transcriptResultIds = new Set(
    transcriptMessages
      .filter(message => message.role === 'tool' && message.tool_call_id)
      .map(message => message.tool_call_id as string)
  );
  const missingResults = recoveredMessages.filter(message => (
    message.role === 'tool'
    && !!message.tool_call_id
    && !transcriptResultIds.has(message.tool_call_id)
  ));

  return missingResults.length > 0
    ? [...transcriptMessages, ...missingResults]
    : transcriptMessages;
}

/** Restore the same portable history and interrupted-tool outcomes in every frontend. */
export function prepareConversationResume(state: SessionResumeState) {
  const recovered = recoverConversation(state.messages.filter(isPersistentMessage));
  const transcript = supplementTranscriptToolResults(
    (state.transcript ?? state.messages).filter(isPersistentMessage), recovered.messages);
  const checkpoint = state.checkpoint ? structuredClone(state.checkpoint) : null;
  let providerState = state.providerState ?? checkpoint?.providerState ?? { kind: 'chat' as const };
  if (recovered.changed && providerState.kind !== 'chat') {
    providerState = { kind: 'chat' };
    if (checkpoint) {
      checkpoint.providerState = providerState;
      checkpoint.strategy = checkpoint.portability === 'extractive' ? 'local-extractive' : 'local-structured';
    }
  }
  return {
    state: { messages: recovered.messages, transcript, checkpoint, providerState,
      canonicalMessages: state.canonicalMessages ?? [] },
    interruption: recovered.interruption,
  };
}
