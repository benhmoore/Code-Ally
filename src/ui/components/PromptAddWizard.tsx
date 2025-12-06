/**
 * PromptAddWizard - Interactive form for creating new prompts
 *
 * Provides a simple three-field form:
 * - Title: Brief name for the prompt
 * - Content: The actual prompt text
 * - Tags: Comma-separated tags (optional)
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ModalContainer } from './ModalContainer.js';
import { ChickAnimation } from './ChickAnimation.js';
import { TextInput } from './TextInput.js';
import { UI_COLORS } from '../constants/colors.js';

interface PromptAddWizardProps {
  title: string;
  content: string;
  tags: string;
  focusedField: 'title' | 'content' | 'tags';
  onFieldChange: (field: 'title' | 'content' | 'tags', value: string) => void;
  onFieldFocus: (field: 'title' | 'content' | 'tags') => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export const PromptAddWizard: React.FC<PromptAddWizardProps> = ({
  title,
  content,
  tags,
  focusedField,
  onFieldChange,
  onFieldFocus,
  onSubmit,
  onCancel,
}) => {
  // Detect edit mode by checking if initial values are provided
  const isEditMode = React.useMemo(() => {
    return title.trim().length > 0 && content.trim().length > 0;
  }, []); // Only check on mount

  // Cursor positions for each field
  const [titleCursor, setTitleCursor] = useState(title.length);
  const [contentCursor, setContentCursor] = useState(content.length);
  const [tagsCursor, setTagsCursor] = useState(tags.length);

  // Submit handler for TextInput
  const handleSubmit = () => {
    if (focusedField !== 'content') {
      onSubmit();
    }
  };

  // Handle cancel from TextInput's onCtrlC (empty buffer)
  const handleCtrlC = () => {
    onCancel();
  };

  useInput((_input, key) => {
    // ESC - always cancel
    if (key.escape) {
      onCancel();
      return;
    }

    // Note: Ctrl+C is handled by TextInput (always active in this form)

    // Submit on Enter (only if not in multiline content field)
    if (key.return && focusedField !== 'content') {
      onSubmit();
      return;
    }

    // Tab or Down: move to next field
    if (key.tab || (key.downArrow && !key.shift)) {
      if (focusedField === 'title') {
        onFieldFocus('content');
      } else if (focusedField === 'content') {
        onFieldFocus('tags');
      } else if (focusedField === 'tags') {
        onFieldFocus('title');
      }
      return;
    }

    // Shift+Tab or Up: move to previous field
    if ((key.tab && key.shift) || key.upArrow) {
      if (focusedField === 'title') {
        onFieldFocus('tags');
      } else if (focusedField === 'content') {
        onFieldFocus('title');
      } else if (focusedField === 'tags') {
        onFieldFocus('content');
      }
      return;
    }
  });

  const renderField = (
    label: string,
    value: string,
    fieldName: 'title' | 'content' | 'tags',
    placeholder: string,
    isMultiline: boolean = false
  ) => {
    const isFocused = focusedField === fieldName;
    const cursor = fieldName === 'title' ? titleCursor : fieldName === 'content' ? contentCursor : tagsCursor;
    const setCursor = fieldName === 'title' ? setTitleCursor : fieldName === 'content' ? setContentCursor : setTagsCursor;

    return (
      <Box marginBottom={1}>
        <TextInput
          label={`${label}:`}
          labelColor={isFocused ? UI_COLORS.PRIMARY : UI_COLORS.TEXT_DEFAULT}
          value={value}
          onValueChange={(newValue) => onFieldChange(fieldName, newValue)}
          cursorPosition={cursor}
          onCursorChange={setCursor}
          onSubmit={handleSubmit}
          onEscape={onCancel}
          onCtrlC={handleCtrlC}
          isActive={isFocused}
          multiline={isMultiline}
          placeholder={placeholder}
        />
      </Box>
    );
  };

  // Check if form is valid
  const isValid = title.trim().length > 0 && content.trim().length > 0;

  return (
    <ModalContainer borderColor={UI_COLORS.TEXT_DIM}>
      <Box flexDirection="column">
        {/* Header with ChickAnimation */}
        <Box marginBottom={1} flexDirection="row" gap={1}>
          <Text bold>
            <ChickAnimation />
          </Text>
          <Text color={UI_COLORS.TEXT_DEFAULT} bold>
            {isEditMode ? 'Edit Prompt' : 'Add Prompt'}
          </Text>
        </Box>

        {/* Description */}
        <Box marginBottom={1}>
          <Text>
            {isEditMode ? 'Update your saved prompt details' : 'Create a new prompt for your library'}
          </Text>
        </Box>

        {/* Form fields */}
        <Box flexDirection="column">
          {renderField('Title', title, 'title', 'Enter a brief title', false)}
          {renderField('Content', content, 'content', 'Enter the prompt content', true)}
          {renderField('Tags', tags, 'tags', 'Optional: comma-separated tags', false)}
        </Box>

        {/* Footer separator and instructions */}
        <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
          <Text dimColor>
            Tab/↑↓: Navigate • Enter: Save{!isValid && ' (title and content required)'} • Esc: Cancel
          </Text>
        </Box>
      </Box>
    </ModalContainer>
  );
};
