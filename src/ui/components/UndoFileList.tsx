/**
 * UndoFileList - Interactive file list for two-stage undo flow
 *
 * Features:
 * - Shows list of recently modified files
 * - Displays diff statistics (+additions, -deletions)
 * - Keyboard navigation (up/down arrows, Enter to select)
 * - Visual selection indicator
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { UndoFileEntry } from '@services/PatchManager.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { createDivider } from '../utils/uiHelpers.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { UI_COLORS } from '../constants/colors.js';

export interface UndoFileListRequest {
  /** Request ID for tracking */
  requestId: string;
  /** List of files with diff stats */
  fileList: UndoFileEntry[];
  /** Currently selected file index */
  selectedIndex: number;
}

export interface UndoFileListProps {
  /** File list request details */
  request: UndoFileListRequest;
  /** Whether the prompt is visible */
  visible?: boolean;
}

/**
 * Format diff stats for display
 */
const formatDiffStats = (stats: { additions: number; deletions: number }): string => {
  const parts: string[] = [];
  if (stats.additions > 0) {
    parts.push(`+${stats.additions}`);
  }
  if (stats.deletions > 0) {
    parts.push(`-${stats.deletions}`);
  }
  return parts.length > 0 ? `(${parts.join(', ')})` : '(no changes)';
};

/**
 * Format timestamp for display
 */
const formatTimestamp = (timestamp: string): string => {
  try {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  } catch {
    return timestamp;
  }
};

/**
 * Truncate file path to fit display width
 */
const truncatePath = (path: string, maxLength: number = 60): string => {
  if (path.length <= maxLength) return path;

  const parts = path.split('/');
  if (parts.length <= 2) return path;

  // Keep first and last parts, truncate middle
  const first = parts[0] || '';
  const last = parts[parts.length - 1] || '';
  const available = maxLength - first.length - last.length - 6; // 6 for "/...//"

  if (available <= 0) {
    return `${first}/.../${last}`;
  }

  // Try to fit some middle parts
  let middle = '';
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i] || '';
    if (middle.length + part.length + 1 <= available) {
      middle += `/${part}`;
    } else {
      middle = '/...';
      break;
    }
  }

  return `${first}${middle}/${last}`;
};

/**
 * UndoFileList Component
 */
export const UndoFileList: React.FC<UndoFileListProps> = ({
  request,
  visible = true,
}) => {
  if (!visible) {
    return null;
  }

  const { fileList, selectedIndex } = request;
  const terminalWidth = useContentWidth();
  const divider = createDivider(terminalWidth);

  return (
    <Box flexDirection="column">
      {/* Top divider */}
      <Box>
        <Text dimColor>{divider}</Text>
      </Box>

      {/* Header */}
      <Box marginY={1}>
        <Text color={UI_COLORS.PRIMARY} bold>
          Undo Operations
        </Text>
      </Box>

      {/* File count */}
      <Box marginBottom={1}>
        <Text dimColor>Recently modified files: </Text>
        <Text bold color={UI_COLORS.PRIMARY}>{fileList.length}</Text>
      </Box>

      {/* File list */}
      {fileList.length > 0 ? (
        <Box flexDirection="column" marginBottom={1}>
          {fileList.map((fileEntry, index) => {
            const isSelected = index === selectedIndex;
            const diffStats = formatDiffStats(fileEntry.stats);
            const timestamp = formatTimestamp(fileEntry.timestamp);
            const filePath = truncatePath(fileEntry.file_path);

            return (
              <Box key={index} flexDirection="column" marginBottom={index < fileList.length - 1 ? 1 : 0}>
                <Box>
                  {/* Selection indicator */}
                  <SelectionIndicator isSelected={isSelected}>
                    <Text color={isSelected ? 'white' : 'gray'}>{filePath}</Text>
                  </SelectionIndicator>
                </Box>

                {/* File details: operation type, diff stats, timestamp */}
                <Box marginLeft={3}>
                  <Text dimColor>
                    {fileEntry.operation_type}
                  </Text>
                  <Text dimColor> </Text>
                  <Text color={fileEntry.stats.changes > 0 ? 'cyan' : 'gray'}>
                    {diffStats}
                  </Text>
                  <Text dimColor> • </Text>
                  <Text dimColor>
                    {timestamp}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      ) : (
        <Box marginBottom={1}>
          <Text dimColor>No operations to undo</Text>
        </Box>
      )}

      {/* Footer */}
      <KeyboardHintFooter action="select" cancelText="cancel" />
    </Box>
  );
};
