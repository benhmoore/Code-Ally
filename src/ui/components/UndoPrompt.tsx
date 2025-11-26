/**
 * UndoPrompt - Interactive undo confirmation modal with diff preview
 *
 * Features:
 * - Shows what operations will be undone
 * - Displays diff preview for each file
 * - Keyboard navigation (up/down arrows, Enter to select)
 * - Visual selection indicator
 */

import React from 'react';
import { Box, Text } from 'ink';
import { DiffDisplay } from './DiffDisplay.js';
import type { UndoPreview } from '@services/PatchManager.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { createDivider } from '../utils/uiHelpers.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { UI_COLORS } from '../constants/colors.js';

export interface UndoRequest {
  /** Request ID for tracking */
  requestId: string;
  /** Number of operations to undo */
  count: number;
  /** Patch metadata */
  patches: Array<{
    patch_number: number;
    timestamp: string;
    operation_type: string;
    file_path: string;
    patch_file: string;
  }>;
  /** Preview data with diffs */
  previewData: UndoPreview[];
}

export interface UndoPromptProps {
  /** Undo request details */
  request: UndoRequest;
  /** Currently selected option index (0=Confirm, 1=Cancel) */
  selectedIndex: number;
  /** Whether the prompt is visible */
  visible?: boolean;
}

/**
 * UndoPrompt Component
 */
export const UndoPrompt: React.FC<UndoPromptProps> = ({
  request,
  selectedIndex,
  visible = true,
}) => {
  if (!visible) {
    return null;
  }

  const { count, previewData } = request;
  const options = ['Confirm', 'Cancel'];
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
          Undo Confirmation
        </Text>
      </Box>

      {/* Operation count */}
      <Box marginBottom={1}>
        <Text dimColor>Operations to undo: </Text>
        <Text bold color={UI_COLORS.PRIMARY}>{count}</Text>
      </Box>

      {/* Preview each operation */}
      {previewData && previewData.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          {previewData.map((preview, index) => (
            <Box key={index} flexDirection="column" marginBottom={1}>
              {/* Operation header */}
              <Box marginBottom={0}>
                {previewData.length > 1 && (
                  <Text dimColor>{index + 1}. </Text>
                )}
                <Text dimColor>Undoing </Text>
                <Text color={UI_COLORS.TEXT_DEFAULT}>{preview.operation_type}</Text>
                <Text dimColor> on </Text>
                <Text>{preview.file_path}</Text>
              </Box>

              {/* File status indicators */}
              {preview.predicted_content === '' && preview.current_content !== '' && (
                <Box marginLeft={2}>
                  <Text color={UI_COLORS.ERROR}>→ File will be deleted</Text>
                </Box>
              )}
              {preview.predicted_content !== '' && preview.current_content === '' && (
                <Box marginLeft={2}>
                  <Text color={UI_COLORS.TEXT_DEFAULT}>→ File will be recreated</Text>
                </Box>
              )}

              {/* Diff preview */}
              {preview.current_content !== preview.predicted_content && (
                <Box marginTop={1} marginBottom={1}>
                  <DiffDisplay
                    oldContent={preview.current_content}
                    newContent={preview.predicted_content}
                    filePath={preview.file_path}
                    maxLinesPerHunk={10}
                  />
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* Options */}
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Select action:</Text>
        {options.map((option, index) => (
          <Box key={option} marginLeft={2}>
            <SelectionIndicator isSelected={selectedIndex === index}>
              <Text color={selectedIndex === index ? 'yellow' : undefined}>{option}</Text>
            </SelectionIndicator>
          </Box>
        ))}
      </Box>

      {/* Footer */}
      <KeyboardHintFooter action="confirm" />
    </Box>
  );
};
