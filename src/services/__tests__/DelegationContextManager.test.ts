/**
 * DelegationContextManager Tests
 *
 * Tests delegation state tracking and lifecycle management
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DelegationContextManager, DelegationContext, ActiveDelegation } from '../DelegationContextManager.js';
import { PooledAgent } from '../AgentPoolService.js';
import { Agent } from '../../agent/Agent.js';

// Mock PooledAgent for testing
function createMockPooledAgent(agentId: string, mockNestedManager?: DelegationContextManager): PooledAgent {
  const mockAgent = {
    getToolOrchestrator: vi.fn(() => ({
      toolManager: {
        delegationContextManager: mockNestedManager,
      },
    })),
  } as unknown as Agent;

  return {
    agent: mockAgent,
    agentId,
    release: vi.fn(),
  };
}

describe('DelegationContextManager', () => {
  let manager: DelegationContextManager;

  beforeEach(() => {
    manager = new DelegationContextManager();
  });

  describe('register', () => {
    it('should register a new delegation in executing state', () => {
      const pooledAgent = createMockPooledAgent('agent-1');

      manager.register('call-1', 'agent', pooledAgent);

      const context = manager.get('call-1');
      expect(context).toBeDefined();
      expect(context?.callId).toBe('call-1');
      expect(context?.toolName).toBe('agent');
      expect(context?.state).toBe('executing');
      expect(context?.pooledAgent).toBe(pooledAgent);
      expect(context?.timestamp).toBeGreaterThan(0);
    });

    it('should allow multiple concurrent delegations', () => {
      const pooledAgent1 = createMockPooledAgent('agent-1');
      const pooledAgent2 = createMockPooledAgent('agent-2');

      manager.register('call-1', 'agent', pooledAgent1);
      manager.register('call-2', 'explore', pooledAgent2);

      expect(manager.has('call-1')).toBe(true);
      expect(manager.has('call-2')).toBe(true);
      expect(manager.getAll()).toHaveLength(2);
    });

    it('should warn if callId already exists', () => {
      const pooledAgent1 = createMockPooledAgent('agent-1');
      const pooledAgent2 = createMockPooledAgent('agent-2');

      manager.register('call-1', 'agent', pooledAgent1);
      manager.register('call-1', 'explore', pooledAgent2); // Duplicate callId

      // Should overwrite with new registration
      const context = manager.get('call-1');
      expect(context?.toolName).toBe('explore');
    });
  });

  describe('transitionToCompleting', () => {
    it('should transition delegation from executing to completing', () => {
      const pooledAgent = createMockPooledAgent('agent-1');

      manager.register('call-1', 'agent', pooledAgent);
      manager.transitionToCompleting('call-1');

      const context = manager.get('call-1');
      expect(context?.state).toBe('completing');
    });

    it('should warn if callId not found', () => {
      manager.transitionToCompleting('non-existent');
      // Should not throw, just log warning
    });

    it('should warn if transitioning from invalid state', () => {
      const pooledAgent = createMockPooledAgent('agent-1');

      manager.register('call-1', 'agent', pooledAgent);
      manager.transitionToCompleting('call-1');
      manager.transitionToCompleting('call-1'); // Transition again

      const context = manager.get('call-1');
      expect(context?.state).toBe('completing');
    });
  });

  describe('clear', () => {
    it('should remove delegation from tracking', () => {
      const pooledAgent = createMockPooledAgent('agent-1');

      manager.register('call-1', 'agent', pooledAgent);
      expect(manager.has('call-1')).toBe(true);

      manager.clear('call-1');
      expect(manager.has('call-1')).toBe(false);
    });

    it('should warn if callId not found', () => {
      manager.clear('non-existent');
      // Should not throw, just log warning
    });
  });

  describe('getActiveDelegation', () => {
    it('should return undefined if no active delegations', () => {
      const result = manager.getActiveDelegation();
      expect(result).toBeUndefined();
    });

    it('should return active delegation in executing state', () => {
      const pooledAgent = createMockPooledAgent('agent-1');

      manager.register('call-1', 'agent', pooledAgent);

      const result = manager.getActiveDelegation();
      expect(result).toBeDefined();
      expect(result?.callId).toBe('call-1');
      expect(result?.toolName).toBe('agent');
      expect(result?.pooledAgent).toBe(pooledAgent);
    });

    it('should return active delegation in completing state', () => {
      const pooledAgent = createMockPooledAgent('agent-1');

      manager.register('call-1', 'agent', pooledAgent);
      manager.transitionToCompleting('call-1');

      const result = manager.getActiveDelegation();
      expect(result).toBeDefined();
      expect(result?.callId).toBe('call-1');
    });

    it('should return most recent delegation if multiple at same depth', async () => {
      const pooledAgent1 = createMockPooledAgent('agent-1');
      const pooledAgent2 = createMockPooledAgent('agent-2');

      manager.register('call-1', 'agent', pooledAgent1);
      // Add small delay to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 2));
      manager.register('call-2', 'explore', pooledAgent2);

      const result = manager.getActiveDelegation();
      expect(result?.callId).toBe('call-2'); // Most recent
    });

    it('should find nested delegation (depth-first search)', () => {
      // Create nested manager with active delegation
      const nestedManager = new DelegationContextManager();
      const nestedPooledAgent = createMockPooledAgent('nested-agent');
      nestedManager.register('nested-call', 'agent', nestedPooledAgent);

      // Create parent delegation with nested manager
      const parentPooledAgent = createMockPooledAgent('parent-agent', nestedManager);
      manager.register('parent-call', 'agent', parentPooledAgent);

      const result = manager.getActiveDelegation();
      expect(result?.callId).toBe('nested-call'); // Should find nested delegation
    });

    it('should handle missing nested manager gracefully', () => {
      // Create agent without toolOrchestrator
      const mockAgent = {
        getToolOrchestrator: vi.fn(() => undefined),
      } as unknown as Agent;

      const pooledAgent: PooledAgent = {
        agent: mockAgent,
        agentId: 'agent-1',
        release: vi.fn(),
      };

      manager.register('call-1', 'agent', pooledAgent);

      const result = manager.getActiveDelegation();
      expect(result?.callId).toBe('call-1'); // Should return parent
    });
  });

  describe('getAllActive', () => {
    it('should return only active delegations', () => {
      const pooledAgent1 = createMockPooledAgent('agent-1');
      const pooledAgent2 = createMockPooledAgent('agent-2');

      manager.register('call-1', 'agent', pooledAgent1);
      manager.register('call-2', 'explore', pooledAgent2);

      const active = manager.getAllActive();
      expect(active).toHaveLength(2);
    });

    it('should sort by timestamp (newest first)', async () => {
      const pooledAgent1 = createMockPooledAgent('agent-1');
      const pooledAgent2 = createMockPooledAgent('agent-2');

      manager.register('call-1', 'agent', pooledAgent1);
      // Add small delay to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 2));
      manager.register('call-2', 'explore', pooledAgent2);

      const active = manager.getAllActive();
      expect(active[0].callId).toBe('call-2'); // Most recent
      expect(active[1].callId).toBe('call-1');
    });

    it('should include both executing and completing states', () => {
      const pooledAgent1 = createMockPooledAgent('agent-1');
      const pooledAgent2 = createMockPooledAgent('agent-2');

      manager.register('call-1', 'agent', pooledAgent1);
      manager.register('call-2', 'explore', pooledAgent2);
      manager.transitionToCompleting('call-1');

      const active = manager.getAllActive();
      expect(active).toHaveLength(2);
      expect(active.find(c => c.callId === 'call-1')?.state).toBe('completing');
      expect(active.find(c => c.callId === 'call-2')?.state).toBe('executing');
    });
  });

  describe('lifecycle', () => {
    it('should follow complete lifecycle: register -> transition -> clear', () => {
      const pooledAgent = createMockPooledAgent('agent-1');

      // Register
      manager.register('call-1', 'agent', pooledAgent);
      expect(manager.has('call-1')).toBe(true);
      expect(manager.get('call-1')?.state).toBe('executing');

      // Transition
      manager.transitionToCompleting('call-1');
      expect(manager.has('call-1')).toBe(true);
      expect(manager.get('call-1')?.state).toBe('completing');

      // Clear
      manager.clear('call-1');
      expect(manager.has('call-1')).toBe(false);
    });

    it('should handle concurrent delegation lifecycles independently', () => {
      const pooledAgent1 = createMockPooledAgent('agent-1');
      const pooledAgent2 = createMockPooledAgent('agent-2');

      manager.register('call-1', 'agent', pooledAgent1);
      manager.register('call-2', 'explore', pooledAgent2);

      // Complete call-1
      manager.transitionToCompleting('call-1');
      manager.clear('call-1');

      // call-2 should still be active
      expect(manager.has('call-1')).toBe(false);
      expect(manager.has('call-2')).toBe(true);
      expect(manager.get('call-2')?.state).toBe('executing');
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', () => {
      const pooledAgent1 = createMockPooledAgent('agent-1');
      const pooledAgent2 = createMockPooledAgent('agent-2');
      const pooledAgent3 = createMockPooledAgent('agent-3');

      manager.register('call-1', 'agent', pooledAgent1);
      manager.register('call-2', 'agent', pooledAgent2);
      manager.register('call-3', 'explore', pooledAgent3);
      manager.transitionToCompleting('call-1');

      const stats = manager.getStats();
      expect(stats.total).toBe(3);
      expect(stats.executing).toBe(2);
      expect(stats.completing).toBe(1);
      expect(stats.byTool.agent).toBe(2);
      expect(stats.byTool.explore).toBe(1);
    });
  });

  describe('clearAll', () => {
    it('should remove all delegations', () => {
      const pooledAgent1 = createMockPooledAgent('agent-1');
      const pooledAgent2 = createMockPooledAgent('agent-2');

      manager.register('call-1', 'agent', pooledAgent1);
      manager.register('call-2', 'explore', pooledAgent2);

      manager.clearAll();

      expect(manager.getAll()).toHaveLength(0);
    });
  });
});
