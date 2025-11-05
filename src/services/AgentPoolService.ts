/**
 * AgentPoolService - Manages a pool of concurrent agent instances
 *
 * Provides resource pooling for agent instances with:
 * - Pool size management with configurable limits
 * - LRU (Least Recently Used) eviction policy
 * - Idle timeout eviction for inactive agents
 * - Agent metadata tracking and lifecycle management
 * - Thread-safe operations with proper cleanup
 *
 * The service maintains a pool of reusable agent instances to reduce initialization
 * overhead and enable efficient concurrent agent execution. Agents are evicted from
 * the pool when idle for too long or when the pool reaches capacity using LRU policy.
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
  /** Idle timeout in milliseconds before evicting an agent (default: 5 minutes) */
  idleTimeoutMs?: number;
  /** Cleanup interval in milliseconds for eviction checks (default: 1 minute) */
  cleanupIntervalMs?: number;
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
  private cleanupInterval: NodeJS.Timeout | null = null;
  private nextAgentId: number = 0;

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
      idleTimeoutMs: config.idleTimeoutMs ?? AGENT_POOL.DEFAULT_IDLE_TIMEOUT_MS,
      cleanupIntervalMs: config.cleanupIntervalMs ?? AGENT_POOL.DEFAULT_CLEANUP_INTERVAL_MS,
      verbose: config.verbose ?? false,
    };

    if (this.config.verbose) {
      logger.debug('[AGENT_POOL] Service created with config:', this.config);
    }
  }

  /**
   * Initialize the service
   *
   * Starts the cleanup interval for idle agent eviction.
   * Called automatically by ServiceRegistry after construction.
   */
  async initialize(): Promise<void> {
    logger.debug('[AGENT_POOL] Initializing service');

    // Start cleanup interval for idle timeout eviction
    this.cleanupInterval = setInterval(() => {
      this.evictIdleAgents();
    }, this.config.cleanupIntervalMs);

    logger.debug('[AGENT_POOL] Service initialized');
  }

  /**
   * Cleanup resources and shutdown the service
   *
   * Stops the cleanup interval and cleans up all pooled agents.
   * Called automatically by ServiceRegistry during shutdown.
   */
  async cleanup(): Promise<void> {
    logger.debug('[AGENT_POOL] Cleanup started');

    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

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
   * @param agentConfig - Configuration for the agent
   * @param customToolManager - Optional custom ToolManager (e.g., filtered tools for read-only agents)
   * @returns PooledAgent with release function
   */
  async acquire(agentConfig: AgentConfig, customToolManager?: ToolManager): Promise<PooledAgent> {
    // Try to find an available agent with matching configuration
    const availableAgent = this.findAvailableAgent(agentConfig);

    if (availableAgent) {
      // Reuse existing agent
      availableAgent.inUse = true;
      availableAgent.lastAccessedAt = Date.now();
      availableAgent.useCount++;

      logger.debug(
        `[AGENT_POOL] Reusing agent ${availableAgent.agentId} (uses: ${availableAgent.useCount})`
      );

      return {
        agent: availableAgent.agent,
        agentId: availableAgent.agentId,
        release: () => this.release(availableAgent.agentId),
      };
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

    // Create agent with error handling
    let agent: Agent;
    try {
      agent = new Agent(
        this.modelClient,
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
   * Find an available agent with matching configuration
   *
   * Searches for an agent that is not in use and has compatible configuration.
   * Uses _poolKey for strict matching when available (for AgentTool custom agents),
   * otherwise falls back to isSpecializedAgent matching (for ExploreTool/PlanTool).
   *
   * @param agentConfig - Desired agent configuration
   * @returns Available agent metadata or null
   */
  private findAvailableAgent(agentConfig: AgentConfig): AgentMetadata | null {
    for (const metadata of this.pool.values()) {
      if (metadata.inUse) {
        continue;
      }

      // If _poolKey exists, use strict matching
      if (agentConfig._poolKey && metadata.config._poolKey) {
        if (metadata.config._poolKey === agentConfig._poolKey) {
          return metadata;
        }
      } else if (metadata.config.isSpecializedAgent === agentConfig.isSpecializedAgent) {
        // Fallback to old logic for ExploreTool/PlanTool
        return metadata;
      }
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

    // Find least recently used agent that is not in use
    for (const metadata of this.pool.values()) {
      if (metadata.inUse) {
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
   * Evict idle agents that have exceeded the idle timeout
   *
   * Called periodically by the cleanup interval. Removes agents that have
   * been idle for longer than idleTimeoutMs.
   */
  private evictIdleAgents(): void {
    const now = Date.now();
    const idsToEvict: string[] = [];

    for (const [agentId, metadata] of this.pool.entries()) {
      if (metadata.inUse) {
        continue;
      }

      const idleTime = now - metadata.lastAccessedAt;
      if (idleTime > this.config.idleTimeoutMs) {
        idsToEvict.push(agentId);
      }
    }

    for (const agentId of idsToEvict) {
      this.evictAgent(agentId);
      logger.debug(`[AGENT_POOL] Evicted idle agent ${agentId}`);
    }

    if (idsToEvict.length > 0) {
      logger.debug(`[AGENT_POOL] Evicted ${idsToEvict.length} idle agent(s)`);
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
}
