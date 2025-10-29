import { BaseTool } from '../tools/BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { spawn } from 'child_process';
import { TIMEOUT_LIMITS } from '../config/toolDefaults.js';
import type { ToolDefinition, PluginManifest } from './PluginLoader.js';
import type { PluginEnvironmentManager } from './PluginEnvironmentManager.js';

/**
 * Wraps external executable plugins (Python scripts, shell scripts, etc.)
 * and provides a standardized interface for executing them as tools.
 *
 * The wrapper handles:
 * - Process spawning and lifecycle management
 * - Input/output serialization (JSON)
 * - Error handling and timeouts
 * - File path resolution
 */
export class ExecutableToolWrapper extends BaseTool {
	// Abstract properties from BaseTool (must not be readonly)
	name: string;
	description: string;
	requiresConfirmation: boolean;

	private readonly command: string;
	private readonly commandArgs: string[];
	private readonly workingDir: string;
	private readonly schema: any;
	private readonly timeout: number;
	private readonly config?: any;
	private readonly manifest: PluginManifest;
	private readonly envManager: PluginEnvironmentManager;

	/**
	 * Creates a new ExecutableToolWrapper instance.
	 *
	 * @param toolDef - Tool definition containing metadata and configuration
	 * @param manifest - Complete plugin manifest (for runtime info)
	 * @param pluginPath - Absolute path to the plugin directory
	 * @param activityStream - Activity stream for logging and user feedback
	 * @param envManager - Plugin environment manager for venv paths
	 * @param timeout - Maximum execution time in milliseconds (default: 120000ms / 2 minutes)
	 * @param config - Optional plugin configuration to be injected as environment variables
	 */
	constructor(
		toolDef: ToolDefinition,
		manifest: PluginManifest,
		pluginPath: string,
		activityStream: ActivityStream,
		envManager: PluginEnvironmentManager,
		timeout: number = 120000,
		config?: any
	) {
		// BaseTool constructor only takes activityStream
		super(activityStream);

		// Set abstract properties
		this.name = toolDef.name;
		this.description = toolDef.description || '';
		this.requiresConfirmation = toolDef.requiresConfirmation ?? false;

		if (!toolDef.command) {
			throw new Error(`Tool definition for '${toolDef.name}' is missing required 'command' field`);
		}

		this.command = toolDef.command;
		this.commandArgs = toolDef.args || [];
		this.workingDir = pluginPath;
		this.schema = toolDef.schema || {};
		this.timeout = timeout;
		this.config = config;
		this.manifest = manifest;
		this.envManager = envManager;
	}

	/**
	 * Returns the function definition for this tool.
	 * Uses the schema from the plugin manifest to define parameters.
	 */
	getFunctionDefinition(): FunctionDefinition {
		return {
			type: 'function',
			function: {
				name: this.name,
				description: this.description,
				parameters: this.schema && Object.keys(this.schema).length > 0
					? this.schema
					: {
						type: 'object',
						properties: {},
						required: []
					}
			}
		};
	}

	/**
	 * Executes the external plugin with the provided arguments.
	 *
	 * @param args - Arguments to pass to the plugin (will be serialized as JSON)
	 * @returns Promise resolving to the tool execution result
	 */
	protected async executeImpl(args: any): Promise<ToolResult> {
		// Capture parameters for logging
		this.captureParams(args);

		try {
			// Execute the plugin and get results
			// Note: Arguments are passed through unchanged. Plugins execute with
			// cwd set to their directory, so they can use relative paths naturally.
			const output = await this.executePlugin(args);

			return output;
		} catch (error) {
			return this.formatErrorResponse(
				error instanceof Error ? error.message : String(error),
				'execution_error'
			);
		}
	}


	/**
	 * Converts plugin configuration to environment variables.
	 * Each config key is prefixed with PLUGIN_CONFIG_ and converted to uppercase.
	 *
	 * @returns Object containing environment variables
	 */
	private getConfigEnvVars(): Record<string, string> {
		if (!this.config || typeof this.config !== 'object') {
			return {};
		}

		const envVars: Record<string, string> = {};
		for (const [key, value] of Object.entries(this.config)) {
			const envKey = `PLUGIN_CONFIG_${key.toUpperCase()}`;
			envVars[envKey] = String(value);
		}
		return envVars;
	}

	/**
	 * Resolves the actual command to execute, injecting venv Python if needed.
	 *
	 * If the plugin specifies runtime='python3' and command='python3',
	 * automatically uses the venv Python interpreter.
	 *
	 * @returns Resolved command path
	 */
	private getResolvedCommand(): string {
		// If plugin uses Python runtime and command is python3, use venv Python
		if (
			this.manifest.runtime === 'python3' &&
			(this.command === 'python3' || this.command === 'python')
		) {
			return this.envManager.getPythonPath(this.manifest.name);
		}

		// Otherwise use command as-is
		return this.command;
	}

	/**
	 * Spawns the external process and manages its execution.
	 *
	 * @param args - Resolved arguments to pass to the plugin
	 * @returns Promise resolving to the tool result
	 */
	private async executePlugin(args: any): Promise<ToolResult> {
		return new Promise((resolve, reject) => {
			const MAX_OUTPUT_SIZE = 10 * 1024 * 1024; // 10MB
			let stdout = '';
			let stderr = '';
			let outputTruncated = false;
			let timedOut = false;

			// Resolve the actual command (with venv injection if needed)
			const resolvedCommand = this.getResolvedCommand();

			// Spawn the child process
			const child = spawn(resolvedCommand, this.commandArgs, {
				cwd: this.workingDir,
				env: {
					...process.env,
					...this.getConfigEnvVars()
				},
				stdio: ['pipe', 'pipe', 'pipe']
			});

			// Write arguments to stdin as JSON early to avoid double-rejection
			// This happens before event handlers are set up to catch write errors cleanly
			try {
				const input = JSON.stringify(args);
				child.stdin.write(input);
				child.stdin.end();
			} catch (error) {
				child.kill();
				reject(new Error(
					`Failed to serialize arguments to JSON: ${error instanceof Error ? error.message : String(error)}\n` +
					`Arguments: ${JSON.stringify(args, null, 2)}`
				));
				return;
			}

			// Set up timeout
			const timeoutId = setTimeout(() => {
				timedOut = true;
				child.kill('SIGTERM');

				// Force kill after graceful shutdown delay if process doesn't terminate
				setTimeout(() => {
					if (child.exitCode === null) {
						child.kill('SIGKILL');
					}
				}, TIMEOUT_LIMITS.GRACEFUL_SHUTDOWN_DELAY);
			}, this.timeout);

			// Handle spawn errors
			child.on('error', (error) => {
				clearTimeout(timeoutId);
				reject(new Error(
					`Failed to spawn process '${this.command}': ${error.message}\n` +
					`Working directory: ${this.workingDir}\n` +
					`Command: ${this.command} ${this.commandArgs.join(' ')}`
				));
			});

			// Collect stdout with size limits and streaming
			child.stdout.on('data', (data) => {
				const chunk = data.toString();
				if (stdout.length + chunk.length <= MAX_OUTPUT_SIZE) {
					stdout += chunk;
					// Stream output for real-time feedback
					this.emitOutputChunk(chunk);
				} else if (!outputTruncated) {
					outputTruncated = true;
					const truncationMsg = '\n\n[Output truncated - exceeded 10MB limit]\n';
					stdout += truncationMsg;
					this.emitOutputChunk(truncationMsg);
				}
			});

			// Collect stderr with size limits
			child.stderr.on('data', (data) => {
				const chunk = data.toString();
				if (stderr.length + chunk.length <= MAX_OUTPUT_SIZE) {
					stderr += chunk;
					this.emitOutputChunk(chunk);
				}
			});

			// Handle process exit
			child.on('close', (code) => {
				clearTimeout(timeoutId);

				if (timedOut) {
					reject(new Error(
						`Plugin execution timed out after ${this.timeout}ms\n` +
						`Command: ${this.command} ${this.commandArgs.join(' ')}\n` +
						`Stderr: ${stderr || '(none)'}`
					));
					return;
				}

				if (code !== 0) {
					reject(new Error(
						`Plugin exited with code ${code}\n` +
						`Command: ${this.command} ${this.commandArgs.join(' ')}\n` +
						`Stdout: ${stdout || '(none)'}\n` +
						`Stderr: ${stderr || '(none)'}`
					));
					return;
				}

				// Process successful exit
				try {
					const result = this.parsePluginOutput(stdout, stderr, outputTruncated);
					resolve(result);
				} catch (error) {
					reject(error);
				}
			});
		});
	}

	/**
	 * Parses the plugin's output and converts it to a ToolResult.
	 * Expects JSON output with optional 'success', 'error', and 'data' fields.
	 *
	 * @param stdout - Standard output from the plugin
	 * @param stderr - Standard error output from the plugin
	 * @param outputTruncated - Whether output was truncated due to size limits
	 * @returns Parsed tool result
	 */
	private parsePluginOutput(stdout: string, stderr: string, outputTruncated: boolean = false): ToolResult {
		if (!stdout.trim()) {
			return this.formatErrorResponse(
				'Plugin produced no output\n' +
				`Stderr: ${stderr || '(none)'}`,
				'plugin_error'
			);
		}

		try {
			const output = JSON.parse(stdout);

			// Check if output explicitly indicates success/failure
			if ('success' in output) {
				if (output.success === false) {
					return this.formatErrorResponse(
						output.error || output.message || 'Plugin execution failed',
						'plugin_error',
						undefined,
						output.data ? { data: output.data } : undefined
					);
				}
			}

			// Check if output has an error field
			if (output.error) {
				return this.formatErrorResponse(
					output.error,
					'plugin_error',
					undefined,
					output.data ? { data: output.data } : undefined
				);
			}

			// Extract result data
			const resultData = output.data !== undefined ? output.data : output;
			let message = output.message || 'Plugin executed successfully';

			// Add warning if output was truncated
			if (outputTruncated) {
				message += '\n\nWarning: Output exceeded 10MB limit and was truncated';
			}

			return this.formatSuccessResponse({
				output: message,
				data: resultData
			});

		} catch (error) {
			// JSON parse failed - return raw output with error context
			return this.formatErrorResponse(
				`Failed to parse plugin output as JSON: ${error instanceof Error ? error.message : String(error)}\n` +
				`Raw output:\n${stdout}\n` +
				`Stderr: ${stderr || '(none)'}`,
				'plugin_error'
			);
		}
	}
}
