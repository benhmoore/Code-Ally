/**
 * Agent file serialization
 *
 * The single source of truth for turning an {@link AgentData} into its on-disk
 * markdown representation and back. All agent file I/O (AgentManager and the
 * agent CRUD tools) goes through these two functions, so the format can only
 * ever change in one place.
 */

import { extractFrontmatter, parseFrontmatterYAML } from './yamlUtils.js';
import type { AgentData } from '../types/agents.js';
import type { AgentRequirements } from '../agent/RequirementTracker.js';

/** Escape special characters for a double-quoted YAML scalar. */
function escapeYamlString(str: string): string {
  return str
    .replace(/\\/g, '\\\\') // Escape backslashes first to avoid double-escaping
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Format a string array as inline JSON-style YAML (e.g. `["read", "grep"]`). */
function formatArray(arr: string[]): string {
  return `[${arr.map(item => `"${escapeYamlString(item)}"`).join(', ')}]`;
}

/**
 * Serialize an agent definition to markdown file content.
 *
 * Optional fields are only emitted when present. `created_at` is preserved from
 * the input when supplied (so edits keep the original creation time); both
 * timestamps default to the current time. Pass `now` to make output
 * deterministic in tests.
 *
 * @param agent - Agent definition to serialize
 * @param now - ISO timestamp to use for created_at/updated_at defaults
 * @returns Formatted agent markdown content
 */
export function serializeAgent(agent: AgentData, now: string = new Date().toISOString()): string {
  const lines: string[] = ['---'];

  lines.push(`name: "${escapeYamlString(agent.name)}"`);
  lines.push(`description: "${escapeYamlString(agent.description)}"`);

  if (agent.model !== undefined) {
    lines.push(`model: "${escapeYamlString(agent.model)}"`);
  }

  if (agent.temperature !== undefined) {
    lines.push(`temperature: ${agent.temperature}`);
  }

  if (agent.reasoning_effort !== undefined) {
    lines.push(`reasoning_effort: "${escapeYamlString(agent.reasoning_effort)}"`);
  }

  if (agent.tools !== undefined) {
    lines.push(`tools: ${formatArray(agent.tools)}`);
  }

  if (agent.usage_guidelines !== undefined) {
    // YAML block scalar for multi-line strings
    lines.push('usage_guidelines: |');
    for (const line of agent.usage_guidelines.split('\n')) {
      lines.push(`  ${line}`);
    }
  }

  if (agent.requirements) {
    lines.push('requirements:');
    const reqs = agent.requirements;
    if (reqs.required_tools_one_of) {
      lines.push(`  required_tools_one_of: ${formatArray(reqs.required_tools_one_of)}`);
    }
    if (reqs.required_tools_all) {
      lines.push(`  required_tools_all: ${formatArray(reqs.required_tools_all)}`);
    }
    if (reqs.minimum_tool_calls !== undefined) {
      lines.push(`  minimum_tool_calls: ${reqs.minimum_tool_calls}`);
    }
    if (reqs.require_tool_use !== undefined) {
      lines.push(`  require_tool_use: ${reqs.require_tool_use}`);
    }
    if (reqs.reminder_message) {
      lines.push(`  reminder_message: "${escapeYamlString(reqs.reminder_message)}"`);
    }
  }

  if (agent.visible_from_agents !== undefined) {
    lines.push(`visible_from_agents: ${formatArray(agent.visible_from_agents)}`);
  }

  if (agent.can_delegate_to_agents !== undefined) {
    lines.push(`can_delegate_to_agents: ${agent.can_delegate_to_agents}`);
  }

  if (agent.can_see_agents !== undefined) {
    lines.push(`can_see_agents: ${agent.can_see_agents}`);
  }

  lines.push(`created_at: "${agent.created_at || now}"`);
  lines.push(`updated_at: "${now}"`);

  lines.push('---');
  lines.push('');
  lines.push(agent.system_prompt);

  return lines.join('\n');
}

/**
 * Parse agent markdown file content into an {@link AgentData}.
 *
 * Validates the structure and field types, throwing a descriptive error when
 * the file is malformed. Timestamps are optional (built-in agents may omit
 * them); `name` falls back to `fallbackName` (typically the filename) when not
 * present in the frontmatter.
 *
 * @param content - Full agent file content (frontmatter + body)
 * @param fallbackName - Name to use when frontmatter omits `name`
 * @returns Parsed agent definition
 * @throws Error if the file format or any field is invalid
 */
export function parseAgentContent(content: string, fallbackName = ''): AgentData {
  const extracted = extractFrontmatter(content);
  if (!extracted) {
    throw new Error('Invalid agent file format: missing or malformed frontmatter');
  }

  const meta = parseFrontmatterYAML(extracted.frontmatter);

  const name = (meta.name as string) || fallbackName;
  if (!name || typeof name !== 'string') {
    throw new Error('Invalid agent file: missing or invalid "name" field');
  }

  const systemPrompt = extracted.body.trim();
  if (!systemPrompt) {
    throw new Error('Invalid agent file: missing system prompt');
  }

  const agent: AgentData = {
    name,
    description: typeof meta.description === 'string' ? meta.description : '',
    system_prompt: systemPrompt,
  };

  if (meta.model !== undefined) {
    if (typeof meta.model !== 'string') throw new Error('Invalid agent file: "model" must be a string');
    agent.model = meta.model;
  }

  if (meta.temperature !== undefined) {
    if (typeof meta.temperature !== 'number' || isNaN(meta.temperature)) {
      throw new Error(`Invalid agent file: "temperature" must be a number (got ${typeof meta.temperature})`);
    }
    agent.temperature = meta.temperature;
  }

  if (meta.reasoning_effort !== undefined) {
    if (typeof meta.reasoning_effort !== 'string') throw new Error('Invalid agent file: "reasoning_effort" must be a string');
    agent.reasoning_effort = meta.reasoning_effort;
  }

  if (meta.tools !== undefined) {
    if (!Array.isArray(meta.tools)) throw new Error('Invalid agent file: "tools" must be an array');
    agent.tools = meta.tools;
  }

  if (meta.usage_guidelines !== undefined) {
    if (typeof meta.usage_guidelines !== 'string') throw new Error('Invalid agent file: "usage_guidelines" must be a string');
    agent.usage_guidelines = meta.usage_guidelines;
  }

  if (meta.requirements !== undefined) {
    if (typeof meta.requirements !== 'object' || Array.isArray(meta.requirements)) {
      throw new Error('Invalid agent file: "requirements" must be an object');
    }
    agent.requirements = meta.requirements as AgentRequirements;
  }

  if (meta.visible_from_agents !== undefined) {
    if (!Array.isArray(meta.visible_from_agents)) throw new Error('Invalid agent file: "visible_from_agents" must be an array');
    agent.visible_from_agents = meta.visible_from_agents;
  }

  if (meta.can_delegate_to_agents !== undefined) {
    if (typeof meta.can_delegate_to_agents !== 'boolean') throw new Error('Invalid agent file: "can_delegate_to_agents" must be a boolean');
    agent.can_delegate_to_agents = meta.can_delegate_to_agents;
  }

  if (meta.can_see_agents !== undefined) {
    if (typeof meta.can_see_agents !== 'boolean') throw new Error('Invalid agent file: "can_see_agents" must be a boolean');
    agent.can_see_agents = meta.can_see_agents;
  }

  if (typeof meta.created_at === 'string') agent.created_at = meta.created_at;
  if (typeof meta.updated_at === 'string') agent.updated_at = meta.updated_at;

  return agent;
}
