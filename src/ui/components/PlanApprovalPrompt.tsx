/**
 * PlanApprovalPrompt - Interactive plan approval modal with keyboard navigation
 *
 * Displays the plan content and presents approval options:
 * 1. Approve - proceed with implementation
 * 2. Approve + clear context - compact before implementing
 * 3. Feedback text input - revise plan
 *
 * Follows PermissionPrompt patterns (keyboard nav, SelectionIndicator, KeyboardHintFooter).
 */

import React, { useEffect, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { SelectionIndicator } from './SelectionIndicator.js';
import { Clickable } from './Clickable.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { wrapAnsiText } from '@utils/terminalText.js';
import { UI_COLORS } from '../constants/colors.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { TextInput } from './TextInput.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';

/**
 * Plan approval request data (from PLAN_APPROVAL_REQUEST event)
 */
export interface PlanApprovalRequest {
  planFilePath: string;
  planContent: string;
}

export interface PlanApprovalPromptProps {
  /** Plan approval request data */
  request: PlanApprovalRequest;
  /** Currently selected option index */
  selectedIndex: number;
  /** Feedback text for revision option */
  feedbackText: string;
  /** Callback when feedback text changes */
  onFeedbackTextChange: (text: string) => void;
  /** Cursor position for feedback TextInput */
  cursorPosition: number;
  /** Cursor position change callback */
  onCursorChange: (position: number) => void;
  /** Activate the option at an index, as a click on its row does. */
  onOptionPress?: (index: number) => void;
}

/** Plan approval option labels */
const APPROVAL_OPTIONS = [
  'Approve',
  'Approve + compact context',
  'Provide feedback...',
];

/**
 * PlanApprovalPrompt Component
 */
export const PlanApprovalPrompt: React.FC<PlanApprovalPromptProps> = ({
  request,
  selectedIndex,
  feedbackText,
  onFeedbackTextChange,
  cursorPosition,
  onCursorChange,
  onOptionPress,
}) => {
  const terminalRows = useTerminalRows();

  const { stdout } = useStdout();
  const [offset, setOffset] = useState(0);
  const width = Math.max(10, (stdout.columns || 80) - 8);
  const planLines = request.planContent.split('\n').flatMap(line => wrapAnsiText(line, width, { preserveWhitespace: true }));
  const previewLines = Math.max(1, terminalRows - 14);
  const maximum = Math.max(0, planLines.length - previewLines);
  const start = Math.min(offset, maximum);
  const displayContent = planLines.slice(start, start + previewLines).join('\n');
  useEffect(() => { setOffset(0); }, [request.planContent, request.planFilePath]);
  useInput((_input, key) => {
    if (key.pageUp) setOffset(current => Math.max(0, Math.min(current, maximum) - previewLines));
    if (key.pageDown) setOffset(current => Math.min(maximum, current + previewLines));
    if (selectedIndex !== 2 && key.ctrl && _input === 'a') setOffset(0);
    if (selectedIndex !== 2 && key.ctrl && _input === 'e') setOffset(maximum);
  });

  return (
    <InteractiveSurface
      title="Plan ready for review"
      tone={UI_COLORS.PRIMARY}
      description={request.planFilePath}
      footer={<KeyboardHintFooter action="confirm" />}
    >
      <Box flexDirection="column">
        <Text>{displayContent}</Text>
        <Text dimColor>Lines {start + 1}–{Math.min(start + previewLines, planLines.length)} of {planLines.length} · PgUp/PgDn to scroll · Ctrl+A/E first/last</Text>
      </Box>

      {/* Options */}
      <Box flexDirection="column" marginTop={1}>
        {APPROVAL_OPTIONS.map((option, idx) => {
          const isSelected = idx === selectedIndex;
          const isFeedbackOption = idx === 2;

          return (
            <Clickable key={idx} flexDirection="row" onPress={onOptionPress && (() => onOptionPress(idx))}>
              {isFeedbackOption && isSelected ? (
                <>
                  <Text color={UI_COLORS.PRIMARY}>{UI_SYMBOLS.NAVIGATION.CHEVRON_RIGHT} </Text>
                  <TextInput
                    value={feedbackText}
                    onValueChange={onFeedbackTextChange}
                    cursorPosition={cursorPosition}
                    onCursorChange={onCursorChange}
                    onSubmit={() => {}}
                    isActive={true}
                    bordered={false}
                    placeholder={option}
                  />
                </>
              ) : (
                <SelectionIndicator isSelected={isSelected}>
                  {option}
                </SelectionIndicator>
              )}
            </Clickable>
          );
        })}
      </Box>

    </InteractiveSurface>
  );
};
