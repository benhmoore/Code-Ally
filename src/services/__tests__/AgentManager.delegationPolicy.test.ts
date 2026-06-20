/**
 * Tests for single-level delegation policy: a sub-agent (depth >= 1) is a leaf and
 * must not see or call other agents.
 */

import { describe, it, expect } from 'vitest';
import { AgentManager } from '../AgentManager.js';
import { applyLeafDelegationPolicy } from '../../config/constants.js';

describe('single-level delegation policy', () => {
  describe('applyLeafDelegationPolicy', () => {
    it('keeps delegation tools for the root agent (depth 0)', () => {
      expect(applyLeafDelegationPolicy(['read', 'agent', 'explore'], 0)).toEqual([
        'read',
        'agent',
        'explore',
      ]);
    });

    it('strips delegation tools for a sub-agent (depth >= 1)', () => {
      expect(applyLeafDelegationPolicy(['read', 'agent', 'explore', 'bash'], 1)).toEqual([
        'read',
        'bash',
      ]);
    });
  });

  describe('AgentManager.computeAllowedTools', () => {
    const manager = new AgentManager();
    // computeAllowedTools only touches toolManager for plugin agents; a stub suffices here.
    const toolManager: any = { getAllTools: () => [] };
    const allToolNames = ['read', 'bash', 'agent', 'explore', 'plan'];

    it('does not strip delegation tools at depth 0', () => {
      const result = manager.computeAllowedTools(
        { tools: ['read', 'agent'] } as any,
        toolManager,
        allToolNames,
        0
      );
      expect(result).toEqual(['read', 'agent']);
    });

    it('strips delegation tools from an explicit toolset at depth 1', () => {
      const result = manager.computeAllowedTools(
        { tools: ['read', 'agent', 'explore'] } as any,
        toolManager,
        allToolNames,
        1
      );
      expect(result).toEqual(['read']);
    });

    it('strips delegation tools from an unrestricted sub-agent at depth 1', () => {
      const result = manager.computeAllowedTools({} as any, toolManager, allToolNames, 1);
      expect(result).toEqual(['read', 'bash']);
    });
  });
});
