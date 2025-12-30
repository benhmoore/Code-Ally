/**
 * ArgumentParser - Comprehensive CLI argument parsing
 *
 * Handles all command-line flags and options for Code Ally,
 * matching the functionality of the Python version.
 */

import { Command } from 'commander';

/**
 * CLI options interface - matches all Python argparse flags
 */
export interface CLIOptions {
  // Model settings
  model?: string;
  endpoint?: string;
  temperature?: number;
  contextSize?: number;
  maxTokens?: number;
  reasoningEffort?: string;

  // Configuration management
  init?: boolean;
  configs?: boolean;
  configShow?: string;
  configSet?: string;
  configReset?: string;

  // Logging
  verbose?: boolean;
  debug?: boolean;

  // Session management
  session?: string;
  sessions?: boolean;
  sessionList?: boolean;
  sessionDelete?: string;
  once?: string;
  noSession?: boolean;
  resume?: string | boolean;

  // Advanced settings
  autoConfirm?: boolean;

  // Profile options
  profile?: string;
  profiles?: boolean;
  profileCreate?: string;
  profileFrom?: string;
  profileList?: boolean;
  profileInfo?: string;
  profileDelete?: string;
  profileDeleteForce?: boolean;
}

/**
 * ArgumentParser class
 *
 * Provides comprehensive CLI argument parsing with all flags
 * from the Python version.
 */
export class ArgumentParser {
  private program: Command;

  constructor() {
    this.program = new Command();
    this.setupArguments();
  }

  /**
   * Set up all CLI arguments and options
   */
  private setupArguments(): void {
    this.program
      .name('ally')
      .description('Code Ally - Local LLM-powered pair programming assistant')
      .version('0.1.0')
      .addHelpText(
        'after',
        `
Interactive Commands (available once running):
  /help              - Show interactive command help
  /project init      - Create ALLY.md configuration
  /project view      - View ALLY.md contents
  /clear             - Clear conversation history
  /compact           - Compact conversation to reduce context
  /model             - Change AI model (interactive selector)
  /debug             - Debug commands (enable/disable/calls/errors/dump)

Use '/help' for complete interactive command reference.
        `
      );

    // Model Settings
    this.program
      .option('--model <name>', 'The model to use')
      .option(
        '--endpoint <url>',
        'The Ollama API endpoint URL'
      )
      .option(
        '--temperature <float>',
        'Temperature for text generation (0.0-1.0)',
        parseFloat
      )
      .option(
        '--context-size <int>',
        'Context size in tokens',
        (val) => parseInt(val, 10)
      )
      .option(
        '--max-tokens <int>',
        'Maximum tokens to generate',
        (val) => parseInt(val, 10)
      )
      .option(
        '--reasoning-effort <level>',
        'Reasoning effort for gpt-oss models (low, medium, high)'
      );

    // Configuration Management
    this.program
      .option('--init', 'Run interactive setup wizard')
      .option('--configs', 'Show configuration commands cheatsheet')
      .option('--config-show [field]', 'Show configuration (all or specific field)')
      .option('--config-set <field=value>', 'Set configuration value (e.g., model=llama3.2)')
      .option('--config-reset [field]', 'Reset configuration (all or specific field)');

    // Logging
    this.program
      .option('--verbose, -v', 'Enable verbose mode with detailed logging')
      .option(
        '--debug',
        'Enable debug mode with DEBUG level logging messages'
      );

    // Session Management
    this.program
      .option('--session <name>', 'Resume or create named session')
      .option('--sessions', 'Show session commands cheatsheet')
      .option('--session-list', 'List all available sessions')
      .option('--session-delete <name>', 'Delete a session')
      .option(
        '-1, --once <message>',
        'Single message to process in non-interactive mode'
      )
      .option(
        '--no-session',
        'Disable automatic session creation and persistence'
      )
      .option(
        '--resume [session]',
        'Resume a conversation from a session. If session ID provided, resume that session. If no ID provided, show interactive selection menu.'
      );

    // Advanced Settings
    this.program
      .option('--auto-confirm', 'Auto-confirm tool executions');

    // Profile Management
    this.program
      .option('--profile <name>', 'Launch with specific profile')
      .option('--profiles', 'Show profile commands cheatsheet')
      .option('--profile-create <name>', 'Create a new profile')
      .option('--profile-from <source>', 'Clone from existing profile (use with --profile-create)')
      .option('--profile-list', 'List all profiles')
      .option('--profile-info <name>', 'Show profile information')
      .option('--profile-delete <name>', 'Delete a profile')
      .option('--profile-delete-force', 'Force delete profile with data (use with --profile-delete)');
  }

  /**
   * Parse command-line arguments
   *
   * @param argv - Process arguments (defaults to process.argv)
   * @returns Parsed CLI options
   */
  parse(argv: string[] = process.argv): CLIOptions {
    this.program.parse(argv);
    const opts = this.program.opts();

    // Convert commander's camelCase to our preferred format
    return {
      // Model settings
      model: opts.model,
      endpoint: opts.endpoint,
      temperature: opts.temperature,
      contextSize: opts.contextSize,
      maxTokens: opts.maxTokens,
      reasoningEffort: opts.reasoningEffort,

      // Configuration
      init: opts.init,
      configs: opts.configs,
      configShow: opts.configShow,
      configSet: opts.configSet,
      configReset: opts.configReset,

      // Logging
      verbose: opts.verbose,
      debug: opts.debug,

      // Session
      session: opts.session,
      sessions: opts.sessions,
      sessionList: opts.sessionList,
      sessionDelete: opts.sessionDelete,
      once: opts.once,
      noSession: opts.session === false,
      resume: opts.resume,

      // Advanced
      autoConfirm: opts.autoConfirm,

      // Profile
      profile: opts.profile,
      profiles: opts.profiles,
      profileCreate: opts.profileCreate,
      profileFrom: opts.profileFrom,
      profileList: opts.profileList,
      profileInfo: opts.profileInfo,
      profileDelete: opts.profileDelete,
      profileDeleteForce: opts.profileDeleteForce,
    };
  }

  /**
   * Show help text
   */
  showHelp(): void {
    this.program.help();
  }

  /**
   * Get usage information
   */
  getUsage(): string {
    return this.program.helpInformation();
  }
}
