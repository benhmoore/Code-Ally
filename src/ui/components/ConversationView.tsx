import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { Message, ToolCallState } from '../../types/index.js';
import { MessageDisplay } from './MessageDisplay.js';
import { ToolCallDisplay } from './ToolCallDisplay.js';
import { CompactionNotice } from '../contexts/AppContext.js';

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
  /** Compaction notices to display */
  compactionNotices?: CompactionNotice[];
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

  // Filter out invisible tools recursively
  const filterInvisibleTools = (
    calls: (ToolCallState & { children?: ToolCallState[] })[]
  ): (ToolCallState & { children?: ToolCallState[] })[] => {
    return calls
      .filter(call => call.visibleInChat !== false)
      .map(call => {
        if (call.children?.length) {
          call.children = filterInvisibleTools(call.children);
        }
        return call;
      });
  };

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

  // First filter invisible tools, then process transparent wrappers
  const visibleCalls = filterInvisibleTools(rootCalls);
  return processTransparentWrappers(visibleCalls);
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
 * Item that can be rendered chronologically (either a message, tool call, or compaction notice)
 */
type TimelineItem =
  | { type: 'message'; message: Message; index: number; timestamp: number }
  | { type: 'toolCall'; toolCall: ToolCallState & { children?: ToolCallState[] }; timestamp: number }
  | { type: 'compactionNotice'; notice: CompactionNotice; timestamp: number };

/**
 * Memoized completed content - never re-renders when active tools update
 */
const CompletedContent = React.memo<{ timeline: TimelineItem[]; terminalWidth: number }>(({ timeline, terminalWidth }) => {
  const dividerWidth = Math.max(60, terminalWidth - 4); // Account for padding
  const divider = '─'.repeat(dividerWidth);

  return (
    <>
      {timeline.map((item) => {
        if (item.type === 'message') {
          return <MessageDisplay key={`msg-${item.index}`} message={item.message} />;
        } else if (item.type === 'toolCall') {
          return (
            <Box key={`tool-${item.toolCall.id}`}>
              {renderToolCallTree(item.toolCall, 0)}
            </Box>
          );
        } else {
          // Compaction notice with horizontal divider
          return (
            <Box key={`compaction-${item.notice.id}`} flexDirection="column" marginY={1}>
              <Box>
                <Text dimColor>{divider}</Text>
              </Box>
              <Box>
                <Text color="cyan" bold>
                  Context compacted
                </Text>
                <Text dimColor> - Previous conversation summarized (was at {item.notice.oldContextUsage}%, threshold {item.notice.threshold}%)</Text>
              </Box>
              <Box>
                <Text dimColor>{divider}</Text>
              </Box>
            </Box>
          );
        }
      })}
    </>
  );
});

/**
 * Memoized active content - only re-renders when active tools change
 */
const ActiveContent = React.memo<{
  runningToolCalls: (ToolCallState & { children?: ToolCallState[] })[];
  streamingContent?: string;
  contextUsage: number;
}>(({ runningToolCalls, streamingContent, contextUsage }) => (
  <>
    {contextUsage >= 70 && (
      <Box>
        <Text color={contextUsage >= 90 ? 'red' : 'yellow'}>
          Context: {contextUsage}% used
        </Text>
      </Box>
    )}

    {runningToolCalls.map((toolCall) => (
      <Box key={`running-tool-${toolCall.id}`}>
        {renderToolCallTree(toolCall, 0)}
      </Box>
    ))}

    {streamingContent && (
      <Box>
        <Text color="green">{streamingContent}</Text>
      </Box>
    )}
  </>
));

/**
 * Simple ConversationView - renders completed and active content separately
 */
export const ConversationView: React.FC<ConversationViewProps> = ({
  messages,
  streamingContent,
  activeToolCalls = [],
  contextUsage,
  compactionNotices = [],
}) => {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || 80; // Fallback to 80 if unavailable
  const toolCallTree = buildToolCallTree(activeToolCalls);

  // Separate completed from running tool calls
  const { completedToolCalls, runningToolCalls } = React.useMemo(() => {
    const completed = toolCallTree.filter(
      (tc) => tc.status === 'success' || tc.status === 'error' || tc.status === 'cancelled'
    );
    const running = toolCallTree.filter(
      (tc) => tc.status === 'executing' || tc.status === 'pending' || tc.status === 'validating'
    );
    return { completedToolCalls: completed, runningToolCalls: running };
  }, [toolCallTree]);

  // Build completed timeline (messages + completed tools + compaction notices) - memoized
  const completedTimeline = React.useMemo(() => {
    const timeline: TimelineItem[] = [];

    // Add all messages (except tool role messages - they're shown via ToolCallDisplay)
    messages.forEach((message, index) => {
      // Skip tool role messages - they should only appear via ToolCallDisplay with ToolCallState
      if (message.role === 'tool') {
        return;
      }

      // Skip assistant messages that only have tool_calls and no content
      if (message.role === 'assistant' && message.tool_calls && !message.content) {
        return;
      }

      timeline.push({
        type: 'message',
        message,
        index,
        timestamp: (message as any).timestamp || 0,
      });
    });

    // Add completed tool calls
    completedToolCalls.forEach((toolCall) => {
      timeline.push({
        type: 'toolCall',
        toolCall,
        timestamp: toolCall.startTime,
      });
    });

    // Add compaction notices
    compactionNotices.forEach((notice) => {
      timeline.push({
        type: 'compactionNotice',
        notice,
        timestamp: notice.timestamp,
      });
    });

    timeline.sort((a, b) => a.timestamp - b.timestamp);
    return timeline;
  }, [messages, completedToolCalls, compactionNotices]);

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Code Ally
        </Text>
        <Text dimColor> - Terminal UI (Ink)</Text>
      </Box>

      {/* Completed content - memoized, doesn't re-render */}
      <CompletedContent timeline={completedTimeline} terminalWidth={terminalWidth} />

      {/* Active content - only re-renders when active tools change */}
      <ActiveContent
        runningToolCalls={runningToolCalls}
        streamingContent={streamingContent}
        contextUsage={contextUsage}
      />
    </Box>
  );
};
