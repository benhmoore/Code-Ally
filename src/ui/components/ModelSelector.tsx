/**
 * ModelSelector - Interactive model selection prompt
 *
 * Shows available Ollama models with keyboard navigation
 */

import React from 'react';
import { Box, Text } from 'ink';

export interface ModelOption {
  name: string;
  size?: string;
  modified?: string;
}

export interface ModelSelectorProps {
  /** Available models */
  models: ModelOption[];
  /** Currently selected model index */
  selectedIndex: number;
  /** Current model name */
  currentModel?: string;
  /** Display name for model type (e.g., "ally model", "service model") */
  typeName?: string;
  /** Whether the prompt is visible */
  visible?: boolean;
}

/**
 * ModelSelector Component
 */
export const ModelSelector: React.FC<ModelSelectorProps> = ({
  models,
  selectedIndex,
  currentModel,
  typeName,
  visible = true,
}) => {
  if (!visible) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        <Box marginBottom={1}>
          <Text color="cyan" bold>
            Select {typeName || 'Model'}
          </Text>
        </Box>

        {currentModel && (
          <Box marginBottom={1}>
            <Text dimColor>Current: </Text>
            <Text color="yellow">{currentModel}</Text>
          </Box>
        )}

        <Box marginBottom={1}>
          <Text dimColor>Available models ({models.length}):</Text>
        </Box>

        {/* Model list */}
        {models.map((model, idx) => {
          const isSelected = idx === selectedIndex;
          const isCurrent = model.name === currentModel;

          return (
            <Box key={idx}>
              <Text>
                {isSelected ? (
                  <Text color="green">&gt; </Text>
                ) : (
                  <Text>  </Text>
                )}
                <Text bold={isSelected}>{model.name}</Text>
                {isCurrent && (
                  <Text dimColor> (current)</Text>
                )}
                {model.size && (
                  <Text dimColor> - {model.size}</Text>
                )}
              </Text>
            </Box>
          );
        })}

        {/* Footer */}
        <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
          <Text dimColor>
            ↑↓ navigate  •  Enter select  •  Esc/Ctrl+C cancel
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
