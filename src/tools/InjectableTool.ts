/**
 * InjectableTool - Interface for tools that support user message injection
 *
 * Tools that create long-running agents (AgentTool, ExploreTool, PlanTool)
 * implement this interface to receive user interjections while the agent is active.
 *
 * Delegation State Lifecycle:
 * - 'executing': Agent is actively running, can receive interjections
 * - 'completing': Agent finished, parent processing result, NO interjections
 * - null: No active delegation
 */

import { PooledAgent } from '../services/AgentPoolService.js';

export interface InjectableTool {
  /**
   * Current delegation state for interjection routing
   * - 'executing': Active, can receive interjections
   * - 'completing': Finishing, cannot receive interjections
   * - null: No active delegation
   */
  readonly delegationState: 'executing' | 'completing' | null;

  /**
   * Active call ID for the current delegation
   * Set when agent starts, cleared when delegation is removed
   */
  readonly activeCallId: string | null;

  /**
   * Currently active pooled agent (if any)
   * Used for accessing nested delegation managers
   */
  readonly currentPooledAgent: PooledAgent | null;

  /**
   * Inject a user message into the active agent's conversation
   * @param message - User message to inject
   */
  injectUserMessage(message: string): void;
}

/**
 * Type guard to check if a tool implements InjectableTool
 */
export function isInjectableTool(tool: unknown): tool is InjectableTool {
  return (
    tool !== null &&
    typeof tool === 'object' &&
    'delegationState' in tool &&
    'activeCallId' in tool &&
    'currentPooledAgent' in tool &&
    'injectUserMessage' in tool &&
    typeof (tool as any).injectUserMessage === 'function'
  );
}
