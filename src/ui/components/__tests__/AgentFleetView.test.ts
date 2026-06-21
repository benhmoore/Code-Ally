import { describe, expect, it } from 'vitest';
import { agentFleetDot } from '../AgentFleetView.js';

describe('AgentFleetView', () => {
  it('uses a filled dot only for the current agent', () => {
    expect(agentFleetDot(true)).toBe('●');
    expect(agentFleetDot(false)).toBe('○');
  });
});
