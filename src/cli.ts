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
import chalk from 'chalk';
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
import { ProfileManager } from './services/ProfileManager.js';
import { setActiveProfile } from './config/paths.js';
import { initializePrimaryColor } from './ui/constants/colors.js';

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
async function cleanExit(code: number = 0): Promise<void> {
  resetTerminalState();

  // Flush pending session saves if registry exists
  const ServiceRegistry = (await import('./services/ServiceRegistry.js')).ServiceRegistry;
  const registry = ServiceRegistry.getInstance();
  try {
    // Shutdown background bash processes if manager exists
    const bashProcessManager = registry.get<any>('bash_process_manager');
    if (bashProcessManager && typeof bashProcessManager.shutdown === 'function') {
      await bashProcessManager.shutdown();
    }

    await registry.shutdown();
  } catch (error) {
    // Ignore errors during shutdown - already exiting
  }

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
 * Handle --configs command (show cheatsheet)
 */
function handleConfigsCheatsheet(): void {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Configuration Commands Cheatsheet');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('  Show configuration:');
  console.log('    ally --config-show           # Show all settings');
  console.log('    ally --config-show model     # Show specific field\n');

  console.log('  Set configuration:');
  console.log('    ally --config-set model=llama3.2');
  console.log('    ally --config-set temperature=0.5\n');

  console.log('  Reset configuration:');
  console.log('    ally --config-reset          # Reset all to defaults');
  console.log('    ally --config-reset model    # Reset specific field\n');

  console.log('  Initial setup:');
  console.log('    ally --init                  # Interactive setup wizard\n');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n  Configuration file: ~/.ally/profiles/<profile>/config.json');
  console.log('  Documentation: docs/reference/configuration.md\n');
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

  // Show cheatsheet
  if (options.configs) {
    handleConfigsCheatsheet();
    return true;
  }

  // Handle --config-show [field]
  if (options.configShow !== undefined) {
    // When no field provided, configShow is boolean true
    // When field provided, configShow is the field name (string)
    const field = typeof options.configShow === 'string' ? options.configShow : undefined;

    if (field) {
      // Show specific field
      if (!configManager.hasKey(field)) {
        console.error(`\nError: Unknown config field: ${field}`);
        const suggestions = configManager.getSimilarKeys(field);
        if (suggestions.length > 0) {
          console.error(`Did you mean: ${suggestions.join(', ')}?\n`);
        }
        process.exit(1);
      }

      const value = configManager.getValue(field as any);
      console.log(`\n${field}: ${JSON.stringify(value, null, 2)}\n`);
    } else {
      // Show entire config
      console.log('\n' + JSON.stringify(configManager.getConfig(), null, 2) + '\n');
    }

    return true;
  }

  // Handle --config-set <field=value>
  if (options.configSet) {
    const kvInput = options.configSet;

    // Validate format
    if (!kvInput.includes('=')) {
      console.error('\nError: Invalid format. Use: --config-set field=value\n');
      console.error('Examples:');
      console.error('  ally --config-set model=llama3.2');
      console.error('  ally --config-set temperature=0.5\n');
      process.exit(1);
    }

    try {
      const result = await configManager.setFromString(kvInput);
      console.log(`\n✓ Configuration updated: ${result.key}`);
      console.log(`  Old value: ${JSON.stringify(result.oldValue)}`);
      console.log(`  New value: ${JSON.stringify(result.newValue)}\n`);
    } catch (error: any) {
      console.error(`\nError: ${error.message}\n`);
      process.exit(1);
    }

    return true;
  }

  // Handle --config-reset [field]
  if (options.configReset !== undefined) {
    // When no field provided, configReset is boolean true
    // When field provided, configReset is the field name (string)
    const field = typeof options.configReset === 'string' ? options.configReset : undefined;

    if (field) {
      // Reset specific field
      if (!configManager.hasKey(field)) {
        console.error(`\nError: Unknown config field: ${field}`);
        const suggestions = configManager.getSimilarKeys(field);
        if (suggestions.length > 0) {
          console.error(`Did you mean: ${suggestions.join(', ')}?\n`);
        }
        process.exit(1);
      }

      try {
        const result = await configManager.resetField(field as any);
        console.log(`\n✓ Reset ${result.key} to default`);
        console.log(`  Old value: ${JSON.stringify(result.oldValue)}`);
        console.log(`  New value: ${JSON.stringify(result.newValue)}\n`);
      } catch (error: any) {
        console.error(`\nError: ${error.message}\n`);
        process.exit(1);
      }
    } else {
      // Reset entire config
      const changes = await configManager.reset();
      const changedKeys = Object.keys(changes);

      if (changedKeys.length === 0) {
        console.log('\nConfiguration is already at default values.\n');
      } else {
        console.log(`\n✓ Configuration reset to defaults (${changedKeys.length} settings changed)\n`);
      }
    }

    return true;
  }

  return false;
}

/**
 * Handle --sessions command (show cheatsheet)
 */
function handleSessionsCheatsheet(): void {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Session Commands Cheatsheet');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('  List sessions:');
  console.log('    ally --session-list\n');

  console.log('  Resume session:');
  console.log('    ally --session <id>');
  console.log('    ally --resume [id]      # Interactive picker if no id\n');

  console.log('  Delete session:');
  console.log('    ally --session-delete <id>\n');

  console.log('  Disable sessions:');
  console.log('    ally --no-session\n');

  console.log('  One-off message:');
  console.log('    ally --once "message"   # No session created\n');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n  Sessions are stored in: ./.ally-sessions/\n');
}

/**
 * Handle session management commands
 */
async function handleSessionCommands(
  options: CLIOptions,
  sessionManager: SessionManager
): Promise<boolean> {
  // Show cheatsheet
  if (options.sessions) {
    handleSessionsCheatsheet();
    return true;
  }

  // List all sessions
  if (options.sessionList) {
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
  if (options.sessionDelete) {
    const success = await sessionManager.deleteSession(options.sessionDelete);

    if (success) {
      console.log(`✓ Session "${options.sessionDelete}" deleted\n`);
    } else {
      console.log(`✗ Session "${options.sessionDelete}" not found\n`);
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

    // DEBUG: Log response details to diagnose blank response issue
    console.log('DEBUG: Response type:', typeof response);
    console.log('DEBUG: Response length:', response?.length);
    console.log('DEBUG: Response value:', JSON.stringify(response));
    console.log('DEBUG: First 100 chars:', response?.substring(0, 100));
    console.log('---');

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
 * Apply color to text using chalk
 * Handles both named colors and hex colors
 *
 * @param text - Text to colorize
 * @param color - Color name (e.g., 'yellow', 'cyan') or hex color (e.g., '#50fa7b')
 * @returns Colored text
 */
function colorize(text: string, color: string): string {
  // If it's a hex color (starts with #), use chalk.hex()
  if (color.startsWith('#')) {
    return chalk.hex(color)(text);
  }

  // Otherwise, use named color
  // chalk supports: yellow, cyan, magenta, etc.
  return (chalk as any)[color]?.(text) ?? text;
}

/**
 * Handle --profiles command (show cheatsheet)
 */
function handleProfilesCheatsheet(): void {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Profile Commands Cheatsheet');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('  List profiles:');
  console.log('    ally --profile-list\n');

  console.log('  Create profile:');
  console.log('    ally --profile-create <name>');
  console.log('    ally --profile-create <name> --profile-from <source>\n');

  console.log('  Switch profile:');
  console.log('    ally --profile <name>\n');

  console.log('  Profile info:');
  console.log('    ally --profile-info <name>\n');

  console.log('  Delete profile:');
  console.log('    ally --profile-delete <name>');
  console.log('    ally --profile-delete <name> --profile-delete-force\n');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n  Profiles provide isolated configurations, plugins, agents, and prompts.');
  console.log('  Each profile has a unique color that customizes the UI appearance.');
  console.log('  Stored in: ~/.ally/profiles/<profile-name>/\n');
  console.log('  Documentation: docs/reference/profiles.md\n');
}

/**
 * Handle --profile-list command
 */
async function handleProfileList(profileManager: ProfileManager): Promise<void> {
  const profiles = await profileManager.listProfiles();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Profiles');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  for (const profile of profiles) {
    // Get profile color
    let profileColor = 'yellow';
    try {
      profileColor = await profileManager.getProfileColor(profile.name);
    } catch (error) {
      // If we can't get the color, default to yellow
    }

    console.log(`  ${profile.name}`);
    if (profile.description) {
      console.log(`    ${profile.description}`);
    }
    console.log(`    Color: ${colorize(profileColor, profileColor)}`);
    console.log(`    Created: ${formatRelativeTime(new Date(profile.created_at))}`);
    console.log(`    Plugins: ${profile.plugin_count} | Agents: ${profile.agent_count} | Prompts: ${profile.prompt_count}\n`);
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\nLaunch with specific profile: ally --profile <name>\n');
}

/**
 * Handle --profile-info command
 */
async function handleProfileInfo(profileManager: ProfileManager, profileName: string): Promise<void> {
  try {
    const profile = await profileManager.loadProfile(profileName);
    const stats = await profileManager.getProfileStats(profileName);

    // Get profile color
    let profileColor = 'yellow';
    try {
      profileColor = await profileManager.getProfileColor(profileName);
    } catch (error) {
      // If we can't get the color, default to yellow
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`  Profile: ${profile.name}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (profile.description) {
      console.log(`  Description: ${profile.description}`);
    }

    console.log(`  Color: ${colorize(profileColor, profileColor)}`);
    console.log(`  Created: ${formatRelativeTime(new Date(profile.created_at))}`);
    console.log(`  Updated: ${formatRelativeTime(new Date(profile.updated_at))}\n`);

    console.log('  Statistics:');
    console.log(`    Plugins: ${stats.plugin_count}`);
    console.log(`    Agents: ${stats.agent_count}`);
    console.log(`    Prompts: ${stats.prompt_count}`);
    console.log(`    Config overrides: ${stats.config_overrides}\n`);

    if (profile.tags && profile.tags.length > 0) {
      console.log(`  Tags: ${profile.tags.join(', ')}\n`);
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } catch (error) {
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/**
 * Handle --profile-create command
 */
async function handleProfileCreate(
  profileManager: ProfileManager,
  name: string,
  cloneFrom?: string
): Promise<void> {
  try {
    await profileManager.createProfile(name, {
      cloneFrom,
    });

    console.log(`\n✓ Profile '${name}' created successfully${cloneFrom ? ` (cloned from ${cloneFrom})` : ''}\n`);
    console.log(`  Launch with: ally --profile ${name}\n`);
  } catch (error) {
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/**
 * Handle --profile-delete command
 */
async function handleProfileDelete(
  profileManager: ProfileManager,
  name: string,
  force?: boolean
): Promise<void> {
  try {
    await profileManager.deleteProfile(name, force);
    console.log(`\n✓ Profile '${name}' deleted successfully\n`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`\nError: ${errorMessage}\n`);

    // If error mentions data, suggest force flag
    if (errorMessage.includes('contains data')) {
      console.error('  To force delete with data: ally --profile-delete ' + name + ' --profile-delete-force\n');
    }

    process.exit(1);
  }
}

/**
 * Main entry point
 */
async function main() {
  try {
    // Parse command-line arguments
    const parser = new ArgumentParser();
    const options = parser.parse();

    // Initialize ProfileManager EARLY (before any other services)
    const profileManager = new ProfileManager();
    await profileManager.initialize();

    // Handle profile commands (these exit after completion)
    if (options.profiles) {
      handleProfilesCheatsheet();
      process.exit(0);
    }

    if (options.profileList) {
      await handleProfileList(profileManager);
      process.exit(0);
    }

    if (options.profileInfo) {
      await handleProfileInfo(profileManager, options.profileInfo);
      process.exit(0);
    }

    if (options.profileCreate) {
      await handleProfileCreate(profileManager, options.profileCreate, options.profileFrom);
      process.exit(0);
    }

    if (options.profileDelete) {
      await handleProfileDelete(profileManager, options.profileDelete, options.profileDeleteForce);
      process.exit(0);
    }

    // Determine active profile (always defaults to 'default' if not specified)
    let activeProfile = options.profile || 'default';

    // Validate profile exists
    if (!(await profileManager.profileExists(activeProfile))) {
      console.error(`\nError: Profile '${activeProfile}' does not exist`);
      console.error(`Available profiles:`);
      const profiles = await profileManager.listProfiles();
      profiles.forEach(p => console.error(`  • ${p.name}`));
      console.error('');
      process.exit(1);
    }

    // Set active profile in path system (CRITICAL - do this before creating any services)
    setActiveProfile(activeProfile);

    // Initialize profile color (CRITICAL - must happen before any UI components are created)
    try {
      const profileColor = await profileManager.getProfileColor(activeProfile);
      initializePrimaryColor(profileColor);
      logger.debug(`[CLI] Initialized PRIMARY color to '${profileColor}' for profile '${activeProfile}'`);
    } catch (error) {
      // If we can't get the profile color, default to yellow and continue
      logger.warn(`[CLI] Failed to load profile color for '${activeProfile}', defaulting to yellow:`, error);
      initializePrimaryColor('yellow');
    }

    // Initialize config manager (now uses profile-specific paths)
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
    registry.registerInstance('profile_manager', profileManager);
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

    // Create prompt library manager
    const { PromptLibraryManager } = await import('./services/PromptLibraryManager.js');
    const promptLibraryManager = new PromptLibraryManager();
    await promptLibraryManager.initialize();
    registry.setPromptLibraryManager(promptLibraryManager);

    // Create tool call history
    const { ToolCallHistory } = await import('./services/ToolCallHistory.js');
    const toolCallHistory = new ToolCallHistory(100); // Keep last 100 tool calls
    registry.setToolCallHistory(toolCallHistory);

    // Create path resolver
    const pathResolver = new PathResolver();
    registry.registerInstance('path_resolver', pathResolver);

    // Create focus manager
    const { FocusManager } = await import('./services/FocusManager.js');
    const focusManager = new FocusManager();
    registry.registerInstance('focus_manager', focusManager);

    // Create read state manager (conversation-scoped)
    const { ReadStateManager } = await import('./services/ReadStateManager.js');
    const readStateManager = new ReadStateManager();
    registry.registerInstance('read_state_manager', readStateManager);

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

    // Create session title generator for idle task coordination
    const { SessionTitleGenerator } = await import('./services/SessionTitleGenerator.js');
    const sessionTitleGenerator = new SessionTitleGenerator(
    serviceModelClient,
    sessionManager,
    config.enable_session_title_generation
  );
    registry.registerInstance('session_title_generator', sessionTitleGenerator);

    // Create message history
    const messageHistory = new MessageHistory({
      maxTokens: config.context_size,
    });
    registry.registerInstance('message_history', messageHistory);

    // Create idle message generator (if enabled)
    const { IdleMessageGenerator } = await import('./services/IdleMessageGenerator.js');
    const idleMessageGenerator = config.enable_idle_messages
      ? new IdleMessageGenerator(serviceModelClient)
      : null;
    registry.registerInstance('idle_message_generator', idleMessageGenerator);

    // Create AutoToolCleanupService
    const { AutoToolCleanupService } = await import('./services/AutoToolCleanupService.js');
    const autoToolCleanup = new AutoToolCleanupService(
      serviceModelClient,
      sessionManager
    );
    registry.registerInstance('auto_tool_cleanup', autoToolCleanup);

    // Create idle task coordinator (requires sessionManager, titleGenerator, idleMessageGenerator, and autoToolCleanup)
    const { IdleTaskCoordinator } = await import('./services/IdleTaskCoordinator.js');
    const idleTaskCoordinator = new IdleTaskCoordinator(
      sessionTitleGenerator,
      idleMessageGenerator,
      autoToolCleanup,
      sessionManager
    );
    await idleTaskCoordinator.initialize();
    registry.registerInstance('idle_task_coordinator', idleTaskCoordinator);

    // Create bash process manager for background shell execution
    const { BashProcessManager } = await import('./services/BashProcessManager.js');
    const bashProcessManager = new BashProcessManager(10); // Max 10 background processes
    registry.registerInstance('bash_process_manager', bashProcessManager);

    // Create project context detector
    const { ProjectContextDetector } = await import('./services/ProjectContextDetector.js');
    const projectContextDetector = new ProjectContextDetector(process.cwd());
    await projectContextDetector.initialize();
    registry.registerInstance('project_context_detector', projectContextDetector);

    // Import and create tools
    const { BashTool } = await import('./tools/BashTool.js');
    const { BashOutputTool } = await import('./tools/BashOutputTool.js');
    const { KillShellTool } = await import('./tools/KillShellTool.js');
    const { ReadTool } = await import('./tools/ReadTool.js');
    const { WriteTool } = await import('./tools/WriteTool.js');
    const { WriteAgentTool } = await import('./tools/WriteAgentTool.js');
    const { WriteTempTool } = await import('./tools/WriteTempTool.js');
    const { EditTool } = await import('./tools/EditTool.js');
    const { LineEditTool } = await import('./tools/LineEditTool.js');
    const { GlobTool } = await import('./tools/GlobTool.js');
    const { GrepTool } = await import('./tools/GrepTool.js');
    const { LsTool } = await import('./tools/LsTool.js');
    const { TreeTool } = await import('./tools/TreeTool.js');
    const { AgentTool } = await import('./tools/AgentTool.js');
    const { CreateAgentTool } = await import('./tools/CreateAgentTool.js');
    const { ExploreTool } = await import('./tools/ExploreTool.js');
    const { PlanTool } = await import('./tools/PlanTool.js');
    const { AgentAskTool } = await import('./tools/AgentAskTool.js');
    const { BatchTool } = await import('./tools/BatchTool.js');
    const { CleanupCallTool } = await import('./tools/CleanupCallTool.js');
    const { TodoWriteTool } = await import('./tools/TodoWriteTool.js');
    const { SessionsTool } = await import('./tools/SessionsTool.js');
    const { LintTool } = await import('./tools/LintTool.js');
    const { FormatTool } = await import('./tools/FormatTool.js');

    const tools = [
      new BashTool(activityStream, config),
      new BashOutputTool(activityStream),
      new KillShellTool(activityStream),
      new ReadTool(activityStream, config),
      new WriteTool(activityStream),
      new WriteAgentTool(activityStream), // Agent-specific write tool (only visible to create-agent)
      new WriteTempTool(activityStream), // Internal tool for explore agents
      new EditTool(activityStream),
      new LineEditTool(activityStream),
      new GlobTool(activityStream),
      new GrepTool(activityStream),
      new LsTool(activityStream),
      new TreeTool(activityStream),
      new AgentTool(activityStream),
      new CreateAgentTool(activityStream),
      new ExploreTool(activityStream),
      new PlanTool(activityStream),
      new AgentAskTool(activityStream),
      new BatchTool(activityStream),
      new CleanupCallTool(activityStream),
      new TodoWriteTool(activityStream), // Unified todo management
      new SessionsTool(activityStream),
      new LintTool(activityStream),
      new FormatTool(activityStream),
    ];

    // Load user plugins from profile-specific plugins directory
    const { PluginLoader } = await import('./plugins/PluginLoader.js');
    const { PluginConfigManager } = await import('./plugins/PluginConfigManager.js');
    const { getPluginsDir } = await import('./config/paths.js');
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
    const { tools: pluginTools, agents: pluginAgents, pluginCount } = await pluginLoader.loadPlugins(getPluginsDir());
    logger.debug('[CLI] Plugins loaded successfully');

    // Start background plugin daemons
    await pluginLoader.startBackgroundPlugins();
    logger.debug('[CLI] Background plugins started');

    // Add graceful shutdown for background plugins
    const shutdownHandler = async (signal: string) => {
      logger.info(`[CLI] Received ${signal}, shutting down...`);
      try {
        // Shutdown background bash processes first (before registry shutdown)
        await bashProcessManager.shutdown();
        logger.debug('[CLI] Background bash processes terminated');

        // Flush pending session saves before exit
        await registry.shutdown();
        logger.debug('[CLI] Registry shutdown complete');

        await backgroundProcessManager.stopAllProcesses();
        logger.info('[CLI] Background plugins stopped successfully');
      } catch (error) {
        logger.error(`[CLI] Error during shutdown: ${error instanceof Error ? error.message : String(error)}`);
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
    // Note: autoAllowModeGetter will be set after UI initialization
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

    // Create agent (creates its own TokenManager and ToolResultManager)
    // System prompt is generated dynamically in sendMessage() with current context
    const agent = new Agent(
      modelClient,
      toolManager,
      activityStream,
      {
        config,
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
    if (idleMessageGenerator) {
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
    }

    // Handle --once mode (single message, non-interactive)
    if (options.once) {
      await handleOnceMode(options.once, options, agent, sessionManager);
      await registry.shutdown();
      cleanExit(0);
    }

    // Interactive mode - Render the Ink UI
    // IMPORTANT: exitOnCtrlC must be false to allow custom Ctrl+C handling in InputPrompt
    inkUIStarted = true;

    // Set default terminal title
    const { setTerminalTitle } = await import('./utils/terminal.js');
    setTerminalTitle('New Session');

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
    cleanExit(130).catch(() => process.exit(130)); // Standard exit code for SIGINT
  } else {
    process.exit(130);
  }
});

process.on('SIGTERM', () => {
  if (inkUIStarted) {
    cleanExit(143).catch(() => process.exit(143)); // Standard exit code for SIGTERM
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
