import React, { useState, useEffect } from 'react';
import { Box, Text, Static, useStdout } from 'ink';
import { Message, ToolCallState } from '../../types/index.js';
import { MessageDisplay } from './MessageDisplay.js';
import { ToolCallDisplay } from './ToolCallDisplay.js';
import { CompactionNotice, RewindNotice } from '../contexts/AppContext.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { BUFFER_SIZES, TEXT_LIMITS } from '../../config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, '../../../package.json'), 'utf-8'));

/**
 * Get the current git branch name
 */
const getGitBranch = (): string | null => {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf-8',
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
    return branch || null;
  } catch (error) {
    return null;
  }
};

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
  /** Rewind notices to display */
  rewindNotices?: RewindNotice[];
  /** Key to force Static remount for compaction/rewind */
  staticRemountKey: number;
  /** Config for displaying model info */
  config?: any;
  /** Number of loaded plugins */
  pluginCount?: number;
}

/**
 * Build tree structure from flat tool call list
 */
function buildToolCallTree(toolCalls: ToolCallState[]): (ToolCallState & { children?: ToolCallState[]; totalChildCount?: number })[] {
  const toolCallMap = new Map<string, ToolCallState & { children?: ToolCallState[]; totalChildCount?: number }>();
  toolCalls.forEach((tc) => {
    toolCallMap.set(tc.id, { ...tc, children: [], totalChildCount: 0 });
  });

  const rootCalls: (ToolCallState & { children?: ToolCallState[]; totalChildCount?: number })[] = [];
  toolCalls.forEach((tc) => {
    const toolCallWithChildren = toolCallMap.get(tc.id);
    if (!toolCallWithChildren) return;

    if (tc.parentId) {
      const parent = toolCallMap.get(tc.parentId);
      if (parent?.children) {
        parent.children.push(toolCallWithChildren);
        // Increment total count for parent
        parent.totalChildCount = (parent.totalChildCount || 0) + 1;
      } else {
        rootCalls.push(toolCallWithChildren);
      }
    } else {
      rootCalls.push(toolCallWithChildren);
    }
  });

  // Limit agent delegations to show only last N tool calls
  const limitAgentToolCalls = (
    calls: (ToolCallState & { children?: ToolCallState[]; totalChildCount?: number })[]
  ): (ToolCallState & { children?: ToolCallState[]; totalChildCount?: number })[] => {
    return calls.map(call => {
      // Check if this is an agent delegation (has 'agent' in toolName)
      const isAgentDelegation = call.toolName === 'agent';

      if (isAgentDelegation && call.children && call.children.length > BUFFER_SIZES.TOP_ITEMS_PREVIEW) {
        // Keep total count before limiting
        call.totalChildCount = call.children.length;
        // Keep only last N children
        call.children = call.children.slice(-BUFFER_SIZES.TOP_ITEMS_PREVIEW);
      }

      // Recursively process children
      if (call.children?.length) {
        call.children = limitAgentToolCalls(call.children);
      }

      return call;
    });
  };

  // Filter out invisible tools recursively
  const filterInvisibleTools = (
    calls: (ToolCallState & { children?: ToolCallState[]; totalChildCount?: number })[]
  ): (ToolCallState & { children?: ToolCallState[]; totalChildCount?: number })[] => {
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

  // First limit agent tool calls, then filter invisible tools, then process transparent wrappers
  const limitedCalls = limitAgentToolCalls(rootCalls);
  const visibleCalls = filterInvisibleTools(limitedCalls);
  return processTransparentWrappers(visibleCalls);
}

/**
 * Render tool call with children recursively
 */
function renderToolCallTree(
  toolCall: ToolCallState & { children?: ToolCallState[] },
  level: number = 0,
  config?: any
): React.ReactNode {
  return (
    <ToolCallDisplay key={toolCall.id} toolCall={toolCall} level={level} config={config}>
      {toolCall.children && toolCall.children.length > 0 && (
        <>
          {toolCall.children.map((child) => renderToolCallTree(child, level + 1, config))}
        </>
      )}
    </ToolCallDisplay>
  );
}

/**
 * Item that can be rendered chronologically (either a message, tool call, compaction notice, or rewind notice)
 */
type TimelineItem =
  | { type: 'message'; message: Message; index: number; timestamp: number }
  | { type: 'toolCall'; toolCall: ToolCallState & { children?: ToolCallState[] }; timestamp: number }
  | { type: 'compactionNotice'; notice: CompactionNotice; timestamp: number }
  | { type: 'rewindNotice'; notice: RewindNotice; timestamp: number };


/**
 * Memoized active content - only re-renders when active tools change
 */
const ActiveContent = React.memo<{
  runningToolCalls: (ToolCallState & { children?: ToolCallState[] })[];
  streamingContent?: string;
  contextUsage: number;
  config?: any;
}>(({ runningToolCalls, streamingContent, config }) => (
  <>
    {runningToolCalls.map((toolCall) => (
      <Box key={`running-tool-${toolCall.id}`}>
        {renderToolCallTree(toolCall, 0, config)}
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
 * ConversationView - renders completed and active content separately
 * Uses Static component to prevent thrashing, with header rendered outside Static
 * to minimize duplication during compaction/rewind
 */
const ConversationViewComponent: React.FC<ConversationViewProps> = ({
  messages,
  streamingContent,
  activeToolCalls = [],
  contextUsage,
  compactionNotices = [],
  rewindNotices = [],
  staticRemountKey,
  config,
  pluginCount,
}) => {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || TEXT_LIMITS.TERMINAL_WIDTH_FALLBACK; // Fallback to 80 if unavailable

  // Get git branch on mount
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  useEffect(() => {
    const branch = getGitBranch();
    setGitBranch(branch);
  }, []);

  // Memoize toolCallTree to prevent unnecessary recalculations
  const toolCallTree = React.useMemo(() => buildToolCallTree(activeToolCalls), [activeToolCalls]);

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

    // Add all messages (except tool/system role messages and empty assistant messages)
    messages.forEach((message, index) => {
      // Skip tool role messages - they should only appear via ToolCallDisplay with ToolCallState
      if (message.role === 'tool') {
        return;
      }

      // Skip system messages - they're internal prompts
      if (message.role === 'system') {
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

    // Add rewind notices
    rewindNotices.forEach((notice) => {
      timeline.push({
        type: 'rewindNotice',
        notice,
        timestamp: notice.timestamp,
      });
    });

    timeline.sort((a, b) => a.timestamp - b.timestamp);
    return timeline;
  }, [messages, completedToolCalls, compactionNotices, rewindNotices]);

  // Pre-render timeline items as JSX for Static component
  const completedJSXItems = React.useMemo(() => {
    const dividerWidth = Math.max(TEXT_LIMITS.DIVIDER_MIN_WIDTH, terminalWidth - TEXT_LIMITS.DIVIDER_PADDING);
    const divider = '─'.repeat(dividerWidth);
    const items: React.ReactNode[] = [];

    completedTimeline.forEach((item) => {
      if (item.type === 'message') {
        items.push(<MessageDisplay key={`msg-${item.index}`} message={item.message} config={config} />);
      } else if (item.type === 'toolCall') {
        items.push(
          <Box key={`tool-${item.toolCall.id}`}>
            {renderToolCallTree(item.toolCall, 0, config)}
          </Box>
        );
      } else if (item.type === 'compactionNotice') {
        // Compaction notice
        items.push(
          <Box key={`compaction-${item.notice.id}`} flexDirection="column" marginY={1}>
            <Box><Text dimColor>{divider}</Text></Box>
            <Box>
              <Text color="cyan" bold>Context compacted</Text>
              <Text dimColor> - Previous conversation summarized (was at {item.notice.oldContextUsage}%, threshold {item.notice.threshold}%)</Text>
            </Box>
            <Box><Text dimColor>{divider}</Text></Box>
          </Box>
        );
      } else if (item.type === 'rewindNotice') {
        // Rewind notice
        items.push(
          <Box key={`rewind-${item.notice.id}`} flexDirection="column" marginY={1}>
            <Box><Text dimColor>{divider}</Text></Box>
            <Box>
              <Text color="yellow" bold>Conversation rewound</Text>
              <Text dimColor> - Returned to message #{item.notice.targetMessageIndex + 1}</Text>
            </Box>
            <Box><Text dimColor>{divider}</Text></Box>
          </Box>
        );
      }
    });

    return items;
  }, [completedTimeline, terminalWidth]);

  return (
    <Box flexDirection="column">
      {/* Header - only show when no messages */}
      {messages.length === 0 && (
        <Box borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
          <Box flexDirection="row">
            <Box flexDirection="column" marginRight={2}>
              <Text color="yellow" bold>      __</Text>
              <Text color="yellow" bold>  ___( o)&gt;</Text>
              <Text color="yellow" bold>  \ &lt;_. )</Text>
              <Text color="yellow" bold>   `---&apos;  </Text>
            </Box>
            <Box flexDirection="column">
              <Text>Ally v{packageJson.version}</Text>
              <Text dimColor>{config?.model || 'No model configured'}</Text>
              <Text dimColor>{process.cwd()}</Text>
              {pluginCount !== undefined && pluginCount > 0 && (
                <Text dimColor>{pluginCount} plugin{pluginCount === 1 ? '' : 's'} loaded</Text>
              )}
              {gitBranch && (
                <Text dimColor color="yellow">branch: {gitBranch}</Text>
              )}
            </Box>
          </Box>
        </Box>
      )}

      {/* Completed content in Static - prevents thrashing */}
      <Static key={`static-${staticRemountKey}`} items={completedJSXItems}>
        {(item) => item}
      </Static>

      {/* Active content - only re-renders when active tools change */}
      <ActiveContent
        runningToolCalls={runningToolCalls}
        streamingContent={streamingContent}
        contextUsage={contextUsage}
        config={config}
      />
    </Box>
  );
};

/**
 * Memoized ConversationView - only re-renders when props actually change
 */
export const ConversationView = React.memo(ConversationViewComponent, (prevProps, nextProps) => {
  const messagesSame = prevProps.messages === nextProps.messages;
  const streamingSame = prevProps.streamingContent === nextProps.streamingContent;
  const toolCallsSame = prevProps.activeToolCalls === nextProps.activeToolCalls;
  const contextSame = prevProps.contextUsage === nextProps.contextUsage;
  const compactionNoticesSame = prevProps.compactionNotices === nextProps.compactionNotices;
  const rewindNoticesSame = prevProps.rewindNotices === nextProps.rewindNotices;
  const isThinkingSame = prevProps.isThinking === nextProps.isThinking;
  const staticKeySame = prevProps.staticRemountKey === nextProps.staticRemountKey;
  const configSame = prevProps.config === nextProps.config;

  return messagesSame && streamingSame && toolCallsSame && contextSame && compactionNoticesSame && rewindNoticesSame && isThinkingSame && staticKeySame && configSame;
});
