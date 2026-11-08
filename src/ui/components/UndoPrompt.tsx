/** Undo confirmation keeps the destructive choice visible while inspecting every change. */
import React from 'react';
import { Box, Text } from 'ink';
import { createTwoFilesPatch } from 'diff';
import { SelectionIndicator } from './SelectionIndicator.js';
import { Clickable } from './Clickable.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { UI_COLORS } from '../constants/colors.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { stripAnsi } from '@utils/terminalText.js';
import type { UndoRequest } from '../hooks/useModalState.js';

export interface UndoPromptProps {
  request: UndoRequest;
  selectedIndex: number;
  visible?: boolean;
  onOptionPress?: (index: number) => void;
}

export const UndoPrompt: React.FC<UndoPromptProps> = ({ request, selectedIndex, visible = true, onOptionPress }) => {
  const previews = React.useMemo(() => request.previewData.map(preview => ({
    ...preview,
    diff: stripAnsi(createTwoFilesPatch(preview.file_path, preview.file_path,
      preview.current_content, preview.predicted_content)),
  })), [request.previewData]);
  if (!visible) return null;
  const single = previews.length === 1 ? previews[0] : undefined;
  const effect = single?.predicted_content === '' && single.current_content !== '' ? 'File will be deleted.'
    : single?.predicted_content !== '' && single?.current_content === '' ? 'File will be recreated.' : undefined;
  return (
    <InteractiveSurface scrollable title="Confirm undo" tone={UI_COLORS.PRIMARY}
      meta={`${request.count} operation${request.count === 1 ? '' : 's'}`} description={effect}
      footer={<>
        {['Confirm', 'Cancel'].map((option, index) => (
          <Clickable key={option} marginLeft={2} onPress={onOptionPress && (() => onOptionPress(index))}>
            <SelectionIndicator isSelected={selectedIndex === index}>
              <Text color={selectedIndex === index ? 'yellow' : undefined}>{option}</Text>
            </SelectionIndicator>
          </Clickable>
        ))}
        <KeyboardHintFooter action="confirm" />
      </>}>
      {previews.map((preview, index) => (
        <Box key={`${preview.patch_number}:${preview.file_path}`} flexDirection="column">
          <Text>{previews.length > 1 ? `${index + 1}. ` : ''}Undoing {preview.operation_type} on {preview.file_path}</Text>
          {preview.predicted_content === '' && preview.current_content !== '' && <Text color={UI_COLORS.ERROR}>→ File will be deleted</Text>}
          {preview.predicted_content !== '' && preview.current_content === '' && <Text>→ File will be recreated</Text>}
          {preview.current_content !== preview.predicted_content && <Text>{preview.diff}</Text>}
        </Box>
      ))}
    </InteractiveSurface>
  );
};
