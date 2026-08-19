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
