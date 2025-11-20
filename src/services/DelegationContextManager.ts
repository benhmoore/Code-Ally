/**
 * DelegationContextManager - Centralized delegation state tracking
 *
 * Manages the lifecycle and state of all active delegations in the interjection
 * routing system. Supports concurrent delegations and recursive delegation
 * hierarchies (Main → Agent1 → Agent2 → ...).
 *
 * Core responsibilities:
 * - Track all active delegations across the system
 * - Manage delegation lifecycle: register → transitionToCompleting → clear
 * - Find the deepest active delegation for interjection routing
 * - Support recursive depth-first search through nested agent hierarchies
 *
 * Thread Safety:
 * JavaScript is single-threaded, so no synchronization primitives are needed.
 * However, methods are not re-entrant - avoid calling manager methods from
 * within callbacks or event handlers that might trigger recursion.
 */

import { PooledAgent } from './AgentPoolService.js';
import { logger } from './Logger.js';
import { AGENT_CONFIG } from '../config/constants.js';

/**
 * Lifecycle state of a delegation
 * - executing: Agent is actively processing the task
 * - completing: Agent finished execution, parent processing result
 */
export type DelegationState = 'executing' | 'completing';

/**
 * Context tracking for a single delegation
 */
export interface DelegationContext {
  /** Unique identifier for this delegation (tool call ID) */
  callId: string;
  /** Tool that initiated the delegation ('agent', 'explore', or 'plan') */
  toolName: string;
  /** Current lifecycle state */
  state: DelegationState;
  /** The pooled agent handling this delegation */
  pooledAgent: PooledAgent;
  /** Timestamp when delegation started (for ordering) */
  timestamp: number;
}

/**
 * Result returned by getActiveDelegation()
 */
export interface ActiveDelegation {
  /** Tool name of the active delegation */
  toolName: string;
  /** Call ID of the active delegation */
  callId: string;
  /** Pooled agent handling the delegation */
  pooledAgent: PooledAgent;
  /** Timestamp when delegation was registered */
  timestamp: number;
}

/**
 * DelegationContextManager manages delegation state tracking
 *
 * This service centralizes delegation context management for the interjection
 * routing system. It tracks delegation lifecycle and provides depth-first
 * search to find the deepest active delegation in nested agent hierarchies.
 */
export class DelegationContextManager {
  /** Map of call ID to delegation context */
  private contexts: Map<string, DelegationContext> = new Map();

  /**
   * Register a new delegation
   *
   * Adds a delegation context in 'executing' state. This should be called
   * when an agent delegation starts (e.g., AgentTool.execute begins).
   *
   * @param callId - Unique identifier for this delegation (tool call ID)
   * @param toolName - Tool initiating the delegation ('agent', 'explore', 'plan')
   * @param pooledAgent - The pooled agent handling this delegation
   */
  register(callId: string, toolName: string, pooledAgent: PooledAgent): void {
    // Validate state transition - warn if callId already exists
    if (this.contexts.has(callId)) {
      logger.warn(
        `[DELEGATION_CONTEXT] register: callId=${callId} tool=${toolName} already exists (state=${this.contexts.get(callId)?.state}). Overwriting.`
      );
    }

    // Check concurrent delegation limit
    if (this.contexts.size >= AGENT_CONFIG.MAX_CONCURRENT_DELEGATIONS) {
      logger.warn(
        `[DELEGATION_CONTEXT] register: max concurrent delegations (${AGENT_CONFIG.MAX_CONCURRENT_DELEGATIONS}) reached. Current: ${this.contexts.size}. Proceeding anyway.`
      );
    }

    const context: DelegationContext = {
      callId,
      toolName,
      state: 'executing',
      pooledAgent,
      timestamp: Date.now(),
    };

    this.contexts.set(callId, context);

    logger.debug(
      `[DELEGATION_CONTEXT] register: callId=${callId} tool=${toolName} state=executing`
    );
  }

  /**
   * Transition delegation from 'executing' to 'completing'
   *
   * Marks the delegation as completing when the agent finishes execution.
   * The delegation remains active for interjection routing until clear() is called.
   *
   * @param callId - Call ID of the delegation to transition
   */
  transitionToCompleting(callId: string): void {
    const context = this.contexts.get(callId);

    if (!context) {
      logger.warn(
        `[DELEGATION_CONTEXT] transitionToCompleting: callId=${callId} not found. Cannot transition.`
      );
      return;
    }

    // Validate state transition
    if (context.state !== 'executing') {
      logger.warn(
        `[DELEGATION_CONTEXT] transitionToCompleting: callId=${callId} tool=${context.toolName} invalid transition from state=${context.state}. Expected 'executing'.`
      );
    }

    context.state = 'completing';

    logger.debug(
      `[DELEGATION_CONTEXT] transitionToCompleting: callId=${callId} tool=${context.toolName} state=completing`
    );
  }

  /**
   * Clear (remove) a delegation
   *
   * Removes the delegation from tracking. This should be called when the
   * parent tool finishes processing the agent's result.
   *
   * @param callId - Call ID of the delegation to clear
   */
  clear(callId: string): void {
    const context = this.contexts.get(callId);

    if (!context) {
      logger.warn(
        `[DELEGATION_CONTEXT] clear: callId=${callId} not found. Nothing to clear.`
      );
      return;
    }

    this.contexts.delete(callId);

    logger.debug(
      `[DELEGATION_CONTEXT] clear: callId=${callId} tool=${context.toolName} removed`
    );
  }

  /**
   * Get a delegation context by call ID
   *
   * Returns the full delegation context for the given call ID, or undefined if not found.
   * This is useful for accessing delegation metadata like timestamp.
   *
   * @param callId - Call ID of the delegation to retrieve
   * @returns DelegationContext if found, undefined otherwise
   */
  getContext(callId: string): DelegationContext | undefined {
    return this.contexts.get(callId);
  }

  /**
   * Get the deepest active delegation for interjection routing
   *
   * Performs recursive depth-first search through nested agent hierarchies
   * to find the deepest delegation in 'executing' state.
   *
   * IMPORTANT: Only routes to 'executing' delegations, NOT 'completing'.
   * This prevents race conditions where interjections route to dying/dead agents:
   * - 'executing' = active delegation, capable of receiving interjections
   * - 'completing' = agent done, parent processing result, NO interjections
   *
   * The 'completing' state exists to track lifecycle (agent finished but not yet
   * cleaned up by parent), but interjections should never route to completing agents
   * since they may already be released to the pool or cleaned up.
   *
   * Algorithm:
   * 1. Find all contexts in 'executing' state (NOT 'completing')
   * 2. For each context, recursively check for nested delegations in sub-agents
   * 3. Return the deepest delegation found (nested takes priority)
   * 4. If multiple delegations at same depth, return most recent (highest timestamp)
   *
   * @returns ActiveDelegation if found, undefined if no active delegations
   */
  getActiveDelegation(): ActiveDelegation | undefined {
    // Collect only executing contexts (NOT completing)
    // Completing agents are dying/dead and cannot receive interjections
    const activeContexts = Array.from(this.contexts.values()).filter(
      ctx => ctx.state === 'executing'
    );

    if (activeContexts.length === 0) {
      return undefined;
    }

    // Find deepest delegation using recursive depth-first search
    let deepestDelegation: ActiveDelegation | undefined;
    let deepestDepth = -1;
    let deepestTimestamp = -1;

    for (const context of activeContexts) {
      const result = this.findDeepestDelegation(context, 0);

      if (result) {
        // Prefer deeper delegations, or more recent if same depth
        if (
          result.depth > deepestDepth ||
          (result.depth === deepestDepth && result.delegation.timestamp > deepestTimestamp)
        ) {
          deepestDelegation = {
            toolName: result.delegation.toolName,
            callId: result.delegation.callId,
            pooledAgent: result.delegation.pooledAgent,
            timestamp: result.delegation.timestamp,
          };
          deepestDepth = result.depth;
          deepestTimestamp = result.delegation.timestamp;
        }
      }
    }

    if (deepestDelegation) {
      logger.debug(
        `[DELEGATION_CONTEXT] getActiveDelegation: found callId=${deepestDelegation.callId} tool=${deepestDelegation.toolName} depth=${deepestDepth}`
      );
    }

    return deepestDelegation;
  }

  /**
   * Recursively find the deepest delegation in a hierarchy
   *
   * Performs depth-first search starting from a delegation context.
   * Checks if the agent has nested delegations by accessing its
   * ToolOrchestrator → ToolManager → DelegationContextManager.
   *
   * @param context - Current delegation context to explore
   * @param currentDepth - Current nesting depth (0 = top level)
   * @returns Object with deepest delegation and depth, or undefined if none found
   */
  private findDeepestDelegation(
    context: DelegationContext,
    currentDepth: number
  ): { delegation: DelegationContext; depth: number } | undefined {
    // Guard against infinite recursion
    if (currentDepth >= AGENT_CONFIG.MAX_DELEGATION_RECURSION_DEPTH) {
      logger.warn(
        `[DELEGATION_CONTEXT] findDeepestDelegation: max recursion depth ${AGENT_CONFIG.MAX_DELEGATION_RECURSION_DEPTH} reached for callId=${context.callId}`
      );
      return { delegation: context, depth: currentDepth };
    }

    // Try to access nested delegation manager (if agent has one)
    let nestedManager: DelegationContextManager | undefined;

    try {
      // Safe navigation: pooledAgent → agent → toolOrchestrator → toolManager → delegationContextManager
      const agent = context.pooledAgent?.agent;
      if (!agent) {
        return { delegation: context, depth: currentDepth };
      }

      const toolOrchestrator = agent.getToolOrchestrator?.();
      if (!toolOrchestrator) {
        return { delegation: context, depth: currentDepth };
      }

      // Access ToolManager via ToolOrchestrator's public API
      const toolManager = typeof toolOrchestrator.getToolManager === 'function'
        ? toolOrchestrator.getToolManager()
        : undefined;

      if (!toolManager) {
        return { delegation: context, depth: currentDepth };
      }

      // Access DelegationContextManager via ToolManager's public API
      nestedManager = typeof toolManager.getDelegationContextManager === 'function'
        ? toolManager.getDelegationContextManager()
        : undefined;
    } catch (error) {
      // Graceful degradation - if we can't access nested manager, treat as leaf
      logger.debug(
        `[DELEGATION_CONTEXT] findDeepestDelegation: error accessing nested manager for callId=${context.callId}: ${error}`
      );
      return { delegation: context, depth: currentDepth };
    }

    // If no nested manager or it's not a DelegationContextManager, this is the deepest
    if (!nestedManager || typeof nestedManager.getActiveDelegation !== 'function') {
      return { delegation: context, depth: currentDepth };
    }

    // Check if nested manager has any active delegations
    // IMPORTANT: Access contexts directly to avoid infinite recursion
    // DO NOT call nestedManager.getActiveDelegation() - it would recurse back here!
    const nestedContexts = (Array.from((nestedManager as any).contexts?.values() || []) as DelegationContext[]).filter(
      (ctx: DelegationContext) => ctx.state === 'executing'
    );

    if (nestedContexts.length === 0) {
      // No nested delegation, current context is deepest
      return { delegation: context, depth: currentDepth };
    }

    // Find deepest among nested contexts
    // Recurse using THIS manager's method on the nested contexts
    // (we can't call nestedManager's private method)
    let deepestNested: { delegation: DelegationContext; depth: number } | undefined;

    for (const nestedContext of nestedContexts) {
      const result = this.findDeepestDelegation(nestedContext, currentDepth + 1);

      if (result) {
        // Prefer deeper delegations, or more recent if same depth
        if (!deepestNested ||
            result.depth > deepestNested.depth ||
            (result.depth === deepestNested.depth && result.delegation.timestamp > deepestNested.delegation.timestamp)) {
          deepestNested = result;
        }
      }
    }

    // Return the deepest we found (nested or current)
    return deepestNested || { delegation: context, depth: currentDepth };
  }

  /**
   * Get all active delegations for debugging
   *
   * Returns array of all delegations in 'executing' or 'completing' state,
   * sorted by timestamp (newest first).
   *
   * @returns Array of active delegation contexts
   */
  getAllActive(): DelegationContext[] {
    return Array.from(this.contexts.values())
      .filter(ctx => ctx.state === 'executing' || ctx.state === 'completing')
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get all delegations (including inactive) for debugging
   *
   * @returns Array of all delegation contexts
   */
  getAll(): DelegationContext[] {
    return Array.from(this.contexts.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Check if a delegation exists
   *
   * @param callId - Call ID to check
   * @returns True if delegation exists
   */
  has(callId: string): boolean {
    return this.contexts.has(callId);
  }

  /**
   * Clear all delegations (used when agent is reused from pool)
   *
   * This prevents stale delegation state from previous tasks when a pooled agent
   * is reused. When an agent is released to the pool and later reused for a new task,
   * any nested delegation contexts from the previous task must be cleared to prevent
   * findDeepestDelegation() from routing to dead agent instances.
   *
   * Critical for preventing state pollution in the delegation system:
   * - Main → Agent1 (pool-agent-1) → Agent2  (Agent2 registered in Agent1's manager)
   * - Agent1 released to pool
   * - Main → Agent1 (reused pool-agent-1) → Agent3
   * - Without clearAll(), findDeepestDelegation() would find stale Agent2 delegation
   *
   * Use with caution outside of pool reuse - may leave active agents in inconsistent state.
   */
  clearAll(): void {
    const count = this.contexts.size;
    this.contexts.clear();

    if (count > 0) {
      logger.debug(`[DELEGATION_CONTEXT] clearAll: removed ${count} contexts (pool cleanup)`);
    }
  }

  /**
   * Get statistics for monitoring
   *
   * @returns Statistics object
   */
  getStats(): {
    total: number;
    executing: number;
    completing: number;
    byTool: Record<string, number>;
  } {
    const stats = {
      total: this.contexts.size,
      executing: 0,
      completing: 0,
      byTool: {} as Record<string, number>,
    };

    for (const context of this.contexts.values()) {
      if (context.state === 'executing') {
        stats.executing++;
      } else if (context.state === 'completing') {
        stats.completing++;
      }

      stats.byTool[context.toolName] = (stats.byTool[context.toolName] || 0) + 1;
    }

    return stats;
  }

  /**
   * Check for stale delegations and log warnings
   *
   * Identifies delegations that have been active longer than the stale threshold.
   * This helps detect stuck or hung agents that may need manual intervention.
   *
   * @returns Array of stale delegation contexts
   */
  checkStaleDelegations(): DelegationContext[] {
    const now = Date.now();
    const staleDelegations: DelegationContext[] = [];

    for (const context of this.contexts.values()) {
      const age = now - context.timestamp;
      if (age > AGENT_CONFIG.DELEGATION_STALE_THRESHOLD) {
        staleDelegations.push(context);
        logger.warn(
          `[DELEGATION_CONTEXT] Stale delegation detected: callId=${context.callId} tool=${context.toolName} age=${Math.round(age / 1000)}s state=${context.state}`
        );
      }
    }

    return staleDelegations;
  }
}
