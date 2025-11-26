/**
 * ModalContainer Component
 *
 * Standardizes modal border styling and padding across all modal components.
 *
 * Purpose:
 * - Provides consistent rounded border style for all modals
 * - Maintains uniform padding (X: 2, Y: 1)
 * - Supports configurable border color (default: gray)
 * - Establishes column layout for modal content
 *
 * Usage:
 * ```tsx
 * <ModalContainer>
 *   <Text>Modal content here</Text>
 * </ModalContainer>
 *
 * <ModalContainer borderColor="yellow">
 *   <Text>Warning modal</Text>
 * </ModalContainer>
 * ```
 */

import React from 'react';
import { Box } from 'ink';
import { UI_COLORS } from '../constants/colors.js';

export interface ModalContainerProps {
  /** Content to display inside the modal */
  children: React.ReactNode;
  /** Border color (default: gray) */
  borderColor?: string;
}

/**
 * ModalContainer Component
 *
 * Wraps modal content with consistent styling:
 * - Round border style for softer appearance
 * - Horizontal padding of 2, vertical padding of 1
 * - Column flex direction for vertical content layout
 * - Configurable border color for different modal types
 */
const ModalContainerComponent: React.FC<ModalContainerProps> = ({
  children,
  borderColor = UI_COLORS.TEXT_DIM,
}) => {
  return (
    <Box
      borderStyle="round"
      borderColor={borderColor}
      paddingX={2}
      paddingY={1}
      flexDirection="column"
    >
      {children}
    </Box>
  );
};

/**
 * Memoized ModalContainer
 *
 * Prevents unnecessary re-renders when props haven't changed.
 * Since modal containers are typically stable, memoization improves performance.
 */
export const ModalContainer = React.memo(ModalContainerComponent);
