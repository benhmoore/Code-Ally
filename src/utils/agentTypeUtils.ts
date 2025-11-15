/**
 * Agent Type Utilities - Centralized agent type system
 *
 * Provides utilities for working with agent types in a consistent way across the codebase.
 * Handles both new explicit agentType field and backward compatibility with pattern matching.
 */

import { AgentConfig } from '../agent/Agent.js';
import { AgentMetadata } from '../services/AgentPoolService.js';
import { formatDisplayName } from '../ui/utils/uiHelpers.js';

/**
 * Standard agent type constants
 */
export const AGENT_TYPES = {
  EXPLORE: 'explore',
  PLAN: 'plan',
  AGENT: 'agent',
  MAIN: 'main',
} as const;

/**
 * Agent type display names for UI
 */
const AGENT_TYPE_DISPLAY_NAMES: Record<string, string> = {
  [AGENT_TYPES.EXPLORE]: 'Explorer',
  [AGENT_TYPES.PLAN]: 'Planner',
  [AGENT_TYPES.AGENT]: 'Assistant',
  [AGENT_TYPES.MAIN]: 'Ally',
};

/**
 * Get display name for an agent type
 *
 * For built-in agent types (explore, plan, agent, main), returns the predefined
 * display name. For custom plugin agents, converts the kebab-case agent name
 * to Title Case using formatDisplayName (e.g., "dokuwiki-investigator" -> "Dokuwiki Investigator").
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
  // This handles plugin agents like "dokuwiki-investigator" -> "Dokuwiki Investigator"
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
  // AgentMetadata has a 'config' property that holds AgentConfig
  const config = (metadata as AgentMetadata).config || (metadata as { config?: AgentConfig }).config;

  if (!config) {
    return AGENT_TYPES.AGENT;
  }

  // Use explicit agentType field
  return config.agentType || AGENT_TYPES.AGENT;
}
