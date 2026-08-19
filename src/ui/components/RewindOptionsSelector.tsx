/**
 * RewindOptionsSelector - Radio selection for rewind flow
 *
 * Shows user a mutually exclusive choice:
 * 1. Restore Conversation - Rewind conversation only, keep files as-is
 * 2. Restore Conversation and Code Changes - Rewind both (default)
 * 3. Cancel - Return to message selector
 *
 * Features:
 * - Radio selection (up/down arrows to navigate)
 * - Enter to confirm selection
 * - Escape to cancel (same as selecting "Cancel")
 * - Clear visual indication of selected option
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { Message } from '@shared/index.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { UI_COLORS } from '../constants/colors.js';
import type { UndoPreview } from '@services/PatchManager.js';
import { calculateDiffStats } from '@utils/diffUtils.js';
import { createTwoFilesPatch } from 'diff';
import { formatDiffStats, truncatePath } from '../utils/formatters.js';
import { formatRelativeTime } from '../utils/timeUtils.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { visibleItemBudget } from '../utils/layout.js';

/**
 * File change statistics
 */
export interface FileChangeStats {
  fileCount: number;
  files: Array<{ path: string }>;
}

export interface FileRestoreDisplay {
  path: string;
  operationLabel: string;
  stats: ReturnType<typeof calculateDiffStats>;
  timestamp: string;
}

/** Collapse operation-level previews into the net restoration per file. */
export function buildFileRestoreDisplays(
  previewData?: ReadonlyArray<UndoPreview>
): FileRestoreDisplay[] | null {
  if (!previewData || previewData.length === 0) return null;

  const byPath = new Map<string, {
    path: string;
    currentContent: string;
    predictedContent: string;
    operationTypes: string[];
    timestamp: string;
  }>();

  // Preview entries are newest-first. The first state is the on-disk content;
  // the last prediction is the content after every selected undo is applied.
  previewData.forEach(preview => {
    const existing = byPath.get(preview.file_path);
    if (existing) {
      existing.predictedContent = preview.predicted_content;
      existing.operationTypes.push(preview.operation_type);
    } else {
      byPath.set(preview.file_path, {
        path: preview.file_path,
        currentContent: preview.current_content,
        predictedContent: preview.predicted_content,
        operationTypes: [preview.operation_type],
        timestamp: preview.timestamp,
      });
    }
  });

  return Array.from(byPath.values()).map(file => {
    const diff = createTwoFilesPatch(
      file.path,
      file.path,
      file.currentContent,
      file.predictedContent,
      '',
      ''
    );
    return {
      path: file.path,
      operationLabel: file.operationTypes.length === 1
        ? file.operationTypes[0]!
        : `${file.operationTypes.length} changes`,
      stats: calculateDiffStats(diff),
      timestamp: file.timestamp,
    };
  });
}

/**
 * Rewind choice type
 */
export type RewindChoice = 'conversation-only' | 'conversation-and-files' | 'cancel';

export interface RewindOptionsSelectorProps {
  /** The message being rewound to */
  targetMessage: Message;
  /** File changes that will be restored */
  fileChanges: FileChangeStats;
  /** Preview data with diffs (optional) */
  previewData?: UndoPreview[];
  /** Callback when user confirms selection */
  onConfirm: (choice: RewindChoice) => void;
  /** Whether the prompt is visible */
  visible?: boolean;
}

/**
 * Truncate message content for display
 */
function truncateContent(content: string, maxLength: number = 60): string {
  const firstLine = content.split('\n')[0] || '';
  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.slice(0, maxLength - 3) + '...';
}

/**
 * RewindOptionsSelector Component
 */
export const RewindOptionsSelector: React.FC<RewindOptionsSelectorProps> = ({
  targetMessage,
  fileChanges,
  previewData,
  onConfirm,
  visible = true,
}) => {
  const terminalRows = useTerminalRows();
  // Build options array dynamically based on file count
  const hasFiles = fileChanges.fileCount > 0;

  // Define options with labels - only show "Restore Conversation and Code Changes" if files exist
  const options = [
    {
      label: 'Restore Conversation',
      description: hasFiles ? 'Rewind conversation only, keep files as-is' : 'Rewind conversation',
      choice: 'conversation-only' as RewindChoice,
    },
    // Only include code changes option if files exist
    ...(hasFiles ? [{
      label: 'Restore Conversation and Code Changes',
      description: `Rewind conversation and restore ${fileChanges.fileCount} file${fileChanges.fileCount === 1 ? '' : 's'}`,
      choice: 'conversation-and-files' as RewindChoice,
    }] : []),
    {
      label: 'Cancel',
      description: 'Return to message selector',
      choice: 'cancel' as RewindChoice,
    },
  ];

  // Default selection:
  // - If files exist: "conversation-and-files" (index 1) for backward compatibility
  // - If no files: "conversation-only" (index 0)
  const [selectedOption, setSelectedOption] = useState(hasFiles ? 1 : 0);

  // Handle keyboard input
  useInput(
    (_input, key) => {
      // Up arrow - navigate to previous option
      if (key.upArrow) {
        setSelectedOption(prev => Math.max(0, prev - 1));
        return;
      }

      // Down arrow - navigate to next option
      if (key.downArrow) {
        setSelectedOption(prev => Math.min(options.length - 1, prev + 1));
        return;
      }

      // Enter - confirm selection
      if (key.return) {
        const selectedChoice = options[selectedOption]?.choice;
        if (selectedChoice) {
          onConfirm(selectedChoice);
        }
        return;
      }

      // Escape - same as selecting "Cancel"
      if (key.escape) {
        onConfirm('cancel');
        return;
      }
    },
    { isActive: visible }
  );

  const messagePreview = truncateContent(targetMessage.content);

  // Prepare file display data from preview data if available
  const fileDisplays = React.useMemo(
    () => buildFileRestoreDisplays(previewData),
    [previewData]
  );

  if (!visible) {
    return null;
  }

  const displayLimit = visibleItemBudget(terminalRows, {
    chromeRows: 15,
    rowsPerItem: 2,
    minimum: 1,
    maximum: 5,
  });
  const displayedFileCount = fileDisplays?.length ?? fileChanges.files.length;
  const hasMoreFiles = displayedFileCount > displayLimit;

  return (
    <InteractiveSurface
      title="Rewind options"
      description={<>Rewind to “<Text color={UI_COLORS.TEXT_DEFAULT}>{messagePreview}</Text>”</>}
      footer={<KeyboardHintFooter action="select" />}
    >

      {/* File changes preview with diff stats */}
      {fileChanges.fileCount > 0 && (
        <Box flexDirection="column">
          <Text dimColor>Files to restore ({fileChanges.fileCount}):</Text>
          {fileDisplays ? (
            <>
              {fileDisplays.slice(0, displayLimit).map((file, index) => {
                const filePath = truncatePath(file.path, 50);
                const diffStats = formatDiffStats(file.stats);
                const timestamp = formatRelativeTime(file.timestamp);

                return (
                  <Box key={index} flexDirection="column" marginLeft={2} marginBottom={index < Math.min(displayLimit, fileDisplays.length) - 1 ? 0 : 0}>
                    <Box>
                      <Text>▸ {filePath}</Text>
                    </Box>
                    <Box marginLeft={2}>
                      <Text dimColor>{file.operationLabel}</Text>
                      <Text dimColor> </Text>
                      <Text color={file.stats.changes > 0 ? 'cyan' : 'gray'}>
                        {diffStats}
                      </Text>
                      <Text dimColor> • </Text>
                      <Text dimColor>{timestamp}</Text>
                    </Box>
                  </Box>
                );
              })}
              {hasMoreFiles && (
                <Box marginLeft={2}>
                  <Text dimColor>▸ ... and {displayedFileCount - displayLimit} more</Text>
                </Box>
              )}
            </>
          ) : (
            <>
              {fileChanges.files.slice(0, displayLimit).map((file, index) => (
                <Box key={index} marginLeft={2}>
                  <Text dimColor>▸ {file.path.split('/').pop() || file.path}</Text>
                </Box>
              ))}
              {hasMoreFiles && (
                <Box marginLeft={2}>
                  <Text dimColor>▸ ... and {displayedFileCount - displayLimit} more</Text>
                </Box>
              )}
            </>
          )}
        </Box>
      )}

      {/* Section header */}
      <Box marginTop={1}>
        <Text dimColor>Select an option:</Text>
      </Box>

      {/* Radio options */}
      <Box flexDirection="column">
        {options.map((option, index) => {
          const isSelected = index === selectedOption;

          return (
            <Box key={option.choice} flexDirection="column">
              {/* Option label */}
              <SelectionIndicator isSelected={isSelected}>
                <Text>{option.label}</Text>
              </SelectionIndicator>
              {/* Option description */}
              {option.description && (
                <Box marginLeft={4}>
                  <Text dimColor>{option.description}</Text>
                </Box>
              )}
            </Box>
          );
        })}
      </Box>

    </InteractiveSurface>
  );
};
