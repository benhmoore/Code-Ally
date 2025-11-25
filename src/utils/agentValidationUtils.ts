/**
 * Agent validation utilities
 *
 * Shared validation functions for agent configuration parameters.
 * Used by WriteAgentTool and EditAgentTool to ensure consistent
 * validation logic across agent creation and editing operations.
 */

import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { ToolManager } from '../tools/ToolManager.js';
import { AgentManager } from '../services/AgentManager.js';
import { ConfigManager } from '../services/ConfigManager.js';
import { formatError } from './errorUtils.js';
import { API_TIMEOUTS } from '../config/constants.js';
import { testModelToolCalling } from '../llm/ModelValidation.js';

/**
 * Validation result with error message if invalid
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Extended validation result for tools validation
 */
export interface ToolsValidationResult extends ValidationResult {
  invalidTools?: string[];
}

/**
 * Extended validation result for model validation
 */
export interface ModelValidationResult extends ValidationResult {
  availableModels?: string[];
}

/**
 * Agent visibility settings
 */
export interface VisibilitySettings {
  visibleFromAgents?: string[];
  canDelegateToAgents?: boolean;
  canSeeAgents?: boolean;
}

/**
 * Validate temperature parameter
 *
 * Temperature controls response randomness. Valid range is 0.0 to 2.0.
 *
 * @param temp - Temperature value to validate
 * @returns Validation result with error message if invalid
 *
 * @example
 * ```typescript
 * const result = validateTemperature(0.7);
 * if (!result.valid) console.error(result.error);
 * ```
 */
export function validateTemperature(temp: number): ValidationResult {
  // Type validation
  if (typeof temp !== 'number' || isNaN(temp)) {
    return {
      valid: false,
      error: 'Temperature must be a number. Example: temperature: 0.7'
    };
  }

  // Range validation
  if (temp < 0 || temp > 2) {
    return {
      valid: false,
      error: `Temperature must be between 0 and 2 (got ${temp}). Example: temperature: 0.7`
    };
  }
  return { valid: true };
}

/**
 * Validate reasoning effort parameter
 *
 * Reasoning effort controls how thoroughly the model processes requests.
 * Valid values are: "low", "medium", "high".
 *
 * @param effort - Reasoning effort level to validate
 * @returns Validation result with error message if invalid
 *
 * @example
 * ```typescript
 * const result = validateReasoningEffort("medium");
 * if (!result.valid) console.error(result.error);
 * ```
 */
export function validateReasoningEffort(effort: string): ValidationResult {
  // Type validation
  if (!effort || typeof effort !== 'string') {
    return {
      valid: false,
      error: 'Reasoning effort must be a non-empty string. Example: reasoning_effort: "medium"'
    };
  }

  // Enum validation
  const validEfforts = ['low', 'medium', 'high'];
  if (!validEfforts.includes(effort.toLowerCase())) {
    return {
      valid: false,
      error: `Reasoning effort must be one of: ${validEfforts.join(', ')} (got "${effort}"). Example: reasoning_effort: "medium"`
    };
  }
  return { valid: true };
}

/**
 * Validate tools array
 *
 * Checks that all tool names exist in the ToolManager.
 * Empty array is valid (means no tools).
 *
 * @param tools - Array of tool names to validate
 * @returns Validation result with invalid tools and suggestions
 *
 * @example
 * ```typescript
 * const result = await validateTools(["read", "write", "invalid-tool"]);
 * if (!result.valid) {
 *   console.error(result.error);
 *   console.log("Invalid tools:", result.invalidTools);
 * }
 * ```
 */
export async function validateTools(tools: string[]): Promise<ToolsValidationResult> {
  try {
    // Type validation
    if (!tools || !Array.isArray(tools)) {
      return {
        valid: false,
        error: 'Tools must be an array. Example: tools: ["read", "write"]'
      };
    }

    // Empty array is valid (means no tools)
    if (tools.length === 0) {
      return { valid: true };
    }

    // Validate array elements are strings
    if (tools.some(tool => typeof tool !== 'string' || !tool)) {
      return {
        valid: false,
        error: 'All tool names must be non-empty strings. Example: tools: ["read", "write"]'
      };
    }

    const registry = ServiceRegistry.getInstance();
    const toolManager = registry.get<ToolManager>('tool_manager');

    if (!toolManager) {
      return {
        valid: false,
        error: 'Internal error: ToolManager not available. Please restart the application.'
      };
    }

    const allTools = toolManager.getAllTools();
    const availableToolNames = allTools.map(tool => tool.name);
    const invalidTools = tools.filter(toolName => !availableToolNames.includes(toolName));

    if (invalidTools.length > 0) {
      return {
        valid: false,
        error: `Invalid tool names: ${invalidTools.join(', ')}. Available tools: ${availableToolNames.slice(0, 10).join(', ')}${availableToolNames.length > 10 ? '...' : ''}`,
        invalidTools
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Failed to validate tools: ${formatError(error)}`
    };
  }
}

/**
 * Validate model name
 *
 * Checks if the model exists in Ollama by querying the /api/tags endpoint.
 *
 * @param model - Model name to validate
 * @returns Validation result with available models if invalid
 *
 * @example
 * ```typescript
 * const result = await validateModel("qwen2.5-coder:32b");
 * if (!result.valid) {
 *   console.error(result.error);
 *   console.log("Available models:", result.availableModels);
 * }
 * ```
 */
export async function validateModel(model: string): Promise<ModelValidationResult> {
  try {
    // Type validation
    if (!model || typeof model !== 'string' || model.trim() === '') {
      return {
        valid: false,
        error: 'Model name must be a non-empty string. Example: model: "qwen2.5-coder:32b"'
      };
    }

    const registry = ServiceRegistry.getInstance();
    const configManager = registry.get<ConfigManager>('config_manager');

    if (!configManager) {
      return {
        valid: false,
        error: 'Internal error: ConfigManager not available. Please restart the application.'
      };
    }

    const config = configManager.getConfig();
    const endpoint = config.endpoint;

    // Fetch available models from Ollama
    const url = `${endpoint}/api/tags`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUTS.OLLAMA_MODEL_LIST_TIMEOUT);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return {
          valid: false,
          error: `Failed to fetch models from Ollama: ${response.status} ${response.statusText}`
        };
      }

      interface OllamaListResponse {
        models: Array<{ name: string }>;
      }

      const data = await response.json() as OllamaListResponse;
      const availableModels = data.models.map(m => m.name);

      if (!availableModels.includes(model)) {
        return {
          valid: false,
          error: `Model "${model}" not found. Available models: ${availableModels.slice(0, 5).join(', ')}${availableModels.length > 5 ? '...' : ''}. Run "ollama list" to see all models, or "ollama pull ${model}" to download it.`,
          availableModels
        };
      }

      return { valid: true };
    } catch (error) {
      clearTimeout(timeout);
      return {
        valid: false,
        error: `Failed to connect to Ollama at ${endpoint}: ${formatError(error)}. Make sure Ollama is running.`
      };
    }
  } catch (error) {
    return {
      valid: false,
      error: `Failed to validate model: ${formatError(error)}`
    };
  }
}

/**
 * Extended validation result for model tool capability check
 */
export interface ModelToolCapabilityResult extends ValidationResult {
  supportsTools?: boolean;
}

/**
 * Validate that a model supports tool calling if tools are configured
 *
 * When an agent is configured with tools, the model must support tool calling.
 * This function checks that requirement and returns an error if the model
 * doesn't support tools but tools are configured.
 *
 * @param model - Model name to check (can be undefined if using default)
 * @param tools - Array of tool names configured for the agent
 * @returns Validation result with tool support status
 *
 * @example
 * ```typescript
 * const result = await validateModelToolCapability("phi3:mini", ["read", "write"]);
 * if (!result.valid) {
 *   console.error(result.error);
 *   // Error: Model "phi3:mini" does not support tool calling...
 * }
 * ```
 */
export async function validateModelToolCapability(
  model: string | undefined,
  tools: string[] | undefined
): Promise<ModelToolCapabilityResult> {
  try {
    // If no tools configured, no capability check needed
    if (!tools || tools.length === 0) {
      return { valid: true, supportsTools: true };
    }

    // If no model specified, agent will use default model which is assumed to support tools
    // (the default model is validated during setup)
    if (!model) {
      return { valid: true, supportsTools: true };
    }

    const registry = ServiceRegistry.getInstance();
    const configManager = registry.get<ConfigManager>('config_manager');

    if (!configManager) {
      return {
        valid: false,
        error: 'Internal error: ConfigManager not available. Please restart the application.'
      };
    }

    const config = configManager.getConfig();
    const endpoint = config.endpoint;

    // Test if the model supports tool calling
    const result = await testModelToolCalling(endpoint, model);

    if (!result.supportsTools) {
      return {
        valid: false,
        supportsTools: false,
        error: `Model "${model}" does not support tool calling, but ${tools.length} tool(s) are configured: ${tools.slice(0, 5).join(', ')}${tools.length > 5 ? '...' : ''}. Either use a model that supports tools, or set tools to an empty array.`
      };
    }

    return { valid: true, supportsTools: true };
  } catch (error) {
    return {
      valid: false,
      error: `Failed to check model tool capability: ${formatError(error)}`
    };
  }
}

/**
 * Validate visibility settings
 *
 * Checks logical consistency of visibility parameters and validates that
 * agent names in visibleFrom exist.
 *
 * @param settings - Visibility settings to validate
 * @returns Validation result with error message if invalid
 *
 * @example
 * ```typescript
 * const result = await validateVisibilitySettings({
 *   visibleFromAgents: ["explore", "plan"],
 *   canDelegateToAgents: true,
 *   canSeeAgents: true
 * });
 * if (!result.valid) console.error(result.error);
 * ```
 */
export async function validateVisibilitySettings(
  settings: VisibilitySettings
): Promise<ValidationResult> {
  try {
    const { visibleFromAgents, canDelegateToAgents, canSeeAgents } = settings;

    // Type validation
    if (visibleFromAgents !== undefined && !Array.isArray(visibleFromAgents)) {
      return {
        valid: false,
        error: 'visible_from_agents must be an array. Example: visible_from_agents: ["explore", "plan"]'
      };
    }
    if (canDelegateToAgents !== undefined && typeof canDelegateToAgents !== 'boolean') {
      return {
        valid: false,
        error: 'can_delegate_to_agents must be a boolean. Example: can_delegate_to_agents: true'
      };
    }
    if (canSeeAgents !== undefined && typeof canSeeAgents !== 'boolean') {
      return {
        valid: false,
        error: 'can_see_agents must be a boolean. Example: can_see_agents: true'
      };
    }

    // Validate visibleFromAgents array elements are strings
    if (visibleFromAgents && visibleFromAgents.some(agent => typeof agent !== 'string' || !agent)) {
      return {
        valid: false,
        error: 'All agent names in visible_from_agents must be non-empty strings. Example: visible_from_agents: ["explore", "plan"]'
      };
    }

    // Note: We don't enforce logical consistency (can_delegate=true + can_see=false)
    // because the user may have specific reasons for this configuration

    // Validate agent names in visibleFromAgents
    if (visibleFromAgents && visibleFromAgents.length > 0) {
      const registry = ServiceRegistry.getInstance();
      const agentManager = registry.get<AgentManager>('agent_manager');

      if (!agentManager) {
        return {
          valid: false,
          error: 'Internal error: AgentManager not available. Please restart the application.'
        };
      }

      const allAgents = await agentManager.listAgents();
      const availableAgentNames = allAgents.map(agent => agent.name);
      const invalidAgents = visibleFromAgents.filter(agentName => !availableAgentNames.includes(agentName));

      if (invalidAgents.length > 0) {
        return {
          valid: false,
          error: `Invalid agent names in visible_from_agents: ${invalidAgents.join(', ')}. Available agents: ${availableAgentNames.slice(0, 10).join(', ')}${availableAgentNames.length > 10 ? '...' : ''}`
        };
      }
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Failed to validate visibility settings: ${formatError(error)}`
    };
  }
}
