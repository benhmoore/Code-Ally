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
import { InteractiveSurface } from './InteractiveSurface.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { centeredWindow, visibleItemBudget } from '../utils/layout.js';

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
  const terminalRows = useTerminalRows();
  const visibleCount = Math.min(
    maxVisible,
    visibleItemBudget(terminalRows, { chromeRows: 9, rowsPerItem: 3, maximum: maxVisible })
  );

  if (!visible) {
    return null;
  }

  if (sessions.length === 0) {
    return (
      <InteractiveSurface title="Resume session" footer={<KeyboardHintFooter hints={[{ key: 'esc', label: 'close' }]} />}>
        <Text color={UI_COLORS.PRIMARY}>No sessions found</Text>
        <Text dimColor>Start a conversation to create one.</Text>
      </InteractiveSurface>
    );
  }

  const totalSessions = sessions.length;
  const window = centeredWindow(sessions, selectedIndex, visibleCount);

  return (
    <InteractiveSurface title="Resume session" meta={`${totalSessions}`} footer={<KeyboardHintFooter action="resume" />}>
        {window.above > 0 && <Text dimColor>  ↑ {window.above} more</Text>}
        {window.items.map((session, idx) => {
          const actualIndex = window.start + idx;
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

        {window.below > 0 && <Text dimColor>  ↓ {window.below} more</Text>}
    </InteractiveSurface>
  );
};
