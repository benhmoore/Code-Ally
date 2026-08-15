/**
 * RewindSelector - Interactive conversation rewind prompt
 *
 * Shows user messages chronologically with keyboard navigation
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Message } from '@shared/index.js';
import { TEXT_LIMITS } from '@config/constants.js';
import { PatchMetadata } from '@services/PatchManager.js';
import { logger } from '@services/Logger.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { UI_COLORS } from '../constants/colors.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { centeredWindow, visibleItemBudget } from '../utils/layout.js';

export interface RewindSelectorProps {
  /** User messages only (pre-filtered) */
  messages: Message[];
  /** Currently selected message index */
  selectedIndex: number;
  /** Whether the prompt is visible */
  visible?: boolean;
  /** Maximum visible items before windowing */
  maxVisible?: number;
  /** All patches from the current session */
  patches?: PatchMetadata[];
}

/**
 * File change statistics for a time window
 */
interface FileChangeStats {
  fileCount: number;
  files: Array<{ path: string }>;
}

/**
 * Format timestamp for display
 */
function formatTime(timestamp?: number): string {
  if (!timestamp) return '??:??';
  const date = new Date(timestamp);
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * Truncate message content for display
 */
function truncateContent(content: string, maxLength: number = TEXT_LIMITS.DESCRIPTION_MAX): string {
  const firstLine = content.split('\n')[0] || '';
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.slice(0, maxLength - 3) + '...';
}

/**
 * Calculate file changes that occurred after a message timestamp
 *
 * IMPORTANT: Assumes messages array is ordered chronologically (oldest first).
 * The last message in the array is the most recent one.
 */
function calculateFileChanges(
  messageTimestamp: number,
  nextMessageTimestamp: number | undefined,
  patches: PatchMetadata[]
): FileChangeStats {
  // Filter patches in the time window
  const relevantPatches = patches.filter(patch => {
    try {
      const patchTime = new Date(patch.timestamp).getTime();
      if (nextMessageTimestamp === undefined) {
        // For the last (most recent) message, include all patches after it
        return patchTime > messageTimestamp;
      } else {
        // For other messages, include patches between this message and the next
        return patchTime > messageTimestamp && patchTime <= nextMessageTimestamp;
      }
    } catch (error) {
      logger.debug(`Malformed patch timestamp: ${patch.timestamp}`);
      return false;
    }
  });

  if (relevantPatches.length === 0) {
    return { fileCount: 0, files: [] };
  }

  // Track unique file paths (multiple patches to same file count as 1)
  const uniqueFiles = new Set<string>();
  for (const patch of relevantPatches) {
    uniqueFiles.add(patch.file_path);
  }

  const files = Array.from(uniqueFiles).map(path => ({ path }));

  return {
    fileCount: files.length,
    files,
  };
}

/**
 * Component to display file changes for a message in the rewind selector
 *
 * Shows either:
 * - "No code changes" if fileCount is 0
 * - Single filename if exactly 1 file changed
 * - "N files changed" summary if multiple files changed
 *
 * Color adapts based on selection state (yellow for selected, gray otherwise)
 */
const FileChangesDisplay: React.FC<{
  changes: FileChangeStats;
  isSelected: boolean;
}> = ({ changes, isSelected }) => {
  const color = isSelected ? UI_COLORS.PRIMARY : UI_COLORS.TEXT_DIM;

  if (changes.fileCount === 0) {
    return (
      <Box marginLeft={2}>
        <Text dimColor>  └─ No code changes</Text>
      </Box>
    );
  }

  if (changes.fileCount === 1 && changes.files[0]) {
    const file = changes.files[0];
    const filename = file.path.split('/').pop() || file.path;
    return (
      <Box marginLeft={2}>
        <Text color={color}>  └─ {filename}</Text>
      </Box>
    );
  }

  // Multiple files
  return (
    <Box marginLeft={2}>
      <Text color={color}>  └─ {changes.fileCount} files changed</Text>
    </Box>
  );
};

/**
 * RewindSelector Component
 */
export const RewindSelector: React.FC<RewindSelectorProps> = ({
  messages,
  selectedIndex,
  visible = true,
  maxVisible = 10,
  patches = [],
}) => {
  const terminalRows = useTerminalRows();
  const visibleCount = Math.min(
    maxVisible,
    visibleItemBudget(terminalRows, { chromeRows: 9, rowsPerItem: 2, maximum: maxVisible })
  );
  // Calculate file changes for each message (memoized)
  const fileChangesMap = React.useMemo(() => {
    const map = new Map<number, FileChangeStats>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg) continue;

      const msgTimestamp = msg.timestamp;

      if (!msgTimestamp) {
        map.set(i, { fileCount: 0, files: [] });
        continue;
      }

      // Get next message timestamp (undefined for last message)
      const nextMsg = messages[i + 1];
      const nextTimestamp = nextMsg?.timestamp;

      const changes = calculateFileChanges(msgTimestamp, nextTimestamp, patches);
      map.set(i, changes);
    }

    return map;
  }, [messages, patches]);

  if (!visible) {
    return null;
  }

  if (messages.length === 0) {
    return (
      <InteractiveSurface title="Rewind conversation">
        <Text color={UI_COLORS.PRIMARY}>No user messages to rewind to.</Text>
      </InteractiveSurface>
    );
  }

  const totalMessages = messages.length;
  const window = centeredWindow(messages, selectedIndex, visibleCount);

  return (
    <InteractiveSurface title="Rewind conversation" meta={`${totalMessages}`} footer={<KeyboardHintFooter action="rewind" />}>
      {window.above > 0 && <Text dimColor>  ↑ {window.above} more</Text>}
      {window.items.map((msg, idx) => {
        const actualIndex = window.start + idx;
        const isSelected = actualIndex === selectedIndex;
        const time = formatTime((msg as any).timestamp);
        const content = truncateContent(msg.content);
        const changes = fileChangesMap.get(actualIndex) || {
          fileCount: 0,
          additions: 0,
          deletions: 0,
          files: [],
        };

        return (
          <Box key={actualIndex} flexDirection="column">
            <Box>
              <SelectionIndicator isSelected={isSelected}>
                <Text color="gray" bold={isSelected}>{time}</Text>
                <Text bold={isSelected}> - {content}</Text>
              </SelectionIndicator>
            </Box>
            <FileChangesDisplay changes={changes} isSelected={isSelected} />
          </Box>
        );
      })}

      {window.below > 0 && <Text dimColor>  ↓ {window.below} more</Text>}
    </InteractiveSurface>
  );
};
