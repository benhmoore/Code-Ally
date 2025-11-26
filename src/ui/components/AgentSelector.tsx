/**
 * AgentSelector - Interactive agent selection prompt
 *
 * Shows available agents with keyboard navigation
 */

import React from 'react';
import { Box, Text } from 'ink';
import { SelectionIndicator } from './SelectionIndicator.js';
import { KeyboardHintFooter } from './KeyboardHintFooter.js';
import { UI_COLORS } from '../constants/colors.js';
import { createDivider } from '../utils/uiHelpers.js';
import { useContentWidth } from '../hooks/useContentWidth.js';

export interface AgentOption {
  name: string;
  description: string;
}

export interface AgentSelectorProps {
  /** Available agents */
  agents: AgentOption[];
  /** Currently selected agent index */
  selectedIndex: number;
  /** Current task prompt */
  taskPrompt?: string;
  /** Whether the prompt is visible */
  visible?: boolean;
}

/**
 * AgentSelector Component
 */
export const AgentSelector: React.FC<AgentSelectorProps> = ({
  agents,
  selectedIndex,
  taskPrompt,
  visible = true,
}) => {
  const terminalWidth = useContentWidth();
  const divider = createDivider(terminalWidth);

  if (!visible) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="column">
        {/* Top divider */}
        <Box>
          <Text dimColor>{divider}</Text>
        </Box>

        <Box marginY={1}>
          <Text color={UI_COLORS.TEXT_DEFAULT} bold>
            Select Agent
          </Text>
        </Box>

        {taskPrompt && (
          <Box marginBottom={1} flexDirection="column">
            <Text dimColor>Task: </Text>
            <Text color={UI_COLORS.PRIMARY}>{taskPrompt}</Text>
          </Box>
        )}

        <Box marginBottom={1}>
          <Text dimColor>Available agents ({agents.length}):</Text>
        </Box>

        {/* Agent list */}
        {agents.map((agent, idx) => {
          const isSelected = idx === selectedIndex;

          return (
            <Box key={idx} marginBottom={0} flexDirection="column">
              <SelectionIndicator isSelected={isSelected}>
                {agent.name}
              </SelectionIndicator>
              <Box marginLeft={4}>
                <Text dimColor>{agent.description}</Text>
              </Box>
            </Box>
          );
        })}

        {/* Footer */}
        <KeyboardHintFooter action="select" />
      </Box>
    </Box>
  );
};
