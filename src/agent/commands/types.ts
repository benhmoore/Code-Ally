/**
 * Unified command metadata types
 *
 * Commands define their metadata once, which is then used for:
 * - /help command output
 * - Tab completion suggestions
 * - Command registration
 */

export type HelpCategory =
  | 'Input Modes'
  | 'Core'
  | 'Agents'
  | 'Marketplace'
  | 'MCP'
  | 'Project'
  | 'Memory'
  | 'Todos'
  | 'Tasks'
  | 'Prompts';

export interface SubcommandEntry {
  /** Subcommand name (e.g., "list", "show", "create") */
  name: string;
  /** Brief description for help and completion */
  description: string;
  /** Optional argument hint (e.g., "<name>", "<id>", "[path]") */
  args?: string;
  /** Completion behavior for Enter when this subcommand is highlighted */
  completion?: CommandCompletionOptions;
}

export type CommandCompletionEnterBehavior = 'insert' | 'submit';

export interface CommandCompletionOptions {
  /**
   * What Enter should do when this command completion is highlighted.
   * - "insert": complete the current component and keep editing.
   * - "submit": complete the current component and submit the command.
   */
  enterBehavior?: CommandCompletionEnterBehavior;
}

export interface CommandMetadata {
  /** Full command name including slash (e.g., "/agent") */
  name: string;
  /** Brief one-line description */
  description: string;
  /** Category for grouping in /help output */
  helpCategory: HelpCategory;
  /** Subcommands for commands with multiple actions */
  subcommands?: SubcommandEntry[];
  /** Completion behavior for Enter when this command is highlighted */
  completion?: CommandCompletionOptions;
  /** Whether responses should use yellow styling (default: false) */
  useYellowOutput?: boolean;
}
