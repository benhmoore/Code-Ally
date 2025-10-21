import React, { useMemo } from 'react';
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

/**
 * Internal ConversationView Component
 */
const ConversationViewComponent: React.FC<ConversationViewProps> = ({
  messages,
  isThinking = false,
  streamingContent,
  activeToolCalls = [],
}) => {
  // Memoize expensive tree building and sorting
  // Only recompute when messages or tool calls actually change
  const conversationItems = useMemo(() => {
    // Build tree structure from flat tool call list
    const toolCallTree = buildToolCallTree(activeToolCalls);

    // Merge messages and tool calls chronologically
    const items: ConversationItem[] = [];

    // Add messages
    messages.forEach((message, index) => {
      items.push({
        type: 'message',
        message,
        index,
        timestamp: message.timestamp || 0,
      });
    });

    // Add root tool calls (children will be rendered recursively)
    toolCallTree.forEach((toolCall) => {
      items.push({
        type: 'toolCall',
        toolCall,
        timestamp: toolCall.startTime,
      });
    });

    // Sort chronologically
    items.sort((a, b) => a.timestamp - b.timestamp);

    return items;
  }, [messages, activeToolCalls]);

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

/**
 * Memoized ConversationView
 *
 * CRITICAL PERFORMANCE FIX:
 * Prevents re-rendering the entire conversation history on every keypress in InputPrompt.
 *
 * Without this, typing in the input causes:
 * - InputPrompt state update (buffer changes)
 * - Parent App re-renders
 * - ConversationView re-renders with ALL messages
 * - With content > viewport height = full screen erase/redraw = flickering
 *
 * With memoization:
 * - InputPrompt updates independently
 * - ConversationView only re-renders when messages/toolCalls actually change
 * - Result: Smooth typing even with 1000+ messages
 */
export const ConversationView = React.memo(
  ConversationViewComponent,
  (prevProps, nextProps) => {
    // Only re-render if conversation data actually changed
    if (prevProps.messages !== nextProps.messages) return false;
    if (prevProps.activeToolCalls !== nextProps.activeToolCalls) return false;
    if (prevProps.isThinking !== nextProps.isThinking) return false;
    if (prevProps.streamingContent !== nextProps.streamingContent) return false;

    // Props are the same - skip re-render
    return true;
  }
);
