/**
 * ProfileCommand - Profile information and management
 *
 * Provides information about profiles but does not support switching in-session.
 * Profile switching is launch-time only via CLI arguments.
 *
 * Commands:
 * - /profile              Show current profile
 * - /profile list         List all profiles
 * - /profile info [name]  Show profile info (current if name not provided)
 */

import { Command } from './Command.js';
import type { Message } from '@shared/index.js';
import type { ServiceRegistry } from '@services/ServiceRegistry.js';
import type { CommandResult } from '../CommandHandler.js';
import type { ProfileManager } from '@services/ProfileManager.js';
import { getActiveProfile } from '@config/paths.js';
import { formatError } from '@utils/errorUtils.js';

export class ProfileCommand extends Command {
  readonly name = '/profile';
  readonly description = 'View profile information';

  // Don't use yellow output for profile info
  protected readonly useYellowOutput = false;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const subcommand = args[0]?.toLowerCase();

    // No subcommand - show current profile
    if (!subcommand) {
      return this.showCurrent(serviceRegistry);
    }

    // Route to subcommands
    switch (subcommand) {
      case 'list':
        return this.listProfiles(serviceRegistry);
      case 'info':
        return this.showInfo(args[1], serviceRegistry);
      default:
        return this.showHelp();
    }
  }

  /**
   * Show current profile information
   */
  private async showCurrent(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const profileManager = serviceRegistry.get<ProfileManager>('profile_manager');

    if (!profileManager) {
      return this.createError('ProfileManager not available');
    }

    const activeProfileName = getActiveProfile();

    try {
      const profile = await profileManager.loadProfile(activeProfileName);
      const stats = await profileManager.getProfileStats(activeProfileName);

      let output = `**Current Profile: ${profile.name}**\n\n`;

      if (profile.description) {
        output += `${profile.description}\n\n`;
      }

      output += '| Resource | Count |\n';
      output += '|----------|-------|\n';
      output += `| Plugins | ${stats.plugin_count} |\n`;
      output += `| Agents | ${stats.agent_count} |\n`;
      output += `| Prompts | ${stats.prompt_count} |\n`;

      return this.createResponse(output);
    } catch (error) {
      return this.createError(formatError(error));
    }
  }

  /**
   * List all available profiles
   */
  private async listProfiles(serviceRegistry: ServiceRegistry): Promise<CommandResult> {
    const profileManager = serviceRegistry.get<ProfileManager>('profile_manager');

    if (!profileManager) {
      return this.createError('ProfileManager not available');
    }

    const activeProfileName = getActiveProfile();

    try {
      const profiles = await profileManager.listProfiles();

      let output = '**Available Profiles**\n\n';
      output += '| Profile | Description | Plugins | Agents |\n';
      output += '|---------|-------------|---------|--------|\n';

      for (const profile of profiles) {
        const current = profile.name === activeProfileName ? ' ●' : '';
        const description = profile.description || '-';
        output += `| ${profile.name}${current} | ${description} | ${profile.plugin_count} | ${profile.agent_count} |\n`;
      }

      output += '\n---\n\n';
      output += '**Switch Profile**\n';
      output += '`ally --profile <name>`  Launch with different profile';

      return this.createResponse(output);
    } catch (error) {
      return this.createError(formatError(error));
    }
  }

  /**
   * Show detailed info for a specific profile
   */
  private async showInfo(
    profileName: string | undefined,
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    const profileManager = serviceRegistry.get<ProfileManager>('profile_manager');

    if (!profileManager) {
      return this.createError('ProfileManager not available');
    }

    const targetProfile = profileName || getActiveProfile();

    try {
      const profile = await profileManager.loadProfile(targetProfile);
      const stats = await profileManager.getProfileStats(targetProfile);

      let output = `**Profile: ${profile.name}**\n\n`;

      if (profile.description) {
        output += `${profile.description}\n\n`;
      }

      output += '| Property | Value |\n';
      output += '|----------|-------|\n';
      output += `| Created | ${new Date(profile.created_at).toLocaleString()} |\n`;
      output += `| Updated | ${new Date(profile.updated_at).toLocaleString()} |\n`;
      output += `| Plugins | ${stats.plugin_count} |\n`;
      output += `| Agents | ${stats.agent_count} |\n`;
      output += `| Prompts | ${stats.prompt_count} |\n`;
      output += `| Config Overrides | ${stats.config_overrides} |\n`;

      if (profile.tags && profile.tags.length > 0) {
        output += `| Tags | ${profile.tags.join(', ')} |\n`;
      }

      output += '\n---\n\n';
      output += `**Launch**\n\`ally --profile ${profile.name}\``;

      return this.createResponse(output);
    } catch (error) {
      return this.createError(formatError(error));
    }
  }

  /**
   * Show help for profile commands
   */
  private showHelp(): CommandResult {
    const output = `**Profile Commands**
\`/profile\`  Show current profile
\`/profile list\`  List all profiles
\`/profile info [name]\`  Show profile details

**Switch Profile**
Profile switching is launch-time only.
\`ally --profile <name>\`  Launch with different profile`;

    return this.createResponse(output);
  }
}
