/**
 * AgentWizardView - Interactive agent creation form with LLM assistance
 *
 * New flow:
 * 1. User provides detailed description
 * 2. LLM generates name, concise description, and system prompt
 * 3. User can customize each field
 * 4. Confirm and create
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import type { AgentGenerationService } from '../../services/AgentGenerationService.js';

enum ConfigStep {
  DESCRIPTION,
  GENERATING,
  CUSTOMIZE_PROMPT,
  CUSTOMIZE_DESCRIPTION,
  CUSTOMIZE_NAME,
  MODEL_CHOICE,
  MODEL_SELECTION,
  MODEL_VALIDATING,
  TOOL_SELECTION,
  TOOL_SELECTION_CUSTOM,
  CONFIRM,
}

interface AgentWizardViewProps {
  initialDescription?: string;
  onComplete: (agentData: {
    name: string;
    description: string;
    systemPrompt: string;
    tools?: string[]; // undefined = all tools
    model?: string; // optional custom model
  }) => void;
  onCancel: () => void;
}

export const AgentWizardView: React.FC<AgentWizardViewProps> = ({
  initialDescription,
  onComplete,
  onCancel,
}) => {
  const [step, setStep] = useState<ConfigStep>(ConfigStep.DESCRIPTION);
  const [currentInput, setCurrentInput] = useState(initialDescription || '');
  const [error, setError] = useState<string | null>(null);

  // Track whether user is in navigation mode (vs typing mode)
  const [inNavigationMode, setInNavigationMode] = useState(false);
  // Navigation index: 0=Continue, 1=Back
  const [actionIndex, setActionIndex] = useState(0); // Default to Continue
  const [confirmIndex, setConfirmIndex] = useState(0); // 0=Create, 1=Back

  // Agent configuration values (populated from LLM generation, then customizable)
  const [customName, setCustomName] = useState('');
  const [customDescription, setCustomDescription] = useState('');
  const [customPromptLines, setCustomPromptLines] = useState<string[]>([]);
  const [selectedTools, setSelectedTools] = useState<string[] | undefined>(undefined); // undefined = all tools
  const [toolSelectionIndex, setToolSelectionIndex] = useState(0); // For arrow key navigation

  // Custom tool selection
  const [availableTools, setAvailableTools] = useState<string[]>([]);
  const [customToolsSelected, setCustomToolsSelected] = useState<Set<string>>(new Set());
  const [customToolIndex, setCustomToolIndex] = useState(0);

  // Model selection
  const [selectedModel, setSelectedModel] = useState<string | undefined>();
  const [availableModels, setAvailableModels] = useState<Array<{ name: string; size?: string }>>([]);
  const [modelIndex, setModelIndex] = useState(0);
  const [_modelSupportsTools, setModelSupportsTools] = useState(true);
  const [modelChoiceIndex, setModelChoiceIndex] = useState(0); // 0=Yes, 1=No, 2=Back

  // Scroll offset for viewing long prompts
  const [promptScrollOffset, setPromptScrollOffset] = useState(0);

  // Get the previous step for backward navigation
  const getPreviousStep = (currentStep: ConfigStep): ConfigStep | null => {
    switch (currentStep) {
      case ConfigStep.DESCRIPTION:
        return null; // First step, can't go back
      case ConfigStep.GENERATING:
        return null; // Can't interrupt generation
      case ConfigStep.CUSTOMIZE_PROMPT:
        return ConfigStep.DESCRIPTION;
      case ConfigStep.CUSTOMIZE_DESCRIPTION:
        return ConfigStep.CUSTOMIZE_PROMPT;
      case ConfigStep.CUSTOMIZE_NAME:
        return ConfigStep.CUSTOMIZE_DESCRIPTION;
      case ConfigStep.MODEL_CHOICE:
        return ConfigStep.CUSTOMIZE_NAME;
      case ConfigStep.MODEL_SELECTION:
        return ConfigStep.MODEL_CHOICE;
      case ConfigStep.MODEL_VALIDATING:
        return null; // Can't interrupt validation
      case ConfigStep.TOOL_SELECTION:
        return selectedModel ? ConfigStep.MODEL_SELECTION : ConfigStep.MODEL_CHOICE;
      case ConfigStep.TOOL_SELECTION_CUSTOM:
        return ConfigStep.TOOL_SELECTION;
      case ConfigStep.CONFIRM:
        // Go back to last configurable step
        if (selectedTools !== undefined && selectedTools.length > 0 && availableTools.length > 0) {
          return ConfigStep.TOOL_SELECTION_CUSTOM;
        } else if (_modelSupportsTools) {
          return ConfigStep.TOOL_SELECTION;
        } else if (selectedModel) {
          return ConfigStep.MODEL_SELECTION;
        } else {
          return ConfigStep.MODEL_CHOICE;
        }
      default:
        return null;
    }
  };

  // Handle continue action
  const handleContinue = () => {
    setError(null);

    if (step === ConfigStep.DESCRIPTION) {
      if (!currentInput.trim()) {
        setError('Description cannot be empty');
        return;
      }
      setInNavigationMode(false);
      setActionIndex(0);
      generateAgentConfig();
    } else if (step === ConfigStep.CUSTOMIZE_PROMPT) {
      setCustomPromptLines(currentInput.split('\n'));
      setCurrentInput(customDescription);
      setInNavigationMode(false);
      setActionIndex(0);
      setStep(ConfigStep.CUSTOMIZE_DESCRIPTION);
    } else if (step === ConfigStep.CUSTOMIZE_DESCRIPTION) {
      if (!currentInput.trim()) {
        setError('Description cannot be empty');
        return;
      }
      setCustomDescription(currentInput.trim());
      setCurrentInput(customName);
      setInNavigationMode(false);
      setActionIndex(0);
      setStep(ConfigStep.CUSTOMIZE_NAME);
    } else if (step === ConfigStep.CUSTOMIZE_NAME) {
      const name = currentInput.trim();
      if (!name) {
        setError('Agent name is required');
        return;
      }
      if (!/^[a-z0-9-]+$/.test(name)) {
        setError('Name must contain only lowercase letters, numbers, and hyphens');
        return;
      }
      setCustomName(name);
      setInNavigationMode(false);
      setActionIndex(0);
      setStep(ConfigStep.MODEL_CHOICE);
    }
  };

  // Handle backward navigation
  const goBack = () => {
    const prevStep = getPreviousStep(step);
    if (prevStep === null) return;

    setError(null);
    setInNavigationMode(false);
    setActionIndex(0);

    // Restore appropriate input state for the previous step
    switch (prevStep) {
      case ConfigStep.DESCRIPTION:
        setCurrentInput(currentInput); // Keep current description
        break;
      case ConfigStep.CUSTOMIZE_PROMPT:
        setCurrentInput(customPromptLines.join('\n'));
        setPromptScrollOffset(0);
        break;
      case ConfigStep.CUSTOMIZE_DESCRIPTION:
        setCurrentInput(customDescription);
        break;
      case ConfigStep.CUSTOMIZE_NAME:
        setCurrentInput(customName);
        break;
      default:
        setCurrentInput('');
        break;
    }

    setStep(prevStep);
  };

  // Load available tools for custom selection
  const loadAvailableTools = () => {
    const registry = ServiceRegistry.getInstance();
    const toolManager = registry.get<any>('tool_manager');
    if (toolManager) {
      const tools = toolManager.getAllTools();
      const toolNames = tools.map((t: any) => t.name).sort();
      setAvailableTools(toolNames);
      setCustomToolsSelected(new Set(toolNames)); // Start with all selected
      setCustomToolIndex(0);
    }
  };

  // Format bytes into human-readable size
  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  };

  // Fetch available models from Ollama
  const fetchModels = async () => {
    setError(null);
    try {
      const registry = ServiceRegistry.getInstance();
      const configManager = registry.get<any>('config_manager');
      const config = configManager?.getConfig();
      const endpoint = config?.endpoint || 'http://localhost:11434';

      const response = await fetch(`${endpoint}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = (await response.json()) as { models?: Array<{ name: string; size?: number }> };
      const models = (data.models || []).map((m) => ({
        name: m.name,
        size: m.size ? formatSize(m.size) : undefined,
      }));

      if (models.length === 0) {
        setError('No models available. Install models with: ollama pull <model>');
        setStep(ConfigStep.MODEL_CHOICE);
        return;
      }

      setAvailableModels(models);
      setModelIndex(0);
      setStep(ConfigStep.MODEL_SELECTION);
    } catch (err) {
      setError(`Failed to fetch models: ${err instanceof Error ? err.message : String(err)}`);
      setStep(ConfigStep.MODEL_CHOICE);
    }
  };

  // Validate model supports tool calling
  const validateModel = async (modelName: string) => {
    setStep(ConfigStep.MODEL_VALIDATING);
    setError(null);

    try {
      const registry = ServiceRegistry.getInstance();
      const configManager = registry.get<any>('config_manager');
      const config = configManager?.getConfig();
      const endpoint = config?.endpoint || 'http://localhost:11434';

      const { testModelToolCalling } = await import('../../llm/ModelValidation.js');
      const result = await testModelToolCalling(endpoint, modelName);

      setModelSupportsTools(result.supportsTools);

      if (!result.supportsTools) {
        // Model doesn't support tools - skip tool selection, set to no tools
        setSelectedTools([]);
        setStep(ConfigStep.CONFIRM);
      } else {
        // Model supports tools - show tool selection
        setStep(ConfigStep.TOOL_SELECTION);
      }
    } catch (err) {
      setError(`Validation failed: ${err instanceof Error ? err.message : String(err)}`);
      setStep(ConfigStep.MODEL_SELECTION);
    }
  };

  // Generate agent configuration using LLM
  const generateAgentConfig = async () => {
    setStep(ConfigStep.GENERATING);
    setError(null);

    try {
      const registry = ServiceRegistry.getInstance();
      const agentGenerationService = registry.get<AgentGenerationService>('agent_generation_service');

      if (!agentGenerationService) {
        throw new Error('Agent generation service not available');
      }

      const result = await agentGenerationService.generateAgent(currentInput);

      // Initialize values with generated values (user can customize them next)
      setCustomName(result.name);
      setCustomDescription(result.description);
      setCustomPromptLines(result.systemPrompt.split('\n'));
      setCurrentInput(result.systemPrompt);
      setPromptScrollOffset(0); // Reset scroll to top

      // Move to customization
      setStep(ConfigStep.CUSTOMIZE_PROMPT);
    } catch (err) {
      setError(`Failed to generate agent: ${err instanceof Error ? err.message : String(err)}`);
      setStep(ConfigStep.DESCRIPTION); // Go back to description
    }
  };

  // Handle keyboard input
  useInput((input, key) => {
    // ESC or Ctrl+C - cancel
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel();
      return;
    }

    // Handle text input steps (DESCRIPTION, CUSTOMIZE_PROMPT, CUSTOMIZE_DESCRIPTION, CUSTOMIZE_NAME)
    const isTextInputStep = step === ConfigStep.DESCRIPTION ||
                           step === ConfigStep.CUSTOMIZE_PROMPT ||
                           step === ConfigStep.CUSTOMIZE_DESCRIPTION ||
                           step === ConfigStep.CUSTOMIZE_NAME;

    if (isTextInputStep && inNavigationMode) {
      // In navigation mode, handle Continue/Back selection
      const hasBack = getPreviousStep(step) !== null;
      const maxIndex = hasBack ? 1 : 0; // 0=Continue, 1=Back (if available)

      if (key.upArrow) {
        setActionIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setActionIndex((prev) => Math.min(maxIndex, prev + 1));
        return;
      }
      if (key.return) {
        if (actionIndex === 0) {
          // Continue - validate and proceed
          handleContinue();
        } else {
          // Back - go to previous step
          goBack();
        }
        return;
      }
      // Escape - go back to typing mode
      if (key.escape) {
        setInNavigationMode(false);
        return;
      }
      // Any letter/number - go back to typing mode and process the key
      if (input && !key.ctrl && !key.meta) {
        setInNavigationMode(false);
        // Fall through to handle the input
      }
    }

    if (step === ConfigStep.DESCRIPTION && !inNavigationMode) {
      if (key.return && key.shift) {
        // Shift+Enter adds a newline
        setCurrentInput((prev) => prev + '\n');
        setError(null);
      } else if (key.return || key.downArrow) {
        // Enter or Down arrow switches to navigation mode
        setInNavigationMode(true);
        setActionIndex(0); // Default to Continue
      } else if (key.backspace || key.delete) {
        setCurrentInput((prev) => prev.slice(0, -1));
        setError(null);
      } else if (input && !key.ctrl && !key.meta) {
        setCurrentInput((prev) => prev + input);
        setError(null);
      }
    } else if (step === ConfigStep.CUSTOMIZE_PROMPT && !inNavigationMode) {
      if (key.upArrow) {
        // Scroll up
        setPromptScrollOffset((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        // Scroll down
        const lines = currentInput.split('\n');
        const maxOffset = Math.max(0, lines.length - 10); // Show 10 lines at a time
        setPromptScrollOffset((prev) => Math.min(maxOffset, prev + 1));
      } else if (key.return && key.shift) {
        // Shift+Enter adds a newline
        setCurrentInput((prev) => prev + '\n');
        setError(null);
      } else if (key.return || key.tab) {
        // Enter or Tab switches to navigation mode
        setInNavigationMode(true);
        setActionIndex(0);
      } else if (key.backspace || key.delete) {
        setCurrentInput((prev) => prev.slice(0, -1));
        setError(null);
      } else if (input && !key.ctrl && !key.meta) {
        setCurrentInput((prev) => prev + input);
        setError(null);
      }
    } else if (step === ConfigStep.CUSTOMIZE_DESCRIPTION && !inNavigationMode) {
      if (key.return || key.downArrow) {
        // Enter or Down arrow switches to navigation mode
        setInNavigationMode(true);
        setActionIndex(0);
      } else if (key.backspace || key.delete) {
        setCurrentInput((prev) => prev.slice(0, -1));
        setError(null);
      } else if (input && !key.ctrl && !key.meta) {
        setCurrentInput((prev) => prev + input);
        setError(null);
      }
    } else if (step === ConfigStep.CUSTOMIZE_NAME && !inNavigationMode) {
      if (key.return || key.downArrow) {
        // Enter or Down arrow switches to navigation mode
        setInNavigationMode(true);
        setActionIndex(0);
      } else if (key.backspace || key.delete) {
        setCurrentInput((prev) => prev.slice(0, -1));
        setError(null);
      } else if (input && !key.ctrl && !key.meta) {
        setCurrentInput((prev) => prev + input);
        setError(null);
      }
    } else if (step === ConfigStep.MODEL_CHOICE) {
      if (key.upArrow) {
        setModelChoiceIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setModelChoiceIndex((prev) => Math.min(2, prev + 1)); // 0=Yes, 1=No, 2=Back
      } else if (key.return) {
        if (modelChoiceIndex === 0) {
          // Yes - fetch models
          fetchModels();
        } else if (modelChoiceIndex === 1) {
          // No - skip to tool selection
          setSelectedModel(undefined);
          setModelSupportsTools(true);
          setToolSelectionIndex(0);
          setStep(ConfigStep.TOOL_SELECTION);
        } else {
          // Back
          goBack();
        }
      }
    } else if (step === ConfigStep.MODEL_SELECTION) {
      if (key.upArrow) {
        setModelIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        // availableModels.length models + 1 Back option
        setModelIndex((prev) => Math.min(availableModels.length, prev + 1));
      } else if (key.return) {
        if (modelIndex < availableModels.length) {
          // Selected a model
          const selected = availableModels[modelIndex];
          if (selected) {
            setSelectedModel(selected.name);
            validateModel(selected.name);
          }
        } else {
          // Selected Back
          goBack();
        }
      }
    } else if (step === ConfigStep.TOOL_SELECTION) {
      // Arrow key navigation
      if (key.upArrow) {
        setToolSelectionIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setToolSelectionIndex((prev) => Math.min(3, prev + 1)); // 4 options (0-3)
      } else if (key.return) {
        // Apply selection based on index
        if (toolSelectionIndex === 0) {
          setSelectedTools(undefined); // All tools
          setStep(ConfigStep.CONFIRM);
        } else if (toolSelectionIndex === 1) {
          setSelectedTools(['read', 'glob', 'grep', 'ls']); // Read-only
          setStep(ConfigStep.CONFIRM);
        } else if (toolSelectionIndex === 2) {
          // Go to custom tool selection
          loadAvailableTools();
          setStep(ConfigStep.TOOL_SELECTION_CUSTOM);
        } else if (toolSelectionIndex === 3) {
          // Back
          goBack();
        }
      } else if (input === '1') {
        // Also support direct number input
        setToolSelectionIndex(0);
        setSelectedTools(undefined);
        setStep(ConfigStep.CONFIRM);
      } else if (input === '2') {
        setToolSelectionIndex(1);
        setSelectedTools(['read', 'glob', 'grep', 'ls']);
        setStep(ConfigStep.CONFIRM);
      } else if (input === '3') {
        setToolSelectionIndex(2);
        loadAvailableTools();
        setStep(ConfigStep.TOOL_SELECTION_CUSTOM);
      }
    } else if (step === ConfigStep.TOOL_SELECTION_CUSTOM) {
      // Arrow key navigation
      if (key.upArrow) {
        setCustomToolIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        // availableTools + 1 for Back option
        setCustomToolIndex((prev) => Math.min(availableTools.length, prev + 1));
      } else if (input === ' ') {
        // Space toggles selection (only for tools, not for Back)
        if (customToolIndex < availableTools.length) {
          const toolName = availableTools[customToolIndex];
          if (toolName) {
            setCustomToolsSelected((prev) => {
              const newSet = new Set(prev);
              if (newSet.has(toolName)) {
                newSet.delete(toolName);
              } else {
                newSet.add(toolName);
              }
              return newSet;
            });
          }
        }
      } else if (key.return) {
        if (customToolIndex < availableTools.length) {
          // Confirm selection
          setSelectedTools(Array.from(customToolsSelected));
          setStep(ConfigStep.CONFIRM);
        } else {
          // Back
          goBack();
        }
      }
    } else if (step === ConfigStep.CONFIRM) {
      if (key.upArrow) {
        setConfirmIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setConfirmIndex((prev) => Math.min(1, prev + 1)); // 0=Create, 1=Back
      } else if (key.return) {
        if (confirmIndex === 0) {
          // Create agent
          onComplete({
            name: customName,
            description: customDescription,
            systemPrompt: customPromptLines.join('\n'),
            tools: selectedTools,
            model: selectedModel,
          });
        } else {
          // Back
          goBack();
        }
      }
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} flexDirection="column" width="100%">
        <Box marginBottom={1}>
          <Text color="cyan" bold>
            Create Agent
          </Text>
        </Box>

        {step === ConfigStep.DESCRIPTION && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text dimColor>Detailed Description ({currentInput.length} chars):</Text>
            </Box>
            <Box marginBottom={1} marginLeft={1} flexDirection="column">
              {currentInput.length === 0 && !inNavigationMode ? (
                <Box>
                  <Text color="green">&gt; </Text>
                  <Text color="gray">█</Text>
                </Box>
              ) : inNavigationMode ? (
                // Show read-only preview when in navigation mode
                currentInput.split('\n').slice(-5).map((line, i) => (
                  <Box key={i}>
                    <Text color="green">&gt; </Text>
                    <Text>{line}</Text>
                  </Box>
                ))
              ) : (
                // Show editable text with cursor
                currentInput.split('\n').slice(-5).map((line, i) => (
                  <Box key={i}>
                    <Text color="green">&gt; </Text>
                    <Text>{line}</Text>
                    {i === currentInput.split('\n').slice(-5).length - 1 && (
                      <Text color="gray">█</Text>
                    )}
                  </Box>
                ))
              )}
            </Box>

            {/* Always show navigation options */}
            <Box marginTop={1} flexDirection="column">
              {!inNavigationMode && (
                <Text dimColor>Shift+Enter for newline • ↓ or Enter to navigate</Text>
              )}
              {inNavigationMode && <Text dimColor>Select an option:</Text>}
              <Box marginTop={1} marginLeft={2} flexDirection="column">
                <Box>
                  <Text color={inNavigationMode && actionIndex === 0 ? 'green' : 'gray'} bold={inNavigationMode && actionIndex === 0}>
                    {inNavigationMode && actionIndex === 0 ? '> ' : '  '}Continue
                  </Text>
                </Box>
                {getPreviousStep(step) !== null && (
                  <Box marginTop={0.5}>
                    <Text color={inNavigationMode && actionIndex === 1 ? 'green' : 'gray'} bold={inNavigationMode && actionIndex === 1}>
                      {inNavigationMode && actionIndex === 1 ? '> ' : '  '}Back
                    </Text>
                  </Box>
                )}
              </Box>
              {inNavigationMode && (
                <Box marginTop={1}>
                  <Text dimColor>↑↓ navigate • Enter select • Esc or type to edit</Text>
                </Box>
              )}
            </Box>

            {error && (
              <Box marginTop={1}>
                <Text color="red">{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.GENERATING && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text color="yellow">Generating agent configuration...</Text>
            </Box>
            <Text dimColor>Ally is creating name, description, and system prompt</Text>
            {error && (
              <Box marginTop={1}>
                <Text color="red">{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.CUSTOMIZE_PROMPT && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text dimColor>Customize System Prompt ({currentInput.length} chars):</Text>
            </Box>
            <Box marginBottom={1} marginLeft={1} flexDirection="column">
              {(() => {
                const lines = currentInput.split('\n');
                const visibleLines = 10;
                const hasMoreAbove = promptScrollOffset > 0;
                const hasMoreBelow = promptScrollOffset + visibleLines < lines.length;
                const visibleSlice = lines.slice(promptScrollOffset, promptScrollOffset + visibleLines);

                return (
                  <>
                    {hasMoreAbove && (
                      <Text dimColor>↑ {promptScrollOffset} more line{promptScrollOffset === 1 ? '' : 's'} above</Text>
                    )}
                    {visibleSlice.map((line, i) => (
                      <Box key={i}>
                        <Text color="green">&gt; </Text>
                        <Text>{line}</Text>
                      </Box>
                    ))}
                    {!inNavigationMode && (
                      <Box>
                        <Text color="green">&gt; </Text>
                        <Text color="gray">█</Text>
                      </Box>
                    )}
                    {hasMoreBelow && (
                      <Text dimColor>↓ {lines.length - promptScrollOffset - visibleLines} more line{lines.length - promptScrollOffset - visibleLines === 1 ? '' : 's'} below</Text>
                    )}
                  </>
                );
              })()}
            </Box>

            {/* Always show navigation options */}
            <Box marginTop={1} flexDirection="column">
              {!inNavigationMode && (
                <Text dimColor>↑↓ to scroll, Shift+Enter for newline • Tab or Enter to navigate</Text>
              )}
              {inNavigationMode && <Text dimColor>Select an option:</Text>}
              <Box marginTop={1} marginLeft={2} flexDirection="column">
                <Box>
                  <Text color={inNavigationMode && actionIndex === 0 ? 'green' : 'gray'} bold={inNavigationMode && actionIndex === 0}>
                    {inNavigationMode && actionIndex === 0 ? '> ' : '  '}Continue
                  </Text>
                </Box>
                {getPreviousStep(step) !== null && (
                  <Box marginTop={0.5}>
                    <Text color={inNavigationMode && actionIndex === 1 ? 'green' : 'gray'} bold={inNavigationMode && actionIndex === 1}>
                      {inNavigationMode && actionIndex === 1 ? '> ' : '  '}Back
                    </Text>
                  </Box>
                )}
              </Box>
              {inNavigationMode && (
                <Box marginTop={1}>
                  <Text dimColor>↑↓ navigate • Enter select • Esc or type to edit</Text>
                </Box>
              )}
            </Box>

            {error && (
              <Box marginTop={1}>
                <Text color="red">{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.CUSTOMIZE_DESCRIPTION && (
          <Box flexDirection="column">
            <Text>
              <Text dimColor>Customize Description: </Text>
              <Text>{currentInput}</Text>
              {!inNavigationMode && <Text color="gray">█</Text>}
            </Text>

            {/* Always show navigation options */}
            <Box marginTop={1} flexDirection="column">
              {!inNavigationMode && (
                <Text dimColor>Brief description shown in listings • ↓ or Enter to navigate</Text>
              )}
              {inNavigationMode && <Text dimColor>Select an option:</Text>}
              <Box marginTop={1} marginLeft={2} flexDirection="column">
                <Box>
                  <Text color={inNavigationMode && actionIndex === 0 ? 'green' : 'gray'} bold={inNavigationMode && actionIndex === 0}>
                    {inNavigationMode && actionIndex === 0 ? '> ' : '  '}Continue
                  </Text>
                </Box>
                {getPreviousStep(step) !== null && (
                  <Box marginTop={0.5}>
                    <Text color={inNavigationMode && actionIndex === 1 ? 'green' : 'gray'} bold={inNavigationMode && actionIndex === 1}>
                      {inNavigationMode && actionIndex === 1 ? '> ' : '  '}Back
                    </Text>
                  </Box>
                )}
              </Box>
              {inNavigationMode && (
                <Box marginTop={1}>
                  <Text dimColor>↑↓ navigate • Enter select • Esc or type to edit</Text>
                </Box>
              )}
            </Box>

            {error && (
              <Box marginTop={1}>
                <Text color="red">{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.CUSTOMIZE_NAME && (
          <Box flexDirection="column">
            <Text>
              <Text dimColor>Customize Name: </Text>
              <Text>{currentInput}</Text>
              {!inNavigationMode && <Text color="gray">█</Text>}
            </Text>

            {/* Always show navigation options */}
            <Box marginTop={1} flexDirection="column">
              {!inNavigationMode && (
                <Text dimColor>Use lowercase, numbers, hyphens (e.g., code-reviewer) • ↓ or Enter to navigate</Text>
              )}
              {inNavigationMode && <Text dimColor>Select an option:</Text>}
              <Box marginTop={1} marginLeft={2} flexDirection="column">
                <Box>
                  <Text color={inNavigationMode && actionIndex === 0 ? 'green' : 'gray'} bold={inNavigationMode && actionIndex === 0}>
                    {inNavigationMode && actionIndex === 0 ? '> ' : '  '}Continue
                  </Text>
                </Box>
                {getPreviousStep(step) !== null && (
                  <Box marginTop={0.5}>
                    <Text color={inNavigationMode && actionIndex === 1 ? 'green' : 'gray'} bold={inNavigationMode && actionIndex === 1}>
                      {inNavigationMode && actionIndex === 1 ? '> ' : '  '}Back
                    </Text>
                  </Box>
                )}
              </Box>
              {inNavigationMode && (
                <Box marginTop={1}>
                  <Text dimColor>↑↓ navigate • Enter select • Esc or type to edit</Text>
                </Box>
              )}
            </Box>

            {error && (
              <Box marginTop={1}>
                <Text color="red">{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.MODEL_CHOICE && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text dimColor>Customize model for this agent?</Text>
            </Box>
            <Box marginBottom={1}>
              <Text dimColor>Default: Uses global model configuration</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Select an option:</Text>
              <Box marginTop={1} marginLeft={2} flexDirection="column">
                <Box>
                  <Text color={modelChoiceIndex === 0 ? 'green' : undefined} bold={modelChoiceIndex === 0}>
                    {modelChoiceIndex === 0 ? '> ' : '  '}Yes, customize model
                  </Text>
                </Box>
                <Box marginTop={0.5}>
                  <Text color={modelChoiceIndex === 1 ? 'green' : undefined} bold={modelChoiceIndex === 1}>
                    {modelChoiceIndex === 1 ? '> ' : '  '}No, use global default
                  </Text>
                </Box>
                <Box marginTop={0.5}>
                  <Text color={modelChoiceIndex === 2 ? 'green' : undefined} bold={modelChoiceIndex === 2}>
                    {modelChoiceIndex === 2 ? '> ' : '  '}Back
                  </Text>
                </Box>
              </Box>
              <Box marginTop={1}>
                <Text dimColor>↑↓ navigate • Enter select</Text>
              </Box>
            </Box>
            {error && (
              <Box marginTop={1}>
                <Text color="red">{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.MODEL_SELECTION && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text dimColor>Select Model</Text>
            </Box>
            <Box marginBottom={1} flexDirection="column">
              {availableModels.map((model, idx) => {
                const isSelected = idx === modelIndex;
                return (
                  <Text key={model.name} color={isSelected ? 'green' : undefined}>
                    {isSelected ? '> ' : '  '}
                    {model.name}
                    {model.size && <Text dimColor> - {model.size}</Text>}
                  </Text>
                );
              })}
              <Box marginTop={0.5}>
                <Text color={modelIndex === availableModels.length ? 'green' : undefined}>
                  {modelIndex === availableModels.length ? '> ' : '  '}Back
                </Text>
              </Box>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>↑↓ navigate • Enter select</Text>
            </Box>
            {error && (
              <Box marginTop={1}>
                <Text color="red">{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.MODEL_VALIDATING && (
          <Box flexDirection="column">
            <Text color="yellow">Validating model capabilities...</Text>
            <Box marginTop={1}>
              <Text dimColor>Testing tool-calling support for {selectedModel}</Text>
            </Box>
            {error && (
              <Box marginTop={1}>
                <Text color="red">{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.TOOL_SELECTION && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text dimColor>Tool Access Configuration</Text>
            </Box>
            <Box marginBottom={1}>
              <Text dimColor>Choose which tools this agent can use:</Text>
            </Box>
            <Box marginBottom={1} marginLeft={1} flexDirection="column">
              <Text color={toolSelectionIndex === 0 ? 'green' : undefined}>
                {toolSelectionIndex === 0 ? '▶ ' : '  '}
                <Text color="cyan">1</Text>. All tools - Full access to all available tools
              </Text>
              <Text color={toolSelectionIndex === 1 ? 'green' : undefined}>
                {toolSelectionIndex === 1 ? '▶ ' : '  '}
                <Text color="cyan">2</Text>. Read-only - Limited to file reading and analysis
              </Text>
              <Text color={toolSelectionIndex === 2 ? 'green' : undefined}>
                {toolSelectionIndex === 2 ? '▶ ' : '  '}
                <Text color="cyan">3</Text>. Custom - Choose specific tools
              </Text>
              <Box marginTop={0.5}>
                <Text color={toolSelectionIndex === 3 ? 'green' : undefined}>
                  {toolSelectionIndex === 3 ? '▶ ' : '  '}Back
                </Text>
              </Box>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>Use ↑↓ to navigate, Enter to select, or press 1/2/3</Text>
            </Box>
          </Box>
        )}

        {step === ConfigStep.TOOL_SELECTION_CUSTOM && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text dimColor>Select Tools ({customToolsSelected.size} selected)</Text>
            </Box>
            <Box marginBottom={1} flexDirection="column">
              {availableTools.map((tool, idx) => {
                const isSelected = customToolsSelected.has(tool);
                const isCursor = idx === customToolIndex;
                return (
                  <Text key={tool} color={isCursor ? 'green' : undefined}>
                    {isCursor ? '▶ ' : '  '}
                    {isSelected ? '[x]' : '[ ]'} {tool}
                  </Text>
                );
              })}
              <Box marginTop={0.5}>
                <Text color={customToolIndex === availableTools.length ? 'green' : undefined}>
                  {customToolIndex === availableTools.length ? '▶ ' : '  '}Back
                </Text>
              </Box>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>Use ↑↓ to navigate, Space to toggle, Enter to confirm/select</Text>
            </Box>
          </Box>
        )}

        {step === ConfigStep.CONFIRM && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text>
                <Text bold>Name: </Text>
                <Text color="cyan">{customName}</Text>
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                <Text bold>Description: </Text>
                <Text>{customDescription}</Text>
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                <Text bold>System Prompt: </Text>
                <Text dimColor>{customPromptLines.length} lines</Text>
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                <Text bold>Model: </Text>
                <Text dimColor>
                  {selectedModel || 'Global default'}
                </Text>
              </Text>
            </Box>
            <Box marginBottom={1}>
              <Text>
                <Text bold>Tools: </Text>
                <Text dimColor>
                  {selectedTools === undefined
                    ? 'All available tools'
                    : selectedTools.length === 0
                    ? 'No tools'
                    : `${selectedTools.length} tools (${selectedTools.join(', ')})`}
                </Text>
              </Text>
            </Box>
            {selectedModel && !_modelSupportsTools && (
              <Box marginBottom={1} marginLeft={2}>
                <Text color="yellow">
                  Note: {selectedModel} only supports generation (no tool calling)
                </Text>
              </Box>
            )}
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Select an option:</Text>
              <Box marginTop={1} marginLeft={2} flexDirection="column">
                <Box>
                  <Text color={confirmIndex === 0 ? 'green' : undefined} bold={confirmIndex === 0}>
                    {confirmIndex === 0 ? '> ' : '  '}Create Agent
                  </Text>
                </Box>
                <Box marginTop={0.5}>
                  <Text color={confirmIndex === 1 ? 'green' : undefined} bold={confirmIndex === 1}>
                    {confirmIndex === 1 ? '> ' : '  '}Back
                  </Text>
                </Box>
              </Box>
              <Box marginTop={1}>
                <Text dimColor>↑↓ navigate • Enter select</Text>
              </Box>
            </Box>
          </Box>
        )}

        {/* Footer */}
        <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
          <Text dimColor>Esc cancel</Text>
        </Box>
      </Box>
    </Box>
  );
};
