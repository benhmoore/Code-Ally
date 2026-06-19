/**
 * Delegation utilities
 *
 * Shared primitives for the agent delegation tools (agent, explore, plan,
 * research, sessions, agent-ask). These collapse the boilerplate that was
 * previously copy-pasted across every delegation tool:
 *
 * - The "user can't see this" response suffix (one canonical wording).
 * - The empty/incomplete response → conversation-summary fallback.
 * - DelegationContextManager lifecycle calls (with the registry lookup and
 *   error-swallowing that every caller needs).
 *
 * Each tool composes only the pieces it needs, so genuinely different flows
 * (e.g. AgentTool's richer summary recovery) stay where they belong rather than
 * being forced through a single abstraction.
 */

import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { logger } from '../services/Logger.js';
import { TEXT_LIMITS } from '../config/constants.js';
import { extractSummaryFromConversation } from './agentUtils.js';
import type { Agent } from '../agent/Agent.js';
import type { PooledAgent } from '../services/AgentPoolService.js';

/**
 * Canonical reminder appended to every delegated-agent result, telling the
 * calling model that the user never sees the sub-agent's raw output.
 */
export const AGENT_RESPONSE_SUFFIX =
  "\n\nIMPORTANT: The user CANNOT see this agent's output. You must share relevant information, summarized or verbatim with the user in your own response, if appropriate.";

/**
 * Append the {@link AGENT_RESPONSE_SUFFIX} to a delegated-agent response.
 */
export function appendAgentResponseSuffix(response: string): string {
  return response + AGENT_RESPONSE_SUFFIX;
}

/**
 * Resolve a substantive response from a delegated agent.
 *
 * Falls back to a conversation summary when the agent returns nothing usable:
 * - Empty response → extracted summary, or `fallback` if none.
 * - Interrupted or very short response → extracted summary if it is longer,
 *   otherwise the original response.
 * - Otherwise → the response as-is.
 *
 * @param agent - The delegated agent (for summary extraction)
 * @param response - The raw response returned by the agent
 * @param opts.context - Log context label (e.g. '[EXPLORE_TOOL]')
 * @param opts.label - Prefix for the extracted summary
 * @param opts.fallback - Text to use when nothing can be extracted
 */
export function resolveSubstantiveResponse(
  agent: Agent,
  response: string | null | undefined,
  opts: { context: string; label: string; fallback: string }
): string {
  if (!response || response.trim().length === 0) {
    logger.debug(`${opts.context} Empty response, extracting from conversation`);
    return extractSummaryFromConversation(agent, opts.context, opts.label) || opts.fallback;
  }

  if (response.includes('[Request interrupted') || response.length < TEXT_LIMITS.AGENT_RESPONSE_MIN) {
    logger.debug(`${opts.context} Incomplete response, attempting to extract summary`);
    const summary = extractSummaryFromConversation(agent, opts.context, opts.label);
    return summary && summary.length > response.length ? summary : response;
  }

  return response;
}

/**
 * Resolve the DelegationContextManager from the service registry, returning null
 * if the registry or manager is unavailable (e.g. in unit tests).
 */
function getDelegationManager(): {
  register: (callId: string, agentType: string, pooledAgent: PooledAgent) => void;
  transitionToCompleting: (callId: string) => void;
  clear: (callId: string) => void;
} | null {
  try {
    const toolManager = ServiceRegistry.getInstance().get<any>('tool_manager');
    return toolManager?.getDelegationContextManager?.() ?? null;
  } catch (error) {
    logger.debug(`[DELEGATION] Context manager unavailable: ${error}`);
    return null;
  }
}

/**
 * Register an active delegation so permission prompts can route interjections to
 * the running sub-agent. No-op when the context manager is unavailable.
 */
export function registerDelegation(callId: string, agentType: string, pooledAgent: PooledAgent): void {
  const manager = getDelegationManager();
  if (manager) {
    manager.register(callId, agentType, pooledAgent);
    logger.debug(`[DELEGATION] Registered delegation: callId=${callId}, agentType=${agentType}`);
  }
}

/**
 * Finalize a delegation: transition to 'completing' and clear it. No-op when the
 * context manager is unavailable.
 */
export function completeDelegation(callId: string): void {
  const manager = getDelegationManager();
  if (manager) {
    manager.transitionToCompleting(callId);
    manager.clear(callId);
    logger.debug(`[DELEGATION] Completed delegation: callId=${callId}`);
  }
}
