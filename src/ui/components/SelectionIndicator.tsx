/**
 * SelectionIndicator Component
 *
 * Standardizes selection display across modal components (PermissionPrompt,
 * ModelSelector, RewindSelector, etc.).
 *
 * Purpose:
 * - Provides consistent visual indicator for selected vs unselected items
 * - Uses yellow chevron and bold text for selected items
 * - Maintains proper spacing for unselected items to preserve alignment
 *
 * Usage:
 * ```tsx
 * <SelectionIndicator isSelected={idx === selectedIndex}>
 *   {option.label}
 * </SelectionIndicator>
 * ```
 */

import React from 'react';
import { Text } from 'ink';
import { UI_SYMBOLS } from '@config/uiSymbols.js';
import { UI_COLORS } from '../constants/colors.js';

export interface SelectionIndicatorProps {
  /** Whether this item is currently selected */
  isSelected: boolean;
  /** Content to display (can be text or React nodes) */
  children: React.ReactNode;
}

/**
 * SelectionIndicator Component
 *
 * Displays a visual indicator for selected items in lists and menus.
 * Selected items show a yellow chevron prefix and bold text.
 * Unselected items show spacing to maintain alignment.
 */
const SelectionIndicatorComponent: React.FC<SelectionIndicatorProps> = ({
  isSelected,
  children,
}) => {
  return (
    <Text>
      {isSelected ? (
        <Text color={UI_COLORS.PRIMARY}>{UI_SYMBOLS.NAVIGATION.CHEVRON_RIGHT} </Text>
      ) : (
        <Text>  </Text>
      )}
      <Text bold={isSelected}>{children}</Text>
    </Text>
  );
};

/**
 * Memoized SelectionIndicator
 *
 * Prevents unnecessary re-renders when selection state hasn't changed.
 * Performance optimization for long lists with many items.
 */
export const SelectionIndicator = React.memo(SelectionIndicatorComponent);
