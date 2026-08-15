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
import { InteractiveSurface } from './InteractiveSurface.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { centeredWindow, visibleItemBudget } from '../utils/layout.js';

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
  const terminalRows = useTerminalRows();
  const visibleCount = visibleItemBudget(terminalRows, { chromeRows: 9, maximum: 10 });
  const window = centeredWindow(models, selectedIndex, visibleCount);

  if (!visible) {
    return null;
  }

  // Show loading state when testing capabilities
  if (loading) {
    const selectedModel = models[selectedIndex];
    return (
      <InteractiveSurface title={`Select ${typeName || 'model'}`}>
        <Text color={UI_COLORS.PRIMARY}>
          Testing {selectedModel?.name || 'model'}…
        </Text>
      </InteractiveSurface>
    );
  }

  return (
    <InteractiveSurface
      title={`Select ${typeName || 'model'}`}
      description={currentModel ? <>Current: <Text color={UI_COLORS.PRIMARY}>{currentModel}</Text></> : undefined}
      meta={`${models.length}`}
      footer={<KeyboardHintFooter action="select" />}
    >
        {window.above > 0 && <Text dimColor>  ↑ {window.above} more</Text>}
        {window.items.map((model, idx) => {
          const actualIndex = window.start + idx;
          const isSelected = actualIndex === selectedIndex;
          const isCurrent = model.name === currentModel;

          return (
            <Box key={model.name}>
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

        {window.below > 0 && <Text dimColor>  ↓ {window.below} more</Text>}
    </InteractiveSurface>
  );
};
