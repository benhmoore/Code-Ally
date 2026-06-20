/**
 * AgentFleetView - Live list of background agents below the prompt input
 *
 * Renders a 'main' row plus one row per background agent (status dot, name,
 * elapsed, tokens), à la Claude Code's fleet view. The user reaches it with ↓
 * from the prompt, navigates with ↑/↓, presses Enter to enter an agent's
 * conversation, and Esc to return to main.
 *
 * Display-only: keyboard handling lives in InputPrompt's useInput cascade and
 * is driven by the `focused` / `selectedIndex` props (the same pattern as
 * SessionSelector and the other list selectors).
 *
 * The selectable list is [main, ...agents]; selectedIndex 0 === 'main'.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { BackgroundAgentInfo } from '../hooks/useBackgroundAgents.js';
import { BackgroundAgentStatus } from '@services/BackgroundAgentManager.js';
import { SelectionIndicator } from './SelectionIndicator.js';
import { UI_COLORS } from '../constants/colors.js';
import { formatElapsed } from '../utils/timeUtils.js';

export interface AgentFleetViewProps {
  /** Background agents (excludes the implicit 'main' row) */
  agents: BackgroundAgentInfo[];
  /** Selected index across [main, ...agents] */
  selectedIndex: number;
  /** Whether the fleet list currently has keyboard focus */
  focused: boolean;
  /** Whether the user is currently viewing a background agent (so 'main' returns) */
  activeAgentId: string;
  /** Max agent rows before windowing */
  maxVisible?: number;
}

const STATUS_DOT: Record<BackgroundAgentStatus, string> = {
  running: '○',
  done: '●',
  error: '●',
  cancelled: '○',
};

function statusColor(status: BackgroundAgentStatus): string | undefined {
  switch (status) {
    case 'running': return UI_COLORS.PRIMARY;
    case 'done': return UI_COLORS.SUCCESS;
    case 'error': return UI_COLORS.ERROR;
    case 'cancelled': return undefined; // dimmed
  }
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}

const AgentFleetViewComponent: React.FC<AgentFleetViewProps> = ({
  agents,
  selectedIndex,
  focused,
  activeAgentId,
  maxVisible = 6,
}) => {
  // Nothing to show until at least one background agent exists.
  if (agents.length === 0) {
    return null;
  }

  const now = Date.now();

  // Windowing over the agent rows (the 'main' row is always shown on top).
  const total = agents.length;
  const showScroll = total > maxVisible;
  let startIdx = 0;
  let endIdx = total;
  if (showScroll) {
    // selectedIndex is 1-based over agents (0 === main).
    const agentSel = Math.max(0, selectedIndex - 1);
    const halfWindow = Math.floor(maxVisible / 2);
    startIdx = Math.max(0, agentSel - halfWindow);
    endIdx = Math.min(total, startIdx + maxVisible);
    if (endIdx === total) startIdx = Math.max(0, endIdx - maxVisible);
  }
  const visibleAgents = agents.slice(startIdx, endIdx);
  const hasMoreAbove = startIdx > 0;
  const hasMoreBelow = endIdx < total;

  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      {/* main row (selectable index 0) */}
      <SelectionIndicator isSelected={focused && selectedIndex === 0}>
        <Text color={activeAgentId === 'main' ? UI_COLORS.TEXT_DEFAULT : undefined} bold>
          {'●'} main
        </Text>
      </SelectionIndicator>

      {hasMoreAbove && (
        <Text dimColor>  ↑ {startIdx} more…</Text>
      )}

      {visibleAgents.map((agent, idx) => {
        const actualIndex = startIdx + idx + 1; // +1 for the main row
        const isSelected = focused && actualIndex === selectedIndex;
        const isViewed = activeAgentId === agent.id;
        const elapsedSeconds = Math.round(((agent.endTime ?? now) - agent.startTime) / 1000);
        const dot = STATUS_DOT[agent.status];
        const color = statusColor(agent.status);

        return (
          <SelectionIndicator key={agent.id} isSelected={isSelected}>
            <Text color={color} dimColor={agent.status === 'cancelled'}>{dot} </Text>
            <Text bold={isViewed}>{agent.agentType}</Text>
            <Text dimColor>  {formatElapsed(elapsedSeconds)} · {formatTokens(agent.tokens)}</Text>
            {agent.status !== 'running' && (
              <Text dimColor> ({agent.status})</Text>
            )}
          </SelectionIndicator>
        );
      })}

      {hasMoreBelow && (
        <Text dimColor>  ↓ {total - endIdx} more…</Text>
      )}

      {/* Contextual hint */}
      <Box marginTop={1}>
        {focused ? (
          <Text dimColor>↑↓ navigate · enter to view · x to kill · esc to exit</Text>
        ) : (
          <Text dimColor>↓ to manage agents · ctrl+b to background</Text>
        )}
      </Box>
    </Box>
  );
};

export const AgentFleetView = React.memo(AgentFleetViewComponent);
