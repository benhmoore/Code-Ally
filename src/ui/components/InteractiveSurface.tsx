import React from 'react';
import { Box, Text } from 'ink';
import { UI_COLORS } from '../constants/colors.js';
import { createDivider } from '../utils/uiHelpers.js';
import { useContentWidth } from '../hooks/useContentWidth.js';

export interface InteractiveSurfaceProps {
  /** Omit only when a multi-step workflow renders its own step title. */
  title?: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  tone?: string;
  /** Extra text shown on the title row, aligned after the title. */
  meta?: React.ReactNode;
}

/**
 * The single visual shell for modal and selector states.
 *
 * Invariants:
 * - no border or minimum height;
 * - one horizontal boundary at the top;
 * - one title row, owned either here or by a multi-step workflow;
 * - workflow-specific content owns no duplicate outer padding or divider;
 * - hints are rendered once, through `footer`.
 */
export const InteractiveSurface: React.FC<InteractiveSurfaceProps> = ({
  title,
  description,
  children,
  footer,
  tone = UI_COLORS.TEXT_DEFAULT,
  meta,
}) => {
  const width = useContentWidth();

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text dimColor>{createDivider(Math.max(1, width - 2))}</Text>
      {title && (
        <Box>
          <Text color={tone} bold>{title}</Text>
          {meta && <Text dimColor> · {meta}</Text>}
        </Box>
      )}
      {description && <Text dimColor>{description}</Text>}
      <Box flexDirection="column" marginTop={description ? 1 : 0}>
        {children}
      </Box>
      {footer}
    </Box>
  );
};
