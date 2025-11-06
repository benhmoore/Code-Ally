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
import { Message } from '../../types/index.js';

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
  // Default to "conversation-and-files" (index 1) for backward compatibility
  // Options: 0 = conversation-only, 1 = conversation-and-files, 2 = cancel
  const [selectedOption, setSelectedOption] = useState(1);

  // Handle keyboard input
  useInput(
    (_input, key) => {
      // Up arrow - navigate to previous option
      if (key.upArrow) {
        setSelectedOption(Math.max(0, selectedOption - 1));
        return;
      }

      // Down arrow - navigate to next option
      if (key.downArrow) {
        setSelectedOption(Math.min(2, selectedOption + 1));
        return;
      }

      // Enter - confirm selection
      if (key.return) {
        const choices: RewindChoice[] = ['conversation-only', 'conversation-and-files', 'cancel'];
        const choice = choices[selectedOption];
        if (choice) {
          onConfirm(choice);
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

  const messagePreview = truncateContent(targetMessage.content);
  const fileList = fileChanges.files.slice(0, 3).map(f => {
    const filename = f.path.split('/').pop() || f.path;
    return filename;
  });
  const hasMoreFiles = fileChanges.fileCount > 3;

  // Define options with labels
  const options = [
    {
      label: 'Restore Conversation',
      description: fileChanges.fileCount > 0 ? 'Rewind conversation only, keep files as-is' : 'Rewind conversation (no files to restore)',
    },
    {
      label: 'Restore Conversation and Code Changes',
      description: fileChanges.fileCount > 0
        ? `Rewind conversation and restore ${fileChanges.fileCount} file${fileChanges.fileCount === 1 ? '' : 's'}`
        : 'No files to restore',
      dimmed: fileChanges.fileCount === 0,
    },
    {
      label: 'Cancel',
      description: 'Return to message selector',
    },
  ];

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
            const isDimmed = option.dimmed;

            return (
              <Box key={index} flexDirection="column" marginBottom={index < options.length - 1 ? 1 : 0}>
                {/* Option label */}
                <Box>
                  <Text color={isSelected ? 'green' : undefined} bold={isSelected}>
                    {isSelected ? '> ' : '  '}
                  </Text>
                  <Text
                    color={isDimmed ? 'gray' : (isSelected ? 'green' : 'white')}
                    bold={isSelected}
                    dimColor={isDimmed}
                  >
                    {option.label}
                  </Text>
                </Box>
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
        <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
          <Text dimColor>
            ↑↓ navigate  •  Enter select  •  Esc cancel
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
