/**
 * ToolFormWizard - Interactive tool form UI
 *
 * Schema-driven form for collecting tool parameters with interactive navigation.
 * Supports multiple field types (string, number, boolean, choice, textarea, label)
 * with Tab/Shift+Tab navigation and validation.
 *
 * Features tab-based navigation for multi-field forms, showing completion status
 * for each field and allowing quick navigation between them.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { FormRequest, FormField } from '../../types/index.js';
import { ChickAnimation } from './ChickAnimation.js';
import { ModalContainer } from './ModalContainer.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { TextInput } from './TextInput.js';
import { UI_COLORS } from '../constants/colors.js';

interface ToolFormWizardProps {
  request: FormRequest;
  fieldIndex: number;
  values: Record<string, any>;
  errors: Record<string, string>;
  queueLength: number;
  onFieldIndexChange: (index: number) => void;
  onValueChange: (field: string, value: any) => void;
  onErrorChange: (field: string, error: string | null) => void;
  onComplete: (data: Record<string, any>) => void;
  onCancel: () => void;
}

export const ToolFormWizard: React.FC<ToolFormWizardProps> = ({
  request,
  fieldIndex,
  values,
  errors,
  queueLength,
  onFieldIndexChange,
  onValueChange,
  onErrorChange,
  onComplete,
  onCancel,
}) => {
  const { schema } = request;
  const fields = schema.fields;
  const currentField = fields[fieldIndex];

  // Input state for text fields
  const [inputBuffer, setInputBuffer] = useState('');
  const [inputCursor, setInputCursor] = useState(0);

  // Selection state for boolean/choice fields
  const [booleanIndex, setBooleanIndex] = useState(1); // 0 = Yes, 1 = No
  const [choiceIndex, setChoiceIndex] = useState(0); // Current cursor position
  const [multiSelectValues, setMultiSelectValues] = useState<Set<string>>(new Set()); // Selected values for multi-select

  // "Other" custom input state for inline choice input
  const [otherInputBuffer, setOtherInputBuffer] = useState('');
  const [otherInputCursor, setOtherInputCursor] = useState(0);

  // Tab bar focus state (for multi-field forms)
  const [tabBarFocused, setTabBarFocused] = useState(false);

  // Track previous field index to detect field navigation
  const [prevFieldIndex, setPrevFieldIndex] = useState(fieldIndex);
  const fieldChanged = fieldIndex !== prevFieldIndex;

  // Initialize input buffer when field changes or values change
  useEffect(() => {
    if (!currentField) return;

    // Update tracking
    if (fieldChanged) {
      setPrevFieldIndex(fieldIndex);
      setOtherInputBuffer('');
      setOtherInputCursor(0);
      // Don't reset tabBarFocused here - it's managed by navigation handlers
    }

    if (currentField.type === 'boolean') {
      const currentValue = values[currentField.name] ?? currentField.default ?? false;
      setBooleanIndex(currentValue ? 0 : 1);
      setInputBuffer('');
      setInputCursor(0);
    } else if (currentField.type === 'choice') {
      const currentValue = values[currentField.name] ?? currentField.default;

      // For multi-select, initialize from array value
      if (currentField.multiSelect) {
        const arrayValue = Array.isArray(currentValue) ? currentValue : [];
        setMultiSelectValues(new Set(arrayValue));
        setChoiceIndex(0);
      } else {
        // Single select - find the index
        const idx = currentField.choices?.findIndex(c => c.value === currentValue) ?? 0;
        setChoiceIndex(idx >= 0 ? idx : 0);
      }
      setInputBuffer('');
      setInputCursor(0);
    } else if (currentField.type === 'label') {
      // Label fields have no editable state
      setInputBuffer('');
      setInputCursor(0);
    } else {
      // string, number, textarea
      const currentValue = values[currentField.name] ?? currentField.default ?? '';
      const strValue = String(currentValue);
      // Always update buffer when field changes, or when values change and buffer matches
      if (fieldChanged || inputBuffer === '' || inputBuffer === strValue) {
        setInputBuffer(strValue);
        setInputCursor(strValue.length);
      }
    }
  }, [fieldIndex, currentField?.name, values]);

  // Check if "Other" option is currently selected
  const isOtherSelected = currentField?.type === 'choice' &&
    currentField.choices?.[choiceIndex]?.value === '__other__';

  // TextInput is active for string/number/textarea fields or inline "Other" input
  const isTextInputActive = isOtherSelected || (currentField &&
    (currentField.type === 'string' ||
     currentField.type === 'number' ||
     currentField.type === 'textarea'));

  // Check if a field has a value (label fields always "have" a value since they're static)
  const fieldHasValue = (field: FormField): boolean => {
    if (field.type === 'label') return true;
    const value = values[field.name];
    return value !== undefined && value !== null && value !== '';
  };

  // Validate a field value
  const validateField = (field: FormField, value: any): string | null => {
    // Label fields have no user input, skip validation
    if (field.type === 'label') return null;

    // Check required
    if (field.required && (value === undefined || value === null || value === '')) {
      return 'This field is required';
    }

    // Skip validation for optional empty fields
    if (!field.required && (value === undefined || value === null || value === '')) {
      return null;
    }

    // Type-specific validation
    if (field.type === 'number') {
      const numValue = typeof value === 'number' ? value : parseFloat(value);
      if (isNaN(numValue)) {
        return 'Please enter a valid number';
      }
      if (field.validation?.min !== undefined && numValue < field.validation.min) {
        return `Value must be at least ${field.validation.min}`;
      }
      if (field.validation?.max !== undefined && numValue > field.validation.max) {
        return `Value must be at most ${field.validation.max}`;
      }
    }

    if (field.type === 'string' || field.type === 'textarea') {
      const strValue = String(value);
      if (field.validation?.minLength !== undefined && strValue.length < field.validation.minLength) {
        return `Must be at least ${field.validation.minLength} characters`;
      }
      if (field.validation?.maxLength !== undefined && strValue.length > field.validation.maxLength) {
        return `Must be at most ${field.validation.maxLength} characters`;
      }
      if (field.validation?.pattern) {
        try {
          const regex = new RegExp(field.validation.pattern);
          if (!regex.test(strValue)) {
            return 'Invalid format';
          }
        } catch {
          // Invalid regex pattern in schema - skip validation rather than crash
        }
      }
    }

    return null;
  };

  // Handle field submission (Enter or moving to next field)
  const handleFieldSubmit = (value: any) => {
    if (!currentField) return;

    // Process value based on type
    let processedValue = value;
    if (currentField.type === 'number') {
      processedValue = value === '' ? undefined : parseFloat(value);
    }

    // Validate
    const error = validateField(currentField, processedValue);
    if (error) {
      onErrorChange(currentField.name, error);
      return;
    }

    // Clear error and update value
    onErrorChange(currentField.name, null);
    const finalValue = processedValue === '' ? undefined : processedValue;
    onValueChange(currentField.name, finalValue);

    // Move to next field or submit
    if (fieldIndex < fields.length - 1) {
      onFieldIndexChange(fieldIndex + 1);
    } else {
      // Last field - validate all and submit
      // Pass current field value since state update is async
      handleFormSubmit(currentField.name, finalValue);
    }
  };

  // Handle "Other" custom input submission
  const handleOtherSubmit = (value: string) => {
    if (!currentField) return;

    if (!value.trim()) {
      onErrorChange(currentField.name, 'Please enter a custom value');
      return;
    }

    const isMultiSelect = currentField.multiSelect === true;
    let finalValue: string | string[];

    if (isMultiSelect) {
      // Multi-select: include all selected values plus the custom text
      const selectedArray = Array.from(multiSelectValues);
      selectedArray.push(value.trim());
      finalValue = selectedArray;
    } else {
      // Single select: just the custom value
      finalValue = value.trim();
    }

    // Store the value (the typed text is stored directly, not '__other__')
    onValueChange(currentField.name, finalValue);
    onErrorChange(currentField.name, null);
    setOtherInputBuffer('');
    setOtherInputCursor(0);

    // Move to next field or submit
    if (fieldIndex < fields.length - 1) {
      onFieldIndexChange(fieldIndex + 1);
    } else {
      handleFormSubmit(currentField.name, finalValue);
    }
  };

  // Handle form submission (validates all fields)
  const handleFormSubmit = (currentFieldName?: string, currentFieldValue?: any) => {
    const allErrors: Record<string, string> = {};
    const finalValues: Record<string, any> = { ...values };

    // Include the current field's value (may not be in values yet due to async state)
    if (currentFieldName !== undefined) {
      finalValues[currentFieldName] = currentFieldValue;
    }

    // Validate all fields
    for (const field of fields) {
      const value = finalValues[field.name];
      const error = validateField(field, value);
      if (error) {
        allErrors[field.name] = error;
      }
    }

    // If there are errors, focus first error field
    if (Object.keys(allErrors).length > 0) {
      const firstErrorField = fields.findIndex(f => allErrors[f.name]);
      if (firstErrorField >= 0) {
        onFieldIndexChange(firstErrorField);
        Object.entries(allErrors).forEach(([field, error]) => {
          onErrorChange(field, error);
        });
      }
      return;
    }

    // All valid - submit
    onComplete(finalValues);
  };

  // Handle Ctrl+C from TextInput
  const handleCtrlC = () => {
    onCancel();
  };

  // Handle keyboard input
  useInput((input, key) => {
    // ESC - cancel
    if (key.escape) {
      onCancel();
      return;
    }

    // Ctrl+C - only handle for non-TextInput contexts
    if (key.ctrl && input === 'c' && !isTextInputActive) {
      onCancel();
      return;
    }

    // Tab - move to next field
    if (key.tab && !key.shift) {
      setTabBarFocused(false);
      if (fieldIndex < fields.length - 1) {
        onFieldIndexChange(fieldIndex + 1);
      } else {
        // Wrap to first field
        onFieldIndexChange(0);
      }
      return;
    }

    // Shift+Tab - move to previous field
    if (key.tab && key.shift) {
      setTabBarFocused(false);
      if (fieldIndex > 0) {
        onFieldIndexChange(fieldIndex - 1);
      } else {
        // Wrap to last field
        onFieldIndexChange(fields.length - 1);
      }
      return;
    }

    // Handle tab bar navigation (only for multi-field forms)
    if (tabBarFocused && fields.length > 1) {
      if (key.leftArrow) {
        if (fieldIndex > 0) {
          onFieldIndexChange(fieldIndex - 1);
        } else {
          onFieldIndexChange(fields.length - 1);
        }
      } else if (key.rightArrow) {
        if (fieldIndex < fields.length - 1) {
          onFieldIndexChange(fieldIndex + 1);
        } else {
          onFieldIndexChange(0);
        }
      } else if (key.downArrow || key.return) {
        setTabBarFocused(false);
      }
      return;
    }

    // Handle boolean field navigation
    if (currentField?.type === 'boolean') {
      if (key.upArrow) {
        if (booleanIndex === 0 && fields.length > 1) {
          // At first option, move to tab bar
          setTabBarFocused(true);
        } else {
          setBooleanIndex(prev => (prev > 0 ? prev - 1 : prev));
        }
      } else if (key.downArrow) {
        setBooleanIndex(prev => (prev < 1 ? prev + 1 : prev));
      } else if (key.return) {
        handleFieldSubmit(booleanIndex === 0);
      }
      return;
    }

    // Handle choice field navigation
    if (currentField?.type === 'choice') {
      const choicesLength = currentField.choices?.length || 0;
      const isMultiSelect = currentField.multiSelect === true;

      if (key.upArrow) {
        if (choiceIndex === 0 && fields.length > 1) {
          // At first option, move to tab bar
          setTabBarFocused(true);
        } else {
          setChoiceIndex(prev => (prev > 0 ? prev - 1 : prev));
        }
      } else if (key.downArrow) {
        setChoiceIndex(prev => (prev < choicesLength - 1 ? prev + 1 : prev));
      } else if (input === ' ' && isMultiSelect && !isOtherSelected) {
        // Space toggles selection in multi-select mode
        const choice = currentField.choices?.[choiceIndex];
        if (choice) {
          setMultiSelectValues(prev => {
            const next = new Set(prev);
            if (next.has(choice.value)) {
              next.delete(choice.value);
            } else {
              next.add(choice.value);
            }
            return next;
          });
        }
      } else if (key.return) {
        if (isMultiSelect) {
          // Submit all selected values as array, including "Other" if filled
          const selectedArray = Array.from(multiSelectValues);
          if (otherInputBuffer.trim()) {
            selectedArray.push(otherInputBuffer.trim());
          }
          if (selectedArray.length === 0) {
            onErrorChange(currentField.name, 'Please select at least one option');
            return;
          }
          handleFieldSubmit(selectedArray);
        } else {
          // Single select - submit current choice
          const choice = currentField.choices?.[choiceIndex];
          if (choice) {
            if (choice.value === '__other__') {
              // "Other" selected - require custom input
              if (!otherInputBuffer.trim()) {
                onErrorChange(currentField.name, 'Please enter a custom value');
                return;
              }
              handleOtherSubmit(otherInputBuffer);
            } else {
              handleFieldSubmit(choice.value);
            }
          }
        }
      }
      return;
    }

    // Handle text field navigation (string, number, textarea)
    if (currentField?.type === 'string' || currentField?.type === 'number' || currentField?.type === 'textarea') {
      if (key.upArrow && fields.length > 1) {
        // Move to tab bar
        setTabBarFocused(true);
      }
      // Other keys handled by TextInput component
      return;
    }

    // Handle label field navigation (read-only, just navigate)
    if (currentField?.type === 'label') {
      if (key.upArrow && fields.length > 1) {
        // Move to tab bar
        setTabBarFocused(true);
      } else if (key.return || key.downArrow) {
        // Enter or down arrow advances to next field
        if (fieldIndex < fields.length - 1) {
          onFieldIndexChange(fieldIndex + 1);
        } else {
          // Last field - submit form (label fields don't contribute data)
          handleFormSubmit();
        }
      }
      return;
    }
  });

  // Render tab bar for multi-field forms
  const renderTabBar = () => {
    if (fields.length <= 1) return null;

    return (
      <Box marginBottom={1} flexDirection="row" flexWrap="wrap">
        <Text color={tabBarFocused ? UI_COLORS.PRIMARY : undefined} dimColor={!tabBarFocused}>← </Text>
        {fields.map((field, index) => {
          const isActive = index === fieldIndex;
          const hasValue = fieldHasValue(field);
          const isLabel = field.type === 'label';
          const isLast = index === fields.length - 1;

          return (
            <Box key={field.name} marginRight={1}>
              <Text
                color={isActive ? UI_COLORS.PRIMARY : undefined}
                inverse={isActive && tabBarFocused}
                bold={isActive && !tabBarFocused}
                dimColor={!isActive && !hasValue}
              >
                {/* Label fields show bullet instead of checkbox */}
                {' '}{isLabel ? '•' : (hasValue ? '✓' : '□')} {field.label || field.name}{' '}
              </Text>
              {!isLast && <Text dimColor> </Text>}
            </Box>
          );
        })}
        <Text color={tabBarFocused ? UI_COLORS.PRIMARY : undefined} dimColor={!tabBarFocused}>→</Text>
      </Box>
    );
  };

  // Render current field
  const renderField = () => {
    if (!currentField) {
      return (
        <Box>
          <Text color="red">Invalid form configuration</Text>
        </Box>
      );
    }

    const fieldError = errors[currentField.name];

    return (
      <>
        {/* Field label/header */}
        {currentField.type === 'label' ? (
          /* Label field: show description as static content */
          <>
            {currentField.label && (
              <Box marginBottom={1}>
                <Text bold>{currentField.label}</Text>
              </Box>
            )}
            <Box marginBottom={1}>
              <Text>{currentField.description || currentField.default || ''}</Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor italic>Press Enter to continue</Text>
            </Box>
          </>
        ) : currentField.type === 'choice' ? (
          /* Choice field: show description as question */
          <>
            <Box marginBottom={1}>
              <Text bold>{currentField.description || currentField.label}</Text>
            </Box>
          </>
        ) : (
          /* Other fields: standard label + description */
          <>
            <Box marginBottom={1}>
              <Text bold>{currentField.label || currentField.name}</Text>
              {currentField.required && <Text color="red"> *</Text>}
            </Box>
            {currentField.description && (
              <Box marginBottom={1}>
                <Text dimColor>{currentField.description}</Text>
              </Box>
            )}
          </>
        )}

        {/* Field error (not shown for label fields) */}
        {fieldError && currentField.type !== 'label' && (
          <Box marginBottom={1}>
            <Text color="red">{fieldError}</Text>
          </Box>
        )}

        {/* Field input (label fields have no input, just the text above) */}
        {currentField.type === 'label' ? null : currentField.type === 'boolean' ? (
          <Box marginBottom={1} flexDirection="column">
            <SelectionIndicator isSelected={booleanIndex === 0}>
              Yes
            </SelectionIndicator>
            <SelectionIndicator isSelected={booleanIndex === 1}>
              No
            </SelectionIndicator>
          </Box>
        ) : currentField.type === 'choice' ? (
          <Box marginBottom={1} flexDirection="column">
            {currentField.choices?.map((choice, index) => {
              const isCursor = index === choiceIndex;
              const isOtherOption = choice.value === '__other__';
              const isMultiSelect = currentField.multiSelect === true;
              const isChecked = isMultiSelect && (multiSelectValues.has(choice.value) || (isOtherOption && otherInputBuffer.length > 0));

              return (
                <Box key={index} flexDirection="column" marginBottom={choice.description && !isOtherOption ? 1 : 0}>
                  <Box>
                    {/* Inline TextInput for "Other" when cursor is on it */}
                    {isOtherOption && isCursor ? (
                      <>
                        <Text color={UI_COLORS.PRIMARY}>{'\u203A'} </Text>
                        <TextInput
                          value={otherInputBuffer}
                          onValueChange={setOtherInputBuffer}
                          cursorPosition={otherInputCursor}
                          onCursorChange={setOtherInputCursor}
                          onSubmit={handleOtherSubmit}
                          onEscape={onCancel}
                          onCtrlC={handleCtrlC}
                          isActive={true}
                          bordered={false}
                          placeholder="Type something..."
                        />
                      </>
                    ) : isOtherOption && otherInputBuffer ? (
                      /* Show typed value when not focused */
                      isMultiSelect ? (
                        <Text dimColor>  [{'\u2713'}] {index + 1}. {otherInputBuffer}</Text>
                      ) : (
                        <SelectionIndicator isSelected={false}>
                          {index + 1}. {otherInputBuffer}
                        </SelectionIndicator>
                      )
                    ) : isMultiSelect ? (
                      /* Multi-select: show checkbox */
                      <Box>
                        <Text color={isCursor ? UI_COLORS.PRIMARY : undefined}>
                          {isCursor ? '\u203A' : ' '} {isChecked ? '[\u2713]' : '[ ]'} {choice.label}
                        </Text>
                      </Box>
                    ) : (
                      /* Single select: use standard indicator */
                      <SelectionIndicator isSelected={isCursor}>
                        {choice.label}
                      </SelectionIndicator>
                    )}
                  </Box>
                  {choice.description && !isOtherOption && (
                    <Box marginLeft={3}>
                      <Text dimColor>{choice.description}</Text>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        ) : (
          <Box marginBottom={1}>
            <TextInput
              label={`${currentField.name} (${currentField.type}):`}
              value={inputBuffer}
              onValueChange={setInputBuffer}
              cursorPosition={inputCursor}
              onCursorChange={setInputCursor}
              onSubmit={handleFieldSubmit}
              onEscape={onCancel}
              onCtrlC={handleCtrlC}
              isActive={true}
              multiline={currentField.type === 'textarea'}
              mask={currentField.secret ? '*' : undefined}
              placeholder={currentField.default !== undefined ? String(currentField.default) : ''}
            />
          </Box>
        )}
      </>
    );
  };

  // Build queue indicator
  const queueIndicator = queueLength > 1 ? ` (${queueLength} pending)` : '';

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <ModalContainer borderColor={UI_COLORS.TEXT_DIM}>
        <Box minHeight={10} width={80} flexDirection="column">
          {/* Tab bar for multi-field forms */}
          {renderTabBar()}

          {/* Header (only show if single field or has explicit title) */}
          {(fields.length === 1 || schema.title !== 'Questions') && (
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                {schema.title}{queueIndicator}
              </Text>
            </Box>
          )}

          {/* Description (only for single-field forms without choice/label type) */}
          {schema.description && fields.length === 1 && currentField?.type !== 'choice' && currentField?.type !== 'label' && (
            <Box marginBottom={1}>
              <Text>{schema.description}</Text>
            </Box>
          )}

          {/* Current field */}
          {renderField()}

          {/* Footer */}
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text dimColor>
              {currentField?.type === 'label'
                ? 'Enter to continue • Tab/Arrow keys to navigate • Esc to cancel'
                : currentField?.type === 'choice' && currentField.multiSelect
                  ? 'Space to toggle • Enter to confirm • Arrow keys to navigate • Esc to cancel'
                  : currentField?.type === 'boolean' || currentField?.type === 'choice'
                    ? 'Enter to select • Tab/Arrow keys to navigate • Esc to cancel'
                    : 'Enter to continue • Tab/Shift+Tab to navigate • Esc to cancel'}
            </Text>
          </Box>
        </Box>
      </ModalContainer>
    </Box>
  );
};
