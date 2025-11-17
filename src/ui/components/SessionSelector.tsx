/**
 * SessionSelector - Interactive session selection prompt
 *
 * Shows available sessions with keyboard navigation for --resume flag
 */

import React from 'react';
import { Box, Text } from 'ink';
import { SessionInfo } from '@shared/index.js';
import { formatRelativeTime } from '../utils/timeUtils.js';
import { TEXT_LIMITS } from '@config/constants.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { UI_COLORS } from '../constants/colors.js';
import { createDivider } from '../utils/uiHelpers.js';
import { useContentWidth } from '../hooks/useContentWidth.js';

export interface SessionSelectorProps {
  /** Available sessions */
  sessions: SessionInfo[];
  /** Currently selected session index */
  selectedIndex: number;
  /** Whether the prompt is visible */
  visible?: boolean;
  /** Maximum visible items before windowing */
  maxVisible?: number;
}

/**
 * Truncate display name for table
 */
function truncateDisplayName(name: string, maxLength: number = TEXT_LIMITS.DESCRIPTION_MAX): string {
  if (name.length <= maxLength) return name;
  return name.slice(0, maxLength - 3) + '...';
}

/**
 * Shorten directory path for display
 */
function shortenPath(path: string): string {
  // Replace home directory with ~
  const homeDir = process.env.HOME || process.env.USERPROFILE;
  if (homeDir && path.startsWith(homeDir)) {
    return '~' + path.slice(homeDir.length);
  }

  return path;
}

/**
 * SessionSelector Component
 */
export const SessionSelector: React.FC<SessionSelectorProps> = ({
  sessions,
  selectedIndex,
  visible = true,
  maxVisible = 10,
}) => {
  const terminalWidth = useContentWidth();
  const divider = createDivider(terminalWidth);

  if (!visible) {
    return null;
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="column">
          {/* Top divider */}
          <Box>
            <Text dimColor>{divider}</Text>
          </Box>

          <Box marginY={1}>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Resume Session
            </Text>
          </Box>
          <Text color={UI_COLORS.PRIMARY}>No sessions found</Text>
          <Box marginTop={1}>
            <Text dimColor>Start a new conversation to create a session.</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  // Calculate windowing
  const totalSessions = sessions.length;
  const showScrollIndicators = totalSessions > maxVisible;

  let startIdx = 0;
  let endIdx = totalSessions;

  if (showScrollIndicators) {
    // Center selected item in window
    const halfWindow = Math.floor(maxVisible / 2);
    startIdx = Math.max(0, selectedIndex - halfWindow);
    endIdx = Math.min(totalSessions, startIdx + maxVisible);

    // Adjust if we're at the end
    if (endIdx === totalSessions) {
      startIdx = Math.max(0, endIdx - maxVisible);
    }
  }

  const visibleSessions = sessions.slice(startIdx, endIdx);
  const hasMoreAbove = startIdx > 0;
  const hasMoreBelow = endIdx < totalSessions;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column">
        {/* Top divider */}
        <Box>
          <Text dimColor>{divider}</Text>
        </Box>

        {/* Header */}
        <Box marginY={1}>
          <Text color={UI_COLORS.TEXT_DEFAULT} bold>
            Resume Session
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>Select a session to resume ({totalSessions} available):</Text>
        </Box>

        {/* Scroll indicator - more above */}
        {hasMoreAbove && (
          <Box>
            <Text dimColor>  ↑ {startIdx} more...</Text>
          </Box>
        )}

        {/* Session list */}
        {visibleSessions.map((session, idx) => {
          const actualIndex = startIdx + idx;
          const isSelected = actualIndex === selectedIndex;
          const displayName = truncateDisplayName(session.display_name);
          const workingDir = shortenPath(session.working_dir);
          const relativeTime = formatRelativeTime(session.last_modified_timestamp);
          const lastMessage = session.lastUserMessage || '(no messages)';

          return (
            <Box key={session.session_id} flexDirection="column">
              <SelectionIndicator isSelected={isSelected}>
                {displayName}
                <Text dimColor> ({session.message_count} msgs, {relativeTime})</Text>
              </SelectionIndicator>
              <Box marginLeft={2} flexDirection="column">
                <Text color={isSelected ? UI_COLORS.PRIMARY : undefined} dimColor={!isSelected}>
                  {lastMessage}
                </Text>
                <Text color={isSelected ? UI_COLORS.PRIMARY : UI_COLORS.TEXT_DIM} dimColor={!isSelected}>
                  {workingDir}
                </Text>
              </Box>
            </Box>
          );
        })}

        {/* Scroll indicator - more below */}
        {hasMoreBelow && (
          <Box>
            <Text dimColor>  ↓ {totalSessions - endIdx} more...</Text>
          </Box>
        )}

        {/* Footer */}
        <KeyboardHintFooter action="select" />
      </Box>
    </Box>
  );
};
