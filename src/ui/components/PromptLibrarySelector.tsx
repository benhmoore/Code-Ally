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
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import { useTerminalRows } from '../hooks/useTerminalRows.js';
import { centeredWindow, visibleItemBudget } from '../utils/layout.js';

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
  const terminalRows = useTerminalRows();
  const visibleCount = Math.min(
    maxVisible,
    visibleItemBudget(terminalRows, { chromeRows: 9, rowsPerItem: 3, maximum: maxVisible })
  );

  if (!visible) {
    return null;
  }

  if (prompts.length === 0) {
    return (
      <InteractiveSurface
        title="Prompt library"
        footer={<KeyboardHintFooter hints={[{ key: 'esc', label: 'close' }]} />}
      >
        <Text>No saved prompts.</Text>
        <Text dimColor>Use /prompt add to create one.</Text>
      </InteractiveSurface>
    );
  }

  const totalPrompts = prompts.length;
  const window = centeredWindow(prompts, selectedIndex, visibleCount);

  return (
    <InteractiveSurface
      title="Prompt library"
      meta={`${totalPrompts}`}
      footer={<KeyboardHintFooter action="use" />}
    >
          {window.above > 0 && <Text dimColor>  ↑ {window.above} more</Text>}
          {window.items.map((prompt, idx) => {
            const actualIndex = window.start + idx;
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

          {window.below > 0 && <Text dimColor>  ↓ {window.below} more</Text>}
    </InteractiveSurface>
  );
};
