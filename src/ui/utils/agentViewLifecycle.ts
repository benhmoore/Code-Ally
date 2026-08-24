import type { BackgroundAgentStatus } from '@services/BackgroundAgentManager.js';
import type { Message, ToolCallState } from '@shared/index.js';

/**
 * An entered child is only interactive while its tracked run is alive. Once
 * it settles (or is removed), the UI must stop routing input to that child.
 */
export function shouldRestoreMainView(
  activeAgentId: string,
  taskStatus: BackgroundAgentStatus | null,
): boolean {
  return activeAgentId !== 'main' && taskStatus !== 'running';
}

/**
 * Reconcile a freshly reconstructed main transcript with the live tool state
 * captured when the user entered a child. Completed calls are authoritative in
 * message history; calls without a tool-result message are still in flight and
 * retain their live UI metadata when available.
 */
export function reconcileRestoredToolCalls(
  messages: Message[],
  reconstructed: ToolCallState[],
  previouslyLive: ToolCallState[],
): ToolCallState[] {
  const completedIds = new Set(
    messages
      .filter((message) => message.role === 'tool' && message.tool_call_id)
      .map((message) => message.tool_call_id as string),
  );
  const previousById = new Map(previouslyLive.map((toolCall) => [toolCall.id, toolCall]));

  return reconstructed.map((toolCall) => {
    if (completedIds.has(toolCall.id)) return toolCall;
    return previousById.get(toolCall.id) ?? {
      ...toolCall,
      status: 'executing',
      endTime: undefined,
    };
  });
}

/**
 * Resolve stale live tool state when the main agent ends. Tool-result messages
 * are authoritative: their reconstructed terminal state wins over a queued UI
 * update that has not rendered yet. Only calls with no recorded result become
 * errors.
 */
export function finalizeToolCallsAtAgentEnd(
  liveCalls: ToolCallState[],
  reconstructed: ToolCallState[],
  now: number,
): ToolCallState[] {
  const terminal = new Set(['success', 'error', 'cancelled']);
  const reconstructedById = new Map(reconstructed.map((call) => [call.id, call]));

  return liveCalls.map((call) => {
    if (terminal.has(call.status)) return call;
    const recorded = reconstructedById.get(call.id);
    if (recorded && terminal.has(recorded.status)) return recorded;
    return {
      ...call,
      status: 'error',
      endTime: now,
      error: call.error || 'Tool did not report completion',
    };
  });
}

/**
 * Apply terminal states already proven by durable tool-result messages while a
 * turn is still running. Activity events are an optimization for live display;
 * they are not authoritative and may be missed during a repaint or compaction.
 */
export function reconcileRecordedToolCalls(
  messages: Message[],
  liveCalls: ToolCallState[],
  reconstructed: ToolCallState[],
): ToolCallState[] {
  const recordedIds = new Set(
    messages
      .filter((message) => message.role === 'tool' && message.tool_call_id)
      .map((message) => message.tool_call_id as string),
  );
  const recordedById = new Map(
    reconstructed
      .filter((call) => recordedIds.has(call.id))
      .map((call) => [call.id, call]),
  );

  return liveCalls.map((call) => recordedById.get(call.id) ?? call);
}
