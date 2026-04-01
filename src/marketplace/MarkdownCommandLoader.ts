/**
 * MarkdownCommandLoader - Discovers and loads commands/*.md files from installed plugins
 * as dynamic slash commands.
 *
 * Each .md file becomes a DynamicPluginCommand:
 * - Command name = filename without .md (e.g., rt.md -> /rt)
 * - YAML frontmatter parsed for allowed-tools
 * - Body = markdown template with $ARGUMENTS placeholder
 */

import { readdir, readFile } from 'fs/promises';
import { join, basename } from 'path';
import { logger } from '../services/Logger.js';
import { formatError } from '../utils/errorUtils.js';
import { parseFrontmatterYAML, extractFrontmatter } from '../utils/yamlUtils.js';
import { Command } from '../agent/commands/Command.js';
import type { CommandResult } from '../agent/CommandHandler.js';
import type { Message } from '../types/index.js';
import type { ServiceRegistry } from '../services/ServiceRegistry.js';
import type { PluginManager } from './PluginManager.js';

/**
 * A dynamic slash command loaded from a plugin's commands/*.md file.
 */
export class DynamicPluginCommand extends Command {
  readonly name: string;
  readonly description: string;
  readonly pluginName: string;
  private readonly body: string;
  private readonly allowedTools: string[];

  constructor(
    commandName: string,
    pluginName: string,
    description: string,
    body: string,
    allowedTools: string[]
  ) {
    super();
    this.name = `/${commandName}`;
    this.pluginName = pluginName;
    this.description = description || `Plugin command from ${pluginName}`;
    this.body = body;
    this.allowedTools = allowedTools;
  }

  async execute(
    args: string[],
    _messages: Message[],
    _serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const userArgs = args.join(' ');
    const expandedBody = this.body.replace(/\$ARGUMENTS/g, userArgs);

    return {
      handled: true,
      response: expandedBody,
      metadata: {
        isCommandResponse: false,
        allowedTools: this.allowedTools.length > 0 ? this.allowedTools : undefined,
        pluginName: this.pluginName,
      } as any,
    };
  }
}

export class MarkdownCommandLoader {
  /**
   * Load all commands from a single plugin's commands/ directory.
   */
  async loadCommandsFromPlugin(
    installPath: string,
    pluginName: string
  ): Promise<DynamicPluginCommand[]> {
    const commandsDir = join(installPath, 'commands');
    const commands: DynamicPluginCommand[] = [];

    let files: string[];
    try {
      files = await readdir(commandsDir);
    } catch {
      // No commands/ directory -- that's fine
      return [];
    }

    for (const file of files) {
      if (!file.endsWith('.md')) continue;

      const commandName = basename(file, '.md');
      const filePath = join(commandsDir, file);

      try {
        const content = await readFile(filePath, 'utf-8');
        const parsed = extractFrontmatter(content);

        let body: string;
        let allowedTools: string[] = [];
        let description = '';

        if (parsed) {
          body = parsed.body;
          const frontmatter = parseFrontmatterYAML(parsed.frontmatter);
          if (frontmatter['allowed-tools'] && Array.isArray(frontmatter['allowed-tools'])) {
            allowedTools = frontmatter['allowed-tools'];
          }
          if (frontmatter.description) {
            description = frontmatter.description;
          }
        } else {
          body = content;
        }

        commands.push(
          new DynamicPluginCommand(commandName, pluginName, description, body, allowedTools)
        );

        logger.debug(`[MarkdownCommandLoader] Loaded command '/${commandName}' from plugin '${pluginName}'`);
      } catch (error) {
        logger.warn(
          `[MarkdownCommandLoader] Failed to load command '${file}' from '${pluginName}': ${formatError(error)}`
        );
      }
    }

    return commands;
  }

  /**
   * Load all commands from all enabled installed plugins.
   */
  async loadAllPluginCommands(
    pluginManager: PluginManager
  ): Promise<DynamicPluginCommand[]> {
    const allCommands: DynamicPluginCommand[] = [];

    for (const plugin of pluginManager.getEnabledPlugins()) {
      const commands = await this.loadCommandsFromPlugin(
        plugin.installPath,
        plugin.pluginName
      );
      allCommands.push(...commands);
    }

    logger.debug(`[MarkdownCommandLoader] Loaded ${allCommands.length} total plugin command(s)`);
    return allCommands;
  }
}
