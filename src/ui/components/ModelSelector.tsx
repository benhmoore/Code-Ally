/**
 * ModelSelector - Interactive model selection prompt
 *
 * Shows configured-provider models with keyboard and pointer navigation
 */

import React from 'react';
import { Text } from 'ink';
import { SelectionIndicator } from './SelectionIndicator.js';
import { Clickable } from './Clickable.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { UI_COLORS } from '../constants/colors.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { useContentWidth } from '../hooks/useContentWidth.js';
import { selectorText } from '../utils/formatters.js';
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
  /** Activate the option at an index, as a click on its row does. */
  onOptionPress?: (index: number) => void;
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
  onOptionPress,
}) => {
  const terminalRows = useTerminalRows();
  const width = Math.max(12, useContentWidth() - 4);
  const visibleCount = visibleItemBudget(terminalRows, { chromeRows: 9, maximum: 10 });
  const window = centeredWindow(models, selectedIndex, visibleCount);

  if (!visible) {
    return null;
  }

  // Show loading state when testing capabilities
  if (loading) {
    const selectedModel = models[selectedIndex];
    return (
      <InteractiveSurface
        title={`Select ${typeName || 'model'}`}
        footer={<KeyboardHintFooter hints={[{ key: 'esc', label: 'cancel' }]} />}
      >
        <Text color={UI_COLORS.PRIMARY}>Checking {selectorText(selectedModel?.name || 'model', width - 10)}…</Text>
        <Text dimColor>The selection is saved after its checks pass.</Text>
      </InteractiveSurface>
    );
  }

  if (!models.length) {
    return (
      <InteractiveSurface
        title={`Select ${typeName || 'model'}`}
        footer={<KeyboardHintFooter hints={[{ key: 'esc', label: 'close' }]} />}
      >
        <Text>No models available from this provider.</Text>
        <Text dimColor>Check /config setup or use /model with an exact model name.</Text>
      </InteractiveSurface>
    );
  }

  return (
    <InteractiveSurface
      title={`Select ${typeName || 'model'}`}
      meta={`${Math.min(models.length, Math.max(1, selectedIndex + 1))} of ${models.length}`}
      footer={<KeyboardHintFooter action="select" />}
    >
      {window.above > 0 && <Text dimColor> ↑ {window.above} more</Text>}
      {window.items.map((model, idx) => {
        const actualIndex = window.start + idx;
        const isSelected = actualIndex === selectedIndex;
        const isCurrent = model.name === currentModel;
        const suffix = `${isCurrent ? ' (current)' : ''}${model.size && width > 30 ? ` · ${model.size}` : ''}`;
        const name = selectorText(model.name, Math.max(1, width - 2 - suffix.length));

        return (
          <Clickable key={model.name} onPress={onOptionPress && (() => onOptionPress(actualIndex))}>
            <SelectionIndicator isSelected={isSelected}>
              {name}
              <Text dimColor>{suffix}</Text>
            </SelectionIndicator>
          </Clickable>
        );
      })}

      {window.below > 0 && <Text dimColor> ↓ {window.below} more</Text>}
    </InteractiveSurface>
  );
};
