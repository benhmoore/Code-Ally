/**
 * BackgroundProcessManager Usage Examples
 *
 * This file demonstrates common usage patterns for managing background
 * plugin processes (daemons) in the Ally application.
 */

import { BackgroundProcessManager, BackgroundProcessConfig, ProcessState } from './BackgroundProcessManager.js';
import { PluginEnvironmentManager } from './PluginEnvironmentManager.js';
import { getPluginEnvsDir } from '../config/paths.js';
import { PLUGIN_TIMEOUTS } from './constants.js';
import { join } from 'path';

/**
 * Example 1: Starting a simple Python daemon
 *
 * This example shows how to start a Python background process with
 * default health checking.
 */
async function example1_SimplePythonDaemon(): Promise<void> {
  const manager = new BackgroundProcessManager();
  const envManager = new PluginEnvironmentManager();

  const pluginName = 'search-plugin';
  const pluginPath = '/Users/bhm128/.ally/plugins/search-plugin';

  // Get the venv Python interpreter path
  const pythonPath = envManager.getPythonPath(pluginName);

  // Configure the background process
  const config: BackgroundProcessConfig = {
    pluginName,
    pluginPath,
    command: pythonPath,
    args: ['daemon.py'], // Relative to pluginPath
    socketPath: join(getPluginEnvsDir(), pluginName, 'daemon.sock'),
    startupTimeout: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_STARTUP,
    shutdownGracePeriod: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_SHUTDOWN_GRACE_PERIOD,
    healthcheck: {
      interval: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_HEALTH_CHECK_INTERVAL,
      timeout: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_HEALTH_CHECK_TIMEOUT,
      retries: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_MAX_HEALTH_CHECK_FAILURES,
    },
  };

  try {
    // Start the process
    await manager.startProcess(config);
    console.log(`Process started successfully (PID: ${manager.getPid(pluginName)})`);

    // Check status
    console.log(`Is running: ${manager.isRunning(pluginName)}`);
    console.log(`Current state: ${manager.getState(pluginName)}`);
  } catch (error) {
    console.error('Failed to start process:', error);
  }
}

/**
 * Example 2: Starting with custom environment variables
 *
 * Pass configuration or secrets to the daemon via environment variables.
 */
async function example2_WithEnvironmentVariables(): Promise<void> {
  const manager = new BackgroundProcessManager();
  const envManager = new PluginEnvironmentManager();

  const pluginName = 'api-server';
  const pluginPath = '/Users/bhm128/.ally/plugins/api-server';

  const config: BackgroundProcessConfig = {
    pluginName,
    pluginPath,
    command: envManager.getPythonPath(pluginName),
    args: ['server.py'],
    socketPath: join(getPluginEnvsDir(), pluginName, 'daemon.sock'),
    // Pass configuration via environment
    envVars: {
      PORT: '8080',
      API_KEY: 'secret-key-here',
      LOG_LEVEL: 'debug',
    },
    startupTimeout: 30000,
    shutdownGracePeriod: 5000,
  };

  await manager.startProcess(config);
}

/**
 * Example 3: Monitoring process health
 *
 * Get detailed process information and health status.
 */
async function example3_MonitoringHealth(): Promise<void> {
  const manager = new BackgroundProcessManager();
  const pluginName = 'search-plugin';

  // Get detailed process info
  const info = manager.getProcessInfo(pluginName);
  if (info) {
    console.log('Process Information:');
    console.log(`  State: ${info.state}`);
    console.log(`  PID: ${info.pid}`);
    console.log(`  Failed Health Checks: ${info.failedHealthChecks}`);
    console.log(`  Restart Attempts: ${info.restartAttempts}`);
    console.log(`  Last State Change: ${info.lastStateChange}`);
    if (info.lastError) {
      console.log(`  Last Error: ${info.lastError}`);
    }
  } else {
    console.log('Process not tracked');
  }
}

/**
 * Example 4: Graceful shutdown
 *
 * Stop a single process or all processes gracefully.
 */
async function example4_GracefulShutdown(): Promise<void> {
  const manager = new BackgroundProcessManager();

  // Stop a specific process
  await manager.stopProcess('search-plugin');

  // Or stop all processes (e.g., during app shutdown)
  await manager.stopAllProcesses();
}

/**
 * Example 5: Custom health check configuration
 *
 * Fine-tune health monitoring for different plugin types.
 */
async function example5_CustomHealthChecks(): Promise<void> {
  const manager = new BackgroundProcessManager();
  const envManager = new PluginEnvironmentManager();

  const pluginName = 'critical-service';
  const pluginPath = '/Users/bhm128/.ally/plugins/critical-service';

  const config: BackgroundProcessConfig = {
    pluginName,
    pluginPath,
    command: envManager.getPythonPath(pluginName),
    args: ['daemon.py'],
    socketPath: join(getPluginEnvsDir(), pluginName, 'daemon.sock'),
    // More aggressive health monitoring for critical services
    healthcheck: {
      interval: 10000, // Check every 10 seconds
      timeout: 2000,   // Wait max 2 seconds for response
      retries: 2,      // Only 2 failures before restart
    },
    startupTimeout: 60000, // Allow more time for startup
    shutdownGracePeriod: 10000, // Give more time for cleanup
  };

  await manager.startProcess(config);
}

/**
 * Example 6: Handling startup failures
 *
 * Proper error handling when starting processes.
 */
async function example6_ErrorHandling(): Promise<void> {
  const manager = new BackgroundProcessManager();
  const envManager = new PluginEnvironmentManager();

  const pluginName = 'flaky-plugin';
  const pluginPath = '/Users/bhm128/.ally/plugins/flaky-plugin';

  const config: BackgroundProcessConfig = {
    pluginName,
    pluginPath,
    command: envManager.getPythonPath(pluginName),
    args: ['daemon.py'],
    socketPath: join(getPluginEnvsDir(), pluginName, 'daemon.sock'),
    startupTimeout: 30000,
    shutdownGracePeriod: 5000,
  };

  try {
    await manager.startProcess(config);
    console.log('Process started successfully');
  } catch (error) {
    // Handle different failure scenarios
    if (error instanceof Error) {
      if (error.message.includes('already running')) {
        console.log('Process is already running');
      } else if (error.message.includes('Timeout waiting for socket')) {
        console.error('Process started but socket not ready - check daemon logs');
      } else if (error.message.includes('Failed to spawn')) {
        console.error('Could not execute command - check paths and permissions');
      } else {
        console.error('Unexpected error:', error.message);
      }
    }

    // Check if process is in error state
    const state = manager.getState(pluginName);
    if (state === ProcessState.ERROR) {
      const info = manager.getProcessInfo(pluginName);
      console.error('Process error details:', info?.lastError);
    }
  }
}

/**
 * Example 7: Automatic restart on crash
 *
 * The manager automatically restarts crashed processes up to the retry limit.
 * This example shows how to check restart status.
 */
async function example7_AutoRestart(): Promise<void> {
  const manager = new BackgroundProcessManager();
  const pluginName = 'search-plugin';

  // Check restart attempts
  const info = manager.getProcessInfo(pluginName);
  if (info) {
    console.log(`Restart attempts: ${info.restartAttempts}/${PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_MAX_RESTART_ATTEMPTS}`);

    if (info.restartAttempts >= PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_MAX_RESTART_ATTEMPTS) {
      console.log('⚠️  Process has exceeded maximum restart attempts');
      console.log('Manual intervention may be required');
    }
  }
}

/**
 * Example 8: Integration with PluginLoader
 *
 * How the BackgroundProcessManager integrates with the plugin system.
 */
async function example8_PluginIntegration(): Promise<void> {
  const manager = new BackgroundProcessManager();
  const envManager = new PluginEnvironmentManager();

  // Typically called from PluginLoader when loading a plugin with a daemon
  interface PluginManifest {
    name: string;
    daemon?: {
      command: string;
      args: string[];
      healthcheck?: {
        interval: number;
        timeout: number;
        retries: number;
      };
    };
  }

  const manifest: PluginManifest = {
    name: 'search-plugin',
    daemon: {
      command: 'python3',
      args: ['daemon.py'],
      healthcheck: {
        interval: 30000,
        timeout: 5000,
        retries: 3,
      },
    },
  };

  const pluginPath = '/Users/bhm128/.ally/plugins/search-plugin';

  if (manifest.daemon) {
    // Resolve command to venv Python if needed
    const command = manifest.daemon.command === 'python3'
      ? envManager.getPythonPath(manifest.name)
      : manifest.daemon.command;

    const config: BackgroundProcessConfig = {
      pluginName: manifest.name,
      pluginPath,
      command,
      args: manifest.daemon.args,
      socketPath: join(getPluginEnvsDir(), manifest.name, 'daemon.sock'),
      healthcheck: manifest.daemon.healthcheck,
      startupTimeout: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_STARTUP,
      shutdownGracePeriod: PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_SHUTDOWN_GRACE_PERIOD,
    };

    await manager.startProcess(config);
  }
}

/**
 * Example 9: Cleanup on application shutdown
 *
 * Proper cleanup when the main application exits.
 */
async function example9_ApplicationShutdown(): Promise<void> {
  const manager = new BackgroundProcessManager();

  // Register shutdown handler
  process.on('SIGTERM', async () => {
    console.log('Shutting down background processes...');
    await manager.stopAllProcesses();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('Shutting down background processes...');
    await manager.stopAllProcesses();
    process.exit(0);
  });
}

/**
 * Example 10: Complete lifecycle management
 *
 * Full example showing startup, monitoring, and shutdown.
 */
async function example10_CompleteLifecycle(): Promise<void> {
  const manager = new BackgroundProcessManager();
  const envManager = new PluginEnvironmentManager();

  const pluginName = 'search-plugin';
  const pluginPath = '/Users/bhm128/.ally/plugins/search-plugin';

  try {
    // 1. Start the process
    console.log('Starting background process...');
    const config: BackgroundProcessConfig = {
      pluginName,
      pluginPath,
      command: envManager.getPythonPath(pluginName),
      args: ['daemon.py'],
      socketPath: join(getPluginEnvsDir(), pluginName, 'daemon.sock'),
      envVars: {
        LOG_LEVEL: 'info',
      },
      healthcheck: {
        interval: 30000,
        timeout: 5000,
        retries: 3,
      },
      startupTimeout: 30000,
      shutdownGracePeriod: 5000,
    };

    await manager.startProcess(config);
    console.log('✓ Process started');

    // 2. Verify it's running
    if (manager.isRunning(pluginName)) {
      console.log(`✓ Process is running (PID: ${manager.getPid(pluginName)})`);
    }

    // 3. Do work with the daemon...
    // (Your application logic here)

    // 4. Monitor health periodically
    const checkHealth = () => {
      const info = manager.getProcessInfo(pluginName);
      if (info) {
        console.log(`Health: state=${info.state}, failures=${info.failedHealthChecks}`);
      }
    };

    // Check health every minute
    const healthCheckInterval = setInterval(checkHealth, 60000);

    // 5. Cleanup on exit
    process.on('SIGTERM', async () => {
      clearInterval(healthCheckInterval);
      console.log('Stopping background process...');
      await manager.stopProcess(pluginName);
      console.log('✓ Process stopped');
      process.exit(0);
    });

  } catch (error) {
    console.error('Error managing background process:', error);
    process.exit(1);
  }
}

// Export for documentation purposes
export {
  example1_SimplePythonDaemon,
  example2_WithEnvironmentVariables,
  example3_MonitoringHealth,
  example4_GracefulShutdown,
  example5_CustomHealthChecks,
  example6_ErrorHandling,
  example7_AutoRestart,
  example8_PluginIntegration,
  example9_ApplicationShutdown,
  example10_CompleteLifecycle,
};
