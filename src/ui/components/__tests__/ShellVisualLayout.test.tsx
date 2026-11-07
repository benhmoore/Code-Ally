import React from 'react';
import { Box, renderToString } from 'ink';
import { visibleLength } from '@utils/terminalText.js';
import { describe, expect, it } from 'vitest';
import { StatusIndicator } from '../StatusIndicator.js';
import { AgentFleetView } from '../AgentFleetView.js';
import { TerminalContext, deriveWidths } from '../../contexts/TerminalContext.js';
import type { BackgroundAgentInfo } from '../../hooks/useBackgroundAgents.js';

function frame(element: React.ReactNode, columns: number, rows: number): string[] {
  return renderToString(<TerminalContext.Provider value={deriveWidths(columns, rows)}>
    <Box width={columns} flexDirection="column">{element}</Box>
  </TerminalContext.Provider>, { columns }).split('\n');
}

describe.each([[80, 24], [40, 12]])('shell visual geometry %ix%i', (columns, rows) => {
  it('keeps a long activity label on one row while retaining elapsed time and the interrupt action', () => {
    const lines = frame(<StatusIndicator isProcessing activeSubAgents={['Investigate authentication session serialization and recovery across multiple services']}/>, columns, rows);
    expect(lines).toHaveLength(1);
    expect(visibleLength(lines[0]!)).toBeLessThanOrEqual(columns);
    expect(lines[0]).toContain('esc interrupt');
    expect(lines[0]).toContain('0s');
    expect(lines[0]?.indexOf('Working')).toBe(3);
    expect(lines[0]).toContain('…');
  });

  it('keeps focused fleet names and complete metadata together on single rows', () => {
    const agents = [{ id: 'agent-one', agentType: 'explore',
      taskPrompt: 'Investigate authentication session serialization and recovery across multiple services',
      status: 'done', startTime: Date.now() - 12000, endTime: Date.now(), tokens: 8400,
    }] as BackgroundAgentInfo[];
    const lines = frame(<AgentFleetView agents={agents} focused selectedIndex={1} activeAgentId="agent-one" maxVisible={1}/>, columns, rows);
    const toolRow = lines.find(line => line.includes('8.4k tokens'));
    expect(toolRow).toBeDefined();
    expect(toolRow).toContain('12s');
    expect(toolRow).toContain('(done)');
    expect(toolRow).toContain('…');
    expect(visibleLength(toolRow!)).toBeLessThanOrEqual(columns);
    expect(lines.filter(line => line.includes('8.4k tokens'))).toHaveLength(1);
    expect(lines.join('\n')).toContain('enter view');
    expect(lines.join('\n')).toContain('esc back');
    expect(lines.join('\n')).not.toContain('to kill');
    expect(lines.length).toBeLessThanOrEqual(rows);
  });
});
