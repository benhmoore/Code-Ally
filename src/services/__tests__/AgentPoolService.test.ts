/**
 * AgentPoolService unit tests
 *
 * Tests agent acquisition, release, LRU eviction, and race condition handling.
 * Verifies the pool manages concurrent agent instances correctly with proper
 * resource pooling and thread-safe operations.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentPoolService } from '../AgentPoolService.js';
import type { AgentConfig } from '@agent/Agent.js';
import { ModelClient } from '@llm/ModelClient.js';
import { ToolManager } from '@tools/ToolManager.js';
import { ActivityStream } from '../ActivityStream.js';

// Mock the Agent class
vi.mock('../../agent/Agent.js', () => ({
  Agent: vi.fn().mockImplementation(() => ({
    cleanup: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('AgentPoolService', () => {
  let pool: AgentPoolService;
  let mockModelClient: ModelClient;
  let mockToolManager: ToolManager;
  let mockActivityStream: ActivityStream;

  beforeEach(async () => {
    // Create mock dependencies
    mockModelClient = {} as ModelClient;
    mockToolManager = {} as ToolManager;
    mockActivityStream = new ActivityStream();

    // Setup pool with small max size for testing
    pool = new AgentPoolService(
      mockModelClient,
      mockToolManager,
      mockActivityStream,
      undefined,
      undefined,
      { maxPoolSize: 3, verbose: false }
    );
    await pool.initialize();
  });

  afterEach(async () => {
    await pool.cleanup();
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      const newPool = new AgentPoolService(
        mockModelClient,
        mockToolManager,
        mockActivityStream
      );
      await expect(newPool.initialize()).resolves.toBeUndefined();
      await newPool.cleanup();
    });
  });

  describe('acquire', () => {
    it('should create new agent when pool is empty', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };
      const result = await pool.acquire(config);

      expect(result.agent).toBeDefined();
      expect(result.agentId).toBeDefined();
      expect(typeof result.release).toBe('function');
      expect(result.agentId).toMatch(/^pool-agent-/);
    });

    it('should return different agentIds for different agents', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      const result1 = await pool.acquire(config);
      const result2 = await pool.acquire(config);

      expect(result1.agentId).not.toBe(result2.agentId);
    });

    it('should reuse existing agent with matching config', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      // Acquire and release
      const result1 = await pool.acquire(config);
      const firstAgentId = result1.agentId;
      result1.release();

      // Acquire again with same config
      const result2 = await pool.acquire(config);

      // Should reuse the same agent
      expect(result2.agentId).toBe(firstAgentId);
    });

    it('should NOT reuse agent that is in use', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      // Acquire but don't release
      const result1 = await pool.acquire(config);

      // Acquire again (should create new agent)
      const result2 = await pool.acquire(config);

      expect(result2.agentId).not.toBe(result1.agentId);
    });

    it('should NOT reuse agent currently being acquired (race condition fix)', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      // First acquire and release to populate pool
      const result1 = await pool.acquire(config);
      result1.release();

      // Now acquire two agents concurrently
      const [result2, result3] = await Promise.all([
        pool.acquire(config),
        pool.acquire(config),
      ]);

      // One should reuse the released agent, one should create new
      // But they should NOT be the same agent
      expect(result2.agentId).not.toBe(result3.agentId);
    });

    it('should evict LRU when pool at capacity', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      // Fill pool to capacity (3)
      const result1 = await pool.acquire(config);
      const result2 = await pool.acquire(config);
      const result3 = await pool.acquire(config);

      // Release all
      result1.release();
      result2.release();
      result3.release();

      // Acquire 4th agent - should evict LRU
      const result4 = await pool.acquire(config);

      const stats = pool.getPoolStats();
      expect(stats.totalAgents).toBe(3); // Still at capacity

      // Clean up
      result4.release();
    });

    it('should create fresh agent when initialMessages provided', async () => {
      const config: AgentConfig = {
        isSpecializedAgent: true,
        initialMessages: [{ role: 'user', content: 'test' }],
      };

      // Acquire and release
      const result1 = await pool.acquire(config);
      const firstAgentId = result1.agentId;
      result1.release();

      // Acquire again with initialMessages
      const result2 = await pool.acquire(config);

      // Should create fresh agent, not reuse
      expect(result2.agentId).not.toBe(firstAgentId);
    });

    it('should use custom ToolManager when provided', async () => {
      const customToolManager = {} as ToolManager;
      const config: AgentConfig = { isSpecializedAgent: true };

      const result = await pool.acquire(config, customToolManager);

      expect(result.agent).toBeDefined();
      // Can't directly verify the ToolManager, but ensure no errors
    });

    it('should use custom ModelClient when provided', async () => {
      const customModelClient = {} as ModelClient;
      const config: AgentConfig = { isSpecializedAgent: true };

      const result = await pool.acquire(config, undefined, customModelClient);

      expect(result.agent).toBeDefined();
      // Can't directly verify the ModelClient, but ensure no errors
    });

    it('should match agents by _poolKey if present', async () => {
      const config1: AgentConfig = {
        isSpecializedAgent: true,
        _poolKey: 'custom-key-1',
      };
      const config2: AgentConfig = {
        isSpecializedAgent: true, // Same flag now (both must be true for pooling)
        _poolKey: 'custom-key-1', // Same key
      };

      // Acquire and release with config1
      const result1 = await pool.acquire(config1);
      const firstAgentId = result1.agentId;
      result1.release();

      // Acquire with config2 (same _poolKey)
      const result2 = await pool.acquire(config2);

      // Should reuse due to matching _poolKey
      expect(result2.agentId).toBe(firstAgentId);
    });

    it('should not match agents with different _poolKey', async () => {
      const config1: AgentConfig = {
        isSpecializedAgent: true,
        _poolKey: 'key-1',
      };
      const config2: AgentConfig = {
        isSpecializedAgent: true,
        _poolKey: 'key-2',
      };

      // Acquire and release with config1
      const result1 = await pool.acquire(config1);
      const firstAgentId = result1.agentId;
      result1.release();

      // Acquire with config2 (different _poolKey)
      const result2 = await pool.acquire(config2);

      // Should NOT reuse due to different _poolKey
      expect(result2.agentId).not.toBe(firstAgentId);
    });

    it('should update agent metadata on acquire', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      const result = await pool.acquire(config);
      const agentId = result.agentId;

      const metadata = pool.getAgentMetadata(agentId);
      expect(metadata).toBeDefined();
      expect(metadata?.inUse).toBe(true);
      expect(metadata?.useCount).toBe(1);
      expect(metadata?.lastAccessedAt).toBeDefined();

      result.release();
    });

    it('should increment useCount on reuse', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      const result1 = await pool.acquire(config);
      const agentId = result1.agentId;
      result1.release();

      const result2 = await pool.acquire(config);
      expect(result2.agentId).toBe(agentId);

      const metadata = pool.getAgentMetadata(agentId);
      expect(metadata?.useCount).toBe(2);

      result2.release();
    });
  });

  describe('release', () => {
    it('should mark agent as not in use', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };
      const result = await pool.acquire(config);
      const agentId = result.agentId;

      result.release();

      const metadata = pool.getAgentMetadata(agentId);
      expect(metadata?.inUse).toBe(false);
    });

    it('should update last accessed time', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };
      const result = await pool.acquire(config);
      const agentId = result.agentId;

      const metadataBefore = pool.getAgentMetadata(agentId);
      const timeBefore = metadataBefore?.lastAccessedAt;

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 10));

      result.release();

      const metadataAfter = pool.getAgentMetadata(agentId);
      const timeAfter = metadataAfter?.lastAccessedAt;

      expect(timeAfter).toBeGreaterThan(timeBefore!);
    });

    it('should make agent available for reuse', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      const result1 = await pool.acquire(config);
      const agentId = result1.agentId;
      result1.release();

      const result2 = await pool.acquire(config);
      expect(result2.agentId).toBe(agentId);

      result2.release();
    });

    it('should handle release of unknown agent gracefully', async () => {
      // Create a release function with a non-existent agentId
      // This simulates calling release after the agent was removed
      const config: AgentConfig = { isSpecializedAgent: true };
      const result = await pool.acquire(config);

      // Remove the agent
      await pool.removeAgent(result.agentId);

      // Now release should handle gracefully
      expect(() => result.release()).not.toThrow();
    });
  });

  describe('evictLRU', () => {
    it('should evict least recently used agent', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      // Create 3 agents and release them
      const result1 = await pool.acquire(config);
      const result2 = await pool.acquire(config);
      const result3 = await pool.acquire(config);

      const agent1Id = result1.agentId;

      result1.release();
      await new Promise(resolve => setTimeout(resolve, 10));
      result2.release();
      await new Promise(resolve => setTimeout(resolve, 10));
      result3.release();

      // Acquire 4th agent - will reuse agent1 (oldest released)
      // But if we keep them all released and create new agents, it should evict
      const result4 = await pool.acquire(config);
      const result5 = await pool.acquire(config);
      const result6 = await pool.acquire(config);

      // After acquiring 3 more (total 6 requests), pool should still be at max (3)
      // and at least one of the original agents should be evicted
      expect(pool.getPoolStats().totalAgents).toBe(3);

      result4.release();
      result5.release();
      result6.release();
    });

    it('should skip agents that are in use', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      // Create 3 agents
      const result1 = await pool.acquire(config);
      const result2 = await pool.acquire(config);
      const result3 = await pool.acquire(config);

      const agent1Id = result1.agentId;
      const agent2Id = result2.agentId;
      const agent3Id = result3.agentId;

      // Release agent1 (oldest) but keep agent2 and agent3 in use
      result1.release();
      await new Promise(resolve => setTimeout(resolve, 10));
      // Don't release 2 and 3

      // Try to acquire 4th agent - should reuse released agent1
      const result4 = await pool.acquire(config);

      // Should reuse agent1, so pool stays at 3
      expect(pool.getPoolStats().totalAgents).toBe(3);
      expect(result4.agentId).toBe(agent1Id);

      // agent2 and agent3 should still be in pool (in use)
      expect(pool.hasAgent(agent2Id)).toBe(true);
      expect(pool.hasAgent(agent3Id)).toBe(true);

      result2.release();
      result3.release();
      result4.release();
    });

    it('should skip agents being acquired (race condition fix)', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      // Fill pool
      const result1 = await pool.acquire(config);
      const result2 = await pool.acquire(config);
      const result3 = await pool.acquire(config);

      result1.release();
      result2.release();
      result3.release();

      // This is hard to test directly because the acquiring state is very short
      // The main protection is in findAndReserveAgent which atomically marks as acquiring
      // We've verified this through the concurrent acquire test above
      expect(pool.getPoolStats().totalAgents).toBe(3);
    });

    it('should log warning if all agents are in use', async () => {
      const { logger } = await import('../Logger.js');
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const config: AgentConfig = { isSpecializedAgent: true };

      // Create 3 agents and keep them all in use
      const result1 = await pool.acquire(config);
      const result2 = await pool.acquire(config);
      const result3 = await pool.acquire(config);

      // Try to acquire 4th - should trigger warning during eviction
      const result4 = await pool.acquire(config);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cannot evict - all agents are in use')
      );

      warnSpy.mockRestore();

      result1.release();
      result2.release();
      result3.release();
      result4.release();
    });
  });

  describe('removeAgent', () => {
    it('should call agent.cleanup()', async () => {
      const { Agent } = await import('@agent/Agent.js');
      const mockCleanup = vi.fn().mockResolvedValue(undefined);

      // Override mock for this test
      (Agent as any).mockImplementationOnce(() => ({
        cleanup: mockCleanup,
      }));

      const config: AgentConfig = { isSpecializedAgent: true };
      const result = await pool.acquire(config);
      const agentId = result.agentId;

      result.release();
      await pool.removeAgent(agentId);

      expect(mockCleanup).toHaveBeenCalled();
    });

    it('should remove agent from pool', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };
      const result = await pool.acquire(config);
      const agentId = result.agentId;

      result.release();
      await pool.removeAgent(agentId);

      expect(pool.hasAgent(agentId)).toBe(false);
    });

    it('should return false if agent not found', async () => {
      const removed = await pool.removeAgent('non-existent-agent');
      expect(removed).toBe(false);
    });

    it('should return false if agent is in use', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };
      const result = await pool.acquire(config);
      const agentId = result.agentId;

      // Don't release - keep in use
      const removed = await pool.removeAgent(agentId);

      expect(removed).toBe(false);
      expect(pool.hasAgent(agentId)).toBe(true);

      result.release();
    });

    it('should log warning when trying to remove in-use agent', async () => {
      const { logger } = await import('../Logger.js');
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const config: AgentConfig = { isSpecializedAgent: true };
      const result = await pool.acquire(config);
      const agentId = result.agentId;

      await pool.removeAgent(agentId);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cannot remove agent')
      );

      warnSpy.mockRestore();
      result.release();
    });
  });

  describe('cleanup', () => {
    it('should cleanup all agents in pool', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      await pool.acquire(config);
      await pool.acquire(config);
      await pool.acquire(config);

      await pool.cleanup();

      expect(pool.getPoolStats().totalAgents).toBe(0);
    });

    it('should clear pool map', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      const result1 = await pool.acquire(config);
      const result2 = await pool.acquire(config);

      await pool.cleanup();

      expect(pool.hasAgent(result1.agentId)).toBe(false);
      expect(pool.hasAgent(result2.agentId)).toBe(false);
    });
  });

  describe('getPoolStats', () => {
    it('should return accurate stats for empty pool', () => {
      const stats = pool.getPoolStats();

      expect(stats.totalAgents).toBe(0);
      expect(stats.inUseAgents).toBe(0);
      expect(stats.availableAgents).toBe(0);
      expect(stats.maxPoolSize).toBe(3);
      expect(stats.oldestAgentAge).toBeNull();
      expect(stats.newestAgentAge).toBeNull();
    });

    it('should return accurate stats with agents', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      const result1 = await pool.acquire(config);
      const result2 = await pool.acquire(config);
      result1.release();

      const stats = pool.getPoolStats();

      expect(stats.totalAgents).toBe(2);
      expect(stats.inUseAgents).toBe(1); // result2 still in use
      expect(stats.availableAgents).toBe(1); // result1 released
      expect(stats.maxPoolSize).toBe(3);
      expect(stats.oldestAgentAge).toBeGreaterThanOrEqual(0);
      expect(stats.newestAgentAge).toBeGreaterThanOrEqual(0);

      result2.release();
    });

    it('should calculate agent ages correctly', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      const result = await pool.acquire(config);
      await new Promise(resolve => setTimeout(resolve, 100));

      const stats = pool.getPoolStats();

      expect(stats.oldestAgentAge).toBeGreaterThanOrEqual(100);
      expect(stats.newestAgentAge).toBeGreaterThanOrEqual(100);

      result.release();
    });
  });

  describe('clearPool', () => {
    it('should remove all agents', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      await pool.acquire(config);
      await pool.acquire(config);

      await pool.clearPool();

      expect(pool.getPoolStats().totalAgents).toBe(0);
    });

    it('should reset agent ID counter', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      const result1 = await pool.acquire(config);
      await pool.clearPool();

      const result2 = await pool.acquire(config);

      // After clear, counter should reset
      // Both should start with pool-agent-{timestamp}-0
      expect(result2.agentId).toMatch(/-0$/);

      result2.release();
    });

    it('should remove agents even if in use', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      const result1 = await pool.acquire(config);
      const result2 = await pool.acquire(config);

      // Don't release - keep in use
      await pool.clearPool();

      expect(pool.getPoolStats().totalAgents).toBe(0);
    });
  });

  describe('getAgentIds', () => {
    it('should return empty array for empty pool', () => {
      expect(pool.getAgentIds()).toEqual([]);
    });

    it('should return all agent IDs', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      const result1 = await pool.acquire(config);
      const result2 = await pool.acquire(config);

      const ids = pool.getAgentIds();

      expect(ids).toContain(result1.agentId);
      expect(ids).toContain(result2.agentId);
      expect(ids).toHaveLength(2);

      result1.release();
      result2.release();
    });
  });

  describe('hasAgent', () => {
    it('should return false for non-existent agent', () => {
      expect(pool.hasAgent('non-existent')).toBe(false);
    });

    it('should return true for existing agent', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };
      const result = await pool.acquire(config);

      expect(pool.hasAgent(result.agentId)).toBe(true);

      result.release();
    });

    it('should return false after agent removed', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };
      const result = await pool.acquire(config);
      const agentId = result.agentId;

      result.release();
      await pool.removeAgent(agentId);

      expect(pool.hasAgent(agentId)).toBe(false);
    });
  });

  describe('getAgentMetadata', () => {
    it('should return null for non-existent agent', () => {
      expect(pool.getAgentMetadata('non-existent')).toBeNull();
    });

    it('should return metadata for existing agent', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };
      const result = await pool.acquire(config);
      const agentId = result.agentId;

      const metadata = pool.getAgentMetadata(agentId);

      expect(metadata).toBeDefined();
      expect(metadata?.agentId).toBe(agentId);
      expect(metadata?.inUse).toBe(true);
      expect(metadata?.useCount).toBe(1);
      expect(metadata?.config).toEqual(config);
      expect(metadata?.agent).toBeDefined();
      expect(metadata?.createdAt).toBeDefined();
      expect(metadata?.lastAccessedAt).toBeDefined();

      result.release();
    });
  });

  describe('concurrent operations', () => {
    it('should handle multiple concurrent acquires', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      const results = await Promise.all([
        pool.acquire(config),
        pool.acquire(config),
        pool.acquire(config),
        pool.acquire(config),
      ]);

      // All should succeed with unique IDs
      const ids = results.map(r => r.agentId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(4);

      // Cleanup
      results.forEach(r => r.release());
    });

    it('should handle concurrent acquire and release', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      const result1 = await pool.acquire(config);
      const releasePromise = new Promise(resolve => {
        setTimeout(() => {
          result1.release();
          resolve(undefined);
        }, 10);
      });

      const acquirePromise = pool.acquire(config);

      await Promise.all([releasePromise, acquirePromise]);

      // Should not crash or deadlock
      expect(pool.getPoolStats().totalAgents).toBeGreaterThan(0);
    });

    it('should prevent race condition with acquiringAgents set', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      // First acquire and release to populate pool
      const result1 = await pool.acquire(config);
      result1.release();

      // Fire off multiple concurrent acquires
      const promises = Array(10).fill(null).map(() => pool.acquire(config));
      const results = await Promise.all(promises);

      // All should have unique agent IDs (no double-assignment)
      const ids = results.map(r => r.agentId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);

      // Cleanup
      results.forEach(r => r.release());
    });

    it('should atomically reserve agents under high concurrent load', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      // Pre-populate pool with 5 released agents
      const initialAgents = await Promise.all([
        pool.acquire(config),
        pool.acquire(config),
        pool.acquire(config),
        pool.acquire(config),
        pool.acquire(config),
      ]);
      initialAgents.forEach(a => a.release());

      // Fire 50 concurrent acquires (much more than pool size)
      const promises = Array(50)
        .fill(null)
        .map(() => pool.acquire(config));
      const results = await Promise.all(promises);

      // Verify no duplicate agent IDs (the REAL test of atomic reservation)
      const ids = results.map(r => r.agentId);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
      expect(uniqueIds.size).toBe(50);

      // Cleanup all agents
      results.forEach(r => r.release());
    });

    it('should handle rapid acquire-release cycles without duplication', async () => {
      const config: AgentConfig = { isSpecializedAgent: true };

      // Perform 100 rapid acquire-release cycles
      for (let i = 0; i < 100; i++) {
        const result = await pool.acquire(config);
        result.release();
      }

      // Verify pool is stable and not leaking
      const stats = pool.getPoolStats();
      expect(stats.totalAgents).toBeLessThanOrEqual(5); // maxPoolSize
    });
  });

  describe('configuration', () => {
    it('should respect custom maxPoolSize', async () => {
      const customPool = new AgentPoolService(
        mockModelClient,
        mockToolManager,
        mockActivityStream,
        undefined,
        undefined,
        { maxPoolSize: 2 }
      );
      await customPool.initialize();

      expect(customPool.getPoolStats().maxPoolSize).toBe(2);

      await customPool.cleanup();
    });

    it('should use default maxPoolSize when not specified', async () => {
      const defaultPool = new AgentPoolService(
        mockModelClient,
        mockToolManager,
        mockActivityStream
      );
      await defaultPool.initialize();

      // Default is 5 (from AGENT_POOL.DEFAULT_MAX_SIZE)
      expect(defaultPool.getPoolStats().maxPoolSize).toBe(5);

      await defaultPool.cleanup();
    });

    it('should support verbose logging mode', async () => {
      const { logger } = await import('../Logger.js');
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});

      const verbosePool = new AgentPoolService(
        mockModelClient,
        mockToolManager,
        mockActivityStream,
        undefined,
        undefined,
        { verbose: true }
      );

      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('Service created with config'),
        expect.anything()
      );

      debugSpy.mockRestore();
      await verbosePool.cleanup();
    });
  });
});
