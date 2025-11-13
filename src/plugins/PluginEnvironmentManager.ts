/**
 * PluginEnvironmentManager - Manages isolated environments for plugins
 *
 * Handles automatic creation of virtual environments and dependency installation
 * for plugins that require external packages. Each plugin gets its own isolated
 * environment to prevent conflicts.
 *
 * Supported runtimes:
 * - python3: Creates venv and installs from requirements.txt
 * - node: Creates node_modules and installs from package.json
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../services/Logger.js';
import { PLUGIN_ENVS_DIR } from '../config/paths.js';
import { PLUGIN_FILES, PLUGIN_TIMEOUTS, PluginEnvironmentStatus } from './constants.js';

const execAsync = promisify(exec);

/**
 * Plugin dependency specification
 */
export interface PluginDependencies {
  /** Dependencies file (e.g., "requirements.txt", "package.json") */
  file: string;

  /** Optional custom install command (defaults to runtime-specific command) */
  install_command?: string;
}

/**
 * Plugin environment state
 */
interface EnvironmentState {
  /** Plugin name */
  name: string;

  /** Installation status */
  status: PluginEnvironmentStatus;

  /** Error message if status is 'error' */
  error?: string;

  /** Timestamp of last installation */
  installed_at?: string;
}

/**
 * Manages plugin virtual environments and dependency installation
 */
export class PluginEnvironmentManager {
  /**
   * Ensure dependencies are installed for a plugin
   *
   * Checks if dependencies are already installed, and if not, creates
   * the virtual environment and installs them.
   *
   * @param pluginName - Name of the plugin
   * @param pluginPath - Absolute path to the plugin directory
   * @param runtime - Runtime environment (e.g., 'python3', 'node')
   * @param dependencies - Dependency specification
   * @returns True if dependencies are ready, false otherwise
   */
  async ensureDependencies(
    pluginName: string,
    pluginPath: string,
    runtime: string,
    dependencies: PluginDependencies
  ): Promise<boolean> {
    const envPath = join(PLUGIN_ENVS_DIR, pluginName);
    const markerFile = join(envPath, PLUGIN_FILES.STATE_MARKER);

    // Check if already installed
    try {
      await fs.access(markerFile);
      logger.debug(`[PluginEnvironmentManager] Plugin '${pluginName}' dependencies already installed`);
      return true;
    } catch {
      // Marker file doesn't exist, need to install
    }

    // Install dependencies based on runtime
    try {
      logger.info(`[PluginEnvironmentManager] Installing dependencies for '${pluginName}'...`);

      if (runtime === 'python3') {
        await this.setupPythonEnv(pluginName, pluginPath, envPath, dependencies);
      } else if (runtime === 'node') {
        await this.setupNodeEnv(pluginName, pluginPath, envPath, dependencies);
      } else {
        logger.warn(
          `[PluginEnvironmentManager] Unsupported runtime '${runtime}' for plugin '${pluginName}'`
        );
        return false;
      }

      // Mark as installed
      const state: EnvironmentState = {
        name: pluginName,
        status: PluginEnvironmentStatus.READY,
        installed_at: new Date().toISOString(),
      };
      await fs.writeFile(markerFile, JSON.stringify(state, null, 2));

      logger.info(`[PluginEnvironmentManager] ✓ Dependencies installed for '${pluginName}'`);
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        `[PluginEnvironmentManager] Failed to install dependencies for '${pluginName}': ${errorMsg}`
      );

      // Save error state
      const state: EnvironmentState = {
        name: pluginName,
        status: PluginEnvironmentStatus.ERROR,
        error: errorMsg,
      };
      try {
        await fs.mkdir(envPath, { recursive: true });
        await fs.writeFile(markerFile, JSON.stringify(state, null, 2));
      } catch {
        // Ignore errors saving state
      }

      return false;
    }
  }

  /**
   * Setup Python virtual environment and install dependencies
   */
  private async setupPythonEnv(
    pluginName: string,
    pluginPath: string,
    envPath: string,
    dependencies: PluginDependencies
  ): Promise<void> {
    // Create environment directory
    await fs.mkdir(envPath, { recursive: true });

    // Create virtual environment
    logger.info(`[PluginEnvironmentManager]   → Creating virtual environment for '${pluginName}'`);
    try {
      await execAsync(`python3 -m venv "${envPath}"`, {
        timeout: PLUGIN_TIMEOUTS.VENV_CREATION,
      });
    } catch (error) {
      throw new Error(
        `Failed to create virtual environment: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Check if dependencies file exists
    const depsFilePath = join(pluginPath, dependencies.file);
    try {
      await fs.access(depsFilePath);
    } catch {
      // No dependencies file - that's okay, venv is ready
      logger.info(`[PluginEnvironmentManager]   → No dependencies file found, venv ready`);
      return;
    }

    // Install dependencies
    const pipPath = join(envPath, 'bin', 'pip');
    logger.info(`[PluginEnvironmentManager]   → Installing packages from ${dependencies.file}`);

    try {
      // Use custom install command if provided, otherwise default to pip install
      const installCmd = dependencies.install_command
        ? dependencies.install_command.replace(/\{pip\}/g, pipPath)
        : `"${pipPath}" install -q -r "${depsFilePath}"`;

      const { stderr } = await execAsync(installCmd, {
        cwd: pluginPath,
        timeout: PLUGIN_TIMEOUTS.DEPENDENCY_INSTALL,
      });

      // Log output for debugging (only if there are warnings/errors)
      if (stderr && stderr.trim()) {
        logger.debug(`[PluginEnvironmentManager] pip stderr: ${stderr.trim()}`);
      }
    } catch (error) {
      throw new Error(
        `Failed to install dependencies: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Setup Node.js environment and install dependencies
   */
  private async setupNodeEnv(
    pluginName: string,
    pluginPath: string,
    envPath: string,
    dependencies: PluginDependencies
  ): Promise<void> {
    // Create environment directory
    await fs.mkdir(envPath, { recursive: true });

    // Check for node availability
    logger.info(`[PluginEnvironmentManager]   → Checking Node.js availability for '${pluginName}'`);
    try {
      await execAsync('node --version', {
        timeout: PLUGIN_TIMEOUTS.VENV_CREATION,
      });
    } catch (error) {
      throw new Error(
        `Failed to find node binary: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Check if dependencies file exists
    const depsFilePath = join(pluginPath, dependencies.file);
    try {
      await fs.access(depsFilePath);
    } catch {
      // No dependencies file - that's okay, environment is ready
      logger.info(`[PluginEnvironmentManager]   → No dependencies file found, environment ready`);
      return;
    }

    // Install dependencies
    logger.info(`[PluginEnvironmentManager]   → Installing packages from ${dependencies.file}`);

    try {
      // Use custom install command if provided, otherwise default to npm install
      const installCmd = dependencies.install_command
        ? dependencies.install_command.replace(/\{envPath\}/g, envPath)
        : `npm install --prefix "${envPath}"`;

      const { stderr } = await execAsync(installCmd, {
        cwd: pluginPath,
        timeout: PLUGIN_TIMEOUTS.DEPENDENCY_INSTALL,
      });

      // Log output for debugging (only if there are warnings/errors)
      if (stderr && stderr.trim()) {
        logger.debug(`[PluginEnvironmentManager] npm stderr: ${stderr.trim()}`);
      }
    } catch (error) {
      throw new Error(
        `Failed to install dependencies: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get the path to the Python interpreter in the plugin's venv
   *
   * Falls back to system 'python3' if venv doesn't exist.
   *
   * @param pluginName - Name of the plugin
   * @returns Absolute path to the Python interpreter, or 'python3' if venv doesn't exist
   */
  getPythonPath(pluginName: string): string {
    const venvPythonPath = join(PLUGIN_ENVS_DIR, pluginName, 'bin', 'python3');

    // Check if venv python exists synchronously
    try {
      require('fs').accessSync(venvPythonPath);
      return venvPythonPath;
    } catch {
      // Venv doesn't exist, fall back to system python3
      return 'python3';
    }
  }

  /**
   * Get the path to the node_modules directory in the plugin's environment
   *
   * @param pluginName - Name of the plugin
   * @returns Absolute path to the node_modules directory
   */
  getNodeModulesPath(pluginName: string): string {
    return join(PLUGIN_ENVS_DIR, pluginName, 'node_modules');
  }

  /**
   * Get the path to the plugin's virtual environment
   *
   * @param pluginName - Name of the plugin
   * @returns Absolute path to the venv directory
   */
  getEnvPath(pluginName: string): string {
    return join(PLUGIN_ENVS_DIR, pluginName);
  }

  /**
   * Check if a plugin's environment is ready
   */
  async isReady(pluginName: string): Promise<boolean> {
    const markerFile = join(PLUGIN_ENVS_DIR, pluginName, PLUGIN_FILES.STATE_MARKER);
    try {
      const content = await fs.readFile(markerFile, 'utf-8');
      const state: EnvironmentState = JSON.parse(content);
      return state.status === PluginEnvironmentStatus.READY;
    } catch {
      return false;
    }
  }

  /**
   * Remove a plugin's virtual environment
   *
   * Useful for cleanup or forcing reinstallation.
   *
   * @param pluginName - Name of the plugin
   */
  async removeEnvironment(pluginName: string): Promise<void> {
    const envPath = join(PLUGIN_ENVS_DIR, pluginName);
    try {
      await fs.rm(envPath, { recursive: true, force: true });
      logger.info(`[PluginEnvironmentManager] Removed environment for '${pluginName}'`);
    } catch (error) {
      logger.warn(
        `[PluginEnvironmentManager] Failed to remove environment for '${pluginName}': ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
