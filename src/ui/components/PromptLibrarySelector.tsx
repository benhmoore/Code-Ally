/**
 * PromptLibrarySelector - Interactive prompt selection
 *
 * Shows saved prompts with keyboard navigation for /prompt command
 */

import React from 'react';
import { Box, Text } from 'ink';
import { PromptInfo } from '@shared/index.js';
import { formatRelativeTime } from '../utils/timeUtils.js';
import { TEXT_LIMITS } from '@config/constants.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { UI_COLORS } from '../constants/colors.js';
import { ChickAnimation } from './ChickAnimation.js';
import { ModalContainer } from './ModalContainer.js';

export interface PromptLibrarySelectorProps {
  /** Available prompts */
  prompts: PromptInfo[];
  /** Currently selected prompt index */
  selectedIndex: number;
  /** Whether the prompt is visible */
  visible?: boolean;
  /** Maximum visible items before windowing */
  maxVisible?: number;
}

/**
 * Truncate title for display
 */
function truncateTitle(title: string, maxLength: number = TEXT_LIMITS.DESCRIPTION_MAX): string {
  if (title.length <= maxLength) return title;
  return title.slice(0, maxLength - 3) + '...';
}

/**
 * Truncate content for display
 */
function truncateContent(content: string, maxLength: number = TEXT_LIMITS.DESCRIPTION_MAX): string {
  // Get first line only
  const firstLine = content.split('\n')[0] || '';

  if (firstLine.length <= maxLength) return firstLine;
  return firstLine.slice(0, maxLength - 3) + '...';
}

/**
 * Format tags for display
 */
function formatTagsDisplay(tags?: string[]): string {
  if (!tags || tags.length === 0) return '';

  // Show tag count if more than 3 tags
  if (tags.length > 3) {
    return ` • ${tags.length} tags`;
  }

  // Show tags in brackets with truncation
  const tagsStr = tags.join(', ');
  const maxLength = 30;

  if (tagsStr.length > maxLength) {
    return ` • [${tagsStr.slice(0, maxLength - 3)}...]`;
  }

  return ` • [${tagsStr}]`;
}

/**
 * PromptLibrarySelector Component
 */
export const PromptLibrarySelector: React.FC<PromptLibrarySelectorProps> = ({
  prompts,
  selectedIndex,
  visible = true,
  maxVisible = 10,
}) => {
  if (!visible) {
    return null;
  }

  if (prompts.length === 0) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1} width="100%">
        <ModalContainer borderColor={UI_COLORS.TEXT_DIM}>
          <Box minHeight={20} width="100%" flexDirection="column">
            {/* Header with ChickAnimation */}
            <Box marginBottom={1} flexDirection="row" gap={1}>
              <Text bold>
                <ChickAnimation />
              </Text>
              <Text color={UI_COLORS.TEXT_DEFAULT} bold>
                Prompt Library
              </Text>
            </Box>

            {/* Empty message */}
            <Box marginBottom={1}>
              <Text>
                No saved prompts in your library.
              </Text>
            </Box>

            <Box marginBottom={1}>
              <Text dimColor>
                Use /prompt add to create your first prompt.
              </Text>
            </Box>

            {/* Footer */}
            <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
              <Text dimColor>Esc: Close</Text>
            </Box>
          </Box>
        </ModalContainer>
      </Box>
    );
  }

  // Calculate windowing
  const totalPrompts = prompts.length;
  const showScrollIndicators = totalPrompts > maxVisible;

  let startIdx = 0;
  let endIdx = totalPrompts;

  if (showScrollIndicators) {
    // Center selected item in window
    const halfWindow = Math.floor(maxVisible / 2);
    startIdx = Math.max(0, selectedIndex - halfWindow);
    endIdx = Math.min(totalPrompts, startIdx + maxVisible);

    // Adjust if we're at the end
    if (endIdx === totalPrompts) {
      startIdx = Math.max(0, endIdx - maxVisible);
    }
  }

  const visiblePrompts = prompts.slice(startIdx, endIdx);
  const hasMoreAbove = startIdx > 0;
  const hasMoreBelow = endIdx < totalPrompts;

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} width="100%">
      <ModalContainer borderColor={UI_COLORS.TEXT_DIM}>
        <Box minHeight={20} width="100%" flexDirection="column">
          {/* Header with ChickAnimation */}
          <Box marginBottom={1} flexDirection="row" gap={1}>
            <Text bold>
              <ChickAnimation />
            </Text>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Prompt Library
            </Text>
          </Box>

          {/* Subtitle */}
          <Box marginBottom={1}>
            <Text>
              Select a prompt to use ({totalPrompts} available)
            </Text>
          </Box>

          {/* Scroll indicator - more above */}
          {hasMoreAbove && (
            <Box marginBottom={1}>
              <Text dimColor>↑ {startIdx} more above</Text>
            </Box>
          )}

          {/* Prompt list */}
          {visiblePrompts.map((prompt, idx) => {
            const actualIndex = startIdx + idx;
            const isSelected = actualIndex === selectedIndex;
            const displayTitle = truncateTitle(prompt.title);
            const contentPreview = truncateContent(prompt.content);
            const relativeTime = formatRelativeTime(prompt.createdAt);
            const tagsDisplay = formatTagsDisplay(prompt.tags);

            return (
              <Box key={prompt.id} flexDirection="column" marginBottom={1}>
                <SelectionIndicator isSelected={isSelected}>
                  {displayTitle}
                </SelectionIndicator>
                <Box marginLeft={2} flexDirection="column">
                  <Text dimColor={!isSelected} color={isSelected ? UI_COLORS.PRIMARY : undefined}>
                    {contentPreview}
                  </Text>
                  <Text dimColor>
                    {relativeTime}{tagsDisplay}
                  </Text>
                </Box>
              </Box>
            );
          })}

          {/* Scroll indicator - more below */}
          {hasMoreBelow && (
            <Box marginBottom={1}>
              <Text dimColor>↓ {totalPrompts - endIdx} more below</Text>
            </Box>
          )}

          {/* Footer separator and instructions */}
          <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
            <Text dimColor>↑↓: Navigate • Enter: Select • Esc: Cancel</Text>
          </Box>
        </Box>
      </ModalContainer>
    </Box>
  );
};
