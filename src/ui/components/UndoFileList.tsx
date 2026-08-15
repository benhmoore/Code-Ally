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
import { UI_COLORS } from '../constants/colors.js';
import { formatDiffStats, truncatePath } from '../utils/formatters.js';
import { formatRelativeTime } from '../utils/timeUtils.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { centeredWindow, visibleItemBudget } from '../utils/layout.js';

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
 * UndoFileList Component
 */
export const UndoFileList: React.FC<UndoFileListProps> = ({
  request,
  visible = true,
}) => {
  const terminalRows = useTerminalRows();

  if (!visible) {
    return null;
  }

  const { fileList, selectedIndex } = request;
  const visibleCount = visibleItemBudget(terminalRows, { chromeRows: 8, rowsPerItem: 2, maximum: 8 });
  const window = centeredWindow(fileList, selectedIndex, visibleCount);

  return (
    <InteractiveSurface title="Undo operations" tone={UI_COLORS.PRIMARY} meta={`${fileList.length}`} footer={<KeyboardHintFooter action="select" />}>
      {window.above > 0 && <Text dimColor>  ↑ {window.above} more</Text>}
      {fileList.length > 0 ? (
        <Box flexDirection="column">
          {window.items.map((fileEntry, index) => {
            const actualIndex = window.start + index;
            const isSelected = actualIndex === selectedIndex;
            const diffStats = formatDiffStats(fileEntry.stats);
            const timestamp = formatRelativeTime(fileEntry.timestamp);
            const filePath = truncatePath(fileEntry.file_path);

            return (
              <Box key={fileEntry.file_path} flexDirection="column">
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
        <Text dimColor>No operations to undo.</Text>
      )}
      {window.below > 0 && <Text dimColor>  ↓ {window.below} more</Text>}
    </InteractiveSurface>
  );
};
