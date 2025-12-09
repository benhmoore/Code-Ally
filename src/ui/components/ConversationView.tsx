import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, Static } from 'ink';
import { Message, ToolCallState, SessionInfo } from '@shared/index.js';
import { MessageDisplay } from './MessageDisplay.js';
import { ToolCallDisplay } from './ToolCallDisplay.js';
import { CompactionNotice, RewindNotice, StatusMessage } from '../contexts/AppContext.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { BUFFER_SIZES, AGENT_DELEGATION_TOOLS } from '@config/constants.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { createDivider } from '../utils/uiHelpers.js';
import { UI_COLORS } from '../constants/colors.js';
import { formatRelativeTime } from '../utils/timeUtils.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { SessionManager } from '@services/SessionManager.js';

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
  /** Status messages to display (connection retries, etc.) */
  statusMessages?: StatusMessage[];
  /** Key to force Static remount for compaction/rewind */
  staticRemountKey: number;
  /** Config for displaying model info */
  config?: any;
  /** Number of active plugins */
  activePluginCount?: number;
  /** Total number of loaded plugins */
  totalPluginCount?: number;
  /** Current agent name (to prefix non-ally responses) */
  currentAgent?: string;
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
      // Check if this is an agent delegation
      const isAgentDelegation = AGENT_DELEGATION_TOOLS.includes(call.toolName as any);

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
 * Render tool call (children are rendered internally by ToolCallDisplay)
 */
function renderToolCallTree(
  toolCall: ToolCallState & { children?: ToolCallState[] },
  level: number = 0,
  config?: any,
  compactionNotices?: CompactionNotice[]
): React.ReactNode {
  return (
    <ToolCallDisplay
      key={toolCall.id}
      toolCall={toolCall}
      level={level}
      config={config}
      compactionNotices={compactionNotices}
    />
  );
}

/**
 * Item that can be rendered chronologically (either a message, tool call, compaction notice, rewind notice, or status message)
 */
type TimelineItem =
  | { type: 'message'; message: Message; index: number; timestamp: number }
  | { type: 'toolCall'; toolCall: ToolCallState & { children?: ToolCallState[] }; timestamp: number }
  | { type: 'compactionNotice'; notice: CompactionNotice; timestamp: number }
  | { type: 'rewindNotice'; notice: RewindNotice; timestamp: number }
  | { type: 'statusMessage'; statusMessage: StatusMessage; timestamp: number };


/**
 * Memoized active content - only re-renders when active tools change
 */
const ActiveContent = React.memo<{
  runningToolCalls: (ToolCallState & { children?: ToolCallState[] })[];
  streamingContent?: string;
  contextUsage: number;
  config?: any;
  compactionNotices?: CompactionNotice[];
}>(({ runningToolCalls, streamingContent, config, compactionNotices }) => {
  // Early return null if nothing to render - prevents empty Box from taking space
  if (runningToolCalls.length === 0 && !streamingContent) {
    return null;
  }

  return (
    <Box flexDirection="column">
      {runningToolCalls.map((toolCall) => (
        <Box key={`running-tool-${toolCall.id}`} paddingLeft={2}>
          {renderToolCallTree(toolCall, 0, config, compactionNotices)}
        </Box>
      ))}

      {streamingContent && (
        <Box paddingLeft={2}>
          <Text dimColor>{streamingContent}</Text>
        </Box>
      )}
    </Box>
  );
});

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
  statusMessages = [],
  staticRemountKey,
  config,
  activePluginCount,
  totalPluginCount,
  currentAgent,
}) => {
  const terminalWidth = useContentWidth();

  // Ref to store compactionNotices for use in memoized callbacks without triggering recalculation
  // This prevents the completedJSXItems useMemo from being invalidated when compactionNotices changes
  // which was causing Ink's Static component to recalculate layout and accumulate blank lines
  const compactionNoticesRef = useRef(compactionNotices);
  useEffect(() => {
    compactionNoticesRef.current = compactionNotices;
  }, [compactionNotices]);

  // Get git branch on mount
  const [gitBranch, setGitBranch] = useState<string | null>(null);
  useEffect(() => {
    const branch = getGitBranch();
    setGitBranch(branch);
  }, []);

  // Get recent sessions on mount
  const [recentSessions, setRecentSessions] = useState<SessionInfo[]>([]);
  useEffect(() => {
    const fetchRecentSessions = async () => {
      try {
        const serviceRegistry = ServiceRegistry.getInstance();
        const sessionManager = serviceRegistry.get<SessionManager>('session_manager');
        if (sessionManager) {
          const sessions = await sessionManager.getSessionsInfoByDirectory();
          // Sort by last modified descending and take top 3
          const sortedSessions = sessions
            .sort((a, b) => b.last_modified_timestamp - a.last_modified_timestamp)
            .slice(0, 3);
          setRecentSessions(sortedSessions);
        }
      } catch (error) {
        // Silently handle errors by setting empty array
        setRecentSessions([]);
      }
    };
    fetchRecentSessions();
  }, []);

  // Memoize toolCallTree with reference equality check to prevent unnecessary recalculations
  const toolCallTree = React.useMemo(() => buildToolCallTree(activeToolCalls), [activeToolCalls]);

  // Track completed tool IDs to stabilize completedToolCalls reference
  // This prevents the Static component from recalculating when only running tools update
  const prevCompletedIdsRef = useRef<Set<string>>(new Set());
  const prevCompletedToolCallsRef = useRef<(ToolCallState & { children?: ToolCallState[] })[]>([]);

  // Separate completed from running tool calls with stable references
  const { completedToolCalls, runningToolCalls } = React.useMemo(() => {
    const completed = toolCallTree.filter(
      (tc) => tc.status === 'success' || tc.status === 'error' || tc.status === 'cancelled'
    );
    const running = toolCallTree.filter(
      (tc) => tc.status === 'executing' || tc.status === 'pending' || tc.status === 'validating'
    );

    // Check if completed tools set has actually changed (by ID)
    const currentCompletedIds = new Set(completed.map(tc => tc.id));
    const prevIds = prevCompletedIdsRef.current;

    // Compare sets: same size and all current IDs exist in previous
    const sameCompletedSet = currentCompletedIds.size === prevIds.size &&
      [...currentCompletedIds].every(id => prevIds.has(id));

    if (sameCompletedSet) {
      // Return previous reference to prevent downstream recalculation
      return { completedToolCalls: prevCompletedToolCallsRef.current, runningToolCalls: running };
    }

    // Completed set changed - update refs and return new array
    prevCompletedIdsRef.current = currentCompletedIds;
    prevCompletedToolCallsRef.current = completed;
    return { completedToolCalls: completed, runningToolCalls: running };
  }, [toolCallTree]);

  // Build completed timeline (messages + completed tools + compaction notices)
  // Relies on React's memoization + AppContext ref equality for efficient updates
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

      // Skip interjection messages that are nested under tool calls (non-root parentId)
      // Interjections to main agent (parentId: 'root' or undefined) should appear in main conversation
      if (message.metadata?.isInterjection === true
          && message.metadata?.parentId
          && message.metadata?.parentId !== 'root') {
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

    // Add compaction notices (only top-level ones without parentId)
    compactionNotices.forEach((notice) => {
      // Skip notices that are nested under a tool call
      if (notice.parentId) {
        return;
      }

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

    // Add status messages (connection retries, etc.)
    statusMessages.forEach((statusMsg) => {
      timeline.push({
        type: 'statusMessage',
        statusMessage: statusMsg,
        timestamp: statusMsg.timestamp,
      });
    });

    timeline.sort((a, b) => a.timestamp - b.timestamp);
    return timeline;
  }, [messages, completedToolCalls, compactionNotices, rewindNotices, statusMessages]);

  // Pre-render timeline items as JSX for Static component
  const completedJSXItems = React.useMemo(() => {
    const divider = createDivider(terminalWidth);
    const items: React.ReactNode[] = [];

    completedTimeline.forEach((item) => {
      // Apply consistent spacing: marginTop={1} for all items
      const spacing = { marginTop: 1 };

      if (item.type === 'message') {
        // User messages have no left padding, assistant messages have padding
        const messagePadding = item.message.role === 'user' ? {} : { paddingLeft: 2 };
        items.push(
          <Box key={`msg-${item.message.id || item.index}`} {...spacing} {...messagePadding}>
            <MessageDisplay message={item.message} config={config} currentAgent={currentAgent} />
          </Box>
        );
      } else if (item.type === 'toolCall') {
        // Use ref to access compactionNotices without adding it as a useMemo dependency
        // This prevents Static component layout recalculation on every compaction notice change
        items.push(
          <Box key={`tool-${item.toolCall.id}`} {...spacing} paddingLeft={2}>
            {renderToolCallTree(item.toolCall, 0, config, compactionNoticesRef.current)}
          </Box>
        );
      } else if (item.type === 'compactionNotice') {
        // Compaction notice
        items.push(
          <Box key={`compaction-${item.notice.id}`} flexDirection="column" {...spacing} paddingLeft={2}>
            <Box><Text dimColor>{divider}</Text></Box>
            <Box>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>Conversation compacted</Text>
              <Text dimColor> - Removed earlier messages to free context</Text>
            </Box>
            <Box><Text dimColor>{divider}</Text></Box>
          </Box>
        );
      } else if (item.type === 'rewindNotice') {
        // Rewind notice
        const hasRestoredFiles = item.notice.restoredFiles && item.notice.restoredFiles.length > 0;
        const hasFailedRestorations = item.notice.failedRestorations && item.notice.failedRestorations.length > 0;

        items.push(
          <Box key={`rewind-${item.notice.id}`} flexDirection="column" {...spacing} paddingLeft={2}>
            <Box><Text dimColor>{divider}</Text></Box>
            <Box>
              <Text color={UI_COLORS.PRIMARY} bold>Conversation rewound</Text>
              <Text dimColor> - Returned to message #{item.notice.targetMessageIndex + 1}</Text>
            </Box>
            {hasRestoredFiles && (
              <Box marginLeft={2}>
                <Text color={UI_COLORS.TEXT_DEFAULT}>Restored {item.notice.restoredFiles!.length} file{item.notice.restoredFiles!.length !== 1 ? 's' : ''}:</Text>
                {item.notice.restoredFiles!.map((file, idx) => (
                  <Box key={`restored-${idx}`} marginLeft={2}>
                    <Text dimColor>• {file}</Text>
                  </Box>
                ))}
              </Box>
            )}
            {hasFailedRestorations && (
              <Box marginLeft={2}>
                <Text color={UI_COLORS.ERROR}>Failed restorations:</Text>
                {item.notice.failedRestorations!.map((failure, idx) => (
                  <Box key={`failed-${idx}`} marginLeft={2}>
                    <Text dimColor>• {failure}</Text>
                  </Box>
                ))}
              </Box>
            )}
            <Box><Text dimColor>{divider}</Text></Box>
          </Box>
        );
      } else if (item.type === 'statusMessage') {
        // Status message (connection retries, etc.) - displayed in red
        items.push(
          <Box key={`status-${item.statusMessage.id}`} {...spacing} paddingLeft={2}>
            <Text color={UI_COLORS.ERROR}>{item.statusMessage.message}</Text>
          </Box>
        );
      }
    });

    return items;
    // Note: compactionNotices is accessed via ref to avoid unnecessary recalculation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [completedTimeline, terminalWidth, config, currentAgent]);

  return (
    <Box flexDirection="column">
      {/* Header - only show when no messages */}
      {messages.length === 0 && (
        <Box flexDirection="column" marginTop={1} marginBottom={1} borderStyle="round" borderColor={UI_COLORS.TEXT_DIM} paddingX={1}>
          <Box flexDirection="row">
            <Box flexDirection="column" marginRight={2}>
              <Text color={UI_COLORS.PRIMARY} bold>      __</Text>
              <Text color={UI_COLORS.PRIMARY} bold>  ___( o)&gt;</Text>
              <Text color={UI_COLORS.PRIMARY} bold>  \ &lt;_. )</Text>
              <Text color={UI_COLORS.PRIMARY} bold>   `---&apos;  </Text>
            </Box>
            <Box flexDirection="column">
              <Text>Ally v{packageJson.version}</Text>
              <Text dimColor>{config?.model || 'No model configured'}</Text>
              <Text dimColor>{process.cwd()}</Text>
              {totalPluginCount !== undefined && totalPluginCount > 0 && (
                <Text dimColor>
                  {activePluginCount}/{totalPluginCount} plugin{totalPluginCount === 1 ? '' : 's'} active · tag with +/-
                </Text>
              )}
              {gitBranch && (
                <Text dimColor color={UI_COLORS.PRIMARY}>branch: {gitBranch}</Text>
              )}
            </Box>
          </Box>
          {recentSessions.length > 0 && (
            <Box flexDirection="column" marginTop={1} marginLeft={12}>
              <Text>Recent Activity</Text>
              {recentSessions.map((session) => (
                <Box key={session.session_id}>
                  <Text dimColor>
                    {session.display_name} ({formatRelativeTime(session.last_modified_timestamp)})
                  </Text>
                </Box>
              ))}
              <Text dimColor>/resume for more</Text>
            </Box>
          )}
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
        compactionNotices={compactionNotices}
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
  const statusMessagesSame = prevProps.statusMessages === nextProps.statusMessages;
  const isThinkingSame = prevProps.isThinking === nextProps.isThinking;
  const staticKeySame = prevProps.staticRemountKey === nextProps.staticRemountKey;
  const configSame = prevProps.config === nextProps.config;

  return messagesSame && streamingSame && toolCallsSame && contextSame && compactionNoticesSame && rewindNoticesSame && statusMessagesSame && isThinkingSame && staticKeySame && configSame;
});
