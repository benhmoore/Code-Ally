/**
 * CompletionDropdown - Displays completion suggestions
 *
 * Features:
 * - Keyboard navigation (up/down arrows)
 * - Visual selection indicator
 * - Type-specific icons
 * - Descriptions for each completion
 */

import React from 'react';
import { Box, Text } from 'ink';
import { Completion } from '@services/CompletionProvider.js';
import { UI_COLORS } from '../constants/colors.js';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { centeredWindow, visibleItemBudget } from '../utils/layout.js';
import { getCompletionAcceptDecision } from '../utils/inputInteraction.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';

export interface CompletionDropdownProps {
  /** Available completions */
  completions: Completion[];
  /** Currently selected index */
  selectedIndex: number;
  /** Maximum height (number of items to show) */
  maxHeight?: number;
  /** Whether dropdown is visible */
  visible?: boolean;
}

/**
 * Get icon for completion type
 */
function getCompletionIcon(type: Completion['type']): string {
  switch (type) {
    case 'command':
      return '/';
    case 'file':
      return 'f';
    case 'directory':
      return 'd';
    case 'option':
      return '*';
    default:
      return '•';
  }
}

/**
 * Get color for completion type
 */
function getCompletionColor(type: Completion['type']): string {
  switch (type) {
    case 'command':
      return 'yellow';
    case 'file':
      return 'cyan';
    case 'directory':
      return 'magenta';
    case 'option':
      return 'blue';
    default:
      return 'white';
  }
}

/**
 * CompletionDropdown Component
 */
export const CompletionDropdown: React.FC<CompletionDropdownProps> = ({
  completions,
  selectedIndex,
  maxHeight = 8,
  visible = true,
}) => {
  const terminalRows = useTerminalRows();

  if (!visible || completions.length === 0) {
    return null;
  }

  const selectedCompletion = completions[selectedIndex];
  const enterDecision = selectedCompletion
    ? getCompletionAcceptDecision(selectedCompletion, 'enter')
    : null;

  const visibleCount = Math.min(
    maxHeight,
    visibleItemBudget(terminalRows, { chromeRows: 10, maximum: maxHeight })
  );
  const window = centeredWindow(completions, selectedIndex, visibleCount);

  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1} width="100%">
        {/* Header */}
        <Box marginBottom={0}>
          <Text dimColor>
            {completions.length} {completions.length === 1 ? 'suggestion' : 'suggestions'}
          </Text>
        </Box>

        {/* Scroll indicator */}
        {window.above > 0 && (
          <Box justifyContent="center">
            <Text dimColor>↑ {window.above} more</Text>
          </Box>
        )}

        {/* Completion items */}
        {window.items.map((completion, idx) => {
          const actualIndex = window.start + idx;
          const isSelected = actualIndex === selectedIndex;

          return (
            <Box key={actualIndex} paddingLeft={1}>
              {/* Selection indicator */}
              <Text color={isSelected ? UI_COLORS.PRIMARY : undefined} bold={isSelected}>
                {isSelected ? `${UI_SYMBOLS.NAVIGATION.CHEVRON_RIGHT} ` : '  '}
              </Text>

              {/* Icon */}
              <Text color={getCompletionColor(completion.type)}>
                {getCompletionIcon(completion.type)}{' '}
              </Text>

              {/* Value */}
              <Box width="30%">
                <Text
                  color={isSelected ? 'white' : undefined}
                  bold={isSelected}
                  wrap="truncate"
                >
                  {completion.value}
                </Text>
              </Box>

              {/* Description */}
              {completion.description && (
                <Box marginLeft={2} flexGrow={1}>
                  <Text dimColor={!isSelected} wrap="truncate">
                    {completion.description}
                  </Text>
                  {completion.currentValue && (
                    <Text dimColor wrap="truncate">
                      {' '}({completion.currentValue})
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          );
        })}

        {/* Scroll indicator */}
        {window.below > 0 && (
          <Box justifyContent="center">
            <Text dimColor>↓ {window.below} more</Text>
          </Box>
        )}

        {/* Footer hint */}
        <KeyboardHintFooter
          hints={[
            { key: '↑↓', label: 'move' },
            { key: 'enter', label: enterDecision?.submit ? 'run' : 'accept' },
            { key: 'tab', label: 'complete' },
            { key: 'esc', label: 'dismiss' },
          ]}
        />
    </Box>
  );
};
