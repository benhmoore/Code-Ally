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
import { UI_COLORS } from '../constants/colors.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';

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
  const terminalRows = useTerminalRows();

  if (!visible) {
    return null;
  }

  const { count, previewData } = request;
  const options = ['Confirm', 'Cancel'];
  const previewLimit = terminalRows >= 35 ? 3 : 1;
  const visiblePreviews = previewData.slice(0, previewLimit);

  return (
    <InteractiveSurface title="Confirm undo" tone={UI_COLORS.PRIMARY} meta={`${count} operation${count === 1 ? '' : 's'}`} footer={<KeyboardHintFooter action="confirm" />}>
      {previewData && previewData.length > 0 && (
        <Box flexDirection="column">
          {visiblePreviews.map((preview, index) => (
            <Box key={preview.file_path} flexDirection="column">
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
                <Box>
                  <DiffDisplay
                    oldContent={preview.current_content}
                    newContent={preview.predicted_content}
                    filePath={preview.file_path}
                    maxLinesPerHunk={terminalRows >= 35 ? 8 : 3}
                  />
                </Box>
              )}
            </Box>
          ))}
          {previewData.length > visiblePreviews.length && (
            <Text dimColor>… {previewData.length - visiblePreviews.length} more</Text>
          )}
        </Box>
      )}

      {/* Options */}
      <Box flexDirection="column">
        {options.map((option, index) => (
          <Box key={option} marginLeft={2}>
            <SelectionIndicator isSelected={selectedIndex === index}>
              <Text color={selectedIndex === index ? 'yellow' : undefined}>{option}</Text>
            </SelectionIndicator>
          </Box>
        ))}
      </Box>

    </InteractiveSurface>
  );
};
