import type { Message, ToolCallState } from '../types/index.js';
import type { ToolManager } from '../tools/ToolManager.js';
import { resolveDisplayContent } from '../utils/toolResultContent.js';

/**
 * Reconstruct ToolCallState objects from message history
 *
 * When loading a session from disk, we have messages with tool_calls and tool results,
 * but we don't have the ToolCallState objects that are needed for proper UI rendering.
 * This function reconstructs those states from the message history.
 *
 * Tool context data is stored in two places:
 * - Assistant messages: parentId, thinking, thinkingDuration (in metadata.tool_context)
 * - Tool result messages: executionStartTime, agentModel (in metadata.tool_context)
 *
 * @param messages - Array of messages from the session
 * @param serviceRegistry - Service registry to look up tool definitions
 * @returns Array of reconstructed ToolCallState objects
 */
export function reconstructToolCallsFromMessages(messages: Message[], serviceRegistry: { get: (name: 'tool_manager') => ToolManager | null | undefined }): ToolCallState[] {
  const toolCalls: ToolCallState[] = [];
  const toolResultsMap = new Map<string, {
    output: string;
    error?: string;
    isError: boolean;
    timestamp?: number;
    metadata?: any;
  }>();

  // Get ToolManager to look up tool visibility
  const toolManager = serviceRegistry.get('tool_manager');

  // First pass: collect all tool results.
  // Output is read from the persisted DISPLAY payload (metadata.tool_result),
  // never from msg.content — that field holds the LLM wire format
  // ([Tool Call ID]\n<JSON> / <error> wrappers) and must not reach the UI.
  messages.forEach(msg => {
    if (msg.role === 'tool' && msg.tool_call_id) {
      const display = msg.metadata?.tool_result?.[msg.tool_call_id];
      toolResultsMap.set(msg.tool_call_id, {
        output: resolveDisplayContent(display),
        error: display?.error,
        // `is_error` is the protocol-level source of truth and is present even
        // on recovery results created before display metadata existed.
        isError: msg.is_error === true,
        timestamp: msg.timestamp,
        metadata: msg.metadata,
      });
    }
  });

  // Second pass: reconstruct tool call states from assistant messages
  messages.forEach(msg => {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const baseTimestamp = msg.timestamp || Date.now();

      msg.tool_calls.forEach((tc, index) => {
        const result = toolResultsMap.get(tc.id);
        const hasDisplayError = typeof result?.error === 'string'
          ? result.error.length > 0
          : result?.error != null;
        const hasError = result?.isError === true || hasDisplayError;

        // Parse arguments if they're a string
        let parsedArgs: any;
        try {
          parsedArgs = typeof tc.function.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function.arguments;
        } catch {
          parsedArgs = tc.function.arguments;
        }

        // Prefer stored metadata over current tool definitions (for backwards compatibility with version changes)
        let visibleInChat = true; // Default to visible
        let alwaysShowFullOutput = false; // Default to not always showing full output
        let status: ToolCallState['status'] = result ? 'success' : 'pending';

        // First, try to get visibility from stored metadata
        if (msg.metadata?.tool_visibility?.[tc.id] !== undefined) {
          visibleInChat = msg.metadata.tool_visibility[tc.id] ?? true;
        } else if (toolManager) {
          // Fallback to current tool definition if no stored metadata
          const toolDef = toolManager.getTool(tc.function.name);
          if (toolDef) {
            visibleInChat = toolDef.visibleInChat ?? true;
          }
        }

        // Get display flags from tool definition
        let hideOutput = false;
        if (toolManager) {
          const toolDef = toolManager.getTool(tc.function.name);
          if (toolDef) {
            alwaysShowFullOutput = (toolDef as any).alwaysShowFullOutput ?? false;
            hideOutput = (toolDef as any).hideOutput ?? false;
          }
        }

        // Try to get status from stored metadata (prefer tool result message metadata over assistant message)
        // Tool result message metadata is more accurate as it's set at execution time
        if (result?.isError === true) {
          status = 'error';
        } else if (result?.metadata?.tool_status?.[tc.id]) {
          status = result.metadata.tool_status[tc.id];
        } else if (result) {
          // Fallback to inferring from result
          status = hasError ? 'error' : 'success';
        }

        // Merge tool_context from both assistant message and tool result message
        // Assistant message contains: parentId, thinking, thinkingDuration
        // Tool result message contains: executionStartTime, agentModel
        const assistantToolContext = msg.metadata?.tool_context?.[tc.id];
        const resultToolContext = result?.metadata?.tool_context?.[tc.id];

        // Extract context data from both sources
        const parentId = assistantToolContext?.parentId;
        const thinking = assistantToolContext?.thinking;
        const thinkingDuration = assistantToolContext?.thinkingDuration;
        const executionStartTime = resultToolContext?.executionStartTime;
        const agentModel = resultToolContext?.agentModel;

        // Calculate thinking timing if we have thinking content
        let thinkingStartTime: number | undefined;
        let thinkingEndTime: number | undefined;
        if (thinking) {
          // If we have thinking duration, calculate timing based on message timestamp
          if (thinkingDuration !== undefined) {
            // Thinking ends when the message is created (baseTimestamp)
            thinkingEndTime = baseTimestamp + index;
            thinkingStartTime = thinkingEndTime - thinkingDuration;
          } else {
            // Fallback: estimate thinking occurred just before the message
            thinkingEndTime = baseTimestamp + index;
            // Without duration, we can't accurately set startTime
          }
        }

        const toolCallState: ToolCallState = {
          id: tc.id,
          status,
          toolName: tc.function.name,
          arguments: parsedArgs,
          output: result?.output,
          error: result?.error,
          startTime: baseTimestamp + index, // Slightly offset multiple calls in same message
          // Legacy recovery results had no timestamp. A terminal call with an
          // unknown end time should render zero/unknown duration, not keep
          // aging every time the session is opened.
          endTime: result ? (result.timestamp ?? baseTimestamp + index) : undefined,
          visibleInChat: visibleInChat,
          hideOutput,
          alwaysShowFullOutput,
          // Add reconstructed tool context fields
          ...(parentId !== undefined && { parentId }),
          ...(thinking !== undefined && { thinking }),
          ...(thinkingStartTime !== undefined && { thinkingStartTime }),
          ...(thinkingEndTime !== undefined && { thinkingEndTime }),
          ...(executionStartTime !== undefined && { executionStartTime }),
          ...(agentModel !== undefined && { agentModel }),
        };

        toolCalls.push(toolCallState);
      });
    }
  });

  return toolCalls;
}

