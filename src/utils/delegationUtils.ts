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
import type { ModelClient } from '../llm/ModelClient.js';
import type { ToolManager } from '../tools/ToolManager.js';
import type { BackgroundAgentManager } from '../services/BackgroundAgentManager.js';

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

/** Core services every delegation tool needs to spin up a sub-agent. */
export interface DelegationServices {
  registry: ServiceRegistry;
  mainModelClient: ModelClient;
  toolManager: ToolManager;
  configManager: any;
  permissionManager: any;
  appConfig: any;
}

/**
 * Resolve and validate the services required to delegate to a sub-agent.
 *
 * Every delegation tool needs the same four services plus a non-null app config;
 * this centralizes the lookup and the strict-availability checks that were
 * duplicated in BaseDelegationTool and AgentTool.
 *
 * @param toolName - Tool name used in the "requires X" error messages
 * @throws if any required service is missing or getConfig() returns null
 */
export function resolveDelegationServices(toolName: string): DelegationServices {
  const registry = ServiceRegistry.getInstance();
  const mainModelClient = registry.get<ModelClient>('model_client');
  const toolManager = registry.get<ToolManager>('tool_manager');
  const configManager = registry.get<any>('config_manager');
  const permissionManager = registry.get<any>('permission_manager');

  if (!mainModelClient) {
    throw new Error(`${toolName} requires model_client to be registered`);
  }
  if (!toolManager) {
    throw new Error(`${toolName} requires tool_manager to be registered`);
  }
  if (!configManager) {
    throw new Error(`${toolName} requires config_manager to be registered`);
  }
  if (!permissionManager) {
    throw new Error(`${toolName} requires permission_manager to be registered`);
  }

  const appConfig = configManager.getConfig();
  if (!appConfig) {
    throw new Error('ConfigManager.getConfig() returned null/undefined');
  }

  return { registry, mainModelClient, toolManager, configManager, permissionManager, appConfig };
}

/**
 * Route an interjection to a running pooled sub-agent: queue the message and
 * interrupt the agent so it picks the message up. No-op (with a warning) when no
 * pooled agent is active. Shared by every delegation tool's injectUserMessage.
 */
export function injectInterjection(
  pooledAgent: PooledAgent | null,
  message: string,
  context: string
): void {
  if (!pooledAgent) {
    logger.warn(`${context} injectUserMessage called but no active pooled agent`);
    return;
  }
  const agent = pooledAgent.agent;
  if (!agent) {
    logger.warn(`${context} injectUserMessage called but pooled agent has no agent instance`);
    return;
  }
  logger.debug(`${context} Injecting user message into pooled agent:`, pooledAgent.agentId);
  agent.addUserInterjection(message);
  agent.interrupt({ kind: 'user_interjection' });
}

/**
 * Cancel every still-running background agent. Background runs are detached from
 * a tool's foreground activeDelegations, so an interrupt-all must cover them
 * explicitly. No-op when the BackgroundAgentManager is unavailable.
 */
export function cancelRunningBackgroundAgents(): void {
  const manager = ServiceRegistry.getInstance().get<BackgroundAgentManager>('background_agent_manager');
  if (!manager) {
    return;
  }
  for (const task of manager.listTasks()) {
    if (task.status === 'running') {
      manager.cancelTask(task.id);
    }
  }
}
