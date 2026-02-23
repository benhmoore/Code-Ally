/**
 * CommandRegistry - Central registry for command metadata
 *
 * Aggregates metadata from all registered commands to provide:
 * - Unified help content generation
 * - Completion data for CompletionProvider
 * - Command discovery
 */

import type { CommandMetadata, HelpCategory, SubcommandEntry } from './types.js';

class CommandRegistryClass {
  private metadata: Map<string, CommandMetadata> = new Map();

  /**
   * Register command metadata
   * Called automatically when commands are instantiated
   */
  register(meta: CommandMetadata): void {
    // Normalize name (ensure leading slash)
    const name = meta.name.startsWith('/') ? meta.name : `/${meta.name}`;
    this.metadata.set(name, { ...meta, name });
  }

  /**
   * Get metadata for a specific command
   */
  get(commandName: string): CommandMetadata | undefined {
    const name = commandName.startsWith('/') ? commandName : `/${commandName}`;
    return this.metadata.get(name);
  }

  /**
   * Get all registered command metadata
   */
  getAll(): CommandMetadata[] {
    return Array.from(this.metadata.values());
  }

  /**
   * Get commands grouped by help category
   */
  getByCategory(): Map<HelpCategory, CommandMetadata[]> {
    const byCategory = new Map<HelpCategory, CommandMetadata[]>();

    for (const meta of this.metadata.values()) {
      const existing = byCategory.get(meta.helpCategory) || [];
      existing.push(meta);
      byCategory.set(meta.helpCategory, existing);
    }

    return byCategory;
  }

  /**
   * Get subcommands for a specific command (for completion)
   */
  getSubcommands(commandName: string): SubcommandEntry[] {
    const meta = this.get(commandName);
    return meta?.subcommands || [];
  }

  /**
   * Generate formatted help lines for a command
   * Returns array of formatted strings like "`/agent list`  List agents"
   */
  getHelpLines(commandName: string): string[] {
    const meta = this.get(commandName);
    if (!meta) return [];

    if (meta.subcommands && meta.subcommands.length > 0) {
      return meta.subcommands.map(sub => {
        const fullCmd = sub.args
          ? `${meta.name} ${sub.name} ${sub.args}`
          : `${meta.name} ${sub.name}`;
        return `\`${fullCmd}\`  ${sub.description}`;
      });
    }

    // Command without subcommands
    return [`\`${meta.name}\`  ${meta.description}`];
  }

  /**
   * Generate all help content grouped by category
   * Returns formatted sections ready for display
   */
  generateHelpSections(): Array<{ name: HelpCategory; content: string }> {
    const byCategory = this.getByCategory();
    const sections: Array<{ name: HelpCategory; content: string }> = [];

    // Define category order
    const categoryOrder: HelpCategory[] = [
      'Input Modes',
      'Core',
      'Prompts',
      'Agents',
      'Project',
      'Todos',
      'Tasks',
      'Plugins',
      'MCP',
    ];

    for (const category of categoryOrder) {
      const commands = byCategory.get(category);
      if (!commands || commands.length === 0) continue;

      const lines: string[] = [];
      for (const meta of commands) {
        lines.push(...this.getHelpLines(meta.name));
      }

      if (lines.length > 0) {
        sections.push({
          name: category,
          content: lines.join('\n'),
        });
      }
    }

    return sections;
  }

  /**
   * Clear all registered metadata (useful for testing)
   */
  clear(): void {
    this.metadata.clear();
  }
}

// Singleton instance
export const CommandRegistry = new CommandRegistryClass();
