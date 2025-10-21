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
  /** Context usage percentage */
  contextUsage: number;
}

/**
 * Build tree structure from flat tool call list
 */
function buildToolCallTree(toolCalls: ToolCallState[]): (ToolCallState & { children?: ToolCallState[] })[] {
  const toolCallMap = new Map<string, ToolCallState & { children?: ToolCallState[] }>();
  toolCalls.forEach((tc) => {
    toolCallMap.set(tc.id, { ...tc, children: [] });
  });

  const rootCalls: (ToolCallState & { children?: ToolCallState[] })[] = [];
  toolCalls.forEach((tc) => {
    const toolCallWithChildren = toolCallMap.get(tc.id);
    if (!toolCallWithChildren) return;

    if (tc.parentId) {
      const parent = toolCallMap.get(tc.parentId);
      if (parent?.children) {
        parent.children.push(toolCallWithChildren);
      } else {
        rootCalls.push(toolCallWithChildren);
      }
    } else {
      rootCalls.push(toolCallWithChildren);
    }
  });

  // Process transparent wrappers: promote their children
  const processTransparentWrappers = (
    calls: (ToolCallState & { children?: ToolCallState[] })[]
  ): (ToolCallState & { children?: ToolCallState[] })[] => {
    const result: (ToolCallState & { children?: ToolCallState[] })[] = [];

    for (const call of calls) {
      if (call.isTransparent && call.children?.length) {
        result.push(...processTransparentWrappers(call.children));
      } else {
        if (call.children?.length) {
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

/**
 * Item that can be rendered chronologically (either a message or tool call)
 */
type TimelineItem =
  | { type: 'message'; message: Message; index: number; timestamp: number }
  | { type: 'toolCall'; toolCall: ToolCallState & { children?: ToolCallState[] }; timestamp: number };

/**
 * Simple ConversationView - renders everything chronologically
 */
export const ConversationView: React.FC<ConversationViewProps> = ({
  messages,
  streamingContent,
  activeToolCalls = [],
  contextUsage,
}) => {
  const toolCallTree = buildToolCallTree(activeToolCalls);

  // Combine messages and tool calls into a chronological timeline
  const timeline: TimelineItem[] = [];

  // Add messages with their timestamps
  messages.forEach((message, index) => {
    timeline.push({
      type: 'message',
      message,
      index,
      timestamp: (message as any).timestamp || 0,
    });
  });

  // Add root-level tool calls with their start times
  toolCallTree.forEach((toolCall) => {
    timeline.push({
      type: 'toolCall',
      toolCall,
      timestamp: toolCall.startTime,
    });
  });

  // Sort by timestamp
  timeline.sort((a, b) => a.timestamp - b.timestamp);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Code Ally
        </Text>
        <Text dimColor> - Terminal UI (Ink)</Text>
      </Box>

      {/* Chronologically ordered messages and tool calls */}
      {timeline.map((item) => {
        if (item.type === 'message') {
          return <MessageDisplay key={`msg-${item.index}`} message={item.message} />;
        } else {
          return (
            <Box key={`tool-${item.toolCall.id}`}>
              {renderToolCallTree(item.toolCall, 0)}
            </Box>
          );
        }
      })}

      {/* Context warning */}
      {contextUsage >= 70 && (
        <Box>
          <Text color={contextUsage >= 90 ? 'red' : 'yellow'}>
            Context: {contextUsage}% used
          </Text>
        </Box>
      )}

      {/* Streaming content */}
      {streamingContent && (
        <Box>
          <Text color="green">{streamingContent}</Text>
        </Box>
      )}
    </Box>
  );
};
