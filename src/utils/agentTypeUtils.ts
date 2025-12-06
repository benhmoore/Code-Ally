/**
 * Agent Type Utilities - Centralized agent type system
 *
 * Provides utilities for working with agent types in a consistent way across the codebase.
 * Uses AGENT_TYPES from constants.ts as the single source of truth.
 */

import { AgentConfig } from '../agent/Agent.js';
import { AgentMetadata } from '../services/AgentPoolService.js';
import { formatDisplayName } from '../ui/utils/uiHelpers.js';
import { AGENT_TYPES } from '../config/constants.js';

/**
 * Agent type display names for UI
 *
 * Maps agent type identifiers to human-readable display names.
 * Custom/plugin agents not in this map fall back to formatDisplayName().
 */
const AGENT_TYPE_DISPLAY_NAMES: Record<string, string> = {
  [AGENT_TYPES.ALLY]: 'Ally',
  [AGENT_TYPES.TASK]: 'Task',
  [AGENT_TYPES.EXPLORE]: 'Explorer',
  [AGENT_TYPES.PLAN]: 'Planner',
  [AGENT_TYPES.MANAGE_AGENTS]: 'Agent Manager',
};

/**
 * Get display name for an agent type
 *
 * For built-in agent types, returns the predefined display name.
 * For custom/plugin agents, converts kebab-case to Title Case
 * (e.g., "dokuwiki-investigator" -> "Dokuwiki Investigator").
 *
 * @param agentType - Agent type constant or custom string
 * @returns User-friendly display name
 */
export function getAgentDisplayName(agentType: string): string {
  // Check if this is a built-in agent type
  if (AGENT_TYPE_DISPLAY_NAMES[agentType]) {
    return AGENT_TYPE_DISPLAY_NAMES[agentType];
  }

  // For custom agents, convert kebab-case to Title Case
  return formatDisplayName(agentType);
}

/**
 * Extract agent type from agent metadata
 *
 * @param metadata - Agent metadata or wrapper with config
 * @returns Agent type string
 */
export function getAgentType(metadata: AgentMetadata | { config?: AgentConfig }): string {
  // Extract the actual config from the metadata structure
  const config = (metadata as AgentMetadata).config || (metadata as { config?: AgentConfig }).config;

  if (!config) {
    return AGENT_TYPES.TASK;
  }

  // Use explicit agentType field, defaulting to task agent
  return config.agentType || AGENT_TYPES.TASK;
}
