/**
 * ModelSelector - Interactive model selection prompt
 *
 * Shows available Ollama models with keyboard navigation
 */

import React from 'react';
import { Box, Text } from 'ink';
import { SelectionIndicator } from './SelectionIndicator.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { UI_COLORS } from '../constants/colors.js';
import { createDivider } from '../utils/uiHelpers.js';
import { useContentWidth } from '../hooks/useContentWidth.js';

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
  /** Whether capability testing is in progress */
  loading?: boolean;
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
  loading = false,
}) => {
  const terminalWidth = useContentWidth();
  const divider = createDivider(terminalWidth);

  if (!visible) {
    return null;
  }

  // Show loading state when testing capabilities
  if (loading) {
    const selectedModel = models[selectedIndex];
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="column">
          <Box>
            <Text dimColor>{divider}</Text>
          </Box>
          <Box marginY={1}>
            <Text color={UI_COLORS.PRIMARY}>
              Testing capabilities for {selectedModel?.name || 'model'}...
            </Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column">
        {/* Top divider */}
        <Box>
          <Text dimColor>{divider}</Text>
        </Box>

        <Box marginY={1}>
          <Text color={UI_COLORS.TEXT_DEFAULT} bold>
            Select {typeName || 'Model'}
          </Text>
        </Box>

        {currentModel && (
          <Box marginBottom={1}>
            <Text dimColor>Current: </Text>
            <Text color={UI_COLORS.PRIMARY}>{currentModel}</Text>
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
              <SelectionIndicator isSelected={isSelected}>
                {model.name}
                {isCurrent && (
                  <Text dimColor> (current)</Text>
                )}
                {model.size && (
                  <Text dimColor> - {model.size}</Text>
                )}
              </SelectionIndicator>
            </Box>
          );
        })}

        {/* Footer */}
        <KeyboardHintFooter action="select" />
      </Box>
    </Box>
  );
};
