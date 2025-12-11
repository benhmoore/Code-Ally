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
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { AgentGenerationService } from '@services/AgentGenerationService.js';
import { ModalContainer } from './ModalContainer.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { TextInput } from './TextInput.js';
import { UI_COLORS } from '../constants/colors.js';

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
  const [error, setError] = useState<string | null>(null);

  // Track whether user is in navigation mode (vs typing mode)
  const [inNavigationMode, setInNavigationMode] = useState(false);
  // Navigation index: 0=Continue, 1=Back
  const [actionIndex, setActionIndex] = useState(0); // Default to Continue
  const [confirmIndex, setConfirmIndex] = useState(0); // 0=Create, 1=Back

  // Text input buffers and cursors for each field
  const [descriptionBuffer, setDescriptionBuffer] = useState(initialDescription || '');
  const [descriptionCursor, setDescriptionCursor] = useState((initialDescription || '').length);
  const [promptBuffer, setPromptBuffer] = useState('');
  const [promptCursor, setPromptCursor] = useState(0);
  const [descRefinementBuffer, setDescRefinementBuffer] = useState('');
  const [descRefinementCursor, setDescRefinementCursor] = useState(0);
  const [nameBuffer, setNameBuffer] = useState('');
  const [nameCursor, setNameCursor] = useState(0);

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
      if (!descriptionBuffer.trim()) {
        setError('Description cannot be empty');
        return;
      }
      setInNavigationMode(false);
      setActionIndex(0);
      generateAgentConfig();
    } else if (step === ConfigStep.CUSTOMIZE_PROMPT) {
      setCustomPromptLines(promptBuffer.split('\n'));
      setDescRefinementBuffer(customDescription);
      setDescRefinementCursor(customDescription.length);
      setInNavigationMode(false);
      setActionIndex(0);
      setStep(ConfigStep.CUSTOMIZE_DESCRIPTION);
    } else if (step === ConfigStep.CUSTOMIZE_DESCRIPTION) {
      if (!descRefinementBuffer.trim()) {
        setError('Description cannot be empty');
        return;
      }
      setCustomDescription(descRefinementBuffer.trim());
      setNameBuffer(customName);
      setNameCursor(customName.length);
      setInNavigationMode(false);
      setActionIndex(0);
      setStep(ConfigStep.CUSTOMIZE_NAME);
    } else if (step === ConfigStep.CUSTOMIZE_NAME) {
      const name = nameBuffer.trim();
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

    // Restore appropriate buffer state for the previous step
    switch (prevStep) {
      case ConfigStep.DESCRIPTION:
        // Keep current description buffer
        break;
      case ConfigStep.CUSTOMIZE_PROMPT:
        setPromptBuffer(customPromptLines.join('\n'));
        setPromptCursor(customPromptLines.join('\n').length);
        break;
      case ConfigStep.CUSTOMIZE_DESCRIPTION:
        setDescRefinementBuffer(customDescription);
        setDescRefinementCursor(customDescription.length);
        break;
      case ConfigStep.CUSTOMIZE_NAME:
        setNameBuffer(customName);
        setNameCursor(customName.length);
        break;
      default:
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

      const { testModelCapabilities } = await import('@llm/ModelValidation.js');
      const result = await testModelCapabilities(endpoint, modelName);

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

      const result = await agentGenerationService.generateAgent(descriptionBuffer);

      // Initialize values with generated values (user can customize them next)
      setCustomName(result.name);
      setCustomDescription(result.description);
      setCustomPromptLines(result.systemPrompt.split('\n'));
      setPromptBuffer(result.systemPrompt);
      setPromptCursor(result.systemPrompt.length);

      // Move to customization
      setStep(ConfigStep.CUSTOMIZE_PROMPT);
    } catch (err) {
      setError(`Failed to generate agent: ${err instanceof Error ? err.message : String(err)}`);
      setStep(ConfigStep.DESCRIPTION); // Go back to description
    }
  };

  // Steps where TextInput is active (handles its own Ctrl+C)
  const isTextInputStep = step === ConfigStep.DESCRIPTION ||
                          step === ConfigStep.CUSTOMIZE_PROMPT ||
                          step === ConfigStep.CUSTOMIZE_DESCRIPTION ||
                          step === ConfigStep.CUSTOMIZE_NAME;

  // Handle cancel from TextInput's onCtrlC (empty buffer)
  const handleCtrlC = () => {
    onCancel();
  };

  // Handle keyboard input
  useInput((input, key) => {
    // ESC - always cancel
    if (key.escape) {
      onCancel();
      return;
    }

    // Ctrl+C - only handle for non-TextInput steps or when in navigation mode
    if (key.ctrl && input === 'c' && (!isTextInputStep || inNavigationMode)) {
      onCancel();
      return;
    }

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
      if (key.return || key.downArrow) {
        // Enter or Down arrow switches to navigation mode
        setInNavigationMode(true);
        setActionIndex(0); // Default to Continue
      }
    } else if (step === ConfigStep.CUSTOMIZE_PROMPT && !inNavigationMode) {
      if (key.return || key.tab) {
        // Enter or Tab switches to navigation mode
        setInNavigationMode(true);
        setActionIndex(0);
      }
    } else if (step === ConfigStep.CUSTOMIZE_DESCRIPTION && !inNavigationMode) {
      if (key.return || key.downArrow) {
        // Enter or Down arrow switches to navigation mode
        setInNavigationMode(true);
        setActionIndex(0);
      }
    } else if (step === ConfigStep.CUSTOMIZE_NAME && !inNavigationMode) {
      if (key.return || key.downArrow) {
        // Enter or Down arrow switches to navigation mode
        setInNavigationMode(true);
        setActionIndex(0);
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
      <ModalContainer borderColor={UI_COLORS.TEXT_DIM}>
        <Box flexDirection="column" width="100%">
        <Box marginBottom={1}>
          <Text color={UI_COLORS.TEXT_DEFAULT} bold>
            Create Agent
          </Text>
        </Box>

        {step === ConfigStep.DESCRIPTION && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <TextInput
                label={`Detailed Description (${descriptionBuffer.length} chars):`}
                labelColor="gray"
                value={descriptionBuffer}
                onValueChange={setDescriptionBuffer}
                cursorPosition={descriptionCursor}
                onCursorChange={setDescriptionCursor}
                onSubmit={handleContinue}
                onEscape={onCancel}
                onCtrlC={handleCtrlC}
                isActive={!inNavigationMode}
                multiline={true}
                placeholder="Describe your agent in detail..."
              />
            </Box>

            {/* Always show navigation options */}
            <Box marginTop={1} flexDirection="column">
              {!inNavigationMode && (
                <Text dimColor>Shift+Enter for newline • ↓ or Enter to navigate</Text>
              )}
              {inNavigationMode && <Text dimColor>Select an option:</Text>}
              <Box marginTop={1} marginLeft={2} flexDirection="column">
                <Box>
                  <SelectionIndicator isSelected={inNavigationMode && actionIndex === 0}>
                    <Text color={inNavigationMode && actionIndex === 0 ? 'green' : 'gray'}>Continue</Text>
                  </SelectionIndicator>
                </Box>
                {getPreviousStep(step) !== null && (
                  <Box marginTop={0.5}>
                    <SelectionIndicator isSelected={inNavigationMode && actionIndex === 1}>
                      <Text color={inNavigationMode && actionIndex === 1 ? 'green' : 'gray'}>Back</Text>
                    </SelectionIndicator>
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
                <Text color={UI_COLORS.ERROR}>{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.GENERATING && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <Text color={UI_COLORS.PRIMARY}>Generating agent configuration...</Text>
            </Box>
            <Text dimColor>Ally is creating name, description, and system prompt</Text>
            {error && (
              <Box marginTop={1}>
                <Text color={UI_COLORS.ERROR}>{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.CUSTOMIZE_PROMPT && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <TextInput
                label={`Customize System Prompt (${promptBuffer.length} chars):`}
                labelColor="gray"
                value={promptBuffer}
                onValueChange={setPromptBuffer}
                cursorPosition={promptCursor}
                onCursorChange={setPromptCursor}
                onSubmit={handleContinue}
                onEscape={onCancel}
                onCtrlC={handleCtrlC}
                isActive={!inNavigationMode}
                multiline={true}
                placeholder="System prompt..."
              />
            </Box>

            {/* Always show navigation options */}
            <Box marginTop={1} flexDirection="column">
              {!inNavigationMode && (
                <Text dimColor>↑↓ to scroll, Shift+Enter for newline • Tab or Enter to navigate</Text>
              )}
              {inNavigationMode && <Text dimColor>Select an option:</Text>}
              <Box marginTop={1} marginLeft={2} flexDirection="column">
                <Box>
                  <SelectionIndicator isSelected={inNavigationMode && actionIndex === 0}>
                    <Text color={inNavigationMode && actionIndex === 0 ? 'green' : 'gray'}>Continue</Text>
                  </SelectionIndicator>
                </Box>
                {getPreviousStep(step) !== null && (
                  <Box marginTop={0.5}>
                    <SelectionIndicator isSelected={inNavigationMode && actionIndex === 1}>
                      <Text color={inNavigationMode && actionIndex === 1 ? 'green' : 'gray'}>Back</Text>
                    </SelectionIndicator>
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
                <Text color={UI_COLORS.ERROR}>{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.CUSTOMIZE_DESCRIPTION && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <TextInput
                label="Customize Description:"
                labelColor="gray"
                value={descRefinementBuffer}
                onValueChange={setDescRefinementBuffer}
                cursorPosition={descRefinementCursor}
                onCursorChange={setDescRefinementCursor}
                onSubmit={handleContinue}
                onEscape={onCancel}
                onCtrlC={handleCtrlC}
                isActive={!inNavigationMode}
                multiline={false}
                placeholder="Brief description shown in listings"
              />
            </Box>

            {/* Always show navigation options */}
            <Box marginTop={1} flexDirection="column">
              {!inNavigationMode && (
                <Text dimColor>Brief description shown in listings • ↓ or Enter to navigate</Text>
              )}
              {inNavigationMode && <Text dimColor>Select an option:</Text>}
              <Box marginTop={1} marginLeft={2} flexDirection="column">
                <Box>
                  <SelectionIndicator isSelected={inNavigationMode && actionIndex === 0}>
                    <Text color={inNavigationMode && actionIndex === 0 ? 'green' : 'gray'}>Continue</Text>
                  </SelectionIndicator>
                </Box>
                {getPreviousStep(step) !== null && (
                  <Box marginTop={0.5}>
                    <SelectionIndicator isSelected={inNavigationMode && actionIndex === 1}>
                      <Text color={inNavigationMode && actionIndex === 1 ? 'green' : 'gray'}>Back</Text>
                    </SelectionIndicator>
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
                <Text color={UI_COLORS.ERROR}>{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.CUSTOMIZE_NAME && (
          <Box flexDirection="column">
            <Box marginBottom={1}>
              <TextInput
                label="Customize Name:"
                labelColor="gray"
                value={nameBuffer}
                onValueChange={setNameBuffer}
                cursorPosition={nameCursor}
                onCursorChange={setNameCursor}
                onSubmit={handleContinue}
                onEscape={onCancel}
                onCtrlC={handleCtrlC}
                isActive={!inNavigationMode}
                multiline={false}
                placeholder="agent-name"
              />
            </Box>

            {/* Always show navigation options */}
            <Box marginTop={1} flexDirection="column">
              {!inNavigationMode && (
                <Text dimColor>Use lowercase, numbers, hyphens (e.g., code-reviewer) • ↓ or Enter to navigate</Text>
              )}
              {inNavigationMode && <Text dimColor>Select an option:</Text>}
              <Box marginTop={1} marginLeft={2} flexDirection="column">
                <Box>
                  <SelectionIndicator isSelected={inNavigationMode && actionIndex === 0}>
                    <Text color={inNavigationMode && actionIndex === 0 ? 'green' : 'gray'}>Continue</Text>
                  </SelectionIndicator>
                </Box>
                {getPreviousStep(step) !== null && (
                  <Box marginTop={0.5}>
                    <SelectionIndicator isSelected={inNavigationMode && actionIndex === 1}>
                      <Text color={inNavigationMode && actionIndex === 1 ? 'green' : 'gray'}>Back</Text>
                    </SelectionIndicator>
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
                <Text color={UI_COLORS.ERROR}>{error}</Text>
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
                  <SelectionIndicator isSelected={modelChoiceIndex === 0}>
                    Yes, customize model
                  </SelectionIndicator>
                </Box>
                <Box marginTop={0.5}>
                  <SelectionIndicator isSelected={modelChoiceIndex === 1}>
                    No, use global default
                  </SelectionIndicator>
                </Box>
                <Box marginTop={0.5}>
                  <SelectionIndicator isSelected={modelChoiceIndex === 2}>
                    Back
                  </SelectionIndicator>
                </Box>
              </Box>
              <Box marginTop={1}>
                <Text dimColor>↑↓ navigate • Enter select</Text>
              </Box>
            </Box>
            {error && (
              <Box marginTop={1}>
                <Text color={UI_COLORS.ERROR}>{error}</Text>
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
                  <Box key={model.name}>
                    <SelectionIndicator isSelected={isSelected}>
                      {model.name}
                      {model.size && <Text dimColor> - {model.size}</Text>}
                    </SelectionIndicator>
                  </Box>
                );
              })}
              <Box marginTop={0.5}>
                <SelectionIndicator isSelected={modelIndex === availableModels.length}>
                  Back
                </SelectionIndicator>
              </Box>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>↑↓ navigate • Enter select</Text>
            </Box>
            {error && (
              <Box marginTop={1}>
                <Text color={UI_COLORS.ERROR}>{error}</Text>
              </Box>
            )}
          </Box>
        )}

        {step === ConfigStep.MODEL_VALIDATING && (
          <Box flexDirection="column">
            <Text color={UI_COLORS.PRIMARY}>Validating model capabilities...</Text>
            <Box marginTop={1}>
              <Text dimColor>Testing tool-calling support for {selectedModel}</Text>
            </Box>
            {error && (
              <Box marginTop={1}>
                <Text color={UI_COLORS.ERROR}>{error}</Text>
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
              <SelectionIndicator isSelected={toolSelectionIndex === 0}>
                All tools - Full access to all available tools
              </SelectionIndicator>
              <SelectionIndicator isSelected={toolSelectionIndex === 1}>
                Read-only - Limited to file reading and analysis
              </SelectionIndicator>
              <SelectionIndicator isSelected={toolSelectionIndex === 2}>
                Custom - Choose specific tools
              </SelectionIndicator>
              <Box marginTop={0.5}>
                <SelectionIndicator isSelected={toolSelectionIndex === 3}>
                  Back
                </SelectionIndicator>
              </Box>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>↑↓ navigate • Enter select</Text>
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
                  <Box key={tool}>
                    <SelectionIndicator isSelected={isCursor}>
                      {isSelected ? '[x]' : '[ ]'} {tool}
                    </SelectionIndicator>
                  </Box>
                );
              })}
              <Box marginTop={0.5}>
                <SelectionIndicator isSelected={customToolIndex === availableTools.length}>
                  Back
                </SelectionIndicator>
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
                <Text color={UI_COLORS.TEXT_DEFAULT}>{customName}</Text>
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
                <Text color={UI_COLORS.PRIMARY}>
                  Note: {selectedModel} only supports generation (no tool calling)
                </Text>
              </Box>
            )}
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Select an option:</Text>
              <Box marginTop={1} marginLeft={2} flexDirection="column">
                <Box>
                  <SelectionIndicator isSelected={confirmIndex === 0}>
                    Create Agent
                  </SelectionIndicator>
                </Box>
                <Box marginTop={0.5}>
                  <SelectionIndicator isSelected={confirmIndex === 1}>
                    Back
                  </SelectionIndicator>
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
      </ModalContainer>
    </Box>
  );
};
