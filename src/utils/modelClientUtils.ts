/**
 * Model Client Utilities
 *
 * Consolidates logic for determining and creating appropriate ModelClient instances
 * for agents based on their configuration and global settings.
 *
 * This module handles:
 * - Resolving reasoning_effort inheritance from agent to global config
 * - Determining if a shared client can be reused
 * - Creating dedicated OllamaClient instances when needed
 * - Comprehensive logging at each decision point
 */

import { ModelClient } from '../llm/ModelClient.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { logger } from '../services/Logger.js';
import { REASONING_EFFORT } from '../config/constants.js';
import type { Config } from '../types/index.js';

/**
 * Agent-specific model configuration
 */
export interface AgentModelConfig {
  /** Model name override (if different from global config) */
  model?: string;
  /** Reasoning effort override: "inherit" | "low" | "medium" | "high" */
  reasoning_effort?: string;
  /** Temperature override (if different from global config) */
  temperature?: number;
}

/**
 * Parameters for model client resolution
 */
export interface ModelClientParams {
  /** Agent configuration (optional - if not provided, uses global config) */
  agentConfig?: AgentModelConfig;
  /** Global application configuration */
  appConfig: Config;
  /** Shared model client (may be reused if settings match) */
  sharedClient: ModelClient;
  /** Activity stream for client initialization */
  activityStream: ActivityStream;
  /** Maximum tokens override (if different from global config) */
  maxTokens?: number;
  /** Context string for logging (e.g., '[AGENT_TOOL]', '[AGENT_SWITCHER]') */
  context: string;
}

/**
 * Get the appropriate ModelClient for an agent
 *
 * Determines whether to reuse the shared client or create a dedicated OllamaClient
 * based on agent configuration differences from global settings.
 *
 * @param params - Model client resolution parameters
 * @returns The appropriate ModelClient (shared or newly created)
 *
 * @example
 * ```typescript
 * const modelClient = await getModelClientForAgent({
 *   agentConfig: { model: 'qwen2.5-coder:32b', reasoning_effort: 'high' },
 *   appConfig: config,
 *   sharedClient: mainModelClient,
 *   activityStream: activityStream,
 *   maxTokens: 8000,
 *   context: '[AGENT_TOOL]'
 * });
 * ```
 */
export async function getModelClientForAgent(
  params: ModelClientParams
): Promise<ModelClient> {
  const {
    agentConfig,
    appConfig,
    sharedClient,
    activityStream,
    maxTokens,
    context,
  } = params;

  // Determine target model (agent override or global config)
  const targetModel = agentConfig?.model || appConfig.model;

  // Resolve reasoning_effort: use agent's value if set and not "inherit", otherwise use config
  let resolvedReasoningEffort: string | undefined;
  if (agentConfig?.reasoning_effort && agentConfig.reasoning_effort !== REASONING_EFFORT.INHERIT) {
    resolvedReasoningEffort = agentConfig.reasoning_effort;
    logger.debug(`${context} Using agent reasoning_effort: ${resolvedReasoningEffort}`);
  } else {
    resolvedReasoningEffort = appConfig.reasoning_effort;
    logger.debug(`${context} Using config reasoning_effort: ${resolvedReasoningEffort}`);
  }

  // Determine maxTokens (use provided override or global config)
  const effectiveMaxTokens = maxTokens ?? appConfig.max_tokens;

  // Check if shared client can be reused
  // Reuse only if model, reasoning_effort, AND maxTokens all match config
  const canReuseSharedClient =
    targetModel === appConfig.model &&
    resolvedReasoningEffort === appConfig.reasoning_effort &&
    effectiveMaxTokens === appConfig.max_tokens;

  if (canReuseSharedClient) {
    // Use shared global client
    logger.debug(
      `${context} Using shared model client (model: ${targetModel}, reasoning_effort: ${resolvedReasoningEffort}, maxTokens: ${effectiveMaxTokens})`
    );
    return sharedClient;
  }

  // Agent specifies different settings - create dedicated client
  logger.debug(
    `${context} Creating dedicated client (model: ${targetModel}, reasoning_effort: ${resolvedReasoningEffort}, maxTokens: ${effectiveMaxTokens})`
  );

  // Dynamically import OllamaClient to avoid circular dependencies
  const { OllamaClient } = await import('../llm/OllamaClient.js');

  // Create dedicated client with agent-specific settings
  return new OllamaClient({
    endpoint: appConfig.endpoint,
    modelName: targetModel,
    temperature: agentConfig?.temperature ?? appConfig.temperature,
    contextSize: appConfig.context_size,
    maxTokens: effectiveMaxTokens,
    activityStream: activityStream,
    reasoningEffort: resolvedReasoningEffort,
  });
}
