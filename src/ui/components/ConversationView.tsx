import React from 'react';
import { Box, Text } from 'ink';
import { Message, ToolCallState } from '../../types/index.js';
import { MessageDisplay } from './MessageDisplay.js';
import { ToolCallDisplay } from './ToolCallDisplay.js';

interface ConversationViewProps {
  /** Array of conversation messages to display */
  messages: Message[];
  /** Whether the assistant is currently thinking/processing */
  isThinking?: boolean;
  /** Current streaming content (if any) */
  streamingContent?: string;
  /** Active tool calls to display */
  activeToolCalls?: ToolCallState[];
}

/**
 * ConversationView Component
 *
 * Main container for displaying conversation history. Uses Ink's performance
 * optimization patterns to efficiently render messages.
 *
 * Performance Strategy:
 * - Completed messages are rendered statically (no re-renders)
 * - Only pending/streaming messages update dynamically
 * - Flexible layout adapts to terminal size
 *
 * Note: Unlike Python Rich which uses Live displays, Ink automatically
 * handles re-rendering when state changes. We don't use <Static> here
 * because Ink's reconciliation is already efficient and Static has
 * limitations with dynamic content.
 */
/**
 * Build tree structure from flat tool call list
 */
function buildToolCallTree(toolCalls: ToolCallState[]): ToolCallState[] {
  // Create a map of all tool calls by ID
  const toolCallMap = new Map<string, ToolCallState & { children?: ToolCallState[] }>();
  toolCalls.forEach((tc) => {
    toolCallMap.set(tc.id, { ...tc, children: [] });
  });

  // Build tree by adding children to parents
  const rootCalls: (ToolCallState & { children?: ToolCallState[] })[] = [];
  toolCalls.forEach((tc) => {
    const toolCallWithChildren = toolCallMap.get(tc.id);
    if (!toolCallWithChildren) return;

    if (tc.parentId) {
      const parent = toolCallMap.get(tc.parentId);
      if (parent && parent.children) {
        parent.children.push(toolCallWithChildren);
      } else {
        // Parent not found, treat as root
        rootCalls.push(toolCallWithChildren);
      }
    } else {
      // No parent, this is a root call
      rootCalls.push(toolCallWithChildren);
    }
  });

  // Process transparent wrappers: promote their children and remove them
  const processTransparentWrappers = (
    calls: (ToolCallState & { children?: ToolCallState[] })[]
  ): (ToolCallState & { children?: ToolCallState[] })[] => {
    const result: (ToolCallState & { children?: ToolCallState[] })[] = [];

    for (const call of calls) {
      // If this is a transparent wrapper, promote its children
      if (call.isTransparent && call.children && call.children.length > 0) {
        // Recursively process children first
        const processedChildren = processTransparentWrappers(call.children);
        // Add children directly to result (promoting them)
        result.push(...processedChildren);
      } else {
        // Not transparent, recursively process its children
        if (call.children && call.children.length > 0) {
          call.children = processTransparentWrappers(call.children);
        }
        result.push(call);
      }
    }

    return result;
  };

  return processTransparentWrappers(rootCalls);
}

/**
 * Render tool call with children recursively
 */
function renderToolCallTree(
  toolCall: ToolCallState & { children?: ToolCallState[] },
  level: number = 0
): React.ReactNode {
  return (
    <ToolCallDisplay key={toolCall.id} toolCall={toolCall} level={level}>
      {toolCall.children && toolCall.children.length > 0 && (
        <>
          {toolCall.children.map((child) => renderToolCallTree(child, level + 1))}
        </>
      )}
    </ToolCallDisplay>
  );
}

type ConversationItem =
  | { type: 'message'; message: Message; index: number; timestamp: number }
  | { type: 'toolCall'; toolCall: ToolCallState & { children?: ToolCallState[] }; timestamp: number };

export const ConversationView: React.FC<ConversationViewProps> = ({
  messages,
  isThinking = false,
  streamingContent,
  activeToolCalls = [],
}) => {
  // Build tree structure from flat tool call list
  const toolCallTree = buildToolCallTree(activeToolCalls);

  // Merge messages and tool calls chronologically
  const conversationItems: ConversationItem[] = [];

  // Add messages
  messages.forEach((message, index) => {
    conversationItems.push({
      type: 'message',
      message,
      index,
      timestamp: message.timestamp || 0,
    });
  });

  // Add root tool calls (children will be rendered recursively)
  toolCallTree.forEach((toolCall) => {
    conversationItems.push({
      type: 'toolCall',
      toolCall,
      timestamp: toolCall.startTime,
    });
  });

  // Sort chronologically
  conversationItems.sort((a, b) => a.timestamp - b.timestamp);

  return (
    <Box flexDirection="column" gap={1}>
      {/* Render conversation items in chronological order */}
      {conversationItems.map((item) => {
        if (item.type === 'message') {
          return <MessageDisplay key={`msg-${item.index}`} message={item.message} />;
        } else {
          return <React.Fragment key={`tool-${item.toolCall.id}`}>{renderToolCallTree(item.toolCall, 0)}</React.Fragment>;
        }
      })}

      {/* Show streaming content if present */}
      {streamingContent && (
        <Box flexDirection="column">
          <Text color="green">{streamingContent}</Text>
        </Box>
      )}
    </Box>
  );
};
