/**
 * BackgroundProcessManager - Manages lifecycle of background plugin processes
 *
 * Handles background processes (daemons) that run continuously alongside the main
 * Ally application. Provides:
 * - Process lifecycle management (start, stop, graceful shutdown)
 * - Health monitoring with auto-restart on crashes
 * - State tracking and status reporting
 * - PID file management and orphan cleanup
 *
 * Design decisions:
 * - PID files stored in {PLUGIN_ENVS_DIR}/{pluginName}/daemon.pid for isolation
 * - Socket paths at {PLUGIN_ENVS_DIR}/{pluginName}/daemon.sock for IPC
 * - Graceful shutdown: SIGTERM first, SIGKILL after grace period
 * - Health checks via socket connection (basic connectivity test)
 * - Auto-restart with linear backoff and retry limits
 * - Orphan detection on startup (PID file exists but process dead)
 */

import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import * as net from 'net';
import { logger } from '../services/Logger.js';
import { PLUGIN_ENVS_DIR } from '../config/paths.js';
import { PLUGIN_TIMEOUTS, PLUGIN_CONSTRAINTS } from './constants.js';
import { API_TIMEOUTS } from '../config/constants.js';

/**
 * Configuration for a background process
 */
export interface BackgroundProcessConfig {
  /** Plugin name (used for PID file, socket path, logging) */
  pluginName: string;

  /** Absolute path to the plugin directory */
  pluginPath: string;

  /** Command to execute (e.g., path to Python interpreter) */
  command: string;

  /** Command-line arguments */
  args: string[];

  /** Path to Unix socket for IPC */
  socketPath: string;

  /** Optional environment variables to inject */
  envVars?: Record<string, string>;

  /** Health check configuration */
  healthcheck?: {
    /** Milliseconds between health checks */
    interval: number;
    /** Milliseconds to wait for health response */
    timeout: number;
    /** Failed checks before marking unhealthy */
    retries: number;
  };

  /** Milliseconds to wait for process to start */
  startupTimeout: number;

  /** Milliseconds to wait after SIGTERM before SIGKILL */
  shutdownGracePeriod: number;
}

/**
 * Process state enumeration
 */
export enum ProcessState {
  /** Process is being started */
  STARTING = 'starting',
  /** Process is running and healthy */
  RUNNING = 'running',
  /** Process is being stopped */
  STOPPING = 'stopping',
  /** Process is stopped */
  STOPPED = 'stopped',
  /** Process is in error state */
  ERROR = 'error',
}

/**
 * Internal process metadata
 */
interface ProcessInfo {
  /** Current state */
  state: ProcessState;
  /** Process ID */
  pid?: number;
  /** Child process handle */
  process?: ChildProcess;
  /** Configuration */
  config: BackgroundProcessConfig;
  /** Health check interval handle */
  healthCheckInterval?: NodeJS.Timeout;
  /** Failed health check counter */
  failedHealthChecks: number;
  /** Health check in progress flag */
  healthCheckInProgress: boolean;
  /** Restart attempt counter */
  restartAttempts: number;
  /** Last error message */
  lastError?: string;
  /** Timestamp of last state change */
  lastStateChange: Date;
}

/**
 * Manages background plugin processes
 */
export class BackgroundProcessManager {
  /** Map of plugin name to process info */
  private processes: Map<string, ProcessInfo> = new Map();

  /** Flag to prevent new starts during shutdown */
  private isShuttingDown: boolean = false;

  constructor() {
    logger.debug('[BackgroundProcessManager] Initialized');
  }

  /**
   * Start a background process
   *
   * This method:
   * 1. Checks for existing/orphaned processes
   * 2. Spawns the process with proper environment
   * 3. Writes PID file
   * 4. Waits for socket to be ready (startup verification)
   * 5. Starts health monitoring
   *
   * @param config - Process configuration
   * @throws Error if process is already running or startup fails
   */
  async startProcess(config: BackgroundProcessConfig): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error('Cannot start process during shutdown');
    }

    const { pluginName } = config;
    logger.info(`[BackgroundProcessManager] Starting background process for '${pluginName}'`);

    // Validate socket path length (Unix sockets have a ~104 char limit)
    if (config.socketPath.length > PLUGIN_CONSTRAINTS.MAX_SOCKET_PATH_LENGTH) {
      throw new Error(
        `Socket path too long (${config.socketPath.length} chars, max ${PLUGIN_CONSTRAINTS.MAX_SOCKET_PATH_LENGTH}): ${config.socketPath}`
      );
    }

    // Check if already running
    const existing = this.processes.get(pluginName);
    if (existing && existing.state !== ProcessState.STOPPED && existing.state !== ProcessState.ERROR) {
      throw new Error(`Process '${pluginName}' is already ${existing.state}`);
    }

    // Check for orphaned process from previous run
    await this.cleanupOrphanedProcess(pluginName);

    // Create process info
    const processInfo: ProcessInfo = {
      state: ProcessState.STARTING,
      config,
      failedHealthChecks: 0,
      healthCheckInProgress: false,
      restartAttempts: 0,
      lastStateChange: new Date(),
    };
    this.processes.set(pluginName, processInfo);

    try {
      // Spawn the process
      const childProcess = spawn(config.command, config.args, {
        cwd: config.pluginPath,
        env: {
          ...process.env,
          ...config.envVars,
        },
        detached: false, // Keep as child so it's killed when parent exits
        stdio: ['ignore', 'pipe', 'pipe'], // Ignore stdin, capture stdout/stderr
      });

      processInfo.process = childProcess;
      processInfo.pid = childProcess.pid;

      // Set up error handlers
      childProcess.on('error', (error) => {
        // Only log here, let the catch block handle state changes
        logger.error(
          `[BackgroundProcessManager] Process '${pluginName}' spawn error: ${error.message}`
        );
      });

      childProcess.on('exit', (code, signal) => {
        logger.warn(
          `[BackgroundProcessManager] Process '${pluginName}' exited with code ${code}, signal ${signal}`
        );
        this.handleProcessExit(pluginName, code, signal);
      });

      // Capture stdout/stderr for debugging
      childProcess.stdout?.on('data', (data) => {
        logger.debug(`[BackgroundProcessManager] [${pluginName}] stdout: ${data.toString().trim()}`);
      });

      childProcess.stderr?.on('data', (data) => {
        logger.debug(`[BackgroundProcessManager] [${pluginName}] stderr: ${data.toString().trim()}`);
      });

      // Wait for socket to be ready (indicates successful startup)
      await this.waitForSocket(config.socketPath, config.startupTimeout);

      // Write PID file after process is confirmed to be running
      const pidFile = this.getPidFilePath(pluginName);
      await fs.mkdir(join(PLUGIN_ENVS_DIR, pluginName), { recursive: true });
      await fs.writeFile(pidFile, String(childProcess.pid));
      logger.debug(`[BackgroundProcessManager] Wrote PID file: ${pidFile}`);

      // Update state to running
      processInfo.state = ProcessState.RUNNING;
      processInfo.lastStateChange = new Date();
      logger.info(`[BackgroundProcessManager] ✓ Process '${pluginName}' started successfully (PID: ${childProcess.pid})`);

      // Start health monitoring if configured
      if (config.healthcheck) {
        this.startHealthMonitoring(pluginName, config.healthcheck);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[BackgroundProcessManager] Failed to start '${pluginName}': ${errorMsg}`);

      // Clean up on failure
      if (processInfo.process) {
        this.terminateProcess(processInfo.process, config.shutdownGracePeriod);
      }
      await this.cleanupProcessResources(pluginName);

      processInfo.state = ProcessState.ERROR;
      processInfo.lastError = errorMsg;
      processInfo.lastStateChange = new Date();

      throw new Error(`Failed to start background process '${pluginName}': ${errorMsg}`);
    }
  }

  /**
   * Stop a background process
   *
   * Gracefully stops the process:
   * 1. Stops health monitoring
   * 2. Sends SIGTERM
   * 3. Waits for grace period
   * 4. Sends SIGKILL if still alive
   * 5. Cleans up PID file and resources
   *
   * @param pluginName - Name of the plugin
   */
  async stopProcess(pluginName: string): Promise<void> {
    const processInfo = this.processes.get(pluginName);
    if (!processInfo) {
      logger.warn(`[BackgroundProcessManager] No process found for '${pluginName}'`);
      return;
    }

    if (processInfo.state === ProcessState.STOPPED) {
      logger.debug(`[BackgroundProcessManager] Process '${pluginName}' already stopped`);
      return;
    }

    logger.info(`[BackgroundProcessManager] Stopping process '${pluginName}'`);
    processInfo.state = ProcessState.STOPPING;
    processInfo.lastStateChange = new Date();

    // Stop health monitoring
    this.stopHealthMonitoring(pluginName);

    // Terminate the process
    if (processInfo.process) {
      await this.terminateProcess(processInfo.process, processInfo.config.shutdownGracePeriod);
    }

    // Clean up resources
    await this.cleanupProcessResources(pluginName);

    processInfo.state = ProcessState.STOPPED;
    processInfo.lastStateChange = new Date();
    logger.info(`[BackgroundProcessManager] ✓ Process '${pluginName}' stopped`);
  }

  /**
   * Stop all background processes
   *
   * Used during application shutdown. Stops all processes in parallel
   * for faster shutdown.
   */
  async stopAllProcesses(): Promise<void> {
    logger.info('[BackgroundProcessManager] Stopping all background processes');
    this.isShuttingDown = true;

    const stopPromises = Array.from(this.processes.keys()).map((pluginName) =>
      this.stopProcess(pluginName).catch((error) => {
        logger.error(
          `[BackgroundProcessManager] Error stopping '${pluginName}': ${error instanceof Error ? error.message : String(error)}`
        );
      })
    );

    await Promise.all(stopPromises);
    logger.info('[BackgroundProcessManager] All processes stopped');
  }

  /**
   * Check if a process is running
   *
   * @param pluginName - Name of the plugin
   * @returns True if process is in RUNNING state
   */
  isRunning(pluginName: string): boolean {
    const processInfo = this.processes.get(pluginName);
    return processInfo?.state === ProcessState.RUNNING;
  }

  /**
   * Get process state
   *
   * @param pluginName - Name of the plugin
   * @returns Current process state or undefined if not tracked
   */
  getState(pluginName: string): ProcessState | undefined {
    return this.processes.get(pluginName)?.state;
  }

  /**
   * Get PID for a process
   *
   * @param pluginName - Name of the plugin
   * @returns Process ID or undefined if not running
   */
  getPid(pluginName: string): number | undefined {
    return this.processes.get(pluginName)?.pid;
  }

  /**
   * Get detailed process information (for debugging/monitoring)
   *
   * @param pluginName - Name of the plugin
   * @returns Process info or undefined if not tracked
   */
  getProcessInfo(pluginName: string): Readonly<Omit<ProcessInfo, 'process'>> | undefined {
    const info = this.processes.get(pluginName);
    if (!info) {
      return undefined;
    }

    // Return copy without the process handle (not serializable)
    return {
      state: info.state,
      pid: info.pid,
      config: info.config,
      failedHealthChecks: info.failedHealthChecks,
      healthCheckInProgress: info.healthCheckInProgress,
      restartAttempts: info.restartAttempts,
      lastError: info.lastError,
      lastStateChange: info.lastStateChange,
    };
  }

  /**
   * Get PID file path for a plugin
   */
  private getPidFilePath(pluginName: string): string {
    return join(PLUGIN_ENVS_DIR, pluginName, 'daemon.pid');
  }

  /**
   * Check for and clean up orphaned processes from previous runs
   *
   * An orphaned process is one where:
   * - PID file exists
   * - But process is dead or not responding
   *
   * This can happen if the parent process crashed or was force-killed.
   */
  private async cleanupOrphanedProcess(pluginName: string): Promise<void> {
    const pidFile = this.getPidFilePath(pluginName);

    try {
      const pidStr = await fs.readFile(pidFile, 'utf-8');
      const pid = parseInt(pidStr.trim(), 10);

      if (isNaN(pid)) {
        logger.warn(`[BackgroundProcessManager] Invalid PID in file for '${pluginName}', cleaning up`);
        await fs.unlink(pidFile).catch(() => {});
        return;
      }

      // Check if process is still running
      const isAlive = this.isProcessAlive(pid);
      if (isAlive) {
        logger.warn(
          `[BackgroundProcessManager] Found orphaned process for '${pluginName}' (PID: ${pid}), killing it`
        );
        try {
          process.kill(pid, 'SIGTERM');
          // Wait a bit then force kill if needed
          await new Promise((resolve) => setTimeout(resolve, API_TIMEOUTS.PROCESS_KILL_GRACE_PERIOD));
          if (this.isProcessAlive(pid)) {
            process.kill(pid, 'SIGKILL');
          }
        } catch (error) {
          // Process may have already died
          logger.debug(
            `[BackgroundProcessManager] Error killing orphaned process: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Clean up PID file
      await fs.unlink(pidFile).catch(() => {});
      logger.debug(`[BackgroundProcessManager] Cleaned up orphaned PID file for '${pluginName}'`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug(
          `[BackgroundProcessManager] Error checking for orphaned process: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  /**
   * Check if a process is alive by PID
   *
   * Uses kill(pid, 0) which doesn't actually send a signal but checks
   * if the process exists.
   */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Wait for socket to be ready
   *
   * Polls the socket path until it exists and accepts connections,
   * or timeout is reached.
   *
   * @param socketPath - Path to Unix socket
   * @param timeout - Timeout in milliseconds
   */
  private async waitForSocket(socketPath: string, timeout: number): Promise<void> {
    const startTime = Date.now();
    const pollInterval = PLUGIN_TIMEOUTS.SOCKET_POLL_INTERVAL;

    while (Date.now() - startTime < timeout) {
      try {
        // Try to connect to the socket
        await this.checkSocketConnection(socketPath, PLUGIN_TIMEOUTS.SOCKET_CONNECTION_CHECK_TIMEOUT);
        logger.debug(`[BackgroundProcessManager] Socket is ready: ${socketPath}`);
        return;
      } catch (error) {
        // Socket not ready yet, wait and retry
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      }
    }

    throw new Error(`Timeout waiting for socket: ${socketPath}`);
  }

  /**
   * Check if socket accepts connections
   *
   * Attempts to connect to the socket. If successful, the daemon is ready.
   *
   * @param socketPath - Path to Unix socket
   * @param timeout - Connection timeout in milliseconds
   */
  private async checkSocketConnection(socketPath: string, timeout: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ path: socketPath });
      let timeoutId: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timeoutId);
        socket.destroy();
      };

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Socket connection timeout'));
      }, timeout);

      socket.on('connect', () => {
        cleanup();
        resolve();
      });

      socket.on('error', (error) => {
        cleanup();
        reject(error);
      });
    });
  }

  /**
   * Gracefully terminate a process
   *
   * Sends SIGTERM, waits for grace period, then sends SIGKILL if needed.
   *
   * @param childProcess - Process to terminate
   * @param gracePeriod - Milliseconds to wait before SIGKILL
   */
  private async terminateProcess(
    childProcess: ChildProcess,
    gracePeriod: number
  ): Promise<void> {
    return new Promise((resolve) => {
      // If already dead, resolve immediately
      if (childProcess.exitCode !== null) {
        resolve();
        return;
      }

      // Send SIGTERM
      childProcess.kill('SIGTERM');

      // Set up force kill timeout
      const killTimeout = setTimeout(() => {
        if (childProcess.exitCode === null) {
          logger.warn(
            `[BackgroundProcessManager] Process did not exit gracefully, sending SIGKILL`
          );
          childProcess.kill('SIGKILL');
        }
      }, gracePeriod);

      // Wait for exit (use 'once' to prevent listener accumulation)
      childProcess.once('exit', () => {
        clearTimeout(killTimeout);
        resolve();
      });
    });
  }

  /**
   * Clean up process resources
   *
   * Removes PID file, socket file, and any other tracked resources.
   */
  private async cleanupProcessResources(pluginName: string): Promise<void> {
    const processInfo = this.processes.get(pluginName);
    const pidFile = this.getPidFilePath(pluginName);

    // Remove PID file
    try {
      await fs.unlink(pidFile);
      logger.debug(`[BackgroundProcessManager] Removed PID file: ${pidFile}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug(
          `[BackgroundProcessManager] Error removing PID file: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Remove socket file
    if (processInfo?.config.socketPath) {
      try {
        await fs.unlink(processInfo.config.socketPath);
        logger.debug(`[BackgroundProcessManager] Removed socket file: ${processInfo.config.socketPath}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.debug(
            `[BackgroundProcessManager] Error removing socket file: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
  }

  /**
   * Handle process exit
   *
   * Called when process exits unexpectedly. Attempts auto-restart if
   * within retry limits.
   */
  private async handleProcessExit(
    pluginName: string,
    code: number | null,
    signal: NodeJS.Signals | null
  ): Promise<void> {
    const processInfo = this.processes.get(pluginName);
    if (!processInfo) {
      return;
    }

    // Don't restart if we're intentionally stopping or shutting down
    if (processInfo.state === ProcessState.STOPPING || this.isShuttingDown) {
      return;
    }

    logger.warn(
      `[BackgroundProcessManager] Process '${pluginName}' exited unexpectedly (code: ${code}, signal: ${signal})`
    );

    this.stopHealthMonitoring(pluginName);

    // Check if we should attempt restart
    if (processInfo.restartAttempts < PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_MAX_RESTART_ATTEMPTS) {
      processInfo.restartAttempts++;
      logger.info(
        `[BackgroundProcessManager] Attempting to restart '${pluginName}' (attempt ${processInfo.restartAttempts}/${PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_MAX_RESTART_ATTEMPTS})`
      );

      // Clean up resources before restart
      await this.cleanupProcessResources(pluginName);

      // Wait before restarting (linear backoff)
      const delay = PLUGIN_TIMEOUTS.BACKGROUND_PROCESS_RESTART_DELAY * processInfo.restartAttempts;
      await new Promise((resolve) => setTimeout(resolve, delay));

      try {
        await this.startProcess(processInfo.config);
        logger.info(`[BackgroundProcessManager] ✓ Successfully restarted '${pluginName}'`);
        // Reset restart counter on successful restart
        processInfo.restartAttempts = 0;
      } catch (error) {
        logger.error(
          `[BackgroundProcessManager] Failed to restart '${pluginName}': ${error instanceof Error ? error.message : String(error)}`
        );
        processInfo.state = ProcessState.ERROR;
        processInfo.lastError = `Restart failed: ${error instanceof Error ? error.message : String(error)}`;
        processInfo.lastStateChange = new Date();
        // Clear dead process handles
        processInfo.process = undefined;
        processInfo.pid = undefined;
      }
    } else {
      logger.error(
        `[BackgroundProcessManager] Maximum restart attempts reached for '${pluginName}'`
      );
      processInfo.state = ProcessState.ERROR;
      processInfo.lastError = 'Maximum restart attempts exceeded';
      processInfo.lastStateChange = new Date();
      // Clear dead process handles
      processInfo.process = undefined;
      processInfo.pid = undefined;
      await this.cleanupProcessResources(pluginName);
    }
  }

  /**
   * Start health monitoring for a process
   *
   * Periodically checks if the process is healthy by attempting to
   * connect to its socket. If health checks fail repeatedly, marks
   * the process as unhealthy and attempts restart.
   */
  private startHealthMonitoring(
    pluginName: string,
    config: { interval: number; timeout: number; retries: number }
  ): void {
    const processInfo = this.processes.get(pluginName);
    if (!processInfo) {
      return;
    }

    logger.debug(`[BackgroundProcessManager] Starting health monitoring for '${pluginName}'`);

    processInfo.healthCheckInterval = setInterval(async () => {
      if (!processInfo || processInfo.state !== ProcessState.RUNNING) {
        return;
      }

      // Prevent concurrent health checks
      if (processInfo.healthCheckInProgress) {
        logger.debug(`[BackgroundProcessManager] Health check already in progress for '${pluginName}', skipping`);
        return;
      }

      processInfo.healthCheckInProgress = true;

      try {
        await this.checkSocketConnection(processInfo.config.socketPath, config.timeout);
        // Health check passed, reset counter
        processInfo.failedHealthChecks = 0;
        logger.debug(`[BackgroundProcessManager] Health check passed for '${pluginName}'`);
      } catch (error) {
        processInfo.failedHealthChecks++;
        logger.warn(
          `[BackgroundProcessManager] Health check failed for '${pluginName}' (${processInfo.failedHealthChecks}/${config.retries})`
        );

        if (processInfo.failedHealthChecks >= config.retries) {
          logger.error(
            `[BackgroundProcessManager] Process '${pluginName}' is unhealthy, attempting restart`
          );
          // Check state again before taking action (race condition with stopProcess)
          if (processInfo.state === ProcessState.RUNNING && processInfo.process) {
            processInfo.process.kill('SIGTERM');
          }
        }
      } finally {
        processInfo.healthCheckInProgress = false;
      }
    }, config.interval);
  }

  /**
   * Stop health monitoring for a process
   */
  private stopHealthMonitoring(pluginName: string): void {
    const processInfo = this.processes.get(pluginName);
    if (!processInfo || !processInfo.healthCheckInterval) {
      return;
    }

    logger.debug(`[BackgroundProcessManager] Stopping health monitoring for '${pluginName}'`);
    clearInterval(processInfo.healthCheckInterval);
    processInfo.healthCheckInterval = undefined;
    processInfo.failedHealthChecks = 0;
  }
}
