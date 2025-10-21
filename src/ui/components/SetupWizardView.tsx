/**
 * SetupWizardView - Interactive first-run setup wizard UI
 *
 * Multi-step wizard for configuring Code Ally on first run:
 * 1. Welcome screen
 * 2. Ollama endpoint configuration
 * 3. Model selection
 * 4. Context size selection
 * 5. Temperature configuration
 * 6. Auto-confirm preference
 * 7. Completion screen
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { SetupWizard, SetupConfig } from '../../services/SetupWizard.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { ConfigManager } from '../../services/ConfigManager.js';
import { logger } from '../../services/Logger.js';

enum SetupStep {
  WELCOME,
  ENDPOINT,
  VALIDATING_ENDPOINT,
  MODEL,
  CONTEXT_SIZE,
  TEMPERATURE,
  AUTO_CONFIRM,
  APPLYING,
  COMPLETED,
}

interface SetupWizardViewProps {
  onComplete: () => void;
  onSkip?: () => void;
}

export const SetupWizardView: React.FC<SetupWizardViewProps> = ({ onComplete, onSkip }) => {
  const [step, setStep] = useState<SetupStep>(SetupStep.WELCOME);
  const [endpoint, setEndpoint] = useState('http://localhost:11434');
  const [endpointInput, setEndpointInput] = useState('http://localhost:11434');
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [selectedContextSizeIndex, setSelectedContextSizeIndex] = useState(1); // Default to 32K
  const [temperature, setTemperature] = useState('0.3');
  const [temperatureInput, setTemperatureInput] = useState('0.3');
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setupWizard] = useState(() => {
    const registry = ServiceRegistry.getInstance();
    const configManager = registry.get('config_manager') as ConfigManager;
    return new SetupWizard(configManager);
  });

  const contextSizeOptions = setupWizard.getContextSizeOptions();

  // Handle keyboard input for selection screens
  useInput((input, key) => {
    if (step === SetupStep.WELCOME) {
      if (key.return) {
        setStep(SetupStep.ENDPOINT);
      } else if (input === 's' || input === 'S') {
        if (onSkip) {
          onSkip();
        }
      }
    } else if (step === SetupStep.ENDPOINT) {
      if (key.return) {
        handleEndpointSubmit();
      } else if (key.backspace || key.delete) {
        setEndpointInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setEndpointInput((prev) => prev + input);
      }
    } else if (step === SetupStep.TEMPERATURE) {
      if (key.return) {
        handleTemperatureSubmit();
      } else if (key.backspace || key.delete) {
        setTemperatureInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setTemperatureInput((prev) => prev + input);
      }
    } else if (step === SetupStep.MODEL) {
      if (key.upArrow) {
        setSelectedModelIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedModelIndex((prev) => Math.min(availableModels.length - 1, prev + 1));
      } else if (key.return) {
        setStep(SetupStep.CONTEXT_SIZE);
      }
    } else if (step === SetupStep.CONTEXT_SIZE) {
      if (key.upArrow) {
        setSelectedContextSizeIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedContextSizeIndex((prev) => Math.min(contextSizeOptions.length - 1, prev + 1));
      } else if (key.return) {
        setStep(SetupStep.TEMPERATURE);
      }
    } else if (step === SetupStep.AUTO_CONFIRM) {
      if (input === 'y' || input === 'Y') {
        setAutoConfirm(true);
        applyConfiguration(true);
      } else if (input === 'n' || input === 'N') {
        setAutoConfirm(false);
        applyConfiguration(false);
      }
    } else if (step === SetupStep.COMPLETED) {
      if (key.return) {
        onComplete();
      }
    }
  });

  // Validate endpoint when step changes to VALIDATING_ENDPOINT
  useEffect(() => {
    if (step === SetupStep.VALIDATING_ENDPOINT) {
      validateEndpointAndFetchModels();
    }
  }, [step]);

  const validateEndpointAndFetchModels = async () => {
    setError(null);

    const isValid = await setupWizard.validateOllamaConnection(endpoint);
    if (!isValid) {
      setError('Failed to connect to Ollama. Please check the endpoint and try again.');
      setStep(SetupStep.ENDPOINT);
      return;
    }

    const models = await setupWizard.getAvailableModels(endpoint);
    if (models.length === 0) {
      setError('No models found at this endpoint. Please ensure Ollama has models installed.');
      setStep(SetupStep.ENDPOINT);
      return;
    }

    setAvailableModels(models);
    setSelectedModelIndex(0);
    setStep(SetupStep.MODEL);
  };

  const handleEndpointSubmit = () => {
    if (!endpointInput.trim()) {
      setError('Endpoint cannot be empty');
      return;
    }
    setEndpoint(endpointInput);
    setError(null);
    setStep(SetupStep.VALIDATING_ENDPOINT);
  };

  const handleTemperatureSubmit = () => {
    const temp = parseFloat(temperatureInput);
    if (isNaN(temp)) {
      setError('Temperature must be a number');
      return;
    }
    if (!setupWizard.validateTemperature(temp)) {
      setError('Temperature must be between 0.0 and 2.0');
      return;
    }
    setTemperature(temperatureInput);
    setError(null);
    setStep(SetupStep.AUTO_CONFIRM);
  };

  const applyConfiguration = async (autoConfirmValue: boolean) => {
    setStep(SetupStep.APPLYING);

    // Ensure we have a valid model
    const selectedModel = availableModels[selectedModelIndex];
    if (!selectedModel) {
      setError('No model selected. Please go back and select a model.');
      setStep(SetupStep.MODEL);
      return;
    }

    // Ensure we have a valid context size
    const selectedContextSize = contextSizeOptions[selectedContextSizeIndex];
    if (!selectedContextSize) {
      setError('No context size selected.');
      setStep(SetupStep.CONTEXT_SIZE);
      return;
    }

    const config: SetupConfig = {
      endpoint,
      model: selectedModel,
      context_size: selectedContextSize.value,
      temperature: parseFloat(temperature),
      auto_confirm: autoConfirmValue,
    };

    try {
      await setupWizard.applySetupConfig(config);
      setStep(SetupStep.COMPLETED);
    } catch (error) {
      logger.error('[SetupWizardView] Failed to apply configuration:', error);
      setError('Failed to save configuration. Please try again.');
      setStep(SetupStep.AUTO_CONFIRM);
    }
  };

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        {/* Welcome Step */}
        {step === SetupStep.WELCOME && (
          <>
            <Box marginBottom={1}>
              <Text color="cyan" bold>
                Welcome to Code Ally! 🤖
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                This wizard will help you configure Code Ally for first use.
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text dimColor>
                You'll be asked to configure:
              </Text>
            </Box>
            <Box paddingLeft={2} marginBottom={1} flexDirection="column">
              <Text dimColor>• Ollama endpoint (where your LLM runs)</Text>
              <Text dimColor>• Model selection (which LLM to use)</Text>
              <Text dimColor>• Context size (memory capacity)</Text>
              <Text dimColor>• Temperature (creativity level)</Text>
              <Text dimColor>• Auto-confirm (tool execution behavior)</Text>
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text>
                Press <Text color="green">Enter</Text> to continue or <Text color="yellow">S</Text> to skip
              </Text>
            </Box>
          </>
        )}

        {/* Endpoint Configuration */}
        {step === SetupStep.ENDPOINT && (
          <>
            <Box marginBottom={1}>
              <Text color="cyan" bold>
                Step 1: Ollama Endpoint
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Enter the URL where Ollama is running (default: http://localhost:11434)
              </Text>
            </Box>
            {error && (
              <Box marginBottom={1}>
                <Text color="red">⚠ {error}</Text>
              </Box>
            )}
            <Box marginBottom={1}>
              <Text color="green">Endpoint: </Text>
              <Text>{endpointInput}</Text>
              <Text color="cyan">█</Text>
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Press Enter to validate connection</Text>
            </Box>
          </>
        )}

        {/* Validating Endpoint */}
        {step === SetupStep.VALIDATING_ENDPOINT && (
          <>
            <Box marginBottom={1}>
              <Text color="cyan" bold>
                Validating Endpoint...
              </Text>
            </Box>
            <Box>
              <Text>
                Testing connection to {endpoint}
              </Text>
            </Box>
          </>
        )}

        {/* Model Selection */}
        {step === SetupStep.MODEL && (
          <>
            <Box marginBottom={1}>
              <Text color="cyan" bold>
                Step 2: Model Selection
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Select a model to use (found {availableModels.length} models)
              </Text>
            </Box>
            <Box flexDirection="column" marginBottom={1}>
              {availableModels.map((model, idx) => (
                <Box key={idx}>
                  <Text color={idx === selectedModelIndex ? 'green' : undefined}>
                    {idx === selectedModelIndex ? '▶ ' : '  '}
                    {model}
                  </Text>
                </Box>
              ))}
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Use ↑↓ to select, Enter to confirm</Text>
            </Box>
          </>
        )}

        {/* Context Size Selection */}
        {step === SetupStep.CONTEXT_SIZE && (
          <>
            <Box marginBottom={1}>
              <Text color="cyan" bold>
                Step 3: Context Size
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Select the context window size (how much the model can remember)
              </Text>
            </Box>
            <Box flexDirection="column" marginBottom={1}>
              {contextSizeOptions.map((option, idx) => (
                <Box key={idx}>
                  <Text color={idx === selectedContextSizeIndex ? 'green' : undefined}>
                    {idx === selectedContextSizeIndex ? '▶ ' : '  '}
                    {option.label}
                  </Text>
                </Box>
              ))}
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Use ↑↓ to select, Enter to confirm</Text>
            </Box>
          </>
        )}

        {/* Temperature Configuration */}
        {step === SetupStep.TEMPERATURE && (
          <>
            <Box marginBottom={1}>
              <Text color="cyan" bold>
                Step 4: Temperature
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Set the temperature (0.0 = deterministic, 2.0 = creative, recommended: 0.3)
              </Text>
            </Box>
            {error && (
              <Box marginBottom={1}>
                <Text color="red">⚠ {error}</Text>
              </Box>
            )}
            <Box marginBottom={1}>
              <Text color="green">Temperature: </Text>
              <Text>{temperatureInput}</Text>
              <Text color="cyan">█</Text>
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Enter a value between 0.0 and 2.0, then press Enter</Text>
            </Box>
          </>
        )}

        {/* Auto-confirm Preference */}
        {step === SetupStep.AUTO_CONFIRM && (
          <>
            <Box marginBottom={1}>
              <Text color="cyan" bold>
                Step 5: Auto-confirm Tools
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Should Code Ally automatically execute tools without asking for confirmation?
              </Text>
            </Box>
            <Box marginBottom={1} flexDirection="column">
              <Text dimColor>• Yes: Tools run automatically (faster, less safe)</Text>
              <Text dimColor>• No: You confirm each tool execution (slower, safer)</Text>
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text>
                Press <Text color="green">Y</Text> for Yes or <Text color="yellow">N</Text> for No
              </Text>
            </Box>
          </>
        )}

        {/* Applying Configuration */}
        {step === SetupStep.APPLYING && (
          <>
            <Box marginBottom={1}>
              <Text color="cyan" bold>
                Applying Configuration...
              </Text>
            </Box>
            <Box>
              <Text>
                Saving your settings
              </Text>
            </Box>
          </>
        )}

        {/* Completion */}
        {step === SetupStep.COMPLETED && (
          <>
            <Box marginBottom={1}>
              <Text color="green" bold>
                Setup Complete! ✓
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Code Ally is now configured and ready to use.
              </Text>
            </Box>
            <Box marginBottom={1} flexDirection="column">
              <Text dimColor>Configuration saved:</Text>
              <Text dimColor>• Endpoint: {endpoint}</Text>
              {availableModels[selectedModelIndex] && (
                <Text dimColor>• Model: {availableModels[selectedModelIndex]}</Text>
              )}
              {contextSizeOptions[selectedContextSizeIndex] && (
                <Text dimColor>• Context: {contextSizeOptions[selectedContextSizeIndex].label}</Text>
              )}
              <Text dimColor>• Temperature: {temperature}</Text>
              <Text dimColor>• Auto-confirm: {autoConfirm ? 'Yes' : 'No'}</Text>
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text>
                Press <Text color="green">Enter</Text> to start using Code Ally
              </Text>
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
};
