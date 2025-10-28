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
  config?: boolean;
  configShow?: boolean;
  configReset?: boolean;

  // Logging
  verbose?: boolean;
  debug?: boolean;

  // Session management
  session?: string;
  once?: string;
  listSessions?: boolean;
  deleteSession?: string;
  noSession?: boolean;
  resume?: string | boolean;

  // Advanced settings
  autoConfirm?: boolean;
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
  /project init      - Create ALLY.md configuration for project
  /project show      - View ALLY.md configuration contents
  /project edit      - Edit ALLY.md with default editor
  /clear             - Clear conversation history
  /compact           - Compact conversation to reduce context
  /model ls          - List available models
  /debug system      - Show system prompt and tools

Use '/help' for complete interactive command reference.
        `
      );

    // Model Settings
    this.program
      .option('--model <name>', 'The model to use')
      .option(
        '--endpoint <url>',
        'The Ollama API endpoint URL',
        'http://localhost:11434'
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
      .option(
        '--config',
        'Save the current command line options as config defaults'
      )
      .option('--config-show', 'Show the current configuration')
      .option('--config-reset', 'Reset configuration to defaults');

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
      .option(
        '-1, --once <message>',
        'Single message to process in non-interactive mode'
      )
      .option('--list-sessions', 'List all available sessions')
      .option('--delete-session <name>', 'Delete a session')
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
      config: opts.config,
      configShow: opts.configShow,
      configReset: opts.configReset,

      // Logging
      verbose: opts.verbose,
      debug: opts.debug,

      // Session
      session: opts.session,
      once: opts.once,
      listSessions: opts.listSessions,
      deleteSession: opts.deleteSession,
      noSession: opts.session === false,
      resume: opts.resume,

      // Advanced
      autoConfirm: opts.autoConfirm,
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

/**
 * Create and export a singleton parser instance
 */
export const argumentParser = new ArgumentParser();
