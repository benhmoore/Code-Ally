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
import { SetupWizard } from './cli/SetupWizard.js';
import { logger } from './services/Logger.js';
import { formatRelativeTime } from './ui/utils/timeUtils.js';

/**
 * Comprehensive terminal state reset
 *
 * Resets ALL possible escape sequences that could leak and corrupt the terminal.
 * Call this on exit to ensure clean terminal state.
 */
function resetTerminalState(): void {
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
 * Configure logging based on verbosity flags
 */
function configureLogging(verbose?: boolean, debug?: boolean): void {
  logger.configure({ verbose, debug });
}

/**
 * Check Ollama availability and model access
 */
async function checkOllamaAvailability(
  endpoint: string,
  _model: string | null
): Promise<{ available: boolean; models: string[]; error?: string }> {
  try {
    const response = await fetch(`${endpoint}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return {
        available: false,
        models: [],
        error: `HTTP ${response.status}`,
      };
    }

    const data = (await response.json()) as { models?: Array<{ name: string }> };
    const models = (data.models || []).map((m: { name: string }) => m.name);

    return { available: true, models };
  } catch (error) {
    return {
      available: false,
      models: [],
      error: error instanceof Error ? error.message : 'Connection failed',
    };
  }
}

/**
 * Print Ollama setup instructions
 */
function printOllamaInstructions(endpoint: string, error?: string): void {
  console.log('\n⚠️  Ollama Configuration Required\n');
  console.log('1. Make sure Ollama is installed:');
  console.log('   - Download from: https://ollama.ai');
  console.log('   - Follow the installation instructions for your platform\n');
  console.log('2. Start the Ollama server:');
  console.log('   - Run the Ollama application');
  console.log('   - Or start it from the command line: `ollama serve`\n');
  console.log('3. Pull a compatible model:');
  console.log(
    '   - Run: `ollama pull <model-name>` (choose a model that supports function calling)\n'
  );
  console.log('4. Verify Ollama is running:');
  console.log(`   - Run: curl ${endpoint}/api/tags`);
  console.log('   - You should see a JSON response with available models\n');
  if (error) {
    console.log(`Current error: ${error}\n`);
  }
}

/**
 * Handle configuration commands (--init, --config-show, etc.)
 */
async function handleConfigCommands(
  options: CLIOptions,
  configManager: ConfigManager
): Promise<boolean> {
  // Run interactive setup wizard
  if (options.init) {
    const wizard = new SetupWizard(configManager);
    await wizard.run();
    return true;
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
    if (options.bashTimeout !== undefined)
      newConfig.bash_timeout = options.bashTimeout;
    if (options.yesToAll !== undefined)
      newConfig.auto_confirm = options.yesToAll;

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
  if (options.bashTimeout !== undefined)
    overrides.bash_timeout = options.bashTimeout;
  if (options.yesToAll !== undefined || options.autoConfirm !== undefined) {
    overrides.auto_confirm = options.yesToAll || options.autoConfirm;
  }

  return overrides;
}

/**
 * Handle --once mode (single message, non-interactive)
 */
async function handleOnceMode(
  message: string,
  options: CLIOptions,
  _agent: Agent,
  sessionManager: SessionManager
): Promise<void> {
  // Create or load session
  let sessionName: string | null = null;

  if (!options.noSession) {
    if (options.session) {
      sessionName = options.session;
    } else {
      sessionName = sessionManager.generateSessionName();
    }

    sessionManager.setCurrentSession(sessionName);

    // Load existing session if it exists
    if (await sessionManager.sessionExists(sessionName)) {
      const messages = await sessionManager.getSessionMessages(sessionName);
      console.log(
        `\nResuming session: ${sessionName} (${messages.length} messages)\n`
      );
      // TODO: Add messages to agent context
    }
  }

  // Send the message
  console.log(`> ${message}\n`);

  try {
    // TODO: Implement agent.sendMessage() for single message mode
    console.log('Agent response would go here...\n');

    // Save session if enabled
    if (sessionName) {
      // TODO: Get messages from agent and save
      // await sessionManager.saveSession(sessionName, agent.messages);
      console.log(`[Session: ${sessionName}]\n`);
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

/**
 * Setup and validate Ollama
 */
async function setupOllamaValidation(
  options: CLIOptions,
  config: any
): Promise<string | null> {
  if (options.skipOllamaCheck) {
    return config.model;
  }

  if (options.verbose || options.debug) {
    console.log('Checking Ollama availability...');
  }

  const result = await checkOllamaAvailability(config.endpoint, config.model);

  if (!result.available) {
    console.error(`\n✗ Error: ${result.error || 'Unknown error'}\n`);
    printOllamaInstructions(config.endpoint, result.error);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>(resolve => {
      rl.question('Do you want to continue anyway? (y/n): ', resolve);
    });
    rl.close();

    if (!answer.toLowerCase().startsWith('y')) {
      console.log('\nExiting. Please configure Ollama and try again.\n');
      process.exit(0);
    }

    console.log('\nContinuing without validated Ollama setup...\n');
    return config.model;
  }

  // Ollama is running, check model availability
  if (result.models.length === 0) {
    console.log('\n⚠️  Warning: No models are available in Ollama');
    console.log(
      'Please install a model with: ollama pull <model-name>\n'
    );
    return config.model;
  }

  // Auto-select model if not specified
  if (!config.model) {
    const selectedModel = result.models[0];
    if (selectedModel) {
      console.log(
        `\nℹ️  No model configured, automatically selecting: ${selectedModel}\n`
      );
      return selectedModel;
    }
    return null;
  }

  // Check if configured model is available
  if (!result.models.includes(config.model)) {
    console.log(`\n⚠️  Warning: Model '${config.model}' is not available`);
    console.log(`Available models: ${result.models.join(', ')}\n`);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const answer = await new Promise<string>(resolve => {
      rl.question(
        `Auto-select '${result.models[0] || 'first available model'}'? (y/n): `,
        resolve
      );
    });
    rl.close();

    if (answer.toLowerCase().startsWith('y')) {
      return result.models[0] || null;
    }
  }

  if (options.verbose || options.debug) {
    console.log(
      `✓ Ollama is running and model '${config.model}' is available\n`
    );
  }

  return config.model;
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

    // First-run detection: Check if setup has been completed
    const setupCompleted = configManager.getValue('setup_completed');
    if (!setupCompleted && !options.init && !options.skipOllamaCheck) {
      console.log('\n👋 Welcome to Code Ally!\n');
      console.log('It looks like this is your first time running Code Ally.');
      console.log('Let\'s configure it for your environment.\n');

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const answer = await new Promise<string>(resolve => {
        rl.question('Would you like to run the setup wizard now? (Y/n): ', resolve);
      });
      rl.close();

      const shouldRunSetup = !answer || answer.trim() === '' || answer.toLowerCase().startsWith('y');

      if (shouldRunSetup) {
        const wizard = new SetupWizard(configManager);
        const success = await wizard.run();

        if (!success) {
          console.log('\nYou can run setup later with: ally --init\n');
        }
      } else {
        console.log('\nSetup skipped. You can run it later with: ally --init\n');
        console.log('⚠️  Note: Code Ally may not work correctly without proper configuration.\n');
      }

      // Exit after setup to allow user to see completion message
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

    // Setup and validate Ollama (unless skipped)
    const selectedModel = await setupOllamaValidation(options, configOverrides);
    if (selectedModel) {
      configOverrides.model = selectedModel;
    }

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
    const todoManager = new TodoManager();
    registry.registerInstance('todo_manager', todoManager);

    // Create path resolver
    const pathResolver = new PathResolver();
    registry.registerInstance('path_resolver', pathResolver);

    // Create LLM client
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

    // Create message history
    const messageHistory = new MessageHistory({
      maxTokens: config.context_size,
    });
    registry.registerInstance('message_history', messageHistory);

    // Create idle message generator
    const { IdleMessageGenerator } = await import('./services/IdleMessageGenerator.js');
    const idleMessageGenerator = new IdleMessageGenerator(modelClient, {
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
    const { AgentTool } = await import('./tools/AgentTool.js');
    const { BatchTool } = await import('./tools/BatchTool.js');
    const { TodoWriteTool } = await import('./tools/TodoWriteTool.js');
    const { SessionLookupTool } = await import('./tools/SessionLookupTool.js');
    const { SessionReadTool } = await import('./tools/SessionReadTool.js');
    const { LintTool } = await import('./tools/LintTool.js');
    const { FormatTool } = await import('./tools/FormatTool.js');

    const tools = [
      new BashTool(activityStream),
      new ReadTool(activityStream, config),
      new WriteTool(activityStream),
      new AllyWriteTool(activityStream),
      new EditTool(activityStream),
      new LineEditTool(activityStream),
      new GlobTool(activityStream),
      new GrepTool(activityStream),
      new LsTool(activityStream),
      new AgentTool(activityStream),
      new BatchTool(activityStream),
      new TodoWriteTool(activityStream),
      new SessionLookupTool(activityStream),
      new SessionReadTool(activityStream),
      new LintTool(activityStream),
      new FormatTool(activityStream),
    ];

    // Create tool manager
    const toolManager = new ToolManager(tools, activityStream);
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

    // Get system prompt from prompts module
    const { getMainSystemPrompt } = await import('./prompts/systemMessages.js');
    const systemPrompt = await getMainSystemPrompt();

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
      return;
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
      }),
      {
        exitOnCtrlC: false,
        patchConsole: true, // Intercept console to prevent interference with Ink rendering
      }
    );

    // Wait for the app to exit
    await waitUntilExit();

    // Critical: Comprehensive terminal reset to clean up ANY escape sequence leakage
    resetTerminalState();

    // No final save needed - auto-save happens after every user message and model response
    // A final save here would just overwrite good data with potentially stale data

    // Cleanup
    await registry.shutdown();
  } catch (error) {
    // Critical: Reset terminal even on fatal errors (only if UI was started)
    if (inkUIStarted) {
      resetTerminalState();
    }
    console.error('Fatal error:', error);
    process.exit(1);
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
    resetTerminalState();
  }
  process.exit(130); // Standard exit code for SIGINT
});

process.on('SIGTERM', () => {
  if (inkUIStarted) {
    resetTerminalState();
  }
  process.exit(143); // Standard exit code for SIGTERM
});

process.on('uncaughtException', (error) => {
  if (inkUIStarted) {
    resetTerminalState();
  }
  console.error('Uncaught exception:', error);
  process.exit(1);
});

main();
