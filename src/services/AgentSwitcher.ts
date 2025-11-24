/**
 * AgentSwitcher - Core agent switching infrastructure
 *
 * Handles switching the main agent instance to a different agent type
 * (like explore, plan, or custom agents). Preserves conversation history
 * and properly cleans up the old agent.
 */

import { Agent, AgentConfig } from '../agent/Agent.js';
import { ServiceRegistry } from './ServiceRegistry.js';
import { AgentManager } from './AgentManager.js';
import { ModelClient } from '../llm/ModelClient.js';
import { ToolManager } from '../tools/ToolManager.js';
import { ActivityStream } from './ActivityStream.js';
import { ConfigManager } from './ConfigManager.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { Message } from '../types/index.js';
import { logger } from './Logger.js';

/**
 * Switch the main agent instance to a different agent type
 *
 * @param targetAgentType - Name of the agent to switch to (e.g., 'explore', 'plan', or custom agent)
 *                          Special cases: 'task' or 'ally' returns to default main agent
 * @param registry - Service registry containing all required services
 * @throws Error if agent cannot be loaded or switching fails
 */
export async function switchAgent(
  targetAgentType: string,
  registry: ServiceRegistry
): Promise<Agent> {
  logger.debug('[AGENT_SWITCHER]', 'Switching to agent:', targetAgentType);

  // Get current agent from registry
  const currentAgent = registry.get<Agent>('agent');
  if (!currentAgent) {
    throw new Error('Current agent not found in registry');
  }

  logger.debug('[AGENT_SWITCHER]', 'Current agent ID:', currentAgent.getInstanceId());

  // Get conversation history from current agent
  const conversationHistory = currentAgent.getConversationHistory();
  logger.debug('[AGENT_SWITCHER]', 'Captured', conversationHistory.length, 'messages from current agent');

  // Handle special case: "ally" returns to default main agent
  let agentConfig: AgentConfig;
  let isMainAgent = false;

  if (targetAgentType === 'ally') {
    logger.debug('[AGENT_SWITCHER]', 'Returning to default main agent');
    isMainAgent = true;

    // Create config for main agent
    const configManager = registry.get<ConfigManager>('config_manager');
    if (!configManager) {
      throw new Error('ConfigManager not found in registry');
    }

    agentConfig = {
      config: configManager.getConfig(),
      isSpecializedAgent: false,
      allowTodoManagement: true,
      agentType: 'ally',
    };
  } else {
    // Load target agent definition from AgentManager
    const agentManager = registry.get<AgentManager>('agent_manager');
    if (!agentManager) {
      throw new Error('AgentManager not found in registry');
    }

    const agentData = await agentManager.loadAgent(targetAgentType);
    if (!agentData) {
      throw new Error(`Agent '${targetAgentType}' not found`);
    }

    logger.debug('[AGENT_SWITCHER]', 'Loaded agent definition:', agentData.name);

    // Get config
    const configManager = registry.get<ConfigManager>('config_manager');
    if (!configManager) {
      throw new Error('ConfigManager not found in registry');
    }

    // Get tool manager for computing allowed tools
    const toolManager = registry.get<ToolManager>('tool_manager');
    if (!toolManager) {
      throw new Error('ToolManager not found in registry');
    }

    // Compute allowed tools using centralized helper
    const allToolNames = toolManager.getAllTools().map(t => t.name);
    const allowedTools = agentManager.computeAllowedTools(agentData, allToolNames);

    // Create agent config with target agent's settings
    agentConfig = {
      config: configManager.getConfig(),
      isSpecializedAgent: false, // Top-level agent, not a sub-agent
      allowTodoManagement: true, // Root privilege
      allowedTools: allowedTools, // Restrict to specific tools if defined
      baseAgentPrompt: agentData.system_prompt,
      taskPrompt: agentData.description,
      agentType: targetAgentType,
      agentDepth: 0, // Root level
      agentCallStack: [], // Fresh call stack
    };

    // Log tool restrictions if specified
    if (agentData.tools && Array.isArray(agentData.tools)) {
      logger.debug('[AGENT_SWITCHER]', 'Agent restricted to tools:', agentData.tools);
    }
  }

  // Get required services with comprehensive null safety
  const modelClient = registry.get<ModelClient>('model_client');
  const toolManager = registry.get<ToolManager>('tool_manager');
  const activityStream = registry.get<ActivityStream>('activity_stream');
  const configManager = registry.get<ConfigManager>('config_manager');
  const permissionManager = registry.get<PermissionManager>('permission_manager');

  // Validate all required services are available
  const missingServices: string[] = [];
  if (!modelClient) missingServices.push('model_client');
  if (!toolManager) missingServices.push('tool_manager');
  if (!activityStream) missingServices.push('activity_stream');
  if (!configManager) missingServices.push('config_manager');

  if (missingServices.length > 0) {
    throw new Error(
      `Agent switching failed: Required services not found in registry: ${missingServices.join(', ')}. ` +
      `This usually indicates incomplete initialization. Please restart the application.`
    );
  }

  // Validate ActivityStream is shared (critical assumption for skipping cleanup)
  const oldAgentStream = (currentAgent as any).activityStream;
  const streamsMatch = oldAgentStream === activityStream;

  if (!streamsMatch) {
    logger.warn(
      '[AGENT_SWITCHER]',
      'ActivityStream instances do not match! Old and new agents have different streams.',
      'This may cause event routing issues.'
    );
  }

  logger.debug(
    '[AGENT_SWITCHER]',
    `ActivityStream validation: ${streamsMatch ? 'PASS' : 'FAIL'}`,
    `(old: ${oldAgentStream?.constructor?.name}, new: ${activityStream?.constructor?.name})`
  );

  // Create new agent instance with target configuration
  // Non-null assertions are safe here because we validated services above
  logger.debug('[AGENT_SWITCHER]', 'Creating new agent instance');
  const newAgent = new Agent(
    modelClient!,
    toolManager!,
    activityStream!,
    agentConfig,
    configManager || undefined,
    permissionManager || undefined
  );

  logger.debug('[AGENT_SWITCHER]', 'New agent created with ID:', newAgent.getInstanceId());

  // Add context marker to history indicating the switch
  const switchMessage: Message = {
    role: 'system',
    content: isMainAgent
      ? `[Agent switched back to main Ally agent]`
      : `[Agent switched to: ${targetAgentType}]`,
    timestamp: Date.now(),
  };

  // Transfer conversation history to new agent
  // Load messages first (clears any existing), then add switch marker
  await newAgent.loadMessages(conversationHistory);
  newAgent.addMessage(switchMessage);
  logger.debug('[AGENT_SWITCHER]', 'Transferred', conversationHistory.length, 'messages to new agent');

  // NOTE: We intentionally DO NOT call currentAgent.cleanup() here
  // because it would call activityStream.cleanup() which removes ALL
  // listeners from the shared ActivityStream, breaking UI subscriptions.
  // The old agent will be garbage collected naturally.
  logger.debug('[AGENT_SWITCHER]', 'Skipping cleanup (shared ActivityStream)');

  // Register new agent in ServiceRegistry
  registry.registerInstance('agent', newAgent);
  logger.debug('[AGENT_SWITCHER]', 'Registered new agent in ServiceRegistry');
  logger.debug('[AGENT_SWITCHER]', 'Agent switch complete');

  return newAgent;
}
