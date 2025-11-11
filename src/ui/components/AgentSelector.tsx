/**
 * AgentSelector - Interactive agent selection prompt
 *
 * Shows available agents with keyboard navigation
 */

import React from 'react';
import { Box, Text } from 'ink';

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
  if (!visible) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={2}
        paddingY={1}
        flexDirection="column"
      >
        <Box marginBottom={1}>
          <Text color="cyan" bold>
            Select Agent
          </Text>
        </Box>

        {taskPrompt && (
          <Box marginBottom={1} flexDirection="column">
            <Text dimColor>Task: </Text>
            <Text color="yellow">{taskPrompt}</Text>
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
              <Box>
                <Text>
                  {isSelected ? (
                    <Text color="green">&gt; </Text>
                  ) : (
                    <Text>  </Text>
                  )}
                  <Text bold={isSelected}>{agent.name}</Text>
                </Text>
              </Box>
              <Box marginLeft={4}>
                <Text dimColor>{agent.description}</Text>
              </Box>
            </Box>
          );
        })}

        {/* Footer */}
        <Box marginTop={1} borderTop borderColor="gray" paddingTop={1}>
          <Text dimColor>
            ↑↓ navigate  •  Enter select  •  Esc/Ctrl+C cancel
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
