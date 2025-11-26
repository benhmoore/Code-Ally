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
      getToolManager: vi.fn(() => ({
        getDelegationContextManager: vi.fn(() => mockNestedManager),
      })),
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

      const context = manager.getContext('call-1');
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
      const context = manager.getContext('call-1');
      expect(context?.toolName).toBe('explore');
    });
  });

  describe('transitionToCompleting', () => {
    it('should transition delegation from executing to completing', () => {
      const pooledAgent = createMockPooledAgent('agent-1');

      manager.register('call-1', 'agent', pooledAgent);
      manager.transitionToCompleting('call-1');

      const context = manager.getContext('call-1');
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

      const context = manager.getContext('call-1');
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

    it('should NOT return delegation in completing state (only executing)', () => {
      const pooledAgent = createMockPooledAgent('agent-1');

      manager.register('call-1', 'agent', pooledAgent);
      manager.transitionToCompleting('call-1');

      // Completing delegations should NOT be returned (race condition prevention)
      const result = manager.getActiveDelegation();
      expect(result).toBeUndefined();
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

    it('should skip completing nested delegations (race condition prevention)', () => {
      // Create nested manager with delegation in completing state
      const nestedManager = new DelegationContextManager();
      const nestedPooledAgent = createMockPooledAgent('nested-agent');
      nestedManager.register('nested-call', 'agent', nestedPooledAgent);
      nestedManager.transitionToCompleting('nested-call'); // Mark as completing

      // Create parent delegation in executing state
      const parentPooledAgent = createMockPooledAgent('parent-agent', nestedManager);
      manager.register('parent-call', 'agent', parentPooledAgent);

      // Should return parent (executing) not nested (completing)
      const result = manager.getActiveDelegation();
      expect(result?.callId).toBe('parent-call');
    });

    it('should skip completing parent and not descend into its children', () => {
      // Setup: Parent in completing, nested child in executing
      const nestedManager = new DelegationContextManager();
      const nestedPooledAgent = createMockPooledAgent('nested-agent');
      nestedManager.register('nested-call', 'agent', nestedPooledAgent); // executing

      const parentPooledAgent = createMockPooledAgent('parent-agent', nestedManager);
      manager.register('parent-call', 'agent', parentPooledAgent);
      manager.transitionToCompleting('parent-call'); // Parent completing

      // Should skip parent (completing) entirely - does NOT descend into its children
      // This is correct: if parent is completing/dying, its children may also be dying
      const result = manager.getActiveDelegation();
      expect(result).toBeUndefined();
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
      expect(manager.getContext('call-1')?.state).toBe('executing');

      // Transition
      manager.transitionToCompleting('call-1');
      expect(manager.has('call-1')).toBe(true);
      expect(manager.getContext('call-1')?.state).toBe('completing');

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
      expect(manager.getContext('call-2')?.state).toBe('executing');
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

  describe('Concurrent Delegation Scenarios', () => {
    it('should handle simultaneous completion of parallel delegations', async () => {
      const pooledAgent1 = createMockPooledAgent('agent-1');
      const pooledAgent2 = createMockPooledAgent('agent-2');

      // Register two parallel delegations
      manager.register('call-1', 'agent', pooledAgent1);
      await new Promise(resolve => setTimeout(resolve, 2));
      manager.register('call-2', 'agent', pooledAgent2);

      // Active delegation should be most recent
      let result = manager.getActiveDelegation();
      expect(result?.callId).toBe('call-2');

      // Complete call-2 first (even though it started second)
      manager.transitionToCompleting('call-2');

      // Now call-1 should be active
      result = manager.getActiveDelegation();
      expect(result?.callId).toBe('call-1');

      // Complete call-1
      manager.transitionToCompleting('call-1');

      // No active delegations
      result = manager.getActiveDelegation();
      expect(result).toBeUndefined();

      // Clear both
      manager.clear('call-1');
      manager.clear('call-2');

      expect(manager.getAll()).toHaveLength(0);
    });

    it('should handle nested concurrent branches (parent with multiple children)', async () => {
      // Create two nested managers (two child agents)
      const nestedManager1 = new DelegationContextManager();
      const nestedPooledAgent1 = createMockPooledAgent('nested-1');
      nestedManager1.register('nested-call-1', 'agent', nestedPooledAgent1);

      const nestedManager2 = new DelegationContextManager();
      const nestedPooledAgent2 = createMockPooledAgent('nested-2');
      // Add delay to ensure nested-call-2 is more recent
      await new Promise(resolve => setTimeout(resolve, 2));
      nestedManager2.register('nested-call-2', 'agent', nestedPooledAgent2);

      // Create two parent delegations, each with nested child
      const parentPooledAgent1 = createMockPooledAgent('parent-1', nestedManager1);
      const parentPooledAgent2 = createMockPooledAgent('parent-2', nestedManager2);

      manager.register('parent-call-1', 'agent', parentPooledAgent1);
      // Add delay to ensure parent-call-2 is more recent
      await new Promise(resolve => setTimeout(resolve, 2));
      manager.register('parent-call-2', 'agent', parentPooledAgent2);

      // Should find deepest from most recent parent branch (both depth 1, most recent timestamp wins)
      const result = manager.getActiveDelegation();
      expect(result?.callId).toBe('nested-call-2'); // Most recent parent's nested child

      // Complete first nested child
      nestedManager1.clear('nested-call-1');

      // Should still find second nested child
      const result2 = manager.getActiveDelegation();
      expect(result2?.callId).toBe('nested-call-2');
    });

    it('should handle deep nesting with concurrent delegations at each level', async () => {
      // Level 3: Two concurrent agents at deepest level
      const level3Manager = new DelegationContextManager();
      const level3Agent1 = createMockPooledAgent('level3-1');
      const level3Agent2 = createMockPooledAgent('level3-2');
      level3Manager.register('level3-call-1', 'agent', level3Agent1);
      // Add delay to ensure level3-call-2 is more recent
      await new Promise(resolve => setTimeout(resolve, 2));
      level3Manager.register('level3-call-2', 'agent', level3Agent2);

      // Level 2: Parent of level 3
      const level2Manager = new DelegationContextManager();
      const level2Agent = createMockPooledAgent('level2', level3Manager);
      level2Manager.register('level2-call', 'agent', level2Agent);

      // Level 1: Root with two branches - one deep (via level2), one shallow
      const shallowAgent = createMockPooledAgent('shallow');
      const level1Agent = createMockPooledAgent('level1', level2Manager);

      manager.register('level1-call', 'agent', level1Agent);
      manager.register('shallow-call', 'agent', shallowAgent);

      // Should find deepest delegation (level 3, most recent of the two at that depth)
      const result = manager.getActiveDelegation();
      expect(result?.callId).toBe('level3-call-2');
    });

    it('should handle pool reuse with stale nested delegations', () => {
      // Simulate first use of pooled agent
      const nestedManager = new DelegationContextManager();
      const nestedAgent = createMockPooledAgent('nested-old');
      nestedManager.register('old-nested-call', 'agent', nestedAgent);

      const pooledAgent = createMockPooledAgent('pooled-1', nestedManager);
      manager.register('call-1', 'agent', pooledAgent);

      // Verify nested delegation found
      let result = manager.getActiveDelegation();
      expect(result?.callId).toBe('old-nested-call');

      // Complete and clear first use
      manager.transitionToCompleting('call-1');
      manager.clear('call-1');

      // Simulate pool reuse: clear nested delegations (as AgentPoolService does)
      nestedManager.clearAll();

      // Reuse same pooled agent with new nested delegation
      const newNestedAgent = createMockPooledAgent('nested-new');
      nestedManager.register('new-nested-call', 'agent', newNestedAgent);

      manager.register('call-2', 'agent', pooledAgent); // Same pooledAgent reference

      // Should find NEW nested delegation, not stale one
      result = manager.getActiveDelegation();
      expect(result?.callId).toBe('new-nested-call');
    });

    it('should handle interleaved state transitions with concurrent delegations', async () => {
      const pooledAgent1 = createMockPooledAgent('agent-1');
      const pooledAgent2 = createMockPooledAgent('agent-2');
      const pooledAgent3 = createMockPooledAgent('agent-3');

      // Register three delegations with timing
      manager.register('call-1', 'agent', pooledAgent1);
      await new Promise(resolve => setTimeout(resolve, 2));
      manager.register('call-2', 'explore', pooledAgent2);
      await new Promise(resolve => setTimeout(resolve, 2));
      manager.register('call-3', 'plan', pooledAgent3);

      // Interleaved transitions: 2 completes, 1 still executing, 3 completes
      manager.transitionToCompleting('call-2');

      // Only call-1 and call-3 executing
      let stats = manager.getStats();
      expect(stats.executing).toBe(2);
      expect(stats.completing).toBe(1);

      // Most recent executing should be active
      let result = manager.getActiveDelegation();
      expect(result?.callId).toBe('call-3');

      // Transition call-3
      manager.transitionToCompleting('call-3');

      // Now only call-1 executing
      result = manager.getActiveDelegation();
      expect(result?.callId).toBe('call-1');

      // Clear in different order than completion
      manager.clear('call-1');
      manager.clear('call-3');
      manager.clear('call-2');

      expect(manager.getAll()).toHaveLength(0);
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
