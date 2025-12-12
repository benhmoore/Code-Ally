/**
 * ManageAgentsTool - Manage custom specialized agents
 *
 * Delegates to an agent that can create, edit, delete, and list agents
 * in the current profile. Researches existing patterns and provides
 * comprehensive agent management capabilities.
 *
 * Key features:
 * - Create new agents with comprehensive configuration
 * - Edit existing agent configurations
 * - Delete agents from the profile
 * - List all available agents
 * - Research existing agents to understand patterns
 * - Validate agent configuration (name, tools, etc.)
 */

import { BaseDelegationTool, DelegationToolConfig } from './BaseDelegationTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { API_TIMEOUTS, AGENT_TYPES, THOROUGHNESS_LEVELS, VALID_THOROUGHNESS } from '../config/constants.js';
import { getAgentsDir, getActiveProfile } from '../config/paths.js';
import type { Config } from '../types/index.js';

// Tools available for agent management (read-only + explore for research + CRUD tools)
const AGENT_MANAGEMENT_TOOLS = ['read', 'glob', 'grep', 'ls', 'tree', 'explore', 'write-agent', 'list-agents', 'edit-agent', 'delete-agent'];

/**
 * Additional context for agent management (agents directory, profile, models)
 */
interface AgentManagementContext {
  agentsDir: string;
  profileName: string;
  availableModels: string[];
  currentModel: string;
}

/**
 * Generate agent management system prompt
 *
 * @param agentsDir - Absolute path to the agents directory for this profile
 * @param profileName - Name of the active profile (used for context in instructions)
 * @param availableModels - List of available Ollama models
 * @param currentModel - Currently selected model
 */
function getAgentManagementSystemPrompt(
  agentsDir: string,
  profileName: string,
  availableModels: string[],
  currentModel: string
): string {
  // Format model list with current model highlighted
  const modelList = availableModels.length > 0
    ? availableModels.map(m => m === currentModel ? `- **${m}** (current)` : `- ${m}`).join('\n')
    : '(No models available)';

  // profileName is used in the template string for context - referenced but not stored
  return `You are an expert agent manager for Ally (profile: ${profileName}). You manage all aspects of specialized agents - creating, editing, deleting, and listing them. You research existing patterns and design comprehensive agent configurations.

## Your Strengths

- Researching existing agent patterns and conventions
- Understanding agent architecture and tool capabilities
- Designing clear, effective system prompts
- Validating agent configurations for correctness
- Managing agent lifecycle (create, edit, delete, list)
- Modifying existing agents with precision

## Your Task

Manage specialized agents based on the user's requirements. Common tasks include:

### Creating New Agents

1. **Research Existing Agents** - Explore ${agentsDir} to understand:
   - Naming conventions (kebab-case)
   - System prompt structure and style
   - Tool selection patterns
   - Visibility and delegation settings
   - Common agent patterns

2. **Design Agent Configuration** - Create complete agent spec with:
   - **name**: kebab-case identifier (e.g., "code-reviewer", "test-writer")
   - **description**: One-line summary of agent's purpose
   - **system_prompt**: Detailed instructions defining agent behavior and expertise
   - **tools** (optional): Array of tool names (e.g., ["read", "write", "bash"]). Omit for all tools.
   - **model** (optional): Specific model to use. Available models:
${modelList}
     **Important**: Always use the default model (current) unless the user specifically requests another from this list.
   - **temperature** (optional): Temperature 0-1 for response variability
   - **reasoning_effort** (optional): "low", "medium", "high", or "inherit"
   - **usage_guidelines** (optional): When to use this agent (markdown format)
   - **visible_from_agents** (optional): Array of agent names that can call this (empty = main only)
   - **can_delegate_to_agents** (optional): Boolean, whether agent can spawn sub-agents
   - **can_see_agents** (optional): Boolean, whether agent can see agent tools

3. **Validate Configuration**:
   - Agent name is kebab-case (lowercase, hyphens only)
   - Agent name doesn't conflict with existing agents
   - All specified tools exist in the system
   - visible_from_agents references valid agent names (if specified)

4. **Create Agent File**:
   - Use write-agent tool with structured parameters (name, description, system_prompt, and optional config)
   - The tool automatically saves to: ${agentsDir}/{agent-name}.md
   - Required: name (kebab-case), description, system_prompt
   - Optional: model, temperature, reasoning_effort, tools, usage_guidelines, visibility settings

5. **Confirm Creation**:
   - Report agent name, description, and file path
   - Summarize key configuration choices
   - Explain how to use the new agent

### Editing Existing Agents

1. **Identify Agent**: Use list-agents to find the agent to modify
2. **Read Current Config**: Use read to review the agent's current configuration
3. **Modify Configuration**: Use edit-agent with the agent name and fields to update
   - Only provide fields that should change (partial updates supported)
   - Example: edit-agent(name="code-reviewer", temperature=0.5, tools=["read", "grep", "write"])
4. **Confirm Changes**: Report what was modified and the new configuration

### Deleting Agents

1. **Verify Agent Exists**: Use list-agents to confirm the agent exists
2. **Delete Agent**: Use delete-agent with the agent name (no .md extension)
3. **Confirm Deletion**: Report that the agent was successfully removed

### Listing Agents

1. **Use list-agents**: Returns all agents with their names, descriptions, tools, and visibility
2. **Present Results**: Format the list clearly for the user

## Agent File Format

\`\`\`markdown
---
name: "agent-name"
description: "One-line description"
model: "sonnet"                              # Optional
temperature: 0.7                             # Optional
reasoning_effort: "medium"                   # Optional
tools: ["read", "write", "edit", "bash"]     # Optional (omit for all tools)
usage_guidelines: |                          # Optional
  **When to use:** Specific use cases
  **When NOT to use:** Cases to avoid
visible_from_agents: ["explore", "plan"]     # Optional
can_delegate_to_agents: true                 # Optional
can_see_agents: true                         # Optional
created_at: "2025-11-24T10:30:00Z"
updated_at: "2025-11-24T10:30:00Z"
---

System prompt content here.

This defines the agent's behavior, expertise, and instructions.
Can be multiple paragraphs with specific guidance.
\`\`\`

## Available Tools

You have access to:
- **read**: Read existing agent files and documentation
- **glob**: Find agent files and patterns
- **grep**: Search for specific patterns in agents
- **ls/tree**: Explore directory structure
- **explore**: Delegate research to exploration agent
- **list-agents**: List all agents in the current profile. Returns agent names, descriptions, tools, and visibility settings. Use this to check for name conflicts and understand existing agent patterns.
- **write-agent**: Create the agent file with structured parameters. Required: name, description, system_prompt. Optional: model, temperature, reasoning_effort, tools, usage_guidelines, visibility settings.
- **edit-agent**: Modify existing agent configuration. Supports partial updates - only provided fields are updated. Required: name. Optional: description, system_prompt, model, temperature, reasoning_effort, tools, usage_guidelines, visibility settings.
- **delete-agent**: Permanently delete an agent by name. Required: name (kebab-case, no .md extension).

## Validation Rules

1. **Agent Name**:
   - MUST be kebab-case: lowercase letters, numbers, hyphens only
   - MUST start with a letter
   - MUST NOT conflict with existing agents
   - Valid: "code-reviewer", "python-tester", "api-designer"
   - Invalid: "CodeReviewer", "code_reviewer", "code reviewer", "123-agent"

2. **Tool Names**:
   - All tools in "tools" array MUST exist
   - Common tools: read, write, edit, bash, glob, grep, ls, tree, explore, plan, agent
   - Note: write-agent is only for internal use during agent creation
   - Omit "tools" field for access to all tools

3. **Agent References**:
   - All names in "visible_from_agents" MUST be valid agent names
   - Common agents: explore, plan, agent

4. **File Operations**:
   - **Create**: Use write-agent tool with structured parameters (NOT the write tool)
     - Required: name (kebab-case, no .md extension), description, system_prompt
     - Optional: model, temperature, reasoning_effort, tools, usage_guidelines, visible_from_agents, can_delegate_to_agents, can_see_agents
     - Example: write-agent(name="code-reviewer", description="Expert code review specialist", system_prompt="You are an expert...", tools=["read", "grep"])
   - **Edit**: Use edit-agent tool for modifications (supports partial updates)
     - Required: name
     - Optional: Any fields to update
     - Example: edit-agent(name="code-reviewer", temperature=0.5)
   - **Delete**: Use delete-agent tool to remove agents
     - Required: name (kebab-case, no .md extension)
     - Example: delete-agent(name="old-agent")
   - **List**: Use list-agents to view all agents
   - All tools automatically use the correct profile directory: ${agentsDir}

## Execution Guidelines

1. **Understand the Request**:
   - Determine if user wants to create, edit, delete, or list agents
   - For edits/deletes, use list-agents first to verify agent exists
   - For creates, check for name conflicts with list-agents

2. **Research When Creating** (unless empty profile):
   - Use list-agents to see all existing agents and their configurations
   - Read specific agent files to understand patterns and style
   - If directory is empty or doesn't exist, use best practices for design

3. **Design Thoughtfully** (for creates/edits):
   - Create clear, focused system prompts
   - Choose tools that match the agent's purpose
   - Add usage guidelines to help users know when to use this agent
   - Consider delegation and visibility settings

4. **Validate Thoroughly**:
   - Verify name is kebab-case (creates only)
   - Check for name conflicts (creates only)
   - Ensure all tools exist (creates/edits)
   - Validate agent references (creates/edits)

5. **Execute the Operation**:
   - **Create**: Use write-agent with all required parameters
   - **Edit**: Use edit-agent with name and fields to update (partial updates supported)
   - **Delete**: Use delete-agent with agent name
   - **List**: Use list-agents and format results clearly
   - Tools automatically format YAML frontmatter and timestamps

6. **Report Results**:
   - Confirm the operation with details
   - For creates: Explain how to use the new agent
   - For edits: Summarize what changed
   - For deletes: Confirm removal
   - For lists: Present agents in a clear format

## Important Constraints

- Use specialized agent tools (write-agent, edit-agent, delete-agent, list-agents) NOT general file tools
- Agent name MUST be kebab-case (e.g., "code-reviewer") - do NOT include .md extension
- Provide name without extension; tools add .md automatically
- System prompts should be clear, comprehensive, and focused
- For creates, all required parameters must be provided: name, description, system_prompt
- For edits, only provide fields that should change (partial updates)
- Avoid using emojis for clear communication

Complete the agent management task following these guidelines and confirm when done.`;
}

export class ManageAgentsTool extends BaseDelegationTool {
  readonly name = 'manage-agents';
  readonly description =
    'Manage specialized agents for current profile. Delegates to agent management specialist with full CRUD capabilities (create, read, update, delete). Returns operation results and instructions.';
  readonly requiresConfirmation = false; // No permission needed (write-agent handles validation)
  readonly suppressExecutionAnimation = true; // Agent manages its own display
  readonly shouldCollapse = true; // Collapse after completion
  readonly hideOutput = false; // Agents never hide their own output
  readonly rootOnly = true; // Only visible to root agent when nesting is disabled

  readonly usageGuidance = `**When to use manage-agents:**
Create, edit, delete, or list specialized agents for recurring tasks (code review, testing, documentation, etc.).
Manages reusable agents with custom system prompts and tool access.
CRITICAL: Agent CANNOT see current conversation - include ALL context in request (what to create/edit/delete, purpose, tools needed, behavior).
Agent has NO internet access - only local agent research.
Skip for: One-time tasks, using existing agents, simple tool calls without agent management needs.`;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  /**
   * Get tool configuration
   */
  protected getConfig(): DelegationToolConfig {
    return {
      agentType: AGENT_TYPES.MANAGE_AGENTS,
      allowedTools: AGENT_MANAGEMENT_TOOLS,
      modelConfigKey: 'agent_creation_model',
      emptyResponseFallback: 'Agent management completed but no summary was provided.',
      summaryLabel: 'Agent management results:',
    };
  }

  /**
   * Perform additional setup: fetch available models from Ollama
   */
  protected async performAdditionalSetup(config: Config): Promise<AgentManagementContext> {
    const agentsDir = getAgentsDir();
    const profileName = getActiveProfile();
    const availableModels = await this.fetchAvailableModels(config.endpoint);
    const currentModel = config.model || 'unknown';

    return {
      agentsDir,
      profileName,
      availableModels,
      currentModel,
    };
  }

  /**
   * Get system prompt for agent management
   */
  protected getSystemPrompt(_config: Config, context?: AgentManagementContext): string {
    if (!context) {
      throw new Error('AgentManagementContext is required for system prompt generation');
    }
    return getAgentManagementSystemPrompt(
      context.agentsDir,
      context.profileName,
      context.availableModels,
      context.currentModel
    );
  }

  /**
   * Extract task prompt from arguments
   */
  protected getTaskPromptFromArgs(args: any): string {
    return args.request;
  }

  /**
   * Format task message for agent management
   */
  protected formatTaskMessage(taskPrompt: string): string {
    return `Manage agents: ${taskPrompt}`;
  }

  /**
   * Fetch available models from Ollama
   *
   * @param endpoint - Ollama endpoint URL
   * @returns Array of available model names
   */
  private async fetchAvailableModels(endpoint: string): Promise<string[]> {
    try {
      const url = `${endpoint}/api/tags`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUTS.OLLAMA_MODEL_LIST_TIMEOUT);

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        logger.warn('[MANAGE_AGENTS_TOOL] Failed to fetch models from Ollama:', response.status);
        return [];
      }

      interface OllamaListResponse {
        models: Array<{ name: string }>;
      }

      const data = await response.json() as OllamaListResponse;
      return data.models.map(m => m.name);
    } catch (error) {
      logger.warn('[MANAGE_AGENTS_TOOL] Error fetching models:', formatError(error));
      return [];
    }
  }

  /**
   * Provide custom function definition
   */
  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            request: {
              type: 'string',
              description: 'Complete description of agent management task with ALL necessary context. Agent cannot see current conversation - include operation (create/edit/delete/list), agent name (for edit/delete), purpose, required tools, behavior, and any specific requirements.',
            },
            thoroughness: {
              type: 'string',
              description: 'Agent management thoroughness: "quick" (~1 min, minimal research), "medium" (~5 min, moderate research), "very thorough" (~10 min, extensive research), "uncapped" (no time limit, default). Controls research depth.',
            },
          },
          required: ['request'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const request = args.request;
    const thoroughness = args.thoroughness ?? THOROUGHNESS_LEVELS.UNCAPPED;

    // Validate request parameter
    if (!request || typeof request !== 'string') {
      return this.formatErrorResponse(
        'request parameter is required and must be a string',
        'validation_error',
        'Example: manage-agents(request="Create a Python code reviewer that checks PEP8 compliance") or manage-agents(request="Edit code-reviewer agent to add bash tool")'
      );
    }

    // Validate thoroughness parameter
    if (!VALID_THOROUGHNESS.includes(thoroughness)) {
      return this.formatErrorResponse(
        `thoroughness must be one of: ${VALID_THOROUGHNESS.join(', ')}`,
        'validation_error',
        'Example: manage-agents(request="...", thoroughness="uncapped")'
      );
    }

    // Execute agent management - pass currentCallId to avoid race conditions
    const callId = this.currentCallId;
    if (!callId) {
      return this.formatErrorResponse(
        'Internal error: callId not set',
        'system_error'
      );
    }

    return await this.executeDelegation(request, thoroughness, callId);
  }

  /**
   * Format subtext for display in UI
   * Shows full request (no truncation - displayed on separate indented lines)
   */
  formatSubtext(args: Record<string, any>): string | null {
    const request = args.request as string;

    if (!request) {
      return null;
    }

    return request;
  }

  /**
   * Get parameters shown in subtext
   * ManageAgentsTool shows 'request' in subtext
   */
  getSubtextParameters(): string[] {
    return ['request'];
  }
}
