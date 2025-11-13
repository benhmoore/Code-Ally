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
import { ModalContainer } from './ModalContainer.js';
import { UI_COLORS } from '../constants/colors.js';

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
  if (!visible || completions.length === 0) {
    return null;
  }

  // Calculate visible range (windowing for long lists)
  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(maxHeight / 2), completions.length - maxHeight)
  );
  const endIndex = Math.min(startIndex + maxHeight, completions.length);
  const visibleCompletions = completions.slice(startIndex, endIndex);

  const showScrollUp = startIndex > 0;
  const showScrollDown = endIndex < completions.length;

  return (
    <Box flexDirection="column" marginTop={1} width="80%">
      <ModalContainer borderColor="gray">
        {/* Header */}
        <Box marginBottom={0}>
          <Text dimColor>
            {completions.length} {completions.length === 1 ? 'suggestion' : 'suggestions'}
          </Text>
        </Box>

        {/* Scroll indicator */}
        {showScrollUp && (
          <Box justifyContent="center">
            <Text dimColor>↑ more</Text>
          </Box>
        )}

        {/* Completion items */}
        {visibleCompletions.map((completion, idx) => {
          const actualIndex = startIndex + idx;
          const isSelected = actualIndex === selectedIndex;

          return (
            <Box key={actualIndex} paddingLeft={1}>
              {/* Selection indicator */}
              <Text color={isSelected ? UI_COLORS.PRIMARY : undefined} bold={isSelected}>
                {isSelected ? '❯ ' : '  '}
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
        {showScrollDown && (
          <Box justifyContent="center">
            <Text dimColor>↓ more</Text>
          </Box>
        )}

        {/* Footer hint - Note: CompletionDropdown uses Tab instead of Enter */}
        <Box marginTop={0} borderTop borderColor="gray">
          <Text dimColor>
            Tab: select • ↑↓: navigate • Esc: dismiss
          </Text>
        </Box>
      </ModalContainer>
    </Box>
  );
};

/**
 * Minimal completion dropdown (for inline display)
 */
export const CompletionInline: React.FC<{
  completion: Completion;
}> = ({ completion }) => {
  return (
    <Box marginLeft={1}>
      <Text dimColor>
        {getCompletionIcon(completion.type)} {completion.value}
      </Text>
    </Box>
  );
};
