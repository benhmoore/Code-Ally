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

import React from 'react';
import { Box, Text } from 'ink';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { MarkdownText } from './MarkdownText.js';
import { createDivider } from '../utils/uiHelpers.js';
import { UI_COLORS } from '../constants/colors.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { TextInput } from './TextInput.js';

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
}

/** Plan approval option labels */
const APPROVAL_OPTIONS = [
  'Approve',
  'Approve + clear context',
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
}) => {
  const terminalWidth = useContentWidth();
  const divider = createDivider(terminalWidth);

  // Truncate plan content for display (show first 40 lines max)
  const planLines = request.planContent.split('\n');
  const truncated = planLines.length > 40;
  const displayContent = truncated
    ? planLines.slice(0, 40).join('\n') + '\n...(truncated)'
    : request.planContent;

  return (
    <Box flexDirection="column">
      {/* Top divider */}
      <Box>
        <Text dimColor>{divider}</Text>
      </Box>

      {/* Header */}
      <Box marginY={1}>
        <Text color={UI_COLORS.PRIMARY} bold>
          Plan ready for review
        </Text>
      </Box>

      {/* Plan file path */}
      <Box marginBottom={1}>
        <Text dimColor>File: {request.planFilePath}</Text>
      </Box>

      {/* Plan content preview */}
      <Box flexDirection="column" marginBottom={1}>
        <MarkdownText content={displayContent} />
      </Box>

      {/* Divider before options */}
      <Box>
        <Text dimColor>{divider}</Text>
      </Box>

      {/* Options */}
      <Box flexDirection="column" marginTop={1}>
        {APPROVAL_OPTIONS.map((option, idx) => {
          const isSelected = idx === selectedIndex;
          const isFeedbackOption = idx === 2;

          return (
            <Box key={idx} flexDirection="row">
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
            </Box>
          );
        })}
      </Box>

      {/* Footer */}
      <KeyboardHintFooter action="confirm" cancelText="cancel" />
    </Box>
  );
};
