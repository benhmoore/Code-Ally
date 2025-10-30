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

  // Scroll offset for viewing long prompts
  const [promptScrollOffset, setPromptScrollOffset] = useState(0);

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

    if (step === ConfigStep.DESCRIPTION) {
      if (key.return && key.shift) {
        // Shift+Enter adds a newline
        setCurrentInput((prev) => prev + '\n');
        setError(null);
      } else if (key.return) {
        // Enter submits
        if (!currentInput.trim()) {
          setError('Description cannot be empty');
          return;
        }
        setError(null);
        generateAgentConfig();
      } else if (key.backspace || key.delete) {
        setCurrentInput((prev) => prev.slice(0, -1));
        setError(null);
      } else if (input && !key.ctrl && !key.meta) {
        setCurrentInput((prev) => prev + input);
        setError(null);
      }
    } else if (step === ConfigStep.CUSTOMIZE_PROMPT) {
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
      } else if (key.return) {
        // Enter submits
        setCustomPromptLines(currentInput.split('\n'));
        setCurrentInput(customDescription);
        setStep(ConfigStep.CUSTOMIZE_DESCRIPTION);
      } else if (key.backspace || key.delete) {
        setCurrentInput((prev) => prev.slice(0, -1));
        setError(null);
      } else if (input && !key.ctrl && !key.meta) {
        setCurrentInput((prev) => prev + input);
        setError(null);
      }
    } else if (step === ConfigStep.CUSTOMIZE_DESCRIPTION) {
      if (key.return) {
        if (!currentInput.trim()) {
          setError('Description cannot be empty');
          return;
        }
        setError(null);
        setCustomDescription(currentInput.trim());
        setCurrentInput(customName);
        setStep(ConfigStep.CUSTOMIZE_NAME);
      } else if (key.backspace || key.delete) {
        setCurrentInput((prev) => prev.slice(0, -1));
        setError(null);
      } else if (input && !key.ctrl && !key.meta) {
        setCurrentInput((prev) => prev + input);
        setError(null);
      }
    } else if (step === ConfigStep.CUSTOMIZE_NAME) {
      if (key.return) {
        const name = currentInput.trim();
        if (!name) {
          setError('Agent name is required');
          return;
        }
        // Validate name: lowercase, hyphens, numbers only
        if (!/^[a-z0-9-]+$/.test(name)) {
          setError('Name must contain only lowercase letters, numbers, and hyphens');
          return;
        }
        setError(null);
        setCustomName(name);
        setToolSelectionIndex(0); // Reset to first option
        setStep(ConfigStep.TOOL_SELECTION);
      } else if (key.backspace || key.delete) {
        setCurrentInput((prev) => prev.slice(0, -1));
        setError(null);
      } else if (input && !key.ctrl && !key.meta) {
        setCurrentInput((prev) => prev + input);
        setError(null);
      }
    } else if (step === ConfigStep.TOOL_SELECTION) {
      // Arrow key navigation
      if (key.upArrow) {
        setToolSelectionIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setToolSelectionIndex((prev) => Math.min(2, prev + 1)); // 3 options (0-2)
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
        setCustomToolIndex((prev) => Math.min(availableTools.length - 1, prev + 1));
      } else if (input === ' ') {
        // Space toggles selection
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
      } else if (key.return) {
        // Confirm selection
        setSelectedTools(Array.from(customToolsSelected));
        setStep(ConfigStep.CONFIRM);
      }
    } else if (step === ConfigStep.CONFIRM) {
      if (input === 'y' || input === 'Y') {
        onComplete({
          name: customName,
          description: customDescription,
          systemPrompt: customPromptLines.join('\n'),
          tools: selectedTools, // undefined = all tools
        });
      } else if (input === 'n' || input === 'N') {
        onCancel();
      }
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} flexDirection="column">
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
              {currentInput.split('\n').slice(-5).map((line, i) => (
                <Box key={i}>
                  <Text color="green">&gt; </Text>
                  <Text>{line}</Text>
                </Box>
              ))}
              <Box>
                <Text color="green">&gt; </Text>
                <Text color="gray">█</Text>
              </Box>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>Shift+Enter for newline, Enter to continue</Text>
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
                    <Box>
                      <Text color="green">&gt; </Text>
                      <Text color="gray">█</Text>
                    </Box>
                    {hasMoreBelow && (
                      <Text dimColor>↓ {lines.length - promptScrollOffset - visibleLines} more line{lines.length - promptScrollOffset - visibleLines === 1 ? '' : 's'} below</Text>
                    )}
                  </>
                );
              })()}
            </Box>
            <Box marginTop={1}>
              <Text dimColor>↑↓ to scroll, Shift+Enter for newline, Enter to continue</Text>
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
              <Text color="gray">█</Text>
            </Text>
            <Box marginTop={1}>
              <Text dimColor>Brief description shown in listings</Text>
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
              <Text color="gray">█</Text>
            </Text>
            <Box marginTop={1}>
              <Text dimColor>Use lowercase, numbers, hyphens (e.g., code-reviewer)</Text>
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
            </Box>
            <Box marginTop={1}>
              <Text dimColor>Use ↑↓ to navigate, Space to toggle, Enter to confirm</Text>
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
            <Box marginTop={1}>
              <Text>
                Create agent? <Text color="green" bold>
                  Y
                </Text>/<Text color="red" bold>
                  N
                </Text>
              </Text>
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
