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

      let output = '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      output += `  Current Profile: ${profile.name}\n`;
      output += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

      if (profile.description) {
        output += `  ${profile.description}\n\n`;
      }

      output += `  Active Plugins:  ${stats.plugin_count}\n`;
      output += `  Custom Agents:   ${stats.agent_count}\n`;
      output += `  Prompts:         ${stats.prompt_count}\n\n`;

      output += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

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

      let output = '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      output += '  Available Profiles\n';
      output += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

      for (const profile of profiles) {
        const current = profile.name === activeProfileName ? ' (current session)' : '';
        output += `  ${profile.name}${current}\n`;
        if (profile.description) {
          output += `    ${profile.description}\n`;
        }
        output += `    ${profile.plugin_count} plugins, ${profile.agent_count} agents\n\n`;
      }

      output += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
      output += 'To switch profiles, exit and relaunch:\n';
      output += '  ally --profile <name>\n\n';

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

      let output = '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      output += `  Profile: ${profile.name}\n`;
      output += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

      if (profile.description) {
        output += `  Description: ${profile.description}\n\n`;
      }

      output += `  Created: ${new Date(profile.created_at).toLocaleString()}\n`;
      output += `  Updated: ${new Date(profile.updated_at).toLocaleString()}\n\n`;

      output += `  Plugins:  ${stats.plugin_count}\n`;
      output += `  Agents:   ${stats.agent_count}\n`;
      output += `  Prompts:  ${stats.prompt_count}\n`;
      output += `  Config Overrides: ${stats.config_overrides}\n\n`;

      if (profile.tags && profile.tags.length > 0) {
        output += `  Tags: ${profile.tags.join(', ')}\n\n`;
      }

      output += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
      output += `Launch with: ally --profile ${profile.name}\n\n`;

      return this.createResponse(output);
    } catch (error) {
      return this.createError(formatError(error));
    }
  }

  /**
   * Show help for profile commands
   */
  private showHelp(): CommandResult {
    const output =
      '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
      '  Profile Commands\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      '  /profile              Show current profile\n' +
      '  /profile list         List all profiles\n' +
      '  /profile info [name]  Show profile info\n\n' +
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n' +
      'Profile switching is launch-time only.\n' +
      'To switch: ally --profile <name>\n\n';

    return this.createResponse(output);
  }
}
