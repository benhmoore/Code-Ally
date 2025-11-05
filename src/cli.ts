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
import { AGENT_POOL } from './config/constants.js';

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

  // Show current configuration
  if (options.configShow) {
    console.log(JSON.stringify(configManager.getConfig(), null, 2));
    return true;
  }

  // Reset configuration to defaults
  if (options.configReset) {
    await configManager.reset();
    console.log('✓ Configuration reset to defaults\n');
    return true;
  }

  // Save current settings as new defaults
  if (options.config) {
    const newConfig: any = {};

    if (options.model !== undefined) newConfig.model = options.model;
    if (options.endpoint !== undefined) newConfig.endpoint = options.endpoint;
    if (options.temperature !== undefined)
      newConfig.temperature = options.temperature;
    if (options.contextSize !== undefined)
      newConfig.context_size = options.contextSize;
    if (options.maxTokens !== undefined)
      newConfig.max_tokens = options.maxTokens;
    if (options.autoConfirm !== undefined)
      newConfig.auto_confirm = options.autoConfirm;

    await configManager.setValues(newConfig);
    console.log('✓ Configuration saved successfully\n');
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
        console.log(`\n✓ Created new session: ${sessionId}\n`);
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

    // Initialize service registry
    const registry = ServiceRegistry.getInstance();
    registry.registerInstance('config_manager', configManager);
    registry.registerInstance('session_manager', sessionManager);

    // Create activity stream
    const activityStream = new ActivityStream();
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

    // Create project context detector
    const { ProjectContextDetector } = await import('./services/ProjectContextDetector.js');
    const projectContextDetector = new ProjectContextDetector(process.cwd());
    await projectContextDetector.initialize();
    registry.registerInstance('project_context_detector', projectContextDetector);

    // Import and create tools
    const { BashTool } = await import('./tools/BashTool.js');
    const { ReadTool } = await import('./tools/ReadTool.js');
    const { WriteTool } = await import('./tools/WriteTool.js');
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
    const { SessionLookupTool } = await import('./tools/SessionLookupTool.js');
    const { SessionReadTool } = await import('./tools/SessionReadTool.js');
    const { AskSessionTool } = await import('./tools/AskSessionTool.js');
    const { ListSessionsTool } = await import('./tools/ListSessionsTool.js');
    const { LintTool } = await import('./tools/LintTool.js');
    const { FormatTool } = await import('./tools/FormatTool.js');

    const tools = [
      new BashTool(activityStream, config),
      new ReadTool(activityStream, config),
      new WriteTool(activityStream),
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
      new ListSessionsTool(activityStream),
      new SessionLookupTool(activityStream),
      new SessionReadTool(activityStream),
      new AskSessionTool(activityStream),
      new LintTool(activityStream),
      new FormatTool(activityStream),
    ];

    // Load user plugins from ~/.ally/plugins
    const { PluginLoader } = await import('./plugins/PluginLoader.js');
    const { PluginConfigManager } = await import('./plugins/PluginConfigManager.js');
    const { PLUGINS_DIR } = await import('./config/paths.js');
    const pluginConfigManager = new PluginConfigManager();
    registry.registerInstance('plugin_config_manager', pluginConfigManager);
    const pluginLoader = new PluginLoader(activityStream, pluginConfigManager);
    registry.registerInstance('plugin_loader', pluginLoader);
    const { tools: pluginTools, pluginCount } = await pluginLoader.loadPlugins(PLUGINS_DIR);

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
    await agentManager.ensureDefaultAgent();
    registry.registerInstance('agent_manager', agentManager);

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
        maxPoolSize: AGENT_POOL.DEFAULT_MAX_SIZE, // Keep up to 5 agents in pool (auto-evict least recently used when full)
        verbose: options.debug || false, // Enable verbose logging in debug mode
      }
    );
    await agentPoolService.initialize();
    registry.registerInstance('agent_pool', agentPoolService);

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
        showSetupWizard: options.init, // Show setup wizard if --init flag was passed
        pluginCount,
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
