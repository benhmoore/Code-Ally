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
import { createDivider } from '../utils/uiHelpers.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { UI_COLORS } from '../constants/colors.js';

/**
 * File change statistics
 */
export interface FileChangeStats {
  fileCount: number;
  files: Array<{ path: string }>;
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
  onConfirm,
  visible = true,
}) => {
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

  if (!visible) {
    return null;
  }

  const terminalWidth = useContentWidth();
  const divider = createDivider(terminalWidth);

  const messagePreview = truncateContent(targetMessage.content);
  const fileList = fileChanges.files.slice(0, 3).map(f => {
    const filename = f.path.split('/').pop() || f.path;
    return filename;
  });
  const hasMoreFiles = fileChanges.fileCount > 3;

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Top divider */}
      <Box>
        <Text dimColor>{divider}</Text>
      </Box>

      {/* Header */}
      <Box marginY={1}>
        <Text color={UI_COLORS.TEXT_DEFAULT} bold>
          Rewind Options
        </Text>
      </Box>

      {/* Target message preview */}
      <Box marginBottom={1} flexDirection="column">
        <Text dimColor>Rewinding to:</Text>
        <Box marginLeft={2}>
          <Text color="white">"{messagePreview}"</Text>
        </Box>
      </Box>

      {/* File changes preview */}
      {fileChanges.fileCount > 0 && (
        <Box marginBottom={1} flexDirection="column">
          {fileList.map((filename, index) => (
            <Box key={index} marginLeft={2}>
              <Text dimColor>• {filename}</Text>
            </Box>
          ))}
          {hasMoreFiles && (
            <Box marginLeft={2}>
              <Text dimColor>• ... and {fileChanges.fileCount - 3} more</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Section header */}
      <Box marginTop={1} marginBottom={1}>
        <Text dimColor>Select an option:</Text>
      </Box>

      {/* Radio options */}
      <Box flexDirection="column" marginBottom={1}>
        {options.map((option, index) => {
          const isSelected = index === selectedOption;

          return (
            <Box key={index} flexDirection="column" marginBottom={index < options.length - 1 ? 1 : 0}>
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

      {/* Help text */}
      <KeyboardHintFooter action="select" cancelText="cancel" />
    </Box>
  );
};
