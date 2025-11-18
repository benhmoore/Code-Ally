/**
 * PromptAddWizard - Interactive form for creating new prompts
 *
 * Provides a simple three-field form:
 * - Title: Brief name for the prompt
 * - Content: The actual prompt text
 * - Tags: Comma-separated tags (optional)
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { ModalContainer } from './ModalContainer.js';
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
  useInput((input, key) => {
    // Cancel on Escape or Ctrl+C
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel();
      return;
    }

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

    // Handle text input
    if (key.backspace || key.delete) {
      // Delete character
      const currentValue = focusedField === 'title' ? title : focusedField === 'content' ? content : tags;
      const newValue = currentValue.slice(0, -1);
      onFieldChange(focusedField, newValue);
    } else if (!key.ctrl && !key.meta && input) {
      // Add character
      const currentValue = focusedField === 'title' ? title : focusedField === 'content' ? content : tags;
      const newValue = currentValue + input;
      onFieldChange(focusedField, newValue);
    }
  });

  const renderField = (
    label: string,
    value: string,
    fieldName: 'title' | 'content' | 'tags',
    placeholder: string
  ) => {
    const isFocused = focusedField === fieldName;
    const displayValue = value || (isFocused ? '' : placeholder);
    const color = isFocused ? UI_COLORS.PRIMARY : UI_COLORS.TEXT_DIM;

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={isFocused ? UI_COLORS.PRIMARY : undefined}>
          {label}:
        </Text>
        <Box>
          <Text color={color}>
            {isFocused && '> '}
            {displayValue}
            {isFocused && '_'}
          </Text>
        </Box>
      </Box>
    );
  };

  // Check if form is valid
  const isValid = title.trim().length > 0 && content.trim().length > 0;

  return (
    <ModalContainer borderColor={UI_COLORS.TEXT_DIM}>
      <Box flexDirection="column">
        {/* Title */}
        <Box marginBottom={1}>
          <Text color={UI_COLORS.TEXT_DEFAULT} bold>
            Add Prompt
          </Text>
        </Box>

        {/* Form fields */}
        <Box flexDirection="column">
          {renderField('Title', title, 'title', 'Enter a brief title')}
          {renderField('Content', content, 'content', 'Enter the prompt content')}
          {renderField('Tags', tags, 'tags', 'Optional: comma-separated tags')}
        </Box>

        {/* Footer/instructions */}
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>Tab/↑↓: Navigate fields</Text>
          <Text dimColor>
            Enter: Save prompt{!isValid && ' (title and content required)'}
          </Text>
          <Text dimColor>Esc: Cancel</Text>
        </Box>
      </Box>
    </ModalContainer>
  );
};
