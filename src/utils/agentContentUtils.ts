/**
 * Agent file content utilities
 *
 * Provides functions for constructing and parsing agent definition files.
 * These utilities handle YAML frontmatter generation and parsing for agent files.
 */

import { extractFrontmatter, parseFrontmatterYAML } from './yamlUtils.js';

/**
 * Validate agent name follows kebab-case format
 *
 * @param name - Agent name to validate
 * @returns Validation result with error message if invalid
 */
export function validateAgentName(name: string): { valid: boolean; error?: string } {
  if (!name) {
    return {
      valid: false,
      error: 'name parameter is required'
    };
  }

  const kebabRegex = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
  if (!kebabRegex.test(name)) {
    return {
      valid: false,
      error: `Agent name must be kebab-case: ${name}. Valid examples: "code-reviewer", "python-tester". Invalid: "CodeReviewer", "code_reviewer"`
    };
  }

  return { valid: true };
}

/**
 * Agent frontmatter metadata structure
 *
 * Represents the YAML frontmatter in an agent definition file.
 * All timestamps are in ISO 8601 format (UTC).
 */
export interface AgentFrontmatter {
  name: string;
  description: string;
  model?: string;
  temperature?: number;
  reasoning_effort?: string;
  tools?: string[];
  usage_guidelines?: string;
  visible_from_agents?: string[];
  can_delegate_to_agents?: boolean;
  can_see_agents?: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Parameters for constructing agent file content
 *
 * Used to generate a new agent definition file with optional configuration.
 */
export interface AgentContentParams {
  name: string;
  description: string;
  system_prompt: string;
  model?: string;
  temperature?: number;
  reasoning_effort?: string;
  tools?: string[];
  usage_guidelines?: string;
  visible_from_agents?: string[];
  can_delegate_to_agents?: boolean;
  can_see_agents?: boolean;
  preserveCreatedAt?: string; // Optional parameter to preserve created_at timestamp when editing
}

/**
 * Construct agent file content from structured parameters
 *
 * Generates properly formatted agent file content with YAML frontmatter
 * and system prompt. Only includes optional fields if they are provided.
 *
 * @param params - Agent configuration parameters
 * @returns Formatted agent file content string
 *
 * @example
 * const content = constructAgentContent({
 *   name: "code-reviewer",
 *   description: "Expert code review specialist",
 *   system_prompt: "You are an expert code reviewer...",
 *   model: "qwen2.5-coder:32b",
 *   temperature: 0.7,
 *   tools: ["read", "grep"],
 *   usage_guidelines: "Use for code reviews\nBest for pull requests"
 * });
 *
 * // Result:
 * // ---
 * // name: "code-reviewer"
 * // description: "Expert code review specialist"
 * // model: "qwen2.5-coder:32b"
 * // temperature: 0.7
 * // tools: ["read", "grep"]
 * // usage_guidelines: |
 * //   Use for code reviews
 * //   Best for pull requests
 * // created_at: "2025-11-24T18:11:33Z"
 * // updated_at: "2025-11-24T18:11:33Z"
 * // ---
 * //
 * // You are an expert code reviewer...
 */
export function constructAgentContent(params: AgentContentParams): string {
  // Helper function to escape special characters in YAML quoted strings
  // Note: Backslashes must be escaped first to avoid double-escaping
  const escapeYamlString = (str: string): string => {
    return str
      .replace(/\\/g, '\\\\')   // Escape backslashes first
      .replace(/"/g, '\\"')     // Escape double quotes
      .replace(/\n/g, '\\n')    // Escape newlines
      .replace(/\r/g, '\\r')    // Escape carriage returns
      .replace(/\t/g, '\\t');   // Escape tabs
  };

  // Helper function to format array as JSON array syntax
  const formatArray = (arr: string[]): string => {
    const escapedItems = arr.map(item => `"${escapeYamlString(item)}"`);
    return `[${escapedItems.join(', ')}]`;
  };

  // Generate timestamps in ISO 8601 format (UTC)
  const now = new Date().toISOString();
  const createdAt = params.preserveCreatedAt || now;

  // Build frontmatter lines
  const lines: string[] = ['---'];

  // Required fields
  lines.push(`name: "${escapeYamlString(params.name)}"`);
  lines.push(`description: "${escapeYamlString(params.description)}"`);

  // Optional fields (only include if provided)
  if (params.model !== undefined) {
    lines.push(`model: "${escapeYamlString(params.model)}"`);
  }

  if (params.temperature !== undefined) {
    lines.push(`temperature: ${params.temperature}`);
  }

  if (params.reasoning_effort !== undefined) {
    lines.push(`reasoning_effort: "${escapeYamlString(params.reasoning_effort)}"`);
  }

  if (params.tools !== undefined) {
    lines.push(`tools: ${formatArray(params.tools)}`);
  }

  if (params.usage_guidelines !== undefined) {
    // Use YAML block scalar format for multi-line strings
    lines.push('usage_guidelines: |');
    const guidelineLines = params.usage_guidelines.split('\n');
    guidelineLines.forEach(line => {
      lines.push(`  ${line}`);
    });
  }

  if (params.visible_from_agents !== undefined) {
    lines.push(`visible_from_agents: ${formatArray(params.visible_from_agents)}`);
  }

  if (params.can_delegate_to_agents !== undefined) {
    lines.push(`can_delegate_to_agents: ${params.can_delegate_to_agents}`);
  }

  if (params.can_see_agents !== undefined) {
    lines.push(`can_see_agents: ${params.can_see_agents}`);
  }

  // Timestamps (always included)
  lines.push(`created_at: "${createdAt}"`);
  lines.push(`updated_at: "${now}"`);


  // Close frontmatter
  lines.push('---');

  // Add blank line before system prompt
  lines.push('');

  // Add system prompt
  lines.push(params.system_prompt);

  // Join all lines
  return lines.join('\n');
}

/**
 * Parse agent file content
 *
 * Extracts and parses the YAML frontmatter and system prompt from an agent
 * definition file. Uses the shared YAML parsing utilities.
 *
 * @param content - Full agent file content (with frontmatter and body)
 * @returns Object containing parsed frontmatter and system prompt
 * @throws Error if the file format is invalid or frontmatter cannot be parsed
 *
 * @example
 * const content = `---
 * name: "code-reviewer"
 * description: "Expert code review specialist"
 * model: "qwen2.5-coder:32b"
 * temperature: 0.7
 * tools: ["read", "grep"]
 * created_at: "2025-11-24T18:11:33Z"
 * updated_at: "2025-11-24T18:11:33Z"
 * ---
 *
 * You are an expert code reviewer...`;
 *
 * const { frontmatter, systemPrompt } = parseAgentFile(content);
 * // frontmatter = {
 * //   name: "code-reviewer",
 * //   description: "Expert code review specialist",
 * //   model: "qwen2.5-coder:32b",
 * //   temperature: 0.7,
 * //   tools: ["read", "grep"],
 * //   created_at: "2025-11-24T18:11:33Z",
 * //   updated_at: "2025-11-24T18:11:33Z"
 * // }
 * // systemPrompt = "You are an expert code reviewer..."
 */
export function parseAgentFile(content: string): {
  frontmatter: AgentFrontmatter;
  systemPrompt: string;
} {
  // Extract frontmatter and body
  const extracted = extractFrontmatter(content);

  if (!extracted) {
    throw new Error('Invalid agent file format: missing or malformed frontmatter');
  }

  // Parse the frontmatter YAML
  const parsedMetadata = parseFrontmatterYAML(extracted.frontmatter);

  // Validate required fields
  if (!parsedMetadata.name || typeof parsedMetadata.name !== 'string') {
    throw new Error('Invalid agent file: missing or invalid "name" field');
  }

  if (!parsedMetadata.description || typeof parsedMetadata.description !== 'string') {
    throw new Error('Invalid agent file: missing or invalid "description" field');
  }

  if (!parsedMetadata.created_at || typeof parsedMetadata.created_at !== 'string') {
    throw new Error('Invalid agent file: missing or invalid "created_at" field');
  }

  if (!parsedMetadata.updated_at || typeof parsedMetadata.updated_at !== 'string') {
    throw new Error('Invalid agent file: missing or invalid "updated_at" field');
  }

  // Construct typed frontmatter object
  const frontmatter: AgentFrontmatter = {
    name: parsedMetadata.name,
    description: parsedMetadata.description,
    created_at: parsedMetadata.created_at,
    updated_at: parsedMetadata.updated_at,
  };

  // Add optional fields if present
  if (parsedMetadata.model !== undefined) {
    frontmatter.model = parsedMetadata.model;
  }

  if (parsedMetadata.temperature !== undefined) {
    if (typeof parsedMetadata.temperature !== 'number') {
      throw new Error(`Invalid agent file: "temperature" must be a number (got ${typeof parsedMetadata.temperature})`);
    }
    frontmatter.temperature = parsedMetadata.temperature;
  }

  if (parsedMetadata.reasoning_effort !== undefined) {
    if (typeof parsedMetadata.reasoning_effort !== 'string') {
      throw new Error(`Invalid agent file: "reasoning_effort" must be a string`);
    }
    frontmatter.reasoning_effort = parsedMetadata.reasoning_effort;
  }

  if (parsedMetadata.tools !== undefined) {
    if (!Array.isArray(parsedMetadata.tools)) {
      throw new Error(`Invalid agent file: "tools" must be an array`);
    }
    frontmatter.tools = parsedMetadata.tools;
  }

  if (parsedMetadata.usage_guidelines !== undefined) {
    if (typeof parsedMetadata.usage_guidelines !== 'string') {
      throw new Error(`Invalid agent file: "usage_guidelines" must be a string`);
    }
    frontmatter.usage_guidelines = parsedMetadata.usage_guidelines;
  }

  if (parsedMetadata.visible_from_agents !== undefined) {
    if (!Array.isArray(parsedMetadata.visible_from_agents)) {
      throw new Error(`Invalid agent file: "visible_from_agents" must be an array`);
    }
    frontmatter.visible_from_agents = parsedMetadata.visible_from_agents;
  }

  if (parsedMetadata.can_delegate_to_agents !== undefined) {
    if (typeof parsedMetadata.can_delegate_to_agents !== 'boolean') {
      throw new Error(`Invalid agent file: "can_delegate_to_agents" must be a boolean`);
    }
    frontmatter.can_delegate_to_agents = parsedMetadata.can_delegate_to_agents;
  }

  if (parsedMetadata.can_see_agents !== undefined) {
    if (typeof parsedMetadata.can_see_agents !== 'boolean') {
      throw new Error(`Invalid agent file: "can_see_agents" must be a boolean`);
    }
    frontmatter.can_see_agents = parsedMetadata.can_see_agents;
  }

  // Extract system prompt (body, trimmed)
  const systemPrompt = extracted.body.trim();

  if (!systemPrompt) {
    throw new Error('Invalid agent file: missing system prompt');
  }

  return {
    frontmatter,
    systemPrompt,
  };
}
