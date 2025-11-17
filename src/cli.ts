#!/usr/bin/env node
/**
 * Code Ally CLI Entry Point
 *
 * Handles argument parsing, configuration, and mode selection
 * before launching the appropriate mode (interactive, once, setup, etc.).
 */

import React from 'react';
import { render } from 'ink';
import readline from 'readline';
import { ServiceRegistry } from './services/ServiceRegistry.js';
import { ConfigManager } from './services/ConfigManager.js';
import { SessionManager } from './services/SessionManager.js';
import { ActivityStream } from './services/ActivityStream.js';
import { PathResolver } from './services/PathResolver.js';
import { TodoManager } from './services/TodoManager.js';
import { OllamaClient } from './llm/OllamaClient.js';
import { MessageHistory } from './llm/MessageHistory.js';
import { ToolManager } from './tools/ToolManager.js';
import { TrustManager } from './agent/TrustManager.js';
import { PermissionManager } from './security/PermissionManager.js';
import { Agent } from './agent/Agent.js';
import { App } from './ui/App.js';
import { ArgumentParser, type CLIOptions } from './cli/ArgumentParser.js';
import { logger } from './services/Logger.js';
import { formatRelativeTime } from './ui/utils/timeUtils.js';
import { AGENT_CONFIG } from './config/constants.js';
import { runStartupValidation, needsSetup } from './cli/validation.js';

/**
 * Comprehensive terminal state reset
 *
 * Resets ALL possible escape sequences that could leak and corrupt the terminal.
 * Call this on exit to ensure clean terminal state.
 */
function resetTerminalState(): void {
  // Clear screen and move cursor to home
  process.stdout.write('\x1b[2J\x1b[H');

  // Close any open hyperlinks (OSC 8)
  process.stdout.write('\x1b]8;;\x1b\\');

  // Reset all text formatting (SGR 0)
  process.stdout.write('\x1b[0m');

  // Show cursor (in case it was hidden)
  process.stdout.write('\x1b[?25h');

  // Reset foreground/background colors
  process.stdout.write('\x1b[39m\x1b[49m');

  // Exit alternate screen buffer (in case it was entered)
  process.stdout.write('\x1b[?1049l');

  // Reset bracketed paste mode
  process.stdout.write('\x1b[?2004l');

  // Ensure we're at the start of a new line
  process.stdout.write('\n');
}

/**
 * Clean exit with proper terminal cleanup and stdout flushing
 *
 * Ensures all escape sequences are processed before the application exits.
 * This prevents the terminal from getting stuck waiting for input.
 */
function cleanExit(code: number = 0): void {
  resetTerminalState();

  // Wait for stdout to drain before exiting
  if (process.stdout.write('')) {
    // Buffer is empty, exit immediately
    process.exit(code);
  } else {
    // Buffer has pending data, wait for drain
    process.stdout.once('drain', () => {
      process.exit(code);
    });

    // Fallback timeout to prevent hanging
    setTimeout(() => {
      process.exit(code);
    }, 100);
  }
}

/**
 * Configure logging based on verbosity flags
 */
function configureLogging(verbose?: boolean, debug?: boolean): void {
  logger.configure({ verbose, debug });
}


/**
 * Handle configuration commands (--init, --config-show, etc.)
 */
async function handleConfigCommands(
  options: CLIOptions,
  configManager: ConfigManager
): Promise<boolean> {
  // --init flag is now handled by the UI (via /init command)
  // This section is kept for backwards compatibility warning
  if (options.init) {
    console.log('\n✓ Starting Code Ally with setup wizard...\n');
    console.log('The setup wizard will appear in the UI.');
    console.log('You can also run setup anytime using the /init command.\n');
    // Don't exit - let the app start and show the wizard
    return false;
  }

  // Handle --config subcommand
  if (options.config) {
    // Parse the subcommand: "show [field]", "set field value", "reset [field]"
    const parts = options.config.trim().split(/\s+/);
    const subcommand = parts[0]?.toLowerCase();

    // Handle "show" subcommand
    if (subcommand === 'show') {
      const field = parts[1]; // Optional field name

      if (field) {
        // Show specific field
        if (!configManager.hasKey(field)) {
          console.error(`Unknown config field: ${field}`);
          const suggestions = configManager.getSimilarKeys(field);
          if (suggestions.length > 0) {
            console.error(`Did you mean: ${suggestions.join(', ')}?`);
          }
          return true;
        }

        const value = configManager.getValue(field as any);
        console.log(`${field}: ${JSON.stringify(value, null, 2)}`);
        return true;
      } else {
        // Show entire config
        console.log(JSON.stringify(configManager.getConfig(), null, 2));
      }

      return true;
    }

    // Handle "set" subcommand
    if (subcommand === 'set') {
      // Format: "set field value"
      if (parts.length < 3) {
        console.error('Usage: --config "set <field> <value>"');
        return true;
      }

      const field = parts[1];
      const value = parts.slice(2).join(' ');
      const kvInput = `${field}=${value}`;

      try {
        const result = await configManager.setFromString(kvInput);
        console.log(`✓ Configuration updated: ${result.key}`);
        console.log(`  Old value: ${JSON.stringify(result.oldValue)}`);
        console.log(`  New value: ${JSON.stringify(result.newValue)}`);
      } catch (error: any) {
        console.error(`Error: ${error.message}`);
      }

      return true;
    }

    // Handle "reset" subcommand
    if (subcommand === 'reset') {
      const field = parts[1]; // Optional field name

      if (field) {
        // Reset specific field
        if (!configManager.hasKey(field)) {
          console.error(`Unknown config field: ${field}`);
          const suggestions = configManager.getSimilarKeys(field);
          if (suggestions.length > 0) {
            console.error(`Did you mean: ${suggestions.join(', ')}?`);
          }
          return true;
        }

        try {
          const result = await configManager.resetField(field as any);
          console.log(`✓ Reset ${result.key} to default`);
          console.log(`  Old value: ${JSON.stringify(result.oldValue)}`);
          console.log(`  New value: ${JSON.stringify(result.newValue)}`);
        } catch (error: any) {
          console.error(`Error: ${error.message}`);
        }
      } else {
        // Reset entire config
        const changes = await configManager.reset();
        const changedKeys = Object.keys(changes);

        if (changedKeys.length === 0) {
          console.log('Configuration is already at default values.');
        } else {
          console.log(`✓ Configuration reset to defaults (${changedKeys.length} settings changed)`);
        }
      }

      return true;
    }

    // Unknown subcommand
    console.error(`Unknown config subcommand: ${subcommand}`);
    console.error('Usage: --config "show [field]" | "set <field> <value>" | "reset [field]"');
    return true;
  }

  return false;
}

/**
 * Handle session management commands
 */
async function handleSessionCommands(
  options: CLIOptions,
  sessionManager: SessionManager
): Promise<boolean> {
  // List all sessions
  if (options.listSessions) {
    const sessions = await sessionManager.getSessionsInfo();

    if (sessions.length === 0) {
      console.log('No sessions found.\n');
    } else {
      console.log('\nAvailable sessions:\n');
      for (const session of sessions) {
        console.log(
          `  ${session.session_id}: ${session.display_name} (${session.message_count} messages, ${formatRelativeTime(session.last_modified_timestamp)})`
        );
      }
      console.log('');
    }

    return true;
  }

  // Delete a session
  if (options.deleteSession) {
    const success = await sessionManager.deleteSession(options.deleteSession);

    if (success) {
      console.log(`✓ Session "${options.deleteSession}" deleted\n`);
    } else {
      console.log(`✗ Session "${options.deleteSession}" not found\n`);
    }

    return true;
  }

  return false;
}

/**
 * Handle --resume command (with or without session ID)
 *
 * @returns Session ID to resume, null if cancelled, or 'interactive' if user needs to select
 */
async function handleResumeCommand(
  options: CLIOptions,
  sessionManager: SessionManager
): Promise<string | null | 'interactive'> {
  // --resume not provided
  if (options.resume === undefined) {
    return null;
  }

  // --resume provided with specific session ID
  if (typeof options.resume === 'string' && options.resume.length > 0) {
    const sessionId = options.resume;

    // Check if session exists
    if (await sessionManager.sessionExists(sessionId)) {
      return sessionId;
    } else {
      console.log(`\n✗ Session "${sessionId}" not found.\n`);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>(resolve => {
        rl.question('Would you like to create a new session with this name? (y/n): ', resolve);
      });
      rl.close();

      if (answer.toLowerCase().startsWith('y')) {
        await sessionManager.createSession(sessionId);
        sessionManager.setCurrentSession(sessionId);
        console.log(`\n✓ Created new session: ${sessionId}\n`);

        // Notify PatchManager about the new session
        const registry = ServiceRegistry.getInstance();
        const patchManager = registry.get('patch_manager');
        if (patchManager && typeof (patchManager as any).onSessionChange === 'function') {
          await (patchManager as any).onSessionChange();
        }

        return sessionId;
      }

      return null;
    }
  }

  // --resume without session ID - show interactive selector
  return 'interactive';
}

/**
 * Apply CLI overrides to configuration
 */
function applyConfigOverrides(
  config: any,
  options: CLIOptions
): Record<string, any> {
  const overrides: Record<string, any> = { ...config };

  if (options.model !== undefined) overrides.model = options.model;
  if (options.endpoint !== undefined) overrides.endpoint = options.endpoint;
  if (options.temperature !== undefined)
    overrides.temperature = options.temperature;
  if (options.contextSize !== undefined)
    overrides.context_size = options.contextSize;
  if (options.maxTokens !== undefined)
    overrides.max_tokens = options.maxTokens;
  if (options.reasoningEffort !== undefined)
    overrides.reasoning_effort = options.reasoningEffort;
  if (options.autoConfirm !== undefined) {
    overrides.auto_confirm = options.autoConfirm;
  }

  return overrides;
}

/**
 * Handle --once mode (single message, non-interactive)
 */
async function handleOnceMode(
  message: string,
  options: CLIOptions,
  agent: Agent,
  sessionManager: SessionManager
): Promise<void> {
  // Once mode never creates sessions (single message, non-interactive)
  // If user explicitly wants a session with --once, they can use --session
  let sessionName: string | null = null;

  // Only use sessions if explicitly requested via --session
  if (options.session && !options.noSession) {
    sessionName = options.session;
    sessionManager.setCurrentSession(sessionName);

    // Notify PatchManager about the session change
    const registry = ServiceRegistry.getInstance();
    const patchManager = registry.get('patch_manager');
    if (patchManager && typeof (patchManager as any).onSessionChange === 'function') {
      await (patchManager as any).onSessionChange();
    }

    // Load existing session if it exists
    if (await sessionManager.sessionExists(sessionName)) {
      const messages = await sessionManager.getSessionMessages(sessionName);
      agent.setMessages(messages);
    }
  }

  // Send the message (don't echo it - user already typed it)
  try {
    const response = await agent.sendMessage(message);
    console.log(response);

    // Save session only if explicitly requested
    if (sessionName) {
      await sessionManager.saveSession(sessionName, agent.getMessages());
      console.log(`\n[Session: ${sessionName}]`);
    }
  } catch (error) {
    console.error('Error:', error);
    cleanExit(1);
  }
}


/**
 * Track whether the Ink UI was started (requires terminal reset on exit)
 */
let inkUIStarted = false;

/**
 * Main entry point
 */
async function main() {
  try {
    // Parse command-line arguments
    const parser = new ArgumentParser();
    const options = parser.parse();

    // Initialize config manager
    const configManager = new ConfigManager();
    await configManager.initialize();

    // Handle configuration commands
    if (await handleConfigCommands(options, configManager)) {
      return;
    }

    // Initialize session manager (without model client for now, will be set later)
    const sessionManager = new SessionManager();
    await sessionManager.initialize();

    // Handle session commands
    if (await handleSessionCommands(options, sessionManager)) {
      return;
    }

    // Handle --resume command
    const resumeSession = await handleResumeCommand(options, sessionManager);
    if (resumeSession === null && options.resume !== undefined) {
      // User cancelled or session not found
      return;
    }

    // Apply CLI overrides to configuration
    const configOverrides = applyConfigOverrides(
      configManager.getConfig(),
      options
    );

    // Configure logging
    configureLogging(options.verbose, options.debug);

    // Use full config type
    const config = configOverrides as import('./types/index.js').Config;

    // Check if critical config is missing - force setup wizard if so
    const forceSetup = needsSetup(config);

    // Validate Ollama connectivity and model availability (skip if needs setup, in --once mode, or --init mode)
    let forceModelSelector = false;
    let availableModels: any[] | undefined;
    if (!options.once && !forceSetup && !options.init) {
      const validationResult = await runStartupValidation(config);

      // Critical error: Ollama not connected - exit immediately
      if (!validationResult.ollamaConnected) {
        process.exit(1);
      }

      // Model not found but Ollama is running - continue and show model selector
      if (!validationResult.modelFound) {
        forceModelSelector = true;
        availableModels = validationResult.availableModels;
      }
    }

    // Initialize service registry
    const registry = ServiceRegistry.getInstance();
    registry.registerInstance('config_manager', configManager);
    registry.registerInstance('session_manager', sessionManager);

    // Initialize background plugin services (must be before ActivityStream)
    const { SocketClient } = await import('./plugins/SocketClient.js');
    const { BackgroundProcessManager } = await import('./plugins/BackgroundProcessManager.js');
    const { EventSubscriptionManager } = await import('./plugins/EventSubscriptionManager.js');
    const socketClient = new SocketClient();
    registry.registerInstance('socket_client', socketClient);
    const backgroundProcessManager = new BackgroundProcessManager();
    registry.registerInstance('background_process_manager', backgroundProcessManager);
    const eventSubscriptionManager = new EventSubscriptionManager(socketClient, backgroundProcessManager);
    registry.registerInstance('event_subscription_manager', eventSubscriptionManager);

    // Create activity stream with event subscription manager for plugin events
    const activityStream = new ActivityStream(undefined, eventSubscriptionManager);
    registry.registerInstance('activity_stream', activityStream);

    // Create todo manager
    const todoManager = new TodoManager(activityStream);
    registry.registerInstance('todo_manager', todoManager);

    // Create path resolver
    const pathResolver = new PathResolver();
    registry.registerInstance('path_resolver', pathResolver);

    // Create focus manager
    const { FocusManager } = await import('./services/FocusManager.js');
    const focusManager = new FocusManager();
    registry.registerInstance('focus_manager', focusManager);

    // Create patch manager for undo functionality (session-specific)
    const { PatchManager } = await import('./services/PatchManager.js');
    const patchManager = new PatchManager({
      getSessionId: () => sessionManager.getCurrentSession(),
      maxPatchesPerSession: 100, // Keep last 100 patches per session
      maxPatchesSizeBytes: 10 * 1024 * 1024, // 10MB limit per session
    });
    await patchManager.initialize();
    registry.registerInstance('patch_manager', patchManager);

    // Create LLM client (main agent model)
    const modelClient = new OllamaClient({
      endpoint: config.endpoint,
      modelName: config.model,
      temperature: config.temperature,
      contextSize: config.context_size,
      maxTokens: config.max_tokens,
      reasoningEffort: config.reasoning_effort,
      activityStream,
    });
    registry.registerInstance('model_client', modelClient);

    // Create service model client (for background services like titles, idle messages)
    // Defaults to main model if service_model not specified
    const serviceModelName = config.service_model ?? config.model;
    const serviceModelClient = new OllamaClient({
      endpoint: config.endpoint,
      modelName: serviceModelName,
      temperature: config.temperature,
      contextSize: config.context_size,
      maxTokens: config.max_tokens,
      reasoningEffort: config.reasoning_effort,
      activityStream,
    });
    registry.registerInstance('service_model_client', serviceModelClient);

    // Configure session manager with service model client for title generation
    sessionManager.setModelClient(serviceModelClient);

    // Create session title generator for idle task coordination
    const { SessionTitleGenerator } = await import('./services/SessionTitleGenerator.js');
    const sessionTitleGenerator = new SessionTitleGenerator(serviceModelClient);
    registry.registerInstance('session_title_generator', sessionTitleGenerator);

    // Create message history
    const messageHistory = new MessageHistory({
      maxTokens: config.context_size,
    });
    registry.registerInstance('message_history', messageHistory);

    // Create idle message generator
    const { IdleMessageGenerator } = await import('./services/IdleMessageGenerator.js');
    const idleMessageGenerator = new IdleMessageGenerator(serviceModelClient, {
      minInterval: 10000, // Generate new message every 10 seconds when idle
    });
    registry.registerInstance('idle_message_generator', idleMessageGenerator);

    // Create idle task coordinator (requires sessionManager, titleGenerator, and idleMessageGenerator)
    const { IdleTaskCoordinator } = await import('./services/IdleTaskCoordinator.js');
    const idleTaskCoordinator = new IdleTaskCoordinator(
      sessionTitleGenerator,
      idleMessageGenerator,
      sessionManager
    );
    await idleTaskCoordinator.initialize();
    registry.registerInstance('idle_task_coordinator', idleTaskCoordinator);

    // Create project context detector
    const { ProjectContextDetector } = await import('./services/ProjectContextDetector.js');
    const projectContextDetector = new ProjectContextDetector(process.cwd());
    await projectContextDetector.initialize();
    registry.registerInstance('project_context_detector', projectContextDetector);

    // Import and create tools
    const { BashTool } = await import('./tools/BashTool.js');
    const { ReadTool } = await import('./tools/ReadTool.js');
    const { WriteTool } = await import('./tools/WriteTool.js');
    const { WriteTempTool } = await import('./tools/WriteTempTool.js');
    const { AllyWriteTool } = await import('./tools/AllyWriteTool.js');
    const { EditTool } = await import('./tools/EditTool.js');
    const { LineEditTool } = await import('./tools/LineEditTool.js');
    const { GlobTool } = await import('./tools/GlobTool.js');
    const { GrepTool } = await import('./tools/GrepTool.js');
    const { LsTool } = await import('./tools/LsTool.js');
    const { TreeTool } = await import('./tools/TreeTool.js');
    const { AgentTool } = await import('./tools/AgentTool.js');
    const { ExploreTool } = await import('./tools/ExploreTool.js');
    const { PlanTool } = await import('./tools/PlanTool.js');
    const { AgentAskTool } = await import('./tools/AgentAskTool.js');
    const { BatchTool } = await import('./tools/BatchTool.js');
    const { TodoAddTool } = await import('./tools/TodoAddTool.js');
    const { TodoRemoveTool } = await import('./tools/TodoRemoveTool.js');
    const { TodoUpdateTool } = await import('./tools/TodoUpdateTool.js');
    const { TodoClearTool } = await import('./tools/TodoClearTool.js');
    const { TodoListTool } = await import('./tools/TodoListTool.js');
    const { DenyProposalTool } = await import('./tools/DenyProposalTool.js');
    const { SessionsTool } = await import('./tools/SessionsTool.js');
    const { LintTool } = await import('./tools/LintTool.js');
    const { FormatTool } = await import('./tools/FormatTool.js');

    const tools = [
      new BashTool(activityStream, config),
      new ReadTool(activityStream, config),
      new WriteTool(activityStream),
      new WriteTempTool(activityStream), // Internal tool for explore agents
      new AllyWriteTool(activityStream),
      new EditTool(activityStream),
      new LineEditTool(activityStream),
      new GlobTool(activityStream),
      new GrepTool(activityStream),
      new LsTool(activityStream),
      new TreeTool(activityStream),
      new AgentTool(activityStream),
      new ExploreTool(activityStream),
      new PlanTool(activityStream),
      new AgentAskTool(activityStream),
      new BatchTool(activityStream),
      new TodoAddTool(activityStream),
      new TodoRemoveTool(activityStream),
      new TodoUpdateTool(activityStream),
      new TodoClearTool(activityStream),
      new TodoListTool(activityStream),
      new DenyProposalTool(activityStream), // Always available
      new SessionsTool(activityStream),
      new LintTool(activityStream),
      new FormatTool(activityStream),
    ];

    // Load user plugins from ~/.ally/plugins
    const { PluginLoader } = await import('./plugins/PluginLoader.js');
    const { PluginConfigManager } = await import('./plugins/PluginConfigManager.js');
    const { PLUGINS_DIR } = await import('./config/paths.js');
    const pluginConfigManager = new PluginConfigManager();
    registry.registerInstance('plugin_config_manager', pluginConfigManager);
    const pluginLoader = new PluginLoader(
      activityStream,
      pluginConfigManager,
      socketClient,
      backgroundProcessManager,
      eventSubscriptionManager
    );
    registry.registerInstance('plugin_loader', pluginLoader);
    const { tools: pluginTools, agents: pluginAgents, pluginCount } = await pluginLoader.loadPlugins(PLUGINS_DIR);
    logger.debug('[CLI] Plugins loaded successfully');

    // Start background plugin daemons
    await pluginLoader.startBackgroundPlugins();
    logger.debug('[CLI] Background plugins started');

    // Add graceful shutdown for background plugins
    const shutdownHandler = async (signal: string) => {
      logger.info(`[CLI] Received ${signal}, shutting down background plugins...`);
      try {
        await backgroundProcessManager.stopAllProcesses();
        logger.info('[CLI] Background plugins stopped successfully');
      } catch (error) {
        logger.error(`[CLI] Error stopping background plugins: ${error instanceof Error ? error.message : String(error)}`);
      }
      process.exit(0);
    };

    // Create and initialize PluginActivationManager
    // This must be done AFTER plugins are loaded and BEFORE ToolManager is created
    const { PluginActivationManager } = await import('./plugins/PluginActivationManager.js');
    const pluginActivationManager = new PluginActivationManager(
      pluginLoader,
      sessionManager
    );
    await pluginActivationManager.initialize();
    registry.setPluginActivationManager(pluginActivationManager);
    logger.debug('[CLI] PluginActivationManager initialized');

    // Get active plugin count for UI display
    const activePluginCount = pluginActivationManager.getActivePlugins().length;

    // Merge built-in tools with plugin tools
    const allTools = [...tools, ...pluginTools];

    // Create tool manager with all tools
    const toolManager = new ToolManager(allTools, activityStream);
    registry.registerInstance('tool_manager', toolManager);

    // Create trust manager for permission tracking
    const trustManager = new TrustManager(config.auto_confirm, activityStream);
    registry.registerInstance('trust_manager', trustManager);

    // Create permission manager for security checks
    const permissionManager = new PermissionManager(trustManager);
    registry.registerInstance('permission_manager', permissionManager);

    // Create agent manager for specialized agents
    const { AgentManager } = await import('./services/AgentManager.js');
    const agentManager = new AgentManager();
    registry.registerInstance('agent_manager', agentManager);

    // Register plugin agents with AgentManager
    if (pluginAgents.length > 0) {
      agentManager.registerPluginAgents(pluginAgents);
      logger.debug(`[CLI] Registered ${pluginAgents.length} plugin agent(s)`);
    }

    // Register built-in tool-based agents
    logger.debug('[CLI] Registering built-in tool-agents');
    const exploreTool = toolManager.getTool('explore');
    const planTool = toolManager.getTool('plan');
    const sessionsTool = toolManager.getTool('sessions');

    if (exploreTool && 'getAgentMetadata' in exploreTool) {
      agentManager.registerBuiltInAgent((exploreTool as any).getAgentMetadata());
    }
    if (planTool && 'getAgentMetadata' in planTool) {
      agentManager.registerBuiltInAgent((planTool as any).getAgentMetadata());
    }
    if (sessionsTool && 'getAgentMetadata' in sessionsTool) {
      agentManager.registerBuiltInAgent((sessionsTool as any).getAgentMetadata());
    }
    logger.debug('[CLI] Built-in tool-agents registered');

    // Create agent generation service for LLM-assisted agent creation
    const { AgentGenerationService } = await import('./services/AgentGenerationService.js');
    const agentGenerationService = new AgentGenerationService(serviceModelClient);
    registry.registerInstance('agent_generation_service', agentGenerationService);

    // Create project manager for project context
    const { ProjectManager } = await import('./services/ProjectManager.js');
    const projectManager = new ProjectManager();
    registry.registerInstance('project_manager', projectManager);

    // Get system prompt from prompts module
    const { getMainSystemPrompt } = await import('./prompts/systemMessages.js');
    const isOnceMode = !!options.once;
    const systemPrompt = await getMainSystemPrompt(undefined, undefined, isOnceMode);

    // Create agent (creates its own TokenManager and ToolResultManager)
    const agent = new Agent(
      modelClient,
      toolManager,
      activityStream,
      {
        config,
        systemPrompt,
      },
      configManager, // For configurable token limits
      permissionManager
    );
    registry.registerInstance('agent', agent);

    // Register main agent's TokenManager in ServiceRegistry for global access (UI, etc)
    const tokenManager = agent.getTokenManager();
    registry.registerInstance('token_manager', tokenManager);

    // Create agent pool service for managing concurrent agent instances
    const { AgentPoolService } = await import('./services/AgentPoolService.js');
    const agentPoolService = new AgentPoolService(
      modelClient,
      toolManager,
      activityStream,
      configManager,
      permissionManager,
      {
        maxPoolSize: AGENT_CONFIG.AGENT_POOL_SIZE_WITH_NESTING, // Keep up to 15 agents in pool for depth-3 nesting support (auto-evict least recently used when full)
        verbose: options.debug || false, // Enable verbose logging in debug mode
      }
    );
    await agentPoolService.initialize();
    registry.registerInstance('agent_pool', agentPoolService);

    // Install signal handlers for graceful background plugin shutdown
    // Override the global handlers with plugin-aware versions
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');

    process.on('SIGINT', async () => {
      await shutdownHandler('SIGINT');
    });

    process.on('SIGTERM', async () => {
      await shutdownHandler('SIGTERM');
    });

    // Set up callback to save session when idle messages are generated
    // (Must be after agent is registered)
    idleMessageGenerator.setOnQueueUpdated(() => {
      // Trigger auto-save to persist newly generated idle messages
      const todoManager = registry.get<any>('todo_manager');

      if (agent && sessionManager) {
        const todos = todoManager?.getTodos();
        const idleMessages = idleMessageGenerator.getQueue();
        const projectContext = projectContextDetector?.getCached() ?? undefined;

        sessionManager.autoSave(agent.getMessages(), todos, idleMessages, projectContext).catch((error: Error) => {
          logger.debug('[IDLE_MSG] Failed to auto-save after queue update:', error);
        });
      }
    });

    // Handle --once mode (single message, non-interactive)
    if (options.once) {
      await handleOnceMode(options.once, options, agent, sessionManager);
      await registry.shutdown();
      cleanExit(0);
    }

    // Interactive mode - Render the Ink UI
    // IMPORTANT: exitOnCtrlC must be false to allow custom Ctrl+C handling in InputPrompt
    inkUIStarted = true;
    const { waitUntilExit } = render(
      React.createElement(App, {
        config,
        activityStream,
        agent,
        resumeSession,
        showSetupWizard: options.init || forceSetup, // Show setup wizard if --init flag or missing critical config
        showModelSelector: forceModelSelector, // Show model selector if model not found
        availableModels, // Pass available models from validation
        activePluginCount,
        totalPluginCount: pluginCount,
      }),
      {
        exitOnCtrlC: false,
        patchConsole: true, // Intercept console to prevent interference with Ink rendering
      }
    );

    // Wait for the app to exit
    await waitUntilExit();

    // No final save needed - auto-save happens after every user message and model response
    // A final save here would just overwrite good data with potentially stale data

    // Cleanup
    await registry.shutdown();

    // Exit cleanly with terminal reset and stdout flush
    cleanExit(0);
  } catch (error) {
    // Critical: Reset terminal even on fatal errors (only if UI was started)
    console.error('Fatal error:', error);
    if (inkUIStarted) {
      cleanExit(1);
    } else {
      process.exit(1);
    }
  }
}

// Install global handlers to ensure terminal reset on ANY exit
// Only reset if Ink UI was started (to avoid clearing setup messages)
process.on('exit', () => {
  if (inkUIStarted) {
    resetTerminalState();
  }
});

process.on('SIGINT', () => {
  if (inkUIStarted) {
    cleanExit(130); // Standard exit code for SIGINT
  } else {
    process.exit(130);
  }
});

process.on('SIGTERM', () => {
  if (inkUIStarted) {
    cleanExit(143); // Standard exit code for SIGTERM
  } else {
    process.exit(143);
  }
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  if (inkUIStarted) {
    cleanExit(1);
  } else {
    process.exit(1);
  }
});

main();
