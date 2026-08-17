import React, { useState, useEffect, useRef } from 'react';
import { Box, Static, Text } from 'ink';
import { Message, ToolCallState, ToolCallTreeNode } from '@shared/index.js';
import { MessageDisplay } from './MessageDisplay.js';
import { ToolCallDisplay } from './ToolCallDisplay.js';
import { CompactionNotice, RewindNotice, StatusMessage } from '../contexts/AppContext.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execSync } from 'child_process';
import { LAYOUT } from '@config/constants.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { createDivider } from '../utils/uiHelpers.js';
import { UI_COLORS } from '../constants/colors.js';
import { groupToolCallTimeline } from '../utils/toolCallSummaries.js';
import type {
  ToolCallSummary,
  ToolCallSummaryTimelineItem,
  ToolCallTimelineItem,
} from '../utils/toolCallSummaries.js';
import { getStatusColor, getStatusIcon } from '../utils/statusUtils.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { liveRegionBudget } from '../utils/layout.js';

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
  /** Number of connected MCP servers */
  activeMcpCount?: number;
  /** Total number of configured MCP servers */
  totalMcpCount?: number;
  /** Current agent name (to prefix non-ally responses) */
  currentAgent?: string;
}

/**
 * Build tree structure from flat tool call list
 */
function buildToolCallTree(toolCalls: ToolCallState[]): ToolCallTreeNode[] {
  const toolCallMap = new Map<string, ToolCallTreeNode>();
  toolCalls.forEach((tc) => {
    toolCallMap.set(tc.id, { ...tc, children: [], totalChildCount: 0 });
  });

  const rootCalls: ToolCallTreeNode[] = [];
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

  // Filter out invisible tools recursively
  const filterInvisibleTools = (
    calls: ToolCallTreeNode[]
  ): ToolCallTreeNode[] => {
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
    calls: ToolCallTreeNode[]
  ): ToolCallTreeNode[] => {
    const result: ToolCallTreeNode[] = [];

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

  // Filter invisible tools, then promote transparent wrappers' children.
  // (Agent delegations no longer carry ingested child tool calls — those are
  // stream-isolated to the sub-agent — so there is nothing to limit here.)
  const visibleCalls = filterInvisibleTools(rootCalls);
  return processTransparentWrappers(visibleCalls);
}

/**
 * Render tool call (children are rendered internally by ToolCallDisplay)
 */
function renderToolCallTree(
  toolCall: ToolCallTreeNode,
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
  | ToolCallTimelineItem
  | { type: 'compactionNotice'; notice: CompactionNotice; timestamp: number }
  | { type: 'rewindNotice'; notice: RewindNotice; timestamp: number }
  | { type: 'statusMessage'; statusMessage: StatusMessage; timestamp: number };

/**
 * Timeline items other than tool calls, which groupToolCallTimeline passes through untouched
 */
type NonToolCallTimelineItem = Exclude<TimelineItem, { type: 'toolCall' }>;
type CompletedTimelineItem = NonToolCallTimelineItem | ToolCallTimelineItem | ToolCallSummaryTimelineItem;

type StaticTimelineEntry = {
  item: CompletedTimelineItem;
  key: string;
  spacingBefore: boolean;
};

function timelineItemKey(item: CompletedTimelineItem): string {
  if (item.type === 'message') return `msg-${item.message.id || item.index}`;
  if (item.type === 'toolCall') return `tool-${item.toolCall.id}`;
  if (item.type === 'toolCallSummary') return `tool-summary-${item.summary.id}`;
  if (item.type === 'compactionNotice') return `compaction-${item.notice.id}`;
  if (item.type === 'rewindNotice') return `rewind-${item.notice.id}`;
  return `status-${item.statusMessage.id}`;
}

/**
 * Renders a collapsed group of context-gathering tool calls as a single line,
 * styled like a completed tool call so the timeline reads consistently.
 */
const ToolCallSummaryDisplay: React.FC<{ summary: ToolCallSummary }> = ({ summary }) => (
  <Box>
    <Text color={getStatusColor('success')}>{getStatusIcon('success')} </Text>
    <Text dimColor>{summary.text}</Text>
  </Box>
);

/**
 * Memoized active content - only re-renders when active tools change
 */
/**
 * Maximum number of root-level running tool calls to render.
 * Keeps dynamic output height bounded, preventing Ink's catastrophic
 * clearTerminal+fullStaticOutput rewrite path when output exceeds terminal rows.
 */
const MAX_VISIBLE_RUNNING_TOOLS = 8;

/**
 * Maximum lines of streaming content to display.
 * Prevents unbounded dynamic output growth during long streaming responses.
 */
const MAX_STREAMING_LINES = 60;

function estimateToolRows(toolCall: ToolCallTreeNode): number {
  let rows = 1;
  const output = toolCall.output?.trim();
  if (output && !toolCall.collapsed && (!toolCall.hideOutput || toolCall.alwaysShowFullOutput)) {
    rows += Math.min(6, output.split('\n').length);
  }
  if (toolCall.diffPreview && !toolCall.collapsed) rows += 6;
  if (toolCall.thinking && toolCall.thinkingEndTime) rows += 1;
  if (!toolCall.collapsed) {
    rows += (toolCall.children ?? []).reduce((sum, child) => sum + estimateToolRows(child), 0);
  }
  return rows;
}

const ActiveContent = React.memo<{
  runningToolCalls: ToolCallTreeNode[];
  streamingContent?: string;
  config?: any;
  compactionNotices?: CompactionNotice[];
  pendingSummary?: ToolCallSummary;
}>(({ runningToolCalls, streamingContent, config, compactionNotices, pendingSummary }) => {
  const terminalRows = useTerminalRows();
  const maxActiveHeight = liveRegionBudget(terminalRows);

  // Early return null if nothing to render - prevents empty Box from taking space
  if (runningToolCalls.length === 0 && !streamingContent && !pendingSummary) {
    return null;
  }

  // Cap visible running tools to keep dynamic output height bounded
  const visibleTools = runningToolCalls.length > MAX_VISIBLE_RUNNING_TOOLS
    ? runningToolCalls.slice(-MAX_VISIBLE_RUNNING_TOOLS)
    : runningToolCalls;
  const hiddenToolCount = runningToolCalls.length - visibleTools.length;

  // Keep the newest streaming lines within the terminal-relative budget.
  // `maxHeight` caps large output without reserving empty rows for small output.
  let displayStreaming = streamingContent?.trimStart();
  if (displayStreaming) {
    const lines = displayStreaming.split('\n');
    const reservedRows = visibleTools.length + (pendingSummary ? 1 : 0) + (hiddenToolCount > 0 ? 1 : 0);
    const availableStreamingRows = Math.max(1, Math.min(MAX_STREAMING_LINES, maxActiveHeight - reservedRows));
    if (lines.length > availableStreamingRows) {
      displayStreaming = lines.slice(-availableStreamingRows).join('\n');
    }
  }

  const estimatedRows =
    visibleTools.reduce((sum, tool) => sum + estimateToolRows(tool), 0) +
    (displayStreaming ? displayStreaming.split('\n').length : 0) +
    (pendingSummary ? 1 : 0) +
    (hiddenToolCount > 0 ? 1 : 0);
  const constrainedHeight = estimatedRows > maxActiveHeight ? maxActiveHeight : undefined;

  return (
    <Box flexDirection="column" height={constrainedHeight} overflowY="hidden">
      {/* Trailing context group, deferred out of Static so it can still absorb
          later context calls without rewriting already-printed output */}
      {pendingSummary && (
        <Box paddingLeft={2}>
          <ToolCallSummaryDisplay summary={pendingSummary} />
        </Box>
      )}

      {hiddenToolCount > 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>({hiddenToolCount} more tool{hiddenToolCount !== 1 ? 's' : ''} running...)</Text>
        </Box>
      )}

      {visibleTools.map((toolCall) => (
        <Box key={`running-tool-${toolCall.id}`} paddingLeft={2}>
          <ErrorBoundary label={`running-tool-${toolCall.id}`}>
            {renderToolCallTree(toolCall, 0, config, compactionNotices)}
          </ErrorBoundary>
        </Box>
      ))}

      {displayStreaming && (
        <Box paddingLeft={2}>
          <Text dimColor>{displayStreaming}</Text>
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
  compactionNotices = [],
  rewindNotices = [],
  statusMessages = [],
  staticRemountKey,
  config,
  activePluginCount,
  totalPluginCount,
  activeMcpCount,
  totalMcpCount,
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

  // Resolve synchronously so the startup header never grows after first paint.
  const [gitBranch] = useState(getGitBranch);

  // Memoize toolCallTree with reference equality check to prevent unnecessary recalculations
  const toolCallTree = React.useMemo(() => buildToolCallTree(activeToolCalls), [activeToolCalls]);

  // Track completed tool IDs to stabilize completedToolCalls reference
  // This prevents the Static component from recalculating when only running tools update
  const prevCompletedIdsRef = useRef<Set<string>>(new Set());
  const prevCompletedToolCallsRef = useRef<ToolCallTreeNode[]>([]);

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
  const { completedTimeline, pendingContextSummary } = React.useMemo(() => {
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

    // Collapse consecutive context-gathering calls into one line. The trailing group is
    // deferred to the dynamic region: Static output is append-only, so a group that can
    // still grow must not be printed until a non-context item closes it.
    const grouped = groupToolCallTimeline<NonToolCallTimelineItem>(timeline, {
      disabled: config?.show_full_tool_output === true,
    });

    return { completedTimeline: grouped.items, pendingContextSummary: grouped.pendingSummary };
  }, [messages, completedToolCalls, compactionNotices, rewindNotices, statusMessages, config?.show_full_tool_output]);

  // Commit only newly-finalized timeline items to Ink's static output. Static
  // content lives in the terminal scrollback and is excluded from Ink's live
  // layout, so streaming updates never redraw a terminalful of history. Keep
  // only the latest commit batch in React; retaining one JSX element per item
  // would recreate the long-session memory leak this viewport replaced.
  const committedKeysRef = useRef<Set<string>>(new Set());
  const hadCommittedItemsRef = useRef(false);
  const lastStaticRemountKeyRef = useRef(staticRemountKey);
  const staticGenerationRef = useRef(0);
  const staticBatchRef = useRef<{ generation: number; entries: StaticTimelineEntry[] }>({
    generation: 0,
    entries: [],
  });

  const staticBatch = React.useMemo(() => {
    if (lastStaticRemountKeyRef.current !== staticRemountKey) {
      committedKeysRef.current.clear();
      hadCommittedItemsRef.current = false;
      lastStaticRemountKeyRef.current = staticRemountKey;
    }

    const currentKeys = new Set<string>();
    const entries: StaticTimelineEntry[] = [];
    for (const item of completedTimeline) {
      const key = timelineItemKey(item);
      currentKeys.add(key);
      if (!committedKeysRef.current.has(key)) {
        entries.push({
          item,
          key,
          spacingBefore: hadCommittedItemsRef.current || entries.length > 0,
        });
      }
    }

    // Only currently visible identifiers are needed for duplicate detection.
    // Dropped history cannot reappear without a reset/remount, keeping this set
    // bounded with the live transcript window.
    committedKeysRef.current = currentKeys;
    if (entries.length > 0) {
      hadCommittedItemsRef.current = true;
      staticGenerationRef.current += 1;
      staticBatchRef.current = {
        generation: staticGenerationRef.current,
        entries,
      };
    }
    return staticBatchRef.current;
  }, [completedTimeline, staticRemountKey]);

  const renderCompletedItem = React.useCallback((entry: StaticTimelineEntry) => {
    const divider = createDivider(terminalWidth);
    const item = entry.item;
    const spacing = { marginTop: entry.spacingBefore ? 1 : 0 };

    if (item.type === 'message') {
        const isUser = item.message.role === 'user';
        const indent = isUser ? 0 : LAYOUT.MESSAGE_INDENT;
        const messagePadding = isUser ? {} : { paddingLeft: indent };
        return (
          <Box key={`msg-${item.message.id || item.index}`} {...spacing} {...messagePadding}>
            <ErrorBoundary label={`message-${item.message.id || item.index}`}>
              <MessageDisplay
                message={item.message}
                config={config}
                currentAgent={currentAgent}
                width={Math.max(1, terminalWidth - indent)}
              />
            </ErrorBoundary>
          </Box>
        );
    } else if (item.type === 'toolCall') {
        return (
          <Box key={`tool-${item.toolCall.id}`} {...spacing} paddingLeft={2}>
            <ErrorBoundary label={`tool-${item.toolCall.id}`}>
              {renderToolCallTree(item.toolCall, 0, config, compactionNoticesRef.current)}
            </ErrorBoundary>
          </Box>
        );
    } else if (item.type === 'toolCallSummary') {
        return (
          <Box key={`tool-summary-${item.summary.id}`} {...spacing} paddingLeft={2}>
            <ErrorBoundary label={`tool-summary-${item.summary.id}`}>
              <ToolCallSummaryDisplay summary={item.summary} />
            </ErrorBoundary>
          </Box>
        );
    } else if (item.type === 'compactionNotice') {
        return (
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
        const hasRestoredFiles = item.notice.restoredFiles && item.notice.restoredFiles.length > 0;
        const hasFailedRestorations = item.notice.failedRestorations && item.notice.failedRestorations.length > 0;

        return (
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
        return (
          <Box key={`status-${item.statusMessage.id}`} {...spacing} paddingLeft={2}>
            <Text color={UI_COLORS.ERROR}>{item.statusMessage.message}</Text>
          </Box>
        );
    }
    return null;
  }, [terminalWidth, config, currentAgent]);

  return (
    <Box flexDirection="column">
      {/* Header - only show when no messages */}
      {messages.length === 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            <Text color={UI_COLORS.PRIMARY} bold>( o)&gt; </Text>
            <Text bold>Ally</Text>
            <Text dimColor> v{packageJson.version} · {config?.model || 'no model'}</Text>
          </Text>
          <Text dimColor>
            {process.cwd()}{gitBranch ? ` · ${gitBranch}` : ''}
          </Text>
          {((totalPluginCount ?? 0) > 0 || (totalMcpCount ?? 0) > 0) && (
            <Text dimColor>
              {(totalPluginCount ?? 0) > 0 ? `${activePluginCount ?? 0}/${totalPluginCount} plugins` : ''}
              {(totalPluginCount ?? 0) > 0 && (totalMcpCount ?? 0) > 0 ? ' · ' : ''}
              {(totalMcpCount ?? 0) > 0 ? `${activeMcpCount ?? 0}/${totalMcpCount} MCP` : ''}
            </Text>
          )}
        </Box>
      )}

      {/* Incremental committed history remains in native terminal scrollback. */}
      <Static
        key={`static-${staticRemountKey}-${staticBatch.generation}`}
        items={staticBatch.entries}
      >
        {(entry) => (
          <React.Fragment key={entry.key}>
            {renderCompletedItem(entry)}
          </React.Fragment>
        )}
      </Static>

      {/* Active content - only re-renders when active tools change */}
      <ActiveContent
        runningToolCalls={runningToolCalls}
        streamingContent={streamingContent}
        config={config}
        compactionNotices={compactionNotices}
        pendingSummary={pendingContextSummary}
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
  const compactionNoticesSame = prevProps.compactionNotices === nextProps.compactionNotices;
  const rewindNoticesSame = prevProps.rewindNotices === nextProps.rewindNotices;
  const statusMessagesSame = prevProps.statusMessages === nextProps.statusMessages;
  const isThinkingSame = prevProps.isThinking === nextProps.isThinking;
  const staticKeySame = prevProps.staticRemountKey === nextProps.staticRemountKey;
  const configSame = prevProps.config === nextProps.config;
  const currentAgentSame = prevProps.currentAgent === nextProps.currentAgent;
  const integrationCountsSame =
    prevProps.activePluginCount === nextProps.activePluginCount &&
    prevProps.totalPluginCount === nextProps.totalPluginCount &&
    prevProps.activeMcpCount === nextProps.activeMcpCount &&
    prevProps.totalMcpCount === nextProps.totalMcpCount;

  return messagesSame && streamingSame && toolCallsSame && compactionNoticesSame && rewindNoticesSame && statusMessagesSame && isThinkingSame && staticKeySame && configSame && currentAgentSame && integrationCountsSame;
});
