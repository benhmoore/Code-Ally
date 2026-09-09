import { describe, expect, it } from 'vitest';
import { agentFleetDot, agentFleetLabel, agentFleetLabels } from '../AgentFleetView.js';
import type { BackgroundAgentInfo } from '../../hooks/useBackgroundAgents.js';

function agent(overrides: Partial<BackgroundAgentInfo> = {}): BackgroundAgentInfo {
  return {
    id: 'agent-100-one',
    agentType: 'task',
    taskPrompt: 'Review the persistence layer for correctness',
    status: 'running',
    startTime: 1,
    endTime: null,
    tokens: 0,
    ...overrides,
  };
}

describe('AgentFleetView', () => {
  it('uses a filled dot only for the current agent', () => {
    expect(agentFleetDot(true)).toBe('●');
    expect(agentFleetDot(false)).toBe('○');
  });

  it('prefers an explicit model-supplied description', () => {
    expect(agentFleetLabel(agent({ description: 'CLI implementation' })))
      .toBe('task · CLI implementation');
  });

  it('falls back to a compact single-line task preview', () => {
    expect(agentFleetLabel(agent({ taskPrompt: '  Review the\n  persistence   layer  ' })))
      .toBe('task · Review the persistence layer');
    expect(agentFleetLabel(agent({ taskPrompt: 'x'.repeat(80) }))).toHaveLength(57);
  });

  it('adds stable id suffixes only when semantic labels collide', () => {
    const labels = agentFleetLabels([
      agent({ id: 'agent-100-alpha' }),
      agent({ id: 'agent-101-bravo' }),
      agent({ id: 'agent-102-charlie', taskPrompt: 'Implement the CLI' }),
    ]);
    expect(labels[0]).toMatch(/ · agent-100-alpha$/);
    expect(labels[1]).toMatch(/ · agent-101-bravo$/);
    expect(labels[2]).toBe('task · Implement the CLI');
  });

  it('distinguishes opaque IDs sharing the same final component', () => {
    const labels = agentFleetLabels([
      agent({ id: 'agent-100-same' }),
      agent({ id: 'agent-101-same' }),
    ]);
    expect(new Set(labels).size).toBe(2);
  });
});
