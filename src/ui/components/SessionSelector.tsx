/**
 * SessionSelector - Interactive session selection prompt
 *
 * Shows available sessions with keyboard navigation for --resume flag
 */

import React from 'react';
import { Box, Text } from 'ink';
import { SessionInfo } from '../../types/index.js';
import { formatRelativeTime } from '../utils/timeUtils.js';
import { TEXT_LIMITS } from '../../config/constants.js';

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
  if (!visible) {
    return null;
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box
          borderStyle="round"
          borderColor="cyan"
          paddingX={2}
          paddingY={1}
          flexDirection="column"
        >
          <Box marginBottom={1}>
            <Text color="cyan" bold>
              Resume Session
            </Text>
          </Box>
          <Text color="yellow">No sessions found</Text>
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
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        {/* Header */}
        <Box marginBottom={1}>
          <Text color="cyan" bold>
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

          return (
            <Box key={session.session_id} flexDirection="column">
              <Box>
                <Text color={isSelected ? 'green' : undefined} bold={isSelected}>
                  {isSelected ? '> ' : '  '}
                </Text>
                <Text color={isSelected ? 'green' : undefined} bold={isSelected}>
                  {displayName}
                </Text>
                <Text color={isSelected ? 'green' : 'gray'} dimColor={!isSelected}>
                  {' '}({session.message_count} msgs, {relativeTime})
                </Text>
              </Box>
              <Box marginLeft={2}>
                <Text color={isSelected ? 'cyan' : 'gray'} dimColor={!isSelected}>
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
        <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
          <Text dimColor>
            ↑↓ navigate  •  Enter select  •  Esc/Ctrl+C cancel
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
