/**
 * Agent definition types
 *
 * Canonical home for the data shapes that describe an agent *definition*
 * (as stored on disk and loaded into memory). Runtime instance types such as
 * the full `AgentConfig` (see src/agent/Agent.ts) and pool types (see
 * src/services/AgentPoolService.ts) intentionally live next to the classes that
 * construct them — they carry live service references and belong to those modules.
 *
 * Everything here is plain data: serializable, dependency-light, and shared by
 * the persistence layer (AgentManager, agentContentUtils) and its consumers.
 */

import type { AgentRequirements } from '../agent/RequirementTracker.js';

/**
 * A complete agent definition.
 *
 * This is the parsed, in-memory representation of an agent markdown file, and
 * also the shape persisted back to disk. The `_`-prefixed fields are runtime
 * provenance markers populated for plugin-provided agents; they are never
 * written to disk.
 */
export interface AgentData {
  name: string;
  description: string;
  system_prompt: string;
  model?: string;
  temperature?: number;
  /** Reasoning effort: "inherit", "low", "medium", "high". Defaults to "inherit". */
  reasoning_effort?: string;
  /** Tool names this agent can use. Empty array = no tools, undefined = all tools. */
  tools?: string[];
  /** Optional guidance on when/how to use this agent. */
  usage_guidelines?: string;
  /** Tool call requirements for this agent. */
  requirements?: AgentRequirements;
  created_at?: string;
  updated_at?: string;
  /** Plugin source identifier (only for plugin-provided agents). */
  _pluginName?: string;
  /** Whether this agent is from a linked plugin (dev mode). */
  _isLinked?: boolean;

  /**
   * List of agent names that can call this agent.
   * - undefined: visible to all agents (default)
   * - []: visible to none (only the main assistant can use it)
   * - ["a", "b"]: only these agents can call this agent
   */
  visible_from_agents?: string[];

  /**
   * Whether this agent can delegate to sub-agents.
   * - undefined: defaults to true
   * - false: agent cannot spawn sub-agents
   */
  can_delegate_to_agents?: boolean;

  /**
   * Whether this agent can see other agents in its tool list.
   * - undefined: defaults to true
   * - false: agent cannot see agent/explore/plan delegation tools
   */
  can_see_agents?: boolean;
}

/**
 * Lightweight agent summary used for listings.
 */
export interface AgentInfo {
  name: string;
  description: string;
  file_path: string;
  source?: 'user' | 'plugin' | 'builtin';
  /** Plugin name for plugin-provided agents. */
  pluginName?: string;
  /** True if agent is from an inactive plugin. */
  isInactive?: boolean;
}

/**
 * Base configuration derived from an {@link AgentData}.
 *
 * Common to all agent instantiation contexts (CLI startup, agent switching,
 * sub-agent delegation). Callers extend this with context-specific fields like
 * parentCallId, maxDuration, etc. to build a full runtime `AgentConfig`.
 */
export interface BaseAgentConfig {
  /** Base agent prompt (from the agent's system_prompt). */
  baseAgentPrompt: string;
  /** Task description (from the agent's description). */
  taskPrompt: string;
  /** Restricted tool list, or undefined for all tools. */
  allowedTools: string[] | undefined;
  /** Agent type identifier. */
  agentType: string;
  /** Agent requirements specification. */
  requirements?: AgentRequirements;
}
