/**
 * SetupWizardView - Interactive first-run setup wizard UI
 *
 * Multi-step wizard for configuring Code Ally on first run:
 * 1. Welcome screen
 * 2. Ollama endpoint configuration
 * 3. Laptop preference (optional, for local endpoints)
 * 4. Model selection
 * 5. Context size selection
 * 6. Completion screen
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { SetupWizard, SetupConfig } from '@services/SetupWizard.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ConfigManager } from '@services/ConfigManager.js';
import { logger } from '@services/Logger.js';
import { ChickAnimation } from './ChickAnimation.js';
import { ProgressIndicator } from './ProgressIndicator.js';
import { testModelToolCalling } from '@llm/ModelValidation.js';
import { ModalContainer } from './ModalContainer.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { TextInput } from './TextInput.js';
import { UI_COLORS } from '../constants/colors.js';

enum SetupStep {
  WELCOME,
  ENDPOINT,
  VALIDATING_ENDPOINT,
  LAPTOP_PREFERENCE,
  MODEL,
  VALIDATING_MODEL,
  CONTEXT_SIZE,
  APPLYING,
  COMPLETED,
}

interface SetupWizardViewProps {
  onComplete: () => void;
  onSkip?: () => void;
}

export const SetupWizardView: React.FC<SetupWizardViewProps> = ({ onComplete, onSkip }) => {
  const [step, setStep] = useState<SetupStep>(SetupStep.WELCOME);
  const [welcomeChoiceIndex, setWelcomeChoiceIndex] = useState(0); // 0 = Continue, 1 = Skip
  const [endpoint, setEndpoint] = useState('http://localhost:11434');
  const [endpointBuffer, setEndpointBuffer] = useState('http://localhost:11434');
  const [endpointCursor, setEndpointCursor] = useState('http://localhost:11434'.length);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [selectedModelIndex, setSelectedModelIndex] = useState(0);
  const [selectedContextSizeIndex, setSelectedContextSizeIndex] = useState(1); // Default to 32K
  const [isLaptop, setIsLaptop] = useState(false);
  const [selectedLaptopChoiceIndex, setSelectedLaptopChoiceIndex] = useState(1); // Default to "No"
  const [error, setError] = useState<string | null>(null);
  const [setupWizard] = useState(() => {
    const registry = ServiceRegistry.getInstance();
    const configManager = registry.get('config_manager') as ConfigManager;
    return new SetupWizard(configManager);
  });

  const contextSizeOptions = setupWizard.getContextSizeOptions();

  // Check if endpoint is localhost/local
  const isLocalEndpoint = (endpointUrl: string): boolean => {
    try {
      const url = new URL(endpointUrl);
      const hostname = url.hostname.toLowerCase();
      return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.startsWith('127.');
    } catch {
      return false;
    }
  };

  // Handle keyboard input for selection screens
  useInput((input, key) => {
    // ESC or Ctrl+C - exit the application (except during APPLYING, COMPLETED, and validation steps)
    if ((key.escape || (key.ctrl && input === 'c')) &&
        step !== SetupStep.APPLYING &&
        step !== SetupStep.COMPLETED &&
        step !== SetupStep.VALIDATING_ENDPOINT &&
        step !== SetupStep.VALIDATING_MODEL) {
      process.exit(0);
      return;
    }

    if (step === SetupStep.WELCOME) {
      if (key.upArrow) {
        setWelcomeChoiceIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setWelcomeChoiceIndex((prev) => Math.min(1, prev + 1));
      } else if (key.return) {
        if (welcomeChoiceIndex === 0) {
          // Continue
          setStep(SetupStep.ENDPOINT);
        } else {
          // Skip
          if (onSkip) {
            onSkip();
          }
        }
      }
    } else if (step === SetupStep.MODEL) {
      if (key.upArrow) {
        setSelectedModelIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedModelIndex((prev) => Math.min(availableModels.length - 1, prev + 1));
      } else if (key.return) {
        setStep(SetupStep.VALIDATING_MODEL);
      }
    } else if (step === SetupStep.CONTEXT_SIZE) {
      if (key.upArrow) {
        setSelectedContextSizeIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedContextSizeIndex((prev) => Math.min(contextSizeOptions.length - 1, prev + 1));
      } else if (key.return) {
        applyConfiguration(isLaptop);
      }
    } else if (step === SetupStep.LAPTOP_PREFERENCE) {
      if (key.upArrow) {
        setSelectedLaptopChoiceIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedLaptopChoiceIndex((prev) => Math.min(1, prev + 1));
      } else if (key.return) {
        const laptopValue = selectedLaptopChoiceIndex === 0; // Yes = true, No = false
        setIsLaptop(laptopValue);
        // Set context size based on laptop preference
        if (laptopValue) {
          setSelectedContextSizeIndex(0); // 16K for laptops
        }
        setStep(SetupStep.MODEL);
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
    } else if (step === SetupStep.VALIDATING_MODEL) {
      validateModelToolSupport();
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

    // Check if endpoint is local - if so, ask about laptop preference
    if (isLocalEndpoint(endpoint)) {
      setStep(SetupStep.LAPTOP_PREFERENCE);
    } else {
      // Remote endpoint - skip laptop question
      setIsLaptop(false);
      // Keep default context size (32K - index 1) for desktop/server
      setStep(SetupStep.MODEL);
    }
  };

  const validateModelToolSupport = async () => {
    setError(null);

    const selectedModel = availableModels[selectedModelIndex];
    if (!selectedModel) {
      setError('No model selected');
      setStep(SetupStep.MODEL);
      return;
    }

    try {
      // Test model tool calling support using extracted utility
      const result = await testModelToolCalling(endpoint, selectedModel);

      if (!result.supportsTools) {
        setError(`Model '${selectedModel}' does not support tools. Please select a different model.`);
        setStep(SetupStep.MODEL);
        return;
      }

      // Model supports tools, continue
      setStep(SetupStep.CONTEXT_SIZE);
    } catch (error) {
      // Network errors or timeouts - allow user to continue
      logger.warn('[SetupWizardView] Model validation error:', error);
      setStep(SetupStep.CONTEXT_SIZE);
    }
  };

  const handleEndpointSubmit = (value: string) => {
    if (!value.trim()) {
      setError('Endpoint cannot be empty');
      return;
    }
    setEndpoint(value);
    setError(null);
    setStep(SetupStep.VALIDATING_ENDPOINT);
  };

  const applyConfiguration = async (laptopValue: boolean) => {
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
      service_model: null,
      context_size: selectedContextSize.value,
      temperature: 0.3, // Default temperature
      auto_confirm: false, // Default to requiring confirmation
      enable_idle_messages: !laptopValue, // Disable idle messages on laptops
      enable_session_title_generation: !laptopValue, // Disable title generation on laptops
      tool_call_activity_timeout: laptopValue ? 90 : 120, // Faster timeout on laptops
    };

    try {
      await setupWizard.applySetupConfig(config);
      setStep(SetupStep.COMPLETED);
    } catch (error) {
      logger.error('[SetupWizardView] Failed to apply configuration:', error);
      setError('Failed to save configuration. Please try again.');
      setStep(SetupStep.CONTEXT_SIZE);
    }
  };

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} width="100%">
      <ModalContainer borderColor={UI_COLORS.TEXT_DIM}>
        <Box minHeight={20} width="100%" flexDirection="column">
        {/* Welcome Step */}
        {step === SetupStep.WELCOME && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                Code Ally Setup
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Quick configuration wizard for first-time setup.
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text dimColor>
                Configuration options:
              </Text>
            </Box>
            <Box paddingLeft={2} marginBottom={1} flexDirection="column">
              <Text dimColor>• Ollama endpoint</Text>
              <Text dimColor>• Model selection</Text>
              <Text dimColor>• Context size</Text>
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1} flexDirection="column" gap={1}>
              <Text dimColor>Select an option:</Text>
              <Box marginLeft={2} flexDirection="column">
                <SelectionIndicator isSelected={welcomeChoiceIndex === 0}>
                  Continue
                </SelectionIndicator>
                <SelectionIndicator isSelected={welcomeChoiceIndex === 1}>
                  Skip
                </SelectionIndicator>
              </Box>
            </Box>
          </>
        )}

        {/* Endpoint Configuration */}
        {step === SetupStep.ENDPOINT && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
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
                <Text color={UI_COLORS.ERROR}>{error}</Text>
              </Box>
            )}
            <Box marginBottom={1}>
              <Text color={UI_COLORS.PRIMARY}>Endpoint: </Text>
              <TextInput
                value={endpointBuffer}
                onValueChange={setEndpointBuffer}
                cursorPosition={endpointCursor}
                onCursorChange={setEndpointCursor}
                onSubmit={handleEndpointSubmit}
                onEscape={() => process.exit(0)}
                isActive={true}
                multiline={false}
                placeholder="http://localhost:11434"
              />
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Press Enter to validate connection</Text>
            </Box>
          </>
        )}

        {/* Validating Endpoint */}
        {step === SetupStep.VALIDATING_ENDPOINT && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
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
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                Step 2: Model Selection
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Select a model to use (found {availableModels.length} models)
              </Text>
            </Box>
            {error && (
              <Box marginBottom={1}>
                <Text color={UI_COLORS.ERROR}>{error}</Text>
              </Box>
            )}
            <Box flexDirection="column" marginBottom={1}>
              {availableModels.map((model, idx) => (
                <Box key={idx}>
                  <SelectionIndicator isSelected={idx === selectedModelIndex}>
                    {model}
                  </SelectionIndicator>
                </Box>
              ))}
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Use ↑↓ to select, Enter to confirm</Text>
            </Box>
          </>
        )}

        {/* Validating Model */}
        {step === SetupStep.VALIDATING_MODEL && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                Validating Model...
              </Text>
            </Box>
            <Box>
              <Text>
                Testing {availableModels[selectedModelIndex]} for tool support{' '}
              </Text>
              <ProgressIndicator type="dots" color={UI_COLORS.TEXT_DEFAULT} />
            </Box>
          </>
        )}

        {/* Context Size Selection */}
        {step === SetupStep.CONTEXT_SIZE && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
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
                  <SelectionIndicator isSelected={idx === selectedContextSizeIndex}>
                    {option.label}
                  </SelectionIndicator>
                </Box>
              ))}
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Use ↑↓ to select, Enter to confirm</Text>
            </Box>
          </>
        )}

        {/* Laptop Preference */}
        {step === SetupStep.LAPTOP_PREFERENCE && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                Running on a Laptop?
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Are you running Code Ally on a laptop?
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text dimColor>
                Optimizes settings to reduce heat and battery drain.
              </Text>
            </Box>
            <Box flexDirection="column" marginBottom={1}>
              <Box>
                <SelectionIndicator isSelected={selectedLaptopChoiceIndex === 0}>
                  Yes
                </SelectionIndicator>
                <Text dimColor> - Optimize for laptop use (disables background services)</Text>
              </Box>
              <Box>
                <SelectionIndicator isSelected={selectedLaptopChoiceIndex === 1}>
                  No
                </SelectionIndicator>
                <Text dimColor> - Standard settings (desktop/server)</Text>
              </Box>
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Use ↑↓ arrow keys to navigate, Enter to select, ESC to cancel</Text>
            </Box>
          </>
        )}

        {/* Applying Configuration */}
        {step === SetupStep.APPLYING && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
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
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.PRIMARY} bold>
                Setup Complete
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Configuration saved. Ready to go.
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
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text>
                Press <Text color={UI_COLORS.PRIMARY}>Enter</Text> to start
              </Text>
            </Box>
          </>
        )}
        </Box>
      </ModalContainer>
    </Box>
  );
};
