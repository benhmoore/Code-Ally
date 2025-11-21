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
import { ChickAnimation } from './ChickAnimation.js';
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
    placeholder: string,
    isMultiline: boolean = false
  ) => {
    const isFocused = focusedField === fieldName;
    const displayValue = value || placeholder;
    const showPlaceholder = !value;

    return (
      <Box flexDirection="column" marginBottom={1}>
        {/* Field label */}
        <Text bold color={isFocused ? UI_COLORS.PRIMARY : UI_COLORS.TEXT_DEFAULT}>
          {label}:
        </Text>

        {/* Field input */}
        {isMultiline && value ? (
          // Multi-line content display (show last 3 lines)
          <Box flexDirection="column" marginLeft={2}>
            {value.split('\n').slice(-3).map((line, i, arr) => (
              <Box key={i}>
                <Text color={isFocused ? UI_COLORS.PRIMARY : UI_COLORS.TEXT_DIM}>
                  {line}
                  {isFocused && i === arr.length - 1 && (
                    <Text color={UI_COLORS.TEXT_DEFAULT}>█</Text>
                  )}
                </Text>
              </Box>
            ))}
          </Box>
        ) : (
          // Single-line display
          <Box marginLeft={2}>
            {isFocused ? (
              <Text color={UI_COLORS.PRIMARY}>
                {value || ' '}
                <Text color={UI_COLORS.TEXT_DEFAULT}>█</Text>
              </Text>
            ) : (
              <Text color={showPlaceholder ? UI_COLORS.TEXT_DIM : UI_COLORS.TEXT_DEFAULT}>
                {displayValue}
              </Text>
            )}
          </Box>
        )}
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
