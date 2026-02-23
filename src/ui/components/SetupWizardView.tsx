/**
 * SetupWizardView - Interactive first-run setup wizard UI
 *
 * Multi-step wizard for configuring Code Ally on first run:
 * 1. Welcome screen
 * 2. Ollama endpoint configuration
 * 3. Laptop preference (optional, for local endpoints)
 * 4. Model selection
 * 5. Context size selection
 * 6. Search provider configuration (optional)
 * 7. Completion screen
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { SetupWizard, SetupConfig } from '@services/SetupWizard.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { ConfigManager } from '@services/ConfigManager.js';
import { IntegrationStore } from '@services/IntegrationStore.js';
import { logger } from '@services/Logger.js';
import { ChickAnimation } from './ChickAnimation.js';
import { ProgressIndicator } from './ProgressIndicator.js';
import { testModelCapabilities } from '@llm/ModelValidation.js';
import { ModalContainer } from './ModalContainer.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { TextInput } from './TextInput.js';
import { UI_COLORS } from '../constants/colors.js';
import { SEARCH_PROVIDER_INFO, SearchProviderType } from '../../types/integration.js';
import { MCP_PRESETS, MCP_PRESET_ORDER, buildConfigFromPreset } from '@mcp/MCPPresets.js';
import type { MCPServerManager } from '@mcp/MCPServerManager.js';

enum SetupStep {
  WELCOME,
  ENDPOINT,
  VALIDATING_ENDPOINT,
  LAPTOP_PREFERENCE,
  MODEL,
  VALIDATING_MODEL,
  CONTEXT_SIZE,
  SEARCH_PROMPT,       // Ask if user wants to configure search
  SEARCH_PROVIDER,     // Select provider (brave/serper)
  SEARCH_API_KEY,      // Enter API key
  MCP_PROMPT,          // Ask if user wants to configure an MCP server
  MCP_SERVER_SELECT,   // Select from presets (or "Custom")
  MCP_SERVER_INPUT,    // Enter path or env var for selected preset
  MCP_CUSTOM_NAME,     // Enter custom server name
  MCP_CUSTOM_COMMAND,  // Enter custom server command
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

  // Search configuration state
  const [searchPromptIndex, setSearchPromptIndex] = useState(1); // 0 = Yes, 1 = Skip (default to skip)
  const [searchProviderIndex, setSearchProviderIndex] = useState(0); // Index into searchProviderOptions
  const [searchApiKeyBuffer, setSearchApiKeyBuffer] = useState('');
  const [searchApiKeyCursor, setSearchApiKeyCursor] = useState(0);
  const [selectedSearchProvider, setSelectedSearchProvider] = useState<SearchProviderType>('none');

  // MCP configuration state
  const [mcpPromptIndex, setMcpPromptIndex] = useState(1); // 0 = Yes, 1 = Skip (default to skip)
  const [mcpPresetIndex, setMcpPresetIndex] = useState(0);
  const [mcpInputBuffer, setMcpInputBuffer] = useState('');
  const [mcpInputCursor, setMcpInputCursor] = useState(0);
  const [selectedMcpPresetKey, setSelectedMcpPresetKey] = useState<string>('');
  const [mcpCustomNameBuffer, setMcpCustomNameBuffer] = useState('');
  const [mcpCustomNameCursor, setMcpCustomNameCursor] = useState(0);
  const [mcpCustomCommandBuffer, setMcpCustomCommandBuffer] = useState('');
  const [mcpCustomCommandCursor, setMcpCustomCommandCursor] = useState(0);
  const [mcpCustomName, setMcpCustomName] = useState('');

  /** Preset list with "Custom" appended */
  const mcpOptions = [...MCP_PRESET_ORDER.map(key => ({ key, preset: MCP_PRESETS[key]! })), { key: 'custom', preset: null }];

  // Available search providers (excluding 'none')
  const searchProviderOptions = Object.entries(SEARCH_PROVIDER_INFO)
    .filter(([key]) => key !== 'none')
    .map(([key, info]) => ({ key: key as SearchProviderType, ...info }));

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

  // TextInput is active on text entry steps
  const isTextInputStep = step === SetupStep.ENDPOINT || step === SetupStep.SEARCH_API_KEY
    || step === SetupStep.MCP_SERVER_INPUT || step === SetupStep.MCP_CUSTOM_NAME || step === SetupStep.MCP_CUSTOM_COMMAND;

  // Handle exit from TextInput's onCtrlC (empty buffer)
  const handleCtrlC = () => {
    process.exit(0);
  };

  // Handle keyboard input for selection screens
  useInput((input, key) => {
    // Exclude certain steps from keyboard handling
    const isProtectedStep = step === SetupStep.APPLYING ||
                            step === SetupStep.COMPLETED ||
                            step === SetupStep.VALIDATING_ENDPOINT ||
                            step === SetupStep.VALIDATING_MODEL;

    // ESC - exit (except protected steps)
    if (key.escape && !isProtectedStep) {
      process.exit(0);
      return;
    }

    // Ctrl+C - only handle for non-TextInput steps (TextInput handles its own)
    if (key.ctrl && input === 'c' && !isProtectedStep && !isTextInputStep) {
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
        // Go to optional search configuration prompt
        setStep(SetupStep.SEARCH_PROMPT);
      }
    } else if (step === SetupStep.SEARCH_PROMPT) {
      if (key.upArrow) {
        setSearchPromptIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSearchPromptIndex((prev) => Math.min(1, prev + 1));
      } else if (key.return) {
        if (searchPromptIndex === 0) {
          // Yes - configure search
          setStep(SetupStep.SEARCH_PROVIDER);
        } else {
          // Skip search - go to MCP prompt
          setStep(SetupStep.MCP_PROMPT);
        }
      }
    } else if (step === SetupStep.SEARCH_PROVIDER) {
      if (key.upArrow) {
        setSearchProviderIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSearchProviderIndex((prev) => Math.min(searchProviderOptions.length - 1, prev + 1));
      } else if (key.return) {
        const provider = searchProviderOptions[searchProviderIndex];
        if (provider) {
          setSelectedSearchProvider(provider.key);
          setStep(SetupStep.SEARCH_API_KEY);
        }
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
    } else if (step === SetupStep.MCP_PROMPT) {
      if (key.upArrow) {
        setMcpPromptIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setMcpPromptIndex((prev) => Math.min(1, prev + 1));
      } else if (key.return) {
        if (mcpPromptIndex === 0) {
          setStep(SetupStep.MCP_SERVER_SELECT);
        } else {
          applyAllConfiguration();
        }
      }
    } else if (step === SetupStep.MCP_SERVER_SELECT) {
      if (key.upArrow) {
        setMcpPresetIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setMcpPresetIndex((prev) => Math.min(mcpOptions.length - 1, prev + 1));
      } else if (key.return) {
        const option = mcpOptions[mcpPresetIndex];
        if (option) {
          if (option.key === 'custom') {
            setMcpCustomNameBuffer('');
            setMcpCustomNameCursor(0);
            setStep(SetupStep.MCP_CUSTOM_NAME);
          } else {
            const preset = option.preset;
            setSelectedMcpPresetKey(option.key);
            if (preset && (preset.needsPath || preset.needsEnvKey)) {
              setMcpInputBuffer('');
              setMcpInputCursor(0);
              setStep(SetupStep.MCP_SERVER_INPUT);
            } else {
              applyAllConfiguration(option.key);
            }
          }
        }
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
      validateModelCapabilities();
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

  const validateModelCapabilities = async () => {
    setError(null);

    const selectedModel = availableModels[selectedModelIndex];
    if (!selectedModel) {
      setError('No model selected');
      setStep(SetupStep.MODEL);
      return;
    }

    try {
      // Test model capabilities using extracted utility
      const result = await testModelCapabilities(endpoint, selectedModel);

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

  const [searchApiKey, setSearchApiKey] = useState('');

  const handleSearchApiKeySubmit = (value: string) => {
    if (!value.trim()) {
      setError('API key cannot be empty. Press ESC to skip search configuration.');
      return;
    }
    setError(null);
    setSearchApiKey(value);
    // Continue to MCP prompt
    setStep(SetupStep.MCP_PROMPT);
  };

  const handleMcpInputSubmit = (value: string) => {
    if (!value.trim()) {
      setError('Value cannot be empty. Press ESC to skip.');
      return;
    }
    setError(null);
    applyAllConfiguration(selectedMcpPresetKey, value);
  };

  const handleMcpCustomNameSubmit = (value: string) => {
    const name = value.trim();
    if (!name) {
      setError('Server name cannot be empty. Press ESC to skip.');
      return;
    }
    setError(null);
    setMcpCustomName(name);
    setMcpCustomCommandBuffer('');
    setMcpCustomCommandCursor(0);
    setStep(SetupStep.MCP_CUSTOM_COMMAND);
  };

  const handleMcpCustomCommandSubmit = (value: string) => {
    const command = value.trim();
    if (!command) {
      setError('Command cannot be empty. Press ESC to skip.');
      return;
    }
    setError(null);
    applyAllConfiguration(undefined, undefined, mcpCustomName, command);
  };

  /**
   * Unified apply function — saves core config, optional search, and optional MCP.
   * Reads search state from component state (selectedSearchProvider, searchApiKey).
   * MCP preset is passed in when selected; custom server uses customName + customCommand.
   */
  const applyAllConfiguration = async (mcpPresetKey?: string, mcpInput?: string, customName?: string, customCommand?: string) => {
    setStep(SetupStep.APPLYING);

    const selectedModel = availableModels[selectedModelIndex];
    if (!selectedModel) {
      setError('No model selected. Please go back and select a model.');
      setStep(SetupStep.MODEL);
      return;
    }

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
      temperature: 0.3,
      auto_confirm: false,
      enable_idle_messages: !isLaptop,
      enable_session_title_generation: !isLaptop,
      tool_call_activity_timeout: isLaptop ? 90 : 120,
    };

    try {
      await setupWizard.applySetupConfig(config);

      // Apply search configuration if user provided one
      if (selectedSearchProvider !== 'none' && searchApiKey) {
        const registry = ServiceRegistry.getInstance();
        const integrationStore = registry.get('integration_store') as IntegrationStore | null;
        if (integrationStore) {
          await integrationStore.setSearchProvider(selectedSearchProvider);
          await integrationStore.setSearchAPIKey(searchApiKey);
          logger.debug('[SetupWizardView] Search configuration saved:', selectedSearchProvider);
        }
      }

      // Apply MCP server configuration if user selected a preset
      if (mcpPresetKey) {
        const preset = MCP_PRESETS[mcpPresetKey];
        if (preset) {
          const path = preset.needsPath ? mcpInput : undefined;
          const envValue = preset.needsEnvKey ? mcpInput : undefined;
          const serverConfig = buildConfigFromPreset(preset, path, envValue);

          const registry = ServiceRegistry.getInstance();
          const mcpManager = registry.get('mcp_server_manager') as MCPServerManager | null;
          if (mcpManager) {
            await mcpManager.addServerConfig(mcpPresetKey, serverConfig);
            logger.debug(`[SetupWizardView] MCP server '${mcpPresetKey}' configured`);
          }
        }
      }

      // Apply custom MCP server configuration
      if (customName && customCommand) {
        const parts = customCommand.split(/\s+/);
        const serverConfig = {
          transport: 'stdio' as const,
          command: parts[0]!,
          args: parts.slice(1),
          enabled: true,
          requiresConfirmation: true,
          autoStart: true,
        };

        const registry = ServiceRegistry.getInstance();
        const mcpManager = registry.get('mcp_server_manager') as MCPServerManager | null;
        if (mcpManager) {
          await mcpManager.addServerConfig(customName, serverConfig);
          setSelectedMcpPresetKey(customName);
          logger.debug(`[SetupWizardView] Custom MCP server '${customName}' configured`);
        }
      }

      setStep(SetupStep.COMPLETED);
    } catch (error) {
      logger.error('[SetupWizardView] Failed to apply configuration:', error);
      setError('Failed to save configuration. Please try again.');
      setStep(SetupStep.MCP_PROMPT);
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
              <TextInput
                label="Endpoint:"
                value={endpointBuffer}
                onValueChange={setEndpointBuffer}
                cursorPosition={endpointCursor}
                onCursorChange={setEndpointCursor}
                onSubmit={handleEndpointSubmit}
                onEscape={() => process.exit(0)}
                onCtrlC={handleCtrlC}
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

        {/* Search Provider Prompt (Optional) */}
        {step === SetupStep.SEARCH_PROMPT && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                Optional: Web Search
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Would you like to configure a web search provider?
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text dimColor>
                This enables the research agent to search the web for information.
              </Text>
            </Box>
            <Box flexDirection="column" marginBottom={1}>
              <Box>
                <SelectionIndicator isSelected={searchPromptIndex === 0}>
                  Yes, configure search
                </SelectionIndicator>
              </Box>
              <Box>
                <SelectionIndicator isSelected={searchPromptIndex === 1}>
                  Skip for now
                </SelectionIndicator>
                <Text dimColor> - Can be configured later via /config</Text>
              </Box>
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Use ↑↓ to select, Enter to confirm</Text>
            </Box>
          </>
        )}

        {/* Search Provider Selection */}
        {step === SetupStep.SEARCH_PROVIDER && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                Select Search Provider
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Choose a search provider (requires API key):
              </Text>
            </Box>
            <Box flexDirection="column" marginBottom={1}>
              {searchProviderOptions.map((provider, idx) => (
                <Box key={provider.key} flexDirection="column">
                  <Box>
                    <SelectionIndicator isSelected={idx === searchProviderIndex}>
                      {provider.displayName}
                    </SelectionIndicator>
                  </Box>
                  {idx === searchProviderIndex && (
                    <Box paddingLeft={4}>
                      <Text dimColor>{provider.description}</Text>
                    </Box>
                  )}
                  {idx === searchProviderIndex && provider.signupURL && (
                    <Box paddingLeft={4}>
                      <Text dimColor>Get API key: {provider.signupURL}</Text>
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Use ↑↓ to select, Enter to confirm</Text>
            </Box>
          </>
        )}

        {/* Search API Key Input */}
        {step === SetupStep.SEARCH_API_KEY && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                Enter API Key
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Enter your {SEARCH_PROVIDER_INFO[selectedSearchProvider]?.displayName || selectedSearchProvider} API key:
              </Text>
            </Box>
            {SEARCH_PROVIDER_INFO[selectedSearchProvider]?.signupURL && (
              <Box marginBottom={1}>
                <Text dimColor>
                  Get one at: {SEARCH_PROVIDER_INFO[selectedSearchProvider].signupURL}
                </Text>
              </Box>
            )}
            {error && (
              <Box marginBottom={1}>
                <Text color={UI_COLORS.ERROR}>{error}</Text>
              </Box>
            )}
            <Box marginBottom={1}>
              <TextInput
                label="API Key:"
                value={searchApiKeyBuffer}
                onValueChange={setSearchApiKeyBuffer}
                cursorPosition={searchApiKeyCursor}
                onCursorChange={setSearchApiKeyCursor}
                onSubmit={handleSearchApiKeySubmit}
                onEscape={() => {
                  // Skip search API key on ESC — continue to MCP prompt
                  setError(null);
                  setStep(SetupStep.MCP_PROMPT);
                }}
                onCtrlC={handleCtrlC}
                isActive={true}
                multiline={false}
                placeholder="Enter your API key..."
              />
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Press Enter to save, ESC to skip search configuration</Text>
            </Box>
          </>
        )}

        {/* MCP Server Prompt (Optional) */}
        {step === SetupStep.MCP_PROMPT && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                Optional: MCP Server
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Would you like to connect an MCP (Model Context Protocol) server?
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text dimColor>
                MCP servers extend the assistant with external tools beyond its built-in capabilities — GitHub integration, databases, custom APIs, and more.
              </Text>
            </Box>
            <Box flexDirection="column" marginBottom={1}>
              <Box>
                <SelectionIndicator isSelected={mcpPromptIndex === 0}>
                  Yes, configure a server
                </SelectionIndicator>
              </Box>
              <Box>
                <SelectionIndicator isSelected={mcpPromptIndex === 1}>
                  Skip for now
                </SelectionIndicator>
                <Text dimColor> - Can be configured later via /mcp add</Text>
              </Box>
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Use ↑↓ to select, Enter to confirm</Text>
            </Box>
          </>
        )}

        {/* MCP Server Selection */}
        {step === SetupStep.MCP_SERVER_SELECT && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                Select MCP Server
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Choose a server to configure:
              </Text>
            </Box>
            <Box flexDirection="column" marginBottom={1}>
              {mcpOptions.map((option, idx) => (
                <Box key={option.key} flexDirection="column">
                  <Box>
                    <SelectionIndicator isSelected={idx === mcpPresetIndex}>
                      {option.preset ? option.preset.displayName : 'Custom'}
                    </SelectionIndicator>
                  </Box>
                  {idx === mcpPresetIndex && (
                    <Box paddingLeft={4}>
                      <Text dimColor>
                        {option.preset ? option.preset.description : 'Connect to your own MCP server'}
                      </Text>
                    </Box>
                  )}
                </Box>
              ))}
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Use ↑↓ to select, Enter to confirm</Text>
            </Box>
          </>
        )}

        {/* MCP Server Input (path or env var) */}
        {step === SetupStep.MCP_SERVER_INPUT && (() => {
          const preset = MCP_PRESETS[selectedMcpPresetKey];
          const label = preset?.needsPath ? 'Directory:' : 'API Key:';
          const hint = preset?.needsPath ? (preset.pathHint || '/path/to/directory') : (preset?.envHint || 'Enter value...');
          return (
            <>
              <Box marginBottom={1} flexDirection="row" gap={1}>
                <Text bold>
                  <ChickAnimation />
                </Text>
                <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                  Configure {preset?.displayName || selectedMcpPresetKey}
                </Text>
              </Box>
              <Box marginBottom={1}>
                <Text>
                  {preset?.needsPath
                    ? 'Enter the directory path this server should have access to:'
                    : `Enter your ${preset?.needsEnvKey || 'API key'}:`}
                </Text>
              </Box>
              {error && (
                <Box marginBottom={1}>
                  <Text color={UI_COLORS.ERROR}>{error}</Text>
                </Box>
              )}
              <Box marginBottom={1}>
                <TextInput
                  label={label}
                  value={mcpInputBuffer}
                  onValueChange={setMcpInputBuffer}
                  cursorPosition={mcpInputCursor}
                  onCursorChange={setMcpInputCursor}
                  onSubmit={handleMcpInputSubmit}
                  onEscape={() => {
                    setError(null);
                    applyAllConfiguration();
                  }}
                  onCtrlC={handleCtrlC}
                  isActive={true}
                  multiline={false}
                  placeholder={hint}
                />
              </Box>
              <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
                <Text dimColor>Press Enter to save, ESC to skip MCP configuration</Text>
              </Box>
            </>
          );
        })()}

        {/* MCP Custom Server Name */}
        {step === SetupStep.MCP_CUSTOM_NAME && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                Custom MCP Server
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Enter a name for this server (e.g., my-tools, database):
              </Text>
            </Box>
            {error && (
              <Box marginBottom={1}>
                <Text color={UI_COLORS.ERROR}>{error}</Text>
              </Box>
            )}
            <Box marginBottom={1}>
              <TextInput
                label="Name:"
                value={mcpCustomNameBuffer}
                onValueChange={setMcpCustomNameBuffer}
                cursorPosition={mcpCustomNameCursor}
                onCursorChange={setMcpCustomNameCursor}
                onSubmit={handleMcpCustomNameSubmit}
                onEscape={() => {
                  setError(null);
                  applyAllConfiguration();
                }}
                onCtrlC={handleCtrlC}
                isActive={true}
                multiline={false}
                placeholder="my-server"
              />
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Press Enter to continue, ESC to skip MCP configuration</Text>
            </Box>
          </>
        )}

        {/* MCP Custom Server Command */}
        {step === SetupStep.MCP_CUSTOM_COMMAND && (
          <>
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                Custom MCP Server: {mcpCustomName}
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                Enter the command to start this server:
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text dimColor>
                Example: npx -y @modelcontextprotocol/server-everything
              </Text>
            </Box>
            {error && (
              <Box marginBottom={1}>
                <Text color={UI_COLORS.ERROR}>{error}</Text>
              </Box>
            )}
            <Box marginBottom={1}>
              <TextInput
                label="Command:"
                value={mcpCustomCommandBuffer}
                onValueChange={setMcpCustomCommandBuffer}
                cursorPosition={mcpCustomCommandCursor}
                onCursorChange={setMcpCustomCommandCursor}
                onSubmit={handleMcpCustomCommandSubmit}
                onEscape={() => {
                  setError(null);
                  applyAllConfiguration();
                }}
                onCtrlC={handleCtrlC}
                isActive={true}
                multiline={false}
                placeholder="npx -y @scope/server-name"
              />
            </Box>
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Press Enter to save, ESC to skip MCP configuration</Text>
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
              {selectedSearchProvider !== 'none' && (
                <Text dimColor>• Search: {SEARCH_PROVIDER_INFO[selectedSearchProvider]?.displayName || selectedSearchProvider}</Text>
              )}
              {selectedMcpPresetKey && (
                <Text dimColor>• MCP: {MCP_PRESETS[selectedMcpPresetKey]?.displayName || selectedMcpPresetKey}</Text>
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
