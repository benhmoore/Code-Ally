/**
 * AgentPoolService - Manages a pool of concurrent agent instances
 *
 * Provides resource pooling for agent instances with:
 * - Pool size management with configurable limits
 * - LRU (Least Recently Used) eviction policy when at capacity
 * - Agent metadata tracking and lifecycle management
 * - Thread-safe operations with proper cleanup
 *
 * The service maintains a pool of reusable agent instances to reduce initialization
 * overhead and enable efficient concurrent agent execution. Agents are evicted from
 * the pool when the pool reaches capacity using LRU policy.
 */

import { IService } from '../types/index.js';
import { logger } from './Logger.js';
import { Agent, AgentConfig } from '../agent/Agent.js';
import { ModelClient } from '../llm/ModelClient.js';
import { ToolManager } from '../tools/ToolManager.js';
import { ActivityStream } from './ActivityStream.js';
import { ConfigManager } from './ConfigManager.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { AGENT_POOL } from '../config/constants.js';

/**
 * Configuration for AgentPoolService
 */
export interface AgentPoolConfig {
  /** Maximum number of agents to keep in the pool (default: 5) */
  maxPoolSize?: number;
  /** Enable verbose logging for pool operations (default: false) */
  verbose?: boolean;
}

/**
 * Metadata tracking for pooled agents
 */
export interface AgentMetadata {
  /** Unique identifier for this agent instance */
  agentId: string;
  /** The agent instance */
  agent: Agent;
  /** Timestamp when agent was created */
  createdAt: number;
  /** Timestamp when agent was last accessed */
  lastAccessedAt: number;
  /** Number of times this agent has been used */
  useCount: number;
  /** Whether agent is currently in use */
  inUse: boolean;
  /** Agent configuration used for creation */
  config: AgentConfig;
}

/**
 * Result returned when acquiring an agent from the pool
 */
export interface PooledAgent {
  /** The agent instance */
  agent: Agent;
  /** Unique identifier for this agent */
  agentId: string;
  /** Function to return the agent to the pool */
  release: () => void;
}

/**
 * AgentPoolService manages a pool of reusable agent instances
 *
 * This service follows the singleton pattern and implements IService for
 * proper lifecycle management within the ServiceRegistry.
 */
export class AgentPoolService implements IService {
  private pool: Map<string, AgentMetadata> = new Map();
  private modelClient: ModelClient;
  private toolManager: ToolManager;
  private activityStream: ActivityStream;
  private configManager?: ConfigManager;
  private permissionManager?: PermissionManager;
  private config: Required<AgentPoolConfig>;
  private nextAgentId: number = 0;
  // Track agents currently being acquired to prevent race conditions
  private acquiringAgents: Set<string> = new Set();

  /**
   * Create a new AgentPoolService
   *
   * @param modelClient - LLM client for agent creation
   * @param toolManager - Tool manager for agent creation
   * @param activityStream - Activity stream for event emission
   * @param configManager - Optional configuration manager
   * @param permissionManager - Optional permission manager
   * @param config - Pool configuration options
   */
  constructor(
    modelClient: ModelClient,
    toolManager: ToolManager,
    activityStream: ActivityStream,
    configManager?: ConfigManager,
    permissionManager?: PermissionManager,
    config: AgentPoolConfig = {}
  ) {
    this.modelClient = modelClient;
    this.toolManager = toolManager;
    this.activityStream = activityStream;
    this.configManager = configManager;
    this.permissionManager = permissionManager;

    // Apply defaults to configuration
    this.config = {
      maxPoolSize: config.maxPoolSize ?? AGENT_POOL.DEFAULT_MAX_SIZE,
      verbose: config.verbose ?? false,
    };

    if (this.config.verbose) {
      logger.debug('[AGENT_POOL] Service created with config:', this.config);
    }
  }

  /**
   * Initialize the service
   *
   * Called automatically by ServiceRegistry after construction.
   */
  async initialize(): Promise<void> {
    logger.debug('[AGENT_POOL] Initializing service');
    logger.debug('[AGENT_POOL] Service initialized');
  }

  /**
   * Cleanup resources and shutdown the service
   *
   * Cleans up all pooled agents.
   * Called automatically by ServiceRegistry during shutdown.
   */
  async cleanup(): Promise<void> {
    logger.debug('[AGENT_POOL] Cleanup started');

    // Cleanup all agents in the pool
    const cleanupPromises: Promise<void>[] = [];
    for (const [agentId, metadata] of this.pool.entries()) {
      cleanupPromises.push(
        metadata.agent.cleanup().catch(error => {
          logger.error(`[AGENT_POOL] Error cleaning up agent ${agentId}:`, error);
        })
      );
    }

    await Promise.all(cleanupPromises);
    this.pool.clear();

    logger.debug('[AGENT_POOL] Cleanup completed');
  }

  /**
   * Acquire an agent from the pool or create a new one
   *
   * Implements LRU eviction when pool is at capacity. Returns a PooledAgent
   * object with a release() method to return the agent to the pool.
   *
   * Uses atomic reservation to prevent race conditions:
   * - findAndReserveAgent() marks the agent as acquiring BEFORE returning it
   * - This happens synchronously in a single function, making it atomic
   * - Only one caller can acquire a given agent at a time
   * - Cleanup in finally block ensures acquiring set is properly maintained
   *
   * @param agentConfig - Configuration for the agent
   * @param customToolManager - Optional custom ToolManager (e.g., filtered tools for read-only agents)
   * @param customModelClient - Optional custom ModelClient (e.g., for agents with different models)
   * @returns PooledAgent with release function
   */
  async acquire(agentConfig: AgentConfig, customToolManager?: ToolManager, customModelClient?: ModelClient): Promise<PooledAgent> {
    // If requesting initial messages (context files), always create a fresh agent
    // to avoid context pollution from previous tasks
    const shouldCreateFresh = agentConfig.initialMessages && agentConfig.initialMessages.length > 0;

    const reserved = shouldCreateFresh ? null : this.findAndReserveAgent(agentConfig);

    if (reserved) {
      try {
        // Mark as in use and update metadata
        reserved.metadata.inUse = true;
        reserved.metadata.lastAccessedAt = Date.now();
        reserved.metadata.useCount++;

        // CRITICAL: Clear nested delegation state before reusing agent
        // When reusing a pooled agent, we must clear any stale nested delegation contexts
        // from previous tasks to prevent findDeepestDelegation() from routing to dead agent instances
        //
        // Scenario that this prevents:
        // 1. Main → Agent1 (pool-agent-1) → Agent2
        // 2. Agent2 delegation registered in Agent1's DelegationContextManager
        // 3. Agent1 completes, released to pool
        // 4. Main → Agent1 (same pool-agent-1 reused) → Agent3
        // 5. User interjects
        // 6. findDeepestDelegation() finds STALE Agent2 delegation in Agent1's manager
        // 7. Routes to dead Agent2 instance → CRASH
        //
        // Chain: agent → toolOrchestrator → toolManager → delegationContextManager
        // Use defensive programming with optional chaining to handle missing methods
        try {
          const agent = reserved.metadata.agent;
          // Check if getToolOrchestrator method exists (may not exist in mock agents or older versions)
          if (typeof agent.getToolOrchestrator === 'function') {
            const toolOrchestrator = agent.getToolOrchestrator();
            if (toolOrchestrator && typeof toolOrchestrator.getToolManager === 'function') {
              const toolManager = toolOrchestrator.getToolManager();
              if (toolManager && typeof toolManager.getDelegationContextManager === 'function') {
                const delegationManager = toolManager.getDelegationContextManager();
                if (delegationManager && typeof delegationManager.clearAll === 'function') {
                  delegationManager.clearAll();
                  logger.debug(
                    `[AGENT_POOL] Cleared nested delegation state for reused agent ${reserved.metadata.agentId}`
                  );
                }
              }
            }
          }
        } catch (error) {
          // Graceful degradation - if we can't clear delegation state, log and continue
          // This shouldn't prevent agent reuse, but we should know about it
          logger.warn(
            `[AGENT_POOL] Failed to clear delegation state for agent ${reserved.metadata.agentId}:`,
            error
          );
        }

        // CRITICAL: Clear conversation history before reusing agent
        // System prompt will be regenerated dynamically in sendMessage() with current context
        try {
          const agent = reserved.metadata.agent;
          if (typeof agent.clearConversationHistory === 'function') {
            agent.clearConversationHistory();
            logger.debug(
              `[AGENT_POOL] Cleared conversation history for reused agent ${reserved.metadata.agentId}`
            );
          }
        } catch (error) {
          logger.warn(
            `[AGENT_POOL] Failed to clear conversation history for agent ${reserved.metadata.agentId}:`,
            error
          );
        }

        // CRITICAL: Execution context is passed fresh to sendMessage()
        // When reusing pooled agents, we pass execution context (parentCallId, maxDuration,
        // thoroughness) as parameters to sendMessage() instead of mutating agent state.
        // This prevents stale state and ensures correct event nesting for each invocation.
        //
        // The execution context is extracted from agentConfig and passed to each tool invocation.

        logger.debug(
          `[AGENT_POOL] Reusing agent ${reserved.metadata.agentId} (uses: ${reserved.metadata.useCount})`
        );

        return {
          agent: reserved.metadata.agent,
          agentId: reserved.metadata.agentId,
          release: () => this.release(reserved.metadata.agentId),
        };
      } finally {
        // Remove from acquiring set now that acquisition is complete
        this.acquiringAgents.delete(reserved.metadata.agentId);
      }
    }

    // No available agent - create new one
    // Check if pool is at capacity and evict LRU if needed
    if (this.pool.size >= this.config.maxPoolSize) {
      this.evictLRU();
    }

    const agentId = this.generateAgentId();

    // Use custom ToolManager if provided, otherwise use default
    const toolManager = customToolManager || this.toolManager;

    if (customToolManager) {
      logger.debug(`[AGENT_POOL] Creating agent ${agentId} with custom ToolManager (filtered tools)`);
    } else {
      logger.debug(`[AGENT_POOL] Creating agent ${agentId} with default ToolManager (all tools)`);
    }

    // Use custom ModelClient if provided, otherwise use default
    const modelClient = customModelClient || this.modelClient;

    if (customModelClient) {
      logger.debug(`[AGENT_POOL] Creating agent ${agentId} with custom ModelClient`);
    } else {
      logger.debug(`[AGENT_POOL] Creating agent ${agentId} with default ModelClient`);
    }

    // Create agent with error handling
    let agent: Agent;
    try {
      agent = new Agent(
        modelClient,
        toolManager,
        this.activityStream,
        agentConfig,
        this.configManager,
        this.permissionManager
      );
    } catch (error) {
      logger.error('[AGENT_POOL] Failed to create agent:', error);
      throw error; // Re-throw to caller
    }

    const metadata: AgentMetadata = {
      agentId,
      agent,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      useCount: 1,
      inUse: true,
      config: agentConfig,
    };

    this.pool.set(agentId, metadata);

    logger.debug(`[AGENT_POOL] Created new agent ${agentId} (pool size: ${this.pool.size})`);

    return {
      agent,
      agentId,
      release: () => this.release(agentId),
    };
  }

  /**
   * Release an agent back to the pool
   *
   * Marks the agent as available for reuse. Does not remove from pool.
   *
   * @param agentId - ID of the agent to release
   */
  private release(agentId: string): void {
    const metadata = this.pool.get(agentId);
    if (!metadata) {
      logger.warn(`[AGENT_POOL] Attempted to release unknown agent ${agentId}`);
      return;
    }

    metadata.inUse = false;
    metadata.lastAccessedAt = Date.now();

    logger.debug(`[AGENT_POOL] Released agent ${agentId}`);
  }

  /**
   * Find an available agent with matching configuration and atomically reserve it
   *
   * This method is atomic because it marks the agent as acquiring BEFORE returning it.
   * Since this runs synchronously in a single function, there's no race window where
   * two callers could get the same agent.
   *
   * The agent is added to acquiringAgents before the metadata is returned, ensuring
   * that any subsequent call to this method will skip this agent.
   *
   * @param agentConfig - Desired agent configuration
   * @returns Object with reserved agent metadata, or null if no agent available
   */
  private findAndReserveAgent(agentConfig: AgentConfig): { metadata: AgentMetadata } | null {
    for (const metadata of this.pool.values()) {
      // Skip if agent is in use or currently being acquired
      if (metadata.inUse || this.acquiringAgents.has(metadata.agentId)) {
        continue;
      }

      // Check if configuration matches
      let matches = false;

      // CRITICAL: Prevent cross-type agent reuse
      // If EITHER side has a pool key, BOTH must have matching pool keys
      // This prevents math-expert from reusing explore agents (and vice versa)
      if (agentConfig._poolKey || metadata.config._poolKey) {
        // If only one side has a pool key, they cannot match
        if (!agentConfig._poolKey || !metadata.config._poolKey) {
          continue; // Skip this agent - incompatible pool key configuration
        }
        // Both have pool keys - use strict matching
        matches = metadata.config._poolKey === agentConfig._poolKey;
      } else {
        // Both lack pool keys - use fallback logic for old ExploreTool/PlanTool
        // This allows explore and plan agents to share pools
        matches = metadata.config.isSpecializedAgent === agentConfig.isSpecializedAgent;
      }

      if (!matches) {
        continue;
      }

      // ATOMICALLY reserve this agent before returning
      // This is the critical operation that prevents race conditions
      this.acquiringAgents.add(metadata.agentId);

      logger.debug(`[AGENT_POOL] Reserved agent ${metadata.agentId} for acquisition`);

      return { metadata };
    }

    return null;
  }

  /**
   * Evict the least recently used agent from the pool
   *
   * Finds the agent with the oldest lastAccessedAt timestamp that is not
   * currently in use and removes it from the pool.
   */
  private evictLRU(): void {
    let lruAgent: AgentMetadata | null = null;
    let lruTime: number = Infinity;

    // Find least recently used agent that is not in use or being acquired
    for (const metadata of this.pool.values()) {
      if (metadata.inUse || this.acquiringAgents.has(metadata.agentId)) {
        continue;
      }

      if (metadata.lastAccessedAt < lruTime) {
        lruTime = metadata.lastAccessedAt;
        lruAgent = metadata;
      }
    }

    if (lruAgent) {
      this.evictAgent(lruAgent.agentId);
      logger.debug(
        `[AGENT_POOL] Evicted LRU agent ${lruAgent.agentId} (last used: ${new Date(lruTime).toISOString()})`
      );
    } else {
      logger.warn(
        '[AGENT_POOL] Cannot evict - all agents are in use. Pool may temporarily exceed maxPoolSize.'
      );
    }
  }

  /**
   * Evict a specific agent from the pool
   *
   * Removes the agent from the pool and triggers cleanup.
   * Does not wait for cleanup to complete.
   *
   * @param agentId - ID of the agent to evict
   */
  private evictAgent(agentId: string): void {
    const metadata = this.pool.get(agentId);
    if (!metadata) {
      return;
    }

    this.pool.delete(agentId);

    // Trigger cleanup but don't wait for it
    metadata.agent.cleanup().catch(error => {
      logger.error(`[AGENT_POOL] Error cleaning up evicted agent ${agentId}:`, error);
    });
  }

  /**
   * Generate a unique agent ID
   *
   * Uses sequential numbering with timestamp for uniqueness.
   *
   * @returns Unique agent ID string
   */
  private generateAgentId(): string {
    const id = `pool-agent-${Date.now()}-${this.nextAgentId}`;
    this.nextAgentId++;
    return id;
  }

  /**
   * Get current pool statistics
   *
   * Returns information about the current state of the pool for
   * monitoring and debugging purposes.
   *
   * @returns Pool statistics object
   */
  getPoolStats(): {
    totalAgents: number;
    inUseAgents: number;
    availableAgents: number;
    maxPoolSize: number;
    oldestAgentAge: number | null;
    newestAgentAge: number | null;
  } {
    let inUse = 0;
    let oldestTime: number | null = null;
    let newestTime: number | null = null;
    const now = Date.now();

    for (const metadata of this.pool.values()) {
      if (metadata.inUse) {
        inUse++;
      }

      const age = now - metadata.createdAt;
      if (oldestTime === null || age > oldestTime) {
        oldestTime = age;
      }
      if (newestTime === null || age < newestTime) {
        newestTime = age;
      }
    }

    return {
      totalAgents: this.pool.size,
      inUseAgents: inUse,
      availableAgents: this.pool.size - inUse,
      maxPoolSize: this.config.maxPoolSize,
      oldestAgentAge: oldestTime,
      newestAgentAge: newestTime,
    };
  }

  /**
   * Clear all agents from the pool
   *
   * Removes and cleans up all agents, including those in use.
   * Use with caution - may interrupt active operations.
   */
  async clearPool(): Promise<void> {
    logger.debug('[AGENT_POOL] Clearing pool');

    const cleanupPromises: Promise<void>[] = [];
    for (const [agentId, metadata] of this.pool.entries()) {
      cleanupPromises.push(
        metadata.agent.cleanup().catch(error => {
          logger.error(`[AGENT_POOL] Error cleaning up agent ${agentId}:`, error);
        })
      );
    }

    await Promise.all(cleanupPromises);
    this.pool.clear();
    this.nextAgentId = 0;

    logger.debug('[AGENT_POOL] Pool cleared');
  }

  /**
   * Get all agent IDs currently in the pool
   *
   * Returns an array of all agent IDs, useful for debugging and monitoring.
   *
   * @returns Array of agent ID strings
   */
  getAgentIds(): string[] {
    return Array.from(this.pool.keys());
  }

  /**
   * Check if an agent exists in the pool
   *
   * @param agentId - ID of the agent to check
   * @returns True if agent exists in pool
   */
  hasAgent(agentId: string): boolean {
    return this.pool.has(agentId);
  }

  /**
   * Get metadata for a specific agent
   *
   * @param agentId - ID of the agent
   * @returns Agent metadata or null if not found
   */
  getAgentMetadata(agentId: string): AgentMetadata | null {
    return this.pool.get(agentId) ?? null;
  }

  /**
   * Remove a specific agent from the pool
   *
   * This is a public interface for evicting a specific agent.
   * The agent must not be in use.
   *
   * @param agentId - ID of the agent to remove
   * @returns True if agent was removed, false if not found or in use
   */
  async removeAgent(agentId: string): Promise<boolean> {
    const metadata = this.pool.get(agentId);
    if (!metadata) {
      return false;
    }

    if (metadata.inUse) {
      logger.warn(`[AGENT_POOL] Cannot remove agent ${agentId} - currently in use`);
      return false;
    }

    this.evictAgent(agentId);
    logger.debug(`[AGENT_POOL] Manually removed agent ${agentId}`);
    return true;
  }

  /**
   * Evict all agents belonging to a specific plugin
   *
   * Used when a plugin is reloaded to ensure pooled agents don't use stale
   * system prompts. Matches agents where _poolKey starts with "plugin-{pluginName}-".
   * Agents currently in use are NOT evicted to avoid interrupting active operations.
   *
   * @param pluginName - Name of the plugin whose agents should be evicted
   * @returns Number of agents evicted
   */
  evictPluginAgents(pluginName: string): number {
    const prefix = `plugin-${pluginName}-`;
    const toEvict: string[] = [];

    for (const [agentId, metadata] of this.pool.entries()) {
      // Check if this agent belongs to the plugin
      if (metadata.config._poolKey?.startsWith(prefix)) {
        // Skip agents currently in use
        if (metadata.inUse) {
          logger.debug(
            `[AGENT_POOL] Skipping eviction of in-use agent ${agentId} for plugin '${pluginName}'`
          );
          continue;
        }
        toEvict.push(agentId);
      }
    }

    for (const agentId of toEvict) {
      this.evictAgent(agentId);
    }

    if (toEvict.length > 0) {
      logger.debug(
        `[AGENT_POOL] Evicted ${toEvict.length} pooled agent(s) for plugin '${pluginName}'`
      );
    }

    return toEvict.length;
  }
}
