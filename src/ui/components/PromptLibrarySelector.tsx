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
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { UI_COLORS } from '../constants/colors.js';
import { createDivider } from '../utils/uiHelpers.js';
import { useContentWidth } from '../hooks/useContentWidth.js';

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
  const terminalWidth = useContentWidth();
  const divider = createDivider(terminalWidth);

  if (!visible) {
    return null;
  }

  if (prompts.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="column">
          {/* Top divider */}
          <Box>
            <Text dimColor>{divider}</Text>
          </Box>

          <Box marginY={1}>
            <Text color={UI_COLORS.TEXT_DEFAULT} bold>
              Prompt Library
            </Text>
          </Box>
          <Text color={UI_COLORS.PRIMARY}>No saved prompts</Text>
          <Box marginTop={1}>
            <Text dimColor>Add prompts using the /prompt-save command</Text>
          </Box>
        </Box>
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
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column">
        {/* Top divider */}
        <Box>
          <Text dimColor>{divider}</Text>
        </Box>

        {/* Header */}
        <Box marginY={1}>
          <Text color={UI_COLORS.TEXT_DEFAULT} bold>
            Prompt Library
          </Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>Select a prompt to use ({totalPrompts} available):</Text>
        </Box>

        {/* Scroll indicator - more above */}
        {hasMoreAbove && (
          <Box>
            <Text dimColor>  ↑ {startIdx} more...</Text>
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
            <Box key={prompt.id} flexDirection="column">
              <SelectionIndicator isSelected={isSelected}>
                {displayTitle}
              </SelectionIndicator>
              <Box marginLeft={2} flexDirection="column">
                <Text color={isSelected ? UI_COLORS.PRIMARY : undefined} dimColor={!isSelected}>
                  {contentPreview}
                </Text>
                <Text color={isSelected ? UI_COLORS.PRIMARY : UI_COLORS.TEXT_DIM} dimColor={!isSelected}>
                  {relativeTime}{tagsDisplay}
                </Text>
              </Box>
            </Box>
          );
        })}

        {/* Scroll indicator - more below */}
        {hasMoreBelow && (
          <Box>
            <Text dimColor>  ↓ {totalPrompts - endIdx} more...</Text>
          </Box>
        )}

        {/* Footer */}
        <KeyboardHintFooter action="select" />
      </Box>
    </Box>
  );
};
