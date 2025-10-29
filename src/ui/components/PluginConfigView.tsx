/**
 * PluginConfigView - Interactive plugin configuration UI
 *
 * Modal form for configuring plugins with dynamic schema-based rendering.
 * Supports text, number, boolean, and password (secret) input types.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { PluginConfigSchema, ConfigProperty } from '../../plugins/PluginLoader.js';
import { logger } from '../../services/Logger.js';
import { ChickAnimation } from './ChickAnimation.js';

interface PluginConfigViewProps {
  pluginName: string;
  configSchema: PluginConfigSchema;
  existingConfig?: any;
  onComplete: (config: any) => void;
  onCancel: () => void;
}

enum ConfigStep {
  FIELD_INPUT,
  CONFIRM,
}

export const PluginConfigView: React.FC<PluginConfigViewProps> = ({
  pluginName,
  configSchema,
  existingConfig = {},
  onComplete,
  onCancel,
}) => {
  const [step, setStep] = useState<ConfigStep>(ConfigStep.FIELD_INPUT);
  const [fieldNames, setFieldNames] = useState<string[]>([]);
  const [currentFieldIndex, setCurrentFieldIndex] = useState(0);
  const [configValues, setConfigValues] = useState<Record<string, any>>({});
  const [currentInput, setCurrentInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Initialize field names and config values
  useEffect(() => {
    if (!configSchema?.schema?.properties) {
      logger.error('[PluginConfigView] Invalid config schema');
      onCancel();
      return;
    }

    const fields = Object.keys(configSchema.schema.properties);
    setFieldNames(fields);

    // Initialize with existing config values
    const initialValues: Record<string, any> = {};
    for (const field of fields) {
      if (existingConfig[field] !== undefined) {
        initialValues[field] = existingConfig[field];
      } else {
        const prop = configSchema.schema.properties[field] as ConfigProperty;
        if (prop.default !== undefined) {
          initialValues[field] = prop.default;
        }
      }
    }
    setConfigValues(initialValues);

    // Set initial input to first field's existing value or empty
    if (fields.length > 0) {
      const firstField = fields[0]!;
      const firstProp = configSchema.schema.properties[firstField] as ConfigProperty;
      if (firstProp.type === 'boolean') {
        setCurrentInput('');
      } else {
        setCurrentInput(String(initialValues[firstField] ?? ''));
      }
    }
  }, [configSchema, existingConfig]);

  const currentField = fieldNames[currentFieldIndex];
  const currentProperty = currentField
    ? (configSchema.schema.properties[currentField] as ConfigProperty)
    : null;

  // Handle keyboard input
  useInput((input, key) => {
    // ESC or Ctrl+C - cancel
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel();
      return;
    }

    if (step === ConfigStep.FIELD_INPUT && currentProperty) {
      if (currentProperty.type === 'boolean') {
        // Boolean field - Y/N input
        if (input === 'y' || input === 'Y') {
          handleFieldSubmit(true);
        } else if (input === 'n' || input === 'N') {
          handleFieldSubmit(false);
        }
      } else {
        // Text/Number/Secret field - text input
        if (key.return) {
          if (currentProperty.type === 'number') {
            const numValue = parseFloat(currentInput);
            if (isNaN(numValue) && currentInput.trim() !== '') {
              setError('Please enter a valid number');
              return;
            }
            handleFieldSubmit(currentInput.trim() === '' ? undefined : numValue);
          } else {
            handleFieldSubmit(currentInput);
          }
        } else if (key.backspace || key.delete) {
          setCurrentInput((prev) => prev.slice(0, -1));
          setError(null);
        } else if (input && !key.ctrl && !key.meta) {
          setCurrentInput((prev) => prev + input);
          setError(null);
        }
      }
    } else if (step === ConfigStep.CONFIRM) {
      if (input === 'y' || input === 'Y') {
        handleConfirm();
      } else if (input === 'n' || input === 'N') {
        onCancel();
      }
    }
  });

  const handleFieldSubmit = (value: any) => {
    if (!currentField || !currentProperty) return;

    // Validate required fields
    if (currentProperty.required && (value === undefined || value === null || value === '')) {
      setError(`This field is required`);
      return;
    }

    // Update config values
    const newValues = { ...configValues };
    if (value === undefined || value === null || value === '') {
      // Remove optional empty fields
      delete newValues[currentField];
    } else {
      newValues[currentField] = value;
    }
    setConfigValues(newValues);
    setError(null);

    // Move to next field or confirmation
    if (currentFieldIndex < fieldNames.length - 1) {
      const nextIndex = currentFieldIndex + 1;
      setCurrentFieldIndex(nextIndex);

      const nextField = fieldNames[nextIndex]!;
      const nextProp = configSchema.schema.properties[nextField] as ConfigProperty;

      if (nextProp.type === 'boolean') {
        setCurrentInput('');
      } else {
        setCurrentInput(String(newValues[nextField] ?? ''));
      }
    } else {
      setStep(ConfigStep.CONFIRM);
    }
  };

  const handleConfirm = () => {
    // Validate all required fields
    const errors: string[] = [];
    for (const [key, property] of Object.entries(configSchema.schema.properties)) {
      const prop = property as ConfigProperty;
      const value = configValues[key];

      if (prop.required && (value === undefined || value === null || value === '')) {
        errors.push(`Required field '${key}' is missing`);
      }
    }

    if (errors.length > 0) {
      logger.error('[PluginConfigView] Validation failed:', errors);
      setError(errors.join(', '));
      setStep(ConfigStep.FIELD_INPUT);
      setCurrentFieldIndex(0);
      return;
    }

    onComplete(configValues);
  };

  const renderFieldInput = () => {
    if (!currentField || !currentProperty) {
      return (
        <Box>
          <Text color="red">Invalid configuration schema</Text>
        </Box>
      );
    }

    const progress = `${currentFieldIndex + 1}/${fieldNames.length}`;
    const isSecret = currentProperty.secret === true;
    const displayValue = isSecret ? '*'.repeat(currentInput.length) : currentInput;

    return (
      <>
        <Box marginBottom={1} flexDirection="row" gap={1}>
          <Text bold>
            <ChickAnimation />
          </Text>
          <Text color="cyan" bold>
            Configure {pluginName} [{progress}]
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text bold>{currentField}</Text>
          {currentProperty.required && <Text color="red"> *</Text>}
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>{currentProperty.description}</Text>
        </Box>

        {error && (
          <Box marginBottom={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}

        {currentProperty.type === 'boolean' ? (
          <Box marginBottom={1}>
            <Text>
              Press <Text color="green">Y</Text> for Yes or <Text color="yellow">N</Text> for No
            </Text>
          </Box>
        ) : (
          <>
            <Box marginBottom={1}>
              <Text color="green">{currentField}: </Text>
              <Text>{displayValue}</Text>
              <Text color="cyan">█</Text>
            </Box>
            <Box marginBottom={1}>
              <Text dimColor>
                Type: {currentProperty.type}
                {currentProperty.default !== undefined && ` (default: ${currentProperty.default})`}
              </Text>
            </Box>
          </>
        )}

        <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
          <Text dimColor>
            {currentProperty.type === 'boolean'
              ? 'Press Y or N to continue'
              : 'Press Enter to continue, ESC to cancel'}
          </Text>
        </Box>
      </>
    );
  };

  const renderConfirmation = () => {
    return (
      <>
        <Box marginBottom={1} flexDirection="row" gap={1}>
          <Text bold>
            <ChickAnimation />
          </Text>
          <Text color="cyan" bold>
            Confirm Configuration
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text>Review your configuration for {pluginName}:</Text>
        </Box>

        <Box marginBottom={1} flexDirection="column" paddingLeft={2}>
          {Object.entries(configValues).map(([key, value]) => {
            const prop = configSchema.schema.properties[key] as ConfigProperty;
            const isSecret = prop?.secret === true;
            const displayValue = isSecret ? '********' : String(value);

            return (
              <Box key={key}>
                <Text dimColor>
                  • {key}: <Text color="white">{displayValue}</Text>
                </Text>
              </Box>
            );
          })}
        </Box>

        <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
          <Text>
            Save this configuration? Press <Text color="green">Y</Text> for Yes or{' '}
            <Text color="yellow">N</Text> to cancel
          </Text>
        </Box>
      </>
    );
  };

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        flexDirection="column"
        minHeight={15}
        width={80}
      >
        {step === ConfigStep.FIELD_INPUT && renderFieldInput()}
        {step === ConfigStep.CONFIRM && renderConfirmation()}
      </Box>
    </Box>
  );
};
