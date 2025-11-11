/**
 * PluginActivationManager - Manages plugin activation state per session
 *
 * This service tracks which plugins are active in the current session and provides
 * methods to activate/deactivate plugins. It respects each plugin's activation mode:
 * - "always": Plugin is always active (cannot be deactivated)
 * - "tagged": Plugin must be explicitly activated via #plugin-name tags or commands
 *
 * The activation state is persisted to the session file for continuity across
 * CLI restarts.
 */

import { PluginLoader, PluginManifest } from './PluginLoader.js';
import { SessionManager } from '../services/SessionManager.js';
import { logger } from '../services/Logger.js';

/**
 * Interface for loaded plugin information
 */
interface LoadedPluginInfo {
  name: string;
  manifest: PluginManifest;
}

/**
 * PluginActivationManager handles plugin activation logic and state management
 */
export class PluginActivationManager {
  private activePlugins: Set<string> = new Set();
  private pluginManifests: Map<string, PluginManifest> = new Map();

  constructor(
    private pluginLoader: PluginLoader,
    private sessionManager: SessionManager
  ) {}

  /**
   * Initialize the activation manager from session state
   *
   * This method should be called after plugins are loaded and a session is selected.
   * It loads the active plugins from the session and auto-activates "always" mode plugins.
   */
  async initialize(): Promise<void> {
    // Load all plugin manifests from the plugin loader
    const plugins = this.pluginLoader.getLoadedPlugins();
    plugins.forEach((plugin: LoadedPluginInfo) => {
      this.pluginManifests.set(plugin.name, plugin.manifest);
    });

    // Auto-activate "always" mode plugins (these are always active)
    this.pluginManifests.forEach((manifest, name) => {
      const mode = manifest.activationMode ?? 'always'; // Default to 'always'
      if (mode === 'always') {
        this.activePlugins.add(name);
      }
    });

    // Load active plugins from current session (restores "tagged" plugins)
    const sessionName = this.sessionManager.getCurrentSession();
    if (sessionName) {
      const session = await this.sessionManager.loadSession(sessionName);
      if (session?.active_plugins) {
        session.active_plugins.forEach(name => {
          // Only add if plugin is installed
          if (this.pluginManifests.has(name)) {
            this.activePlugins.add(name);
          } else {
            logger.warn(
              `[PluginActivationManager] Session references plugin '${name}' but it's not installed`
            );
          }
        });
      }
    }

    logger.debug(
      `[PluginActivationManager] Initialized with ${this.activePlugins.size} active plugin(s): ${Array.from(this.activePlugins).join(', ')}`
    );
  }

  /**
   * Activate a plugin by name
   *
   * @param pluginName - Name of the plugin to activate
   * @returns True if activated successfully, false if plugin not found
   */
  activate(pluginName: string): boolean {
    if (!this.pluginManifests.has(pluginName)) {
      logger.warn(`[PluginActivationManager] Cannot activate '${pluginName}' - plugin not installed`);
      return false;
    }

    const wasActive = this.activePlugins.has(pluginName);
    this.activePlugins.add(pluginName);

    if (!wasActive) {
      logger.info(`[PluginActivationManager] Activated plugin: ${pluginName}`);
      this.saveToSession();
    }

    return true;
  }

  /**
   * Deactivate a plugin by name
   *
   * Note: Plugins with "always" activation mode cannot be deactivated.
   *
   * @param pluginName - Name of the plugin to deactivate
   * @returns True if deactivated successfully, false if plugin is in "always" mode or not found
   */
  deactivate(pluginName: string): boolean {
    const manifest = this.pluginManifests.get(pluginName);

    if (!manifest) {
      logger.warn(`[PluginActivationManager] Cannot deactivate '${pluginName}' - plugin not installed`);
      return false;
    }

    const mode = manifest.activationMode ?? 'always';
    if (mode === 'always') {
      logger.warn(
        `[PluginActivationManager] Cannot deactivate '${pluginName}' - plugin is in 'always' mode`
      );
      return false;
    }

    const wasActive = this.activePlugins.has(pluginName);
    this.activePlugins.delete(pluginName);

    if (wasActive) {
      logger.info(`[PluginActivationManager] Deactivated plugin: ${pluginName}`);
      this.saveToSession();
    }

    return true;
  }

  /**
   * Check if a plugin is currently active
   *
   * @param pluginName - Name of the plugin to check
   * @returns True if the plugin is active
   */
  isActive(pluginName: string): boolean {
    return this.activePlugins.has(pluginName);
  }

  /**
   * Get list of all active plugin names
   *
   * @returns Array of active plugin names
   */
  getActivePlugins(): string[] {
    return Array.from(this.activePlugins);
  }

  /**
   * Get list of all installed plugin names
   *
   * @returns Array of installed plugin names
   */
  getInstalledPlugins(): string[] {
    return Array.from(this.pluginManifests.keys());
  }

  /**
   * Get the activation mode for a plugin
   *
   * @param pluginName - Name of the plugin
   * @returns The activation mode ('always' or 'tagged'), or undefined if plugin not found
   */
  getActivationMode(pluginName: string): 'always' | 'tagged' | undefined {
    const manifest = this.pluginManifests.get(pluginName);
    return manifest ? (manifest.activationMode ?? 'always') : undefined;
  }

  /**
   * Parse plugin tags from a message and activate them
   *
   * Searches for #plugin-name patterns in the message and attempts to activate
   * each matched plugin. Returns the list of successfully activated plugin names.
   *
   * @param message - User message to parse for plugin tags
   * @returns Array of plugin names that were successfully activated
   */
  parseAndActivateTags(message: string): string[] {
    const tagPattern = /#([a-z0-9_-]+)/gi;
    const matches = message.matchAll(tagPattern);
    const activated: string[] = [];

    for (const match of matches) {
      const pluginName = match[1];
      if (!pluginName) continue; // Skip if no capture group

      // Check if this matches an installed plugin
      if (this.pluginManifests.has(pluginName)) {
        const wasActive = this.activePlugins.has(pluginName);

        if (this.activate(pluginName)) {
          // Only report as "activated" if it wasn't already active
          if (!wasActive) {
            activated.push(pluginName);
          }
        }
      }
    }

    return activated;
  }

  /**
   * Save the current activation state to the session
   *
   * This is called automatically after activation/deactivation operations.
   * Uses non-blocking auto-save pattern from SessionManager.
   */
  private saveToSession(): void {
    const sessionName = this.sessionManager.getCurrentSession();
    if (!sessionName) {
      logger.debug('[PluginActivationManager] No active session - skipping save');
      return;
    }

    // Update active_plugins in session using public API
    this.sessionManager.updateSession(sessionName, {
      active_plugins: this.getActivePlugins()
    }).catch(error => {
      logger.error(
        `[PluginActivationManager] Failed to save activation state to session: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  /**
   * Refresh plugin manifests (call this after installing/uninstalling plugins)
   *
   * This reloads the plugin manifests from the PluginLoader and updates
   * the activation state accordingly.
   */
  async refresh(): Promise<void> {
    // Clear and reload plugin manifests
    this.pluginManifests.clear();

    const plugins = this.pluginLoader.getLoadedPlugins();
    plugins.forEach((plugin: LoadedPluginInfo) => {
      this.pluginManifests.set(plugin.name, plugin.manifest);
    });

    // Remove any active plugins that are no longer installed
    const installedNames = new Set(this.pluginManifests.keys());
    for (const activeName of this.activePlugins) {
      if (!installedNames.has(activeName)) {
        this.activePlugins.delete(activeName);
        logger.info(
          `[PluginActivationManager] Removed '${activeName}' from active plugins (plugin uninstalled)`
        );
      }
    }

    // Re-activate "always" mode plugins
    this.pluginManifests.forEach((manifest, name) => {
      const mode = manifest.activationMode ?? 'always';
      if (mode === 'always') {
        this.activePlugins.add(name);
      }
    });

    logger.debug(
      `[PluginActivationManager] Refreshed - ${this.activePlugins.size} active plugin(s)`
    );

    // Save updated state to session
    this.saveToSession();
  }
}
