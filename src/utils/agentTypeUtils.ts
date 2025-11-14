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
 * Extract agent type from agent metadata with backward compatibility
 *
 * Priority:
 * 1. Explicit agentType field (new)
 * 2. Pattern matching on baseAgentPrompt (backward compatible)
 * 3. Default fallback
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

  // 1. Check explicit agentType field (new system)
  if (config.agentType) {
    return config.agentType;
  }

  // 2. Backward compatibility: pattern match on baseAgentPrompt
  const baseAgentPrompt = config.baseAgentPrompt;
  if (baseAgentPrompt) {
    if (baseAgentPrompt.includes('codebase exploration')) {
      return AGENT_TYPES.EXPLORE;
    } else if (baseAgentPrompt.includes('implementation planning')) {
      return AGENT_TYPES.PLAN;
    }
  }

  // 3. Default fallback
  return AGENT_TYPES.AGENT;
}
