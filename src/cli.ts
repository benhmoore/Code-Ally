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
import { spawn } from 'child_process';
import { ServiceRegistry } from './services/ServiceRegistry.js';
import type { MCPServerConfig as MCPServerConfigType } from './mcp/MCPConfig.js';
import { ConfigManager } from './services/ConfigManager.js';
import { SessionManager } from './services/SessionManager.js';
import { MemoryService } from './services/MemoryService.js';
import { ActivityStream } from './services/ActivityStream.js';
import { FormManager } from './services/FormManager.js';
import { PathResolver } from './services/PathResolver.js';
import { TodoManager } from './services/TodoManager.js';
import { createModelClient } from './llm/createModelClient.js';
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
import { ActivityEventType } from './types/index.js';
import { runStartupValidation, needsSetup } from './cli/validation.js';
import { ProfileManager } from './services/ProfileManager.js';
import { setActiveProfile } from './config/paths.js';
import { initializePrimaryColor } from './ui/constants/colors.js';
import { getAgentDisplayName } from './utils/agentTypeUtils.js';
import { ScheduledTaskManager, ScheduledTask, presetPolicy } from './services/ScheduledTaskManager.js';
import { SchedulerInstaller } from './services/SchedulerInstaller.js';
import { generateShortId } from './utils/id.js';
import { formatError } from './utils/errorUtils.js';

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

  // Clear terminal tab progress bar (OSC 9;4)
  process.stdout.write('\x1b]9;4;0;\x07');

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
 * Lightweight terminal state re-assertion after process resume (SIGCONT).
 * Unlike resetTerminalState(), this does NOT clear the screen — the user's
 * conversation history should remain visible after Ctrl+Z / fg.
 */
function reassertTerminalState(): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(
    '\x1b[0m'           // Reset all text formatting
    + '\x1b[?25h'       // Show cursor
    + '\x1b[39m\x1b[49m' // Reset fg/bg colors
    + '\x1b]8;;\x1b\\'  // Close any open hyperlinks
    + '\x1b[?2004l'     // Reset bracketed paste mode
  );
}

/**
 * Clean exit with proper terminal cleanup and stdout flushing
 *
 * Ensures all escape sequences are processed before the application exits.
 * This prevents the terminal from getting stuck waiting for input.
 */
let cleanExitPromise: Promise<void> | undefined;
let requestedExitCode = 0;

async function cleanExit(code: number = 0): Promise<void> {
  if (code !== 0) requestedExitCode = code;
  if (cleanExitPromise) return cleanExitPromise;
  cleanExitPromise = performCleanExit();
  return cleanExitPromise;
}

async function performCleanExit(): Promise<void> {
  if (inkUIStarted) {
    resetTerminalState();
  }

  // Flush pending session saves if registry exists
  const ServiceRegistry = (await import('./services/ServiceRegistry.js')).ServiceRegistry;
  const registry = ServiceRegistry.getInstance();
  try {
    const runSupervisor = registry.get('run_supervisor');
    await runSupervisor?.interruptForShutdown('Owning Code-Ally process closed');

    const agent = registry.get('agent');
    agent?.interrupt({ kind: 'user_cancel' });

    const backgroundTaskRegistry = registry.get('background_task_registry');
    await backgroundTaskRegistry?.shutdown();

    // Shutdown background bash processes if manager exists
    const bashProcessManager = registry.get('bash_process_manager');
    if (bashProcessManager && typeof bashProcessManager.shutdown === 'function') {
      await bashProcessManager.shutdown();
    }

    // Shutdown background agents if manager exists
    const backgroundAgentManager = registry.get('background_agent_manager');
    if (backgroundAgentManager && typeof backgroundAgentManager.shutdown === 'function') {
      await backgroundAgentManager.shutdown();
    }

    await registry.shutdown();
  } catch (error) {
    // Ignore errors during shutdown - already exiting
  }

  // Wait for stdout to drain before exiting
  if (process.stdout.write('')) {
    // Buffer is empty, exit immediately
    process.exit(requestedExitCode);
  } else {
    // Buffer has pending data, wait for drain
    process.stdout.once('drain', () => {
      process.exit(requestedExitCode);
    });

    // Fallback timeout to prevent hanging
    setTimeout(() => {
      process.exit(requestedExitCode);
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
  // --init starts the normal UI and requests the same wizard as /init.
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

      const value = configManager.getDisplayValue(field as any);
      console.log(`\n${field}: ${JSON.stringify(value, null, 2)}\n`);
    } else {
      // Show entire config
      console.log('\n' + JSON.stringify(configManager.getRedactedConfig(), null, 2) + '\n');
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
  console.log('\n  Sessions are stored in: ~/.ally/projects/<project>/sessions/\n');
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

      if (options.once) {
        throw new Error(`Cannot resume missing session '${sessionId}' in noninteractive mode; pass --session to create one explicitly`);
      }

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

  if (options.once) {
    throw new Error('--resume requires an explicit session ID in noninteractive mode');
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
): Promise<import('./services/RunSupervisor.js').RunOutcome> {
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
      await sessionManager.saveSession(sessionName, agent.getContextMessages(), agent.getMessages());
      console.log(`\n[Session: ${sessionName}]`);
    }
    const outcome = ServiceRegistry.getInstance().get('run_supervisor')?.getOutcome();
    return outcome ?? { kind: 'failed', error: 'Automatic run ended without a typed outcome' };
  } catch (error) {
    console.error('Error:', error);
    return { kind: 'failed', error: formatError(error) };
  }
}

function exitCodeForRunOutcome(outcome: import('./services/RunSupervisor.js').RunOutcome): number {
  switch (outcome.kind) {
    case 'completed': return 0;
    case 'retryable_failure': return 75;
    case 'blocked': return 2;
    case 'cancelled': return 130;
    case 'failed': return 1;
  }
}

function extractSchedulerArgs(argv: string[] = process.argv): string[] | null {
  const index = argv.findIndex((arg, idx) => idx >= 2 && arg === 'scheduler');
  return index === -1 ? null : argv.slice(index + 1);
}

function parseGlobalArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function schedulerUsage(): string {
  return `Usage:
  ally scheduler install
  ally scheduler uninstall
  ally scheduler status
  ally scheduler tick
  ally scheduler run <task-id>
  ally scheduler list [--all]`;
}

async function initializeSchedulerBasics(profileName?: string): Promise<ScheduledTaskManager> {
  const profileManager = new ProfileManager();
  await profileManager.initialize();
  const activeProfile = profileName || 'default';
  if (!(await profileManager.profileExists(activeProfile))) {
    throw new Error(`Profile '${activeProfile}' does not exist`);
  }
  setActiveProfile(activeProfile);
  const manager = new ScheduledTaskManager();
  await manager.initialize();
  return manager;
}

function formatScheduledTask(task: ScheduledTask): string {
  const status = task.enabled ? 'enabled' : 'disabled';
  const last = task.last_run_at
    ? `${task.last_status} ${formatRelativeTime(new Date(task.last_run_at))}`
    : task.last_status;
  const schedule = task.schedule.type === 'once'
    ? `once ${new Date(task.schedule.run_at).toLocaleString()} ${task.schedule.timezone}`
    : `daily ${task.schedule.time} ${task.schedule.timezone}`;
  return `${task.id}  ${task.title}  [${status}] ${schedule}  next ${new Date(task.next_run_at).toLocaleString()}  last ${last}`;
}

function appendBounded(buffer: string, chunk: Buffer | string, maxChars: number = 80_000): string {
  const next = buffer + chunk.toString();
  return next.length <= maxChars ? next : next.slice(next.length - maxChars);
}

async function runScheduledTask(manager: ScheduledTaskManager, task: ScheduledTask): Promise<number> {
  const runId = `run-${Date.now()}-${generateShortId()}`;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  const sessionId = `scheduled_${task.id}_${stamp}`;

  await manager.recordRunStart(task.id, runId, sessionId, task.project_dir);

  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error('Unable to resolve Code Ally entrypoint for scheduled run');
  }

  const args = [
    scriptPath,
    '--profile',
    task.profile,
    '--scheduled-task',
    task.id,
    '--once',
    task.run_prompt,
    '--session',
    sessionId,
  ];

  const child = spawn(process.execPath, args, {
    cwd: task.project_dir,
    env: {
      ...process.env,
      ALLY_SCHEDULED_RUN_ID: runId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });

  let forcedBySignal: NodeJS.Signals | undefined;
  const signalChild = (signal: NodeJS.Signals) => {
    forcedBySignal = signal;
    if (!child.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch { /* worker already exited */ }
    const killTimer = setTimeout(() => {
      if (child.exitCode !== null) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid!, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* worker already exited */ }
    }, 5000);
    killTimer.unref?.();
  };
  const onSigint = () => signalChild('SIGINT');
  const onSigterm = () => signalChild('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on('close', (code) => resolve(code));
    child.on('error', () => resolve(1));
  });
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);

  const status = exitCode === 0 ? 'success' : 'error';
  const summary = [
    stdout.trim(),
    stderr.trim(),
    forcedBySignal ? `Scheduler stopped worker after ${forcedBySignal}` : '',
  ].filter(Boolean).join('\n\n');
  await manager.recordRunFinish(task.id, task.project_dir, runId, {
    status,
    sessionId,
    summary: summary || `(no output, exit code ${exitCode ?? 'unknown'})`,
    exitCode,
  });

  return exitCode ?? 1;
}

async function uninstallSchedulerIfIdle(manager: ScheduledTaskManager, installer: SchedulerInstaller): Promise<void> {
  if (await manager.countEnabledAll() === 0) {
    await installer.uninstall().catch((error) => {
      logger.debug('[SCHEDULER] Failed to uninstall idle scheduler:', error);
    });
  }
}

async function handleSchedulerCli(args: string[], argv: string[] = process.argv): Promise<void> {
  const command = args[0] || 'help';
  const profile = parseGlobalArg(argv, '--profile');
  const manager = await initializeSchedulerBasics(profile);
  const installer = new SchedulerInstaller();

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      console.log(schedulerUsage());
      return;

    case 'install': {
      const result = await installer.install();
      console.log(`Scheduler ${result.installed ? 'installed' : 'not installed'} (${result.platform}): ${result.detail}`);
      return;
    }

    case 'uninstall': {
      const result = await installer.uninstall();
      console.log(`Scheduler uninstalled (${result.platform}): ${result.detail}`);
      return;
    }

    case 'status': {
      const result = await installer.status();
      const enabled = (await manager.listAll()).filter((task) => task.enabled).length;
      console.log(`Scheduler ${result.installed ? 'installed' : 'not installed'} (${result.platform}): ${result.detail}`);
      console.log(`${enabled} enabled scheduled task${enabled === 1 ? '' : 's'}`);
      return;
    }

    case 'list': {
      const all = args.includes('--all');
      const tasks = all ? await manager.listAll() : await manager.listCurrentProject();
      if (tasks.length === 0) {
        console.log('No scheduled tasks.');
        return;
      }
      for (const task of tasks) {
        console.log(formatScheduledTask(task));
      }
      return;
    }

    case 'tick': {
      await manager.withGlobalLock(async () => {
        const decisions = await manager.getDueTasks();
        if (decisions.length === 0) {
          return;
        }
        for (const decision of decisions) {
          if (decision.skipped) {
            await manager.markSkipped(decision.task, decision.reason || 'missed scheduled time');
            continue;
          }
          if (decision.due) {
            await runScheduledTask(manager, decision.task);
          }
        }
      });
      await uninstallSchedulerIfIdle(manager, installer);
      return;
    }

    case 'run': {
      const taskId = args[1];
      if (!taskId) throw new Error('Usage: ally scheduler run <task-id>');
      const task = await manager.findTask(taskId);
      if (!task) throw new Error(`Scheduled task not found: ${taskId}`);
      const exitCode = await runScheduledTask(manager, task);
      await uninstallSchedulerIfIdle(manager, installer);
      process.exitCode = exitCode;
      return;
    }

    default:
      throw new Error(`Unknown scheduler command: ${command}\n\n${schedulerUsage()}`);
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
    const schedulerArgs = extractSchedulerArgs(process.argv);
    if (schedulerArgs) {
      await handleSchedulerCli(schedulerArgs, process.argv);
      return;
    }

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
    const activeProfile = options.profile || 'default';

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
    if (options.scheduledTask) {
      // Scheduled runs must use their stored deny-by-default policy, even if
      // the user's interactive profile normally has auto_confirm enabled.
      configOverrides.auto_confirm = false;
    }

    // Configure logging
    configureLogging(options.verbose, options.debug);

    // Use full config type
    const config = configOverrides as import('./types/index.js').Config;

    // Check if critical config is missing - force setup wizard if so
    const forceSetup = needsSetup(config);
    if (options.once && forceSetup) {
      throw new Error('Noninteractive mode requires a configured provider and model; run `ally --init` first');
    }

    // Validate the configured provider and model (skip in setup/non-interactive paths).
    let forceModelSelector = false;
    let availableModels: any[] | undefined;
    if (!options.once && !forceSetup && !options.init) {
      const validationResult = await runStartupValidation(config);

      if (!validationResult.providerConnected) {
        process.exit(1);
      }

      if (validationResult.modelStatus === 'missing') {
        forceModelSelector = true;
        availableModels = validationResult.availableModels;
      }
    }

    // Initialize service registry
    const registry = ServiceRegistry.getInstance();
    registry.registerInstance('config_manager', configManager);
    registry.registerInstance('session_manager', sessionManager);

    // Initialize autonomous project memory (stored alongside sessions under ~/.ally)
    const memoryService = new MemoryService();
    await memoryService.initialize();
    registry.registerInstance('memory_service', memoryService);

    // Create activity stream
    const activityStream = new ActivityStream();
    registry.registerInstance('activity_stream', activityStream);

    // One process-local policy authority for every interaction surface. Once
    // and scheduled modes are headless by construction and can never prompt.
    const { RunPolicyManager } = await import('./services/RunPolicyManager.js');
    const isHeadlessRun = Boolean(options.once || options.scheduledTask);
    const runPolicyManager = new RunPolicyManager({
      interaction: isHeadlessRun ? 'none' : 'human',
      execution: isHeadlessRun ? 'headless' : 'terminal',
      completion: isHeadlessRun ? 'durable_objective' : 'chat',
      authorizationPresetId: options.scheduledTask
        ? 'scheduled'
        : config.auto_confirm
          ? 'auto-confirm'
          : isHeadlessRun
            ? 'deny-by-default'
            : 'interactive',
    });
    registry.registerInstance('run_policy_manager', runPolicyManager);
    const { RunSupervisor } = await import('./services/RunSupervisor.js');
    const runSupervisor = new RunSupervisor();
    await runSupervisor.initialize();
    registry.registerInstance('run_supervisor', runSupervisor);

    // Create scheduled task manager (durable, project-scoped scheduler state)
    const scheduledTaskManager = new ScheduledTaskManager(activityStream);
    await scheduledTaskManager.initialize();
    registry.registerInstance('scheduled_task_manager', scheduledTaskManager);
    const scheduledTaskForRun = options.scheduledTask
      ? await scheduledTaskManager.getTask(options.scheduledTask)
      : null;
    if (options.scheduledTask && !scheduledTaskForRun) {
      throw new Error(`Scheduled task not found in this project: ${options.scheduledTask}`);
    }

    // Create todo manager
    const todoManager = new TodoManager(activityStream);
    registry.registerInstance('todo_manager', todoManager);

    // Create plan mode manager
    const { PlanModeManager } = await import('./services/PlanModeManager.js');
    const planModeManager = new PlanModeManager(activityStream, runPolicyManager);
    registry.registerInstance('plan_mode_manager', planModeManager);

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

    // Create additional directories manager
    const { AdditionalDirectoriesManager } = await import('./services/AdditionalDirectoriesManager.js');
    const additionalDirsManager = new AdditionalDirectoriesManager();
    registry.registerInstance('additional_dirs_manager', additionalDirsManager);

    // Create read state manager (conversation-scoped)
    const { ReadStateManager } = await import('./services/ReadStateManager.js');
    const readStateManager = new ReadStateManager();
    registry.registerInstance('read_state_manager', readStateManager);

    // Create read cache for file read deduplication (mtime-based)
    const { ReadCache } = await import('./services/ReadCache.js');
    const readCache = new ReadCache();
    registry.registerInstance('read_cache', readCache);

    // Live input-budget snapshots so tools size output against the space
    // actually available for conversation, not the raw context window.
    const { ContextBudgetService } = await import('./services/ContextBudgetService.js');
    registry.registerInstance('context_budget', new ContextBudgetService());

    // Tracks which deferred tool schemas each agent has loaded on demand.
    const { ToolActivationRegistry } = await import('./services/ToolActivationRegistry.js');
    registry.registerInstance('tool_activation_registry', new ToolActivationRegistry());

    // Create file interaction tracker (for /open command)
    const { FileInteractionTracker } = await import('./services/FileInteractionTracker.js');
    const fileInteractionTracker = new FileInteractionTracker();
    registry.registerInstance('file_interaction_tracker', fileInteractionTracker);

    // Create tool result persistence for saving large outputs to disk
    const { ToolResultPersistence } = await import('./services/ToolResultPersistence.js');
    const toolResultPersistence = new ToolResultPersistence(
      () => sessionManager.getCurrentSession()
    );
    registry.registerInstance('tool_result_persistence', toolResultPersistence);

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
    const modelClient = await createModelClient({ config, activityStream });
    registry.registerInstance('model_client', modelClient);

    // Create service model client (for background services like titles, idle messages)
    // Defaults to main model if service_model not specified
    const serviceModelName = config.service_model ?? config.model;
    const serviceModelClient = await createModelClient({ config, modelName: serviceModelName, activityStream });
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

    // Create background agent manager for non-blocking agent runs.
    // Registered on the root registry so the main agent and scoped sub-agents
    // all resolve the same instance.
    const { BackgroundAgentManager } = await import('./services/BackgroundAgentManager.js');
    const backgroundAgentManager = new BackgroundAgentManager();
    registry.registerInstance('background_agent_manager', backgroundAgentManager);

    // Unified registry over agents + shell processes + condition watchers, for
    // the wait/watch tools. Composes the two managers above (read adapters).
    const { BackgroundTaskRegistry } = await import('./services/BackgroundTaskRegistry.js');
    const backgroundTaskRegistry = new BackgroundTaskRegistry(backgroundAgentManager, bashProcessManager, activityStream);
    registry.registerInstance('background_task_registry', backgroundTaskRegistry);
    registry.registerCleanup('background-task-registry', () => backgroundTaskRegistry.shutdown());

    // Create project context detector
    const { ProjectContextDetector } = await import('./services/ProjectContextDetector.js');
    const projectContextDetector = new ProjectContextDetector(process.cwd());
    await projectContextDetector.initialize();
    registry.registerInstance('project_context_detector', projectContextDetector);

    // Create integration store for search providers and other integrations
    const { IntegrationStore } = await import('./services/IntegrationStore.js');
    const integrationStore = new IntegrationStore();
    await integrationStore.initialize();
    registry.registerInstance('integration_store', integrationStore);

    // Create skill manager for skill discovery and loading
    const { SkillManager } = await import('./services/SkillManager.js');
    const skillManager = new SkillManager();
    await skillManager.initialize();
    registry.setSkillManager(skillManager);

    // Construct the shared built-in catalog used by runtime and evaluations.
    const { createBuiltInTools } = await import('./tools/createBuiltInTools.js');
    const tools = createBuiltInTools(activityStream, config);

    // Initialize marketplace plugin system
    const { MarketplaceManager } = await import('./marketplace/MarketplaceManager.js');
    const { PluginManager } = await import('./marketplace/PluginManager.js');
    const { MarkdownCommandLoader } = await import('./marketplace/MarkdownCommandLoader.js');
    const marketplaceManager = new MarketplaceManager();
    await marketplaceManager.initialize();
    registry.registerInstance('marketplace_manager', marketplaceManager);
    registry.setMarketplaceManager(marketplaceManager);

    const pluginManager = new PluginManager(marketplaceManager);
    await pluginManager.initialize();
    registry.registerInstance('plugin_manager', pluginManager);
    registry.setPluginManager(pluginManager);
    logger.debug('[CLI] Marketplace plugin system initialized');

    // Add graceful shutdown handler
    const shutdownHandler = async (signal: string) => {
      logger.info(`[CLI] Received ${signal}, shutting down...`);
      await cleanExit(signal === 'SIGINT' ? 130 : 143);
    };

    // Load standalone MCP servers (user's mcp-config.json)
    const { MCPServerManager } = await import('./mcp/MCPServerManager.js');
    const mcpServerManager = new MCPServerManager(activityStream);
    registry.registerInstance('mcp_server_manager', mcpServerManager);
    await mcpServerManager.loadConfig(process.cwd());

    // Add MCP servers from enabled marketplace plugins. Each entry is
    // normalized and validated through the shared spec so a malformed plugin
    // server is reported and skipped rather than failing at connect time.
    const { parseServerObject } = await import('./mcp/MCPServerSpec.js');
    const enabledPlugins = pluginManager.getEnabledPlugins();
    for (const plugin of enabledPlugins) {
      const mcpConfig = await pluginManager.getPluginMCPConfig(plugin.installPath);
      if (mcpConfig) {
        const serverConfigs: Record<string, MCPServerConfigType> = {};
        for (const [key, entry] of Object.entries(mcpConfig)) {
          const parsed = parseServerObject({
            transport: 'stdio',
            command: entry.command,
            args: entry.args,
            env: entry.env,
            requiresConfirmation: true,
          });
          if (parsed.ok) {
            serverConfigs[key] = parsed.config;
          } else {
            logger.warn(`[MCP] Skipping invalid plugin server '${key}' from '${plugin.pluginName}': ${parsed.errors.join('; ')}`);
          }
        }
        if (Object.keys(serverConfigs).length > 0) {
          mcpServerManager.addPluginServers(plugin.pluginName, serverConfigs);
        }
      }
    }

    // Start all auto-start servers (both standalone and plugin)
    const mcpTools = await mcpServerManager.startAutoStartServers();
    const activeMcpCount = mcpServerManager.getConnectedServers().length;
    const totalMcpCount = mcpServerManager.getConfiguredServers().length;
    if (mcpTools.length > 0) {
      logger.debug(`[CLI] MCP: ${mcpTools.length} tool(s) from ${activeMcpCount} server(s)`);
    }

    // Get plugin counts for UI display
    const activePluginCount = enabledPlugins.length;
    const pluginCount = pluginManager.getInstalledPlugins().length;

    // Merge built-in tools with MCP tools (all plugin tools come through MCP now)
    const allTools = [...tools, ...mcpTools];

    // Create tool manager with all tools
    const toolManager = new ToolManager(allTools);
    registry.registerInstance('tool_manager', toolManager);

    // Create form manager for interactive tool forms
    const formManager = new FormManager(activityStream, runPolicyManager);
    registry.registerInstance('form_manager', formManager);

    // Inject FormManager into all tools for interactive form support
    toolManager.setFormManager(formManager);
    logger.debug('[CLI] FormManager created and injected into tools');

    // Create trust manager for permission tracking
    // Note: autoAllowModeGetter will be set after UI initialization
    const trustManager = new TrustManager(config.auto_confirm, activityStream);
    trustManager.setRunPolicyManager(runPolicyManager);
    if (scheduledTaskForRun) {
      // Grants are re-derived from current code on every run, so a hand-edited
      // store or a record written by an older build cannot broaden them.
      trustManager.setScheduledPermissionPolicy(presetPolicy(scheduledTaskForRun.policy_preset));
    }
    registry.registerInstance('trust_manager', trustManager);

    // Wire up delegation name getter for INSTRUCT option in permission prompts
    // Returns the agent display name when there's an active delegation (sub-agent running)
    trustManager.setActiveDelegationNameGetter(() => {
      const delegationManager = toolManager.getDelegationContextManager();
      const activeDelegation = delegationManager.getActiveDelegation();
      if (!activeDelegation) {
        return undefined;
      }

      // Get the agent display name from the delegation
      const agentPoolService = registry.get('agent_pool');
      if (!agentPoolService) {
        return 'Agent'; // Fallback if pool service not available
      }

      const metadata = agentPoolService.getAgentMetadata(activeDelegation.pooledAgent.agentId);
      if (!metadata?.config?.agentType) {
        return 'Agent'; // Fallback if no metadata
      }

      return getAgentDisplayName(metadata.config.agentType);
    });

    // Create permission manager for security checks
    const permissionManager = new PermissionManager(trustManager);
    registry.registerInstance('permission_manager', permissionManager);

    // Create agent manager for specialized agents
    const { AgentManager } = await import('./services/AgentManager.js');
    const agentManager = new AgentManager();
    registry.registerInstance('agent_manager', agentManager);

    // Create agent pool service for managing concurrent agent instances
    // Manages concurrent agent instances with auto-eviction
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

    // Load plugin skills and commands
    const markdownCommandLoader = new MarkdownCommandLoader();
    const pluginCommands = await markdownCommandLoader.loadAllPluginCommands(pluginManager);
    registry.registerInstance('plugin_commands', pluginCommands);

    // Register plugin skills and agents with their managers
    for (const plugin of enabledPlugins) {
      await skillManager.loadPluginSkills(plugin.installPath, plugin.pluginName);
      await agentManager.loadPluginAgents(plugin.installPath, plugin.pluginName);
    }
    logger.debug(`[CLI] Plugin skills, agents, and ${pluginCommands.length} command(s) loaded`);

    // Create agent generation service for LLM-assisted agent creation
    const { AgentGenerationService } = await import('./services/AgentGenerationService.js');
    const agentGenerationService = new AgentGenerationService(serviceModelClient);
    registry.registerInstance('agent_generation_service', agentGenerationService);

    // Create agent (creates its own TokenManager and ToolResultManager)
    // System prompt is generated dynamically in sendMessage() with current context
    // Determine which agent to use based on config.default_agent
    let agentType = config.default_agent || 'ally';
    let agentData: Awaited<ReturnType<typeof agentManager.loadAgent>> = null;

    // Load agent configuration if not 'ally'
    if (agentType !== 'ally') {
      agentData = await agentManager.loadAgent(agentType);
      if (!agentData) {
        logger.warn(`[CLI] Configured default_agent '${agentType}' not found, falling back to 'ally'`);
        agentType = 'ally';
      } else {
        logger.debug(`[CLI] Using configured default agent: '${agentType}'`);
      }
    } else {
      logger.debug(`[CLI] Using default agent: 'ally'`);
    }

    // Build agent config - use custom agent settings if a custom agent was loaded
    let agentConfig: import('./agent/Agent.js').AgentConfig;
    let agentModelClient: import('./llm/ModelClient.js').ModelClient = modelClient;

    if (agentData) {
      // Custom agent: build config from agent data
      const baseConfig = agentManager.buildBaseConfig(agentData, agentType, toolManager);

      agentConfig = {
        ...baseConfig,
        config,
        isSpecializedAgent: false, // Top-level agent, not a sub-agent
        allowTodoManagement: true, // Root privilege
        agentDepth: 0,
        agentCallStack: [],
        isScheduledRun: Boolean(options.scheduledTask),
        isOnceMode: Boolean(options.once),
        scheduledTaskId: options.scheduledTask,
      };

      // Get model client for custom agent (may use agent-specific model)
      const { getModelClientForAgent } = await import('./utils/modelClientUtils.js');
      agentModelClient = await getModelClientForAgent({
        agentConfig: agentData,
        appConfig: config,
        sharedClient: modelClient,
        activityStream,
        context: '[CLI]'
      });

      if (baseConfig.allowedTools) {
        logger.debug('[CLI]', 'Default agent restricted to', baseConfig.allowedTools.length, 'tools');
      }
    } else {
      // Default 'ally' agent
      agentConfig = {
        config,
        agentType,
        isScheduledRun: Boolean(options.scheduledTask),
        isOnceMode: Boolean(options.once),
        scheduledTaskId: options.scheduledTask,
      };
    }

    const agent = new Agent(
      agentModelClient,
      toolManager,
      activityStream,
      agentConfig,
      configManager, // For configurable token limits
      permissionManager
    );
    registry.registerInstance('agent', agent);

    // Emit AGENT_SWITCHED event so UI displays correct agent name at startup
    if (agentType !== 'ally') {
      activityStream.emit({
        id: `agent_init_${Date.now()}`,
        type: ActivityEventType.AGENT_SWITCHED,
        timestamp: Date.now(),
        data: {
          agentName: agentType,
          agentId: agent.getInstanceId(),
          agentModel: agentModelClient.modelName,
        },
      });
    }

    // Register main agent's TokenManager in ServiceRegistry for global access (UI, etc)
    const tokenManager = agent.getTokenManager();
    registry.registerInstance('token_manager', tokenManager);

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
        const todoManager = registry.get('todo_manager');
        const additionalDirsManager = registry.get('additional_dirs_manager');

        if (agent && sessionManager) {
          const todos = todoManager?.getTodos();
          const idleMessages = idleMessageGenerator.getQueue();
          const projectContext = projectContextDetector?.getCached() ?? undefined;
          const additionalDirectories = additionalDirsManager?.getAdditionalDirectories() ?? undefined;

          sessionManager.autoSave(
            agent.getContextMessages(),
            todos,
            idleMessages,
            projectContext,
            additionalDirectories,
            agent.getMessages(),
          ).catch((error: Error) => {
            logger.debug('[IDLE_MSG] Failed to auto-save after queue update:', error);
          });
        }
      });
    }

    // Handle --once mode (single message, non-interactive)
    if (options.once) {
      const outcome = await handleOnceMode(options.once, options, agent, sessionManager);
      await cleanExit(exitCodeForRunOutcome(outcome));
      return;
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
        activeMcpCount,
        totalMcpCount,
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
    // Exit cleanly with terminal reset and stdout flush
    await cleanExit(0);
  } catch (error) {
    // Critical: Reset terminal even on fatal errors (only if UI was started)
    console.error('Fatal error:', error);
    if (inkUIStarted) {
      await cleanExit(1);
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

// Re-assert terminal state after process resume (Ctrl+Z then fg)
process.on('SIGCONT', () => {
  if (inkUIStarted) {
    reassertTerminalState();
  }
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  if (inkUIStarted) {
    void cleanExit(1);
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  if (inkUIStarted) {
    void cleanExit(1);
  } else {
    process.exit(1);
  }
});

main();
