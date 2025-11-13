/**
 * BackgroundToolWrapper - Wraps tools provided by background plugin processes
 *
 * Enables tools to call JSON-RPC methods on persistent background daemon processes.
 * Unlike ExecutableToolWrapper which spawns a new process for each tool call,
 * BackgroundToolWrapper communicates with a long-running daemon via Unix sockets.
 *
 * Key differences from ExecutableToolWrapper:
 * - No process spawning - daemon already running
 * - Uses SocketClient for JSON-RPC communication
 * - Simpler lifecycle - just RPC call
 * - No stdout/stderr parsing - RPC returns structured data
 * - Faster - no process startup overhead
 * - Depends on BackgroundProcessManager for daemon lifecycle
 *
 * The wrapper handles:
 * - Tool interface conformance (extends BaseTool)
 * - Process status verification before RPC calls
 * - JSON-RPC communication via SocketClient
 * - Error handling (process not running, RPC errors, timeouts)
 * - Response conversion to ToolResult format
 */

import { BaseTool } from '../tools/BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { SocketClient } from './SocketClient.js';
import { BackgroundProcessManager } from './BackgroundProcessManager.js';
import { logger } from '../services/Logger.js';
import { PLUGIN_TIMEOUTS } from './constants.js';
import type { ToolDefinition, PluginManifest } from './PluginLoader.js';

/**
 * Wraps background RPC tools and provides a standardized interface for executing them.
 *
 * The wrapper handles:
 * - Process status verification
 * - JSON-RPC method invocation
 * - Response conversion to ToolResult format
 * - Comprehensive error handling
 */
export class BackgroundToolWrapper extends BaseTool {
	// BaseTool abstract properties (must be readonly to match interface)
	readonly name: string;
	readonly description: string;
	readonly requiresConfirmation: boolean;
	readonly usageGuidance?: string;
	readonly pluginName?: string;

	/** JSON-RPC method name to invoke */
	private readonly method: string;

	/** Path to Unix domain socket for communication */
	private readonly socketPath: string;

	/** JSON Schema for tool parameters */
	private readonly schema: any;

	/** RPC request timeout in milliseconds */
	private readonly timeout: number;

	/** Socket client for JSON-RPC communication */
	private readonly socketClient: SocketClient;

	/** Process manager for status checks */
	private readonly processManager: BackgroundProcessManager;

	/**
	 * Creates a new BackgroundToolWrapper instance.
	 *
	 * @param toolDef - Tool definition containing metadata and RPC method name
	 * @param manifest - Complete plugin manifest (for runtime info and socket path)
	 * @param activityStream - Activity stream for logging and user feedback
	 * @param socketClient - Socket client for JSON-RPC communication
	 * @param processManager - Process manager for daemon status checks
	 * @param timeout - Maximum RPC request time in milliseconds (default: 30 seconds)
	 */
	constructor(
		toolDef: ToolDefinition,
		manifest: PluginManifest,
		activityStream: ActivityStream,
		socketClient: SocketClient,
		processManager: BackgroundProcessManager,
		timeout?: number
	) {
		// BaseTool constructor only takes activityStream
		super(activityStream);

		// Set abstract properties
		this.name = toolDef.name;
		this.description = toolDef.description || '';
		this.requiresConfirmation = toolDef.requiresConfirmation ?? false;
		this.usageGuidance = toolDef.usageGuidance;
		this.pluginName = manifest.name;

		// Set visibleTo from tool definition (cast to any since it's readonly)
		if (toolDef.visible_to) {
			(this as any).visibleTo = toolDef.visible_to;
		}

		// Validate required fields for background RPC tools
		if (!toolDef.method) {
			throw new Error(`Tool definition for '${toolDef.name}' is missing required 'method' field for background_rpc type`);
		}

		if (!manifest.background?.communication?.path) {
			throw new Error(`Plugin manifest for '${manifest.name}' is missing required background.communication.path field`);
		}

		// Store RPC-specific configuration
		this.method = toolDef.method;
		this.socketPath = manifest.background.communication.path;
		this.schema = toolDef.schema || {};
		this.timeout = timeout ?? PLUGIN_TIMEOUTS.RPC_REQUEST_TIMEOUT;
		this.socketClient = socketClient;
		this.processManager = processManager;

		logger.debug(
			`[BackgroundToolWrapper] Initialized tool '${this.name}' for plugin '${manifest.name}' (method: ${this.method}, socket: ${this.socketPath})`
		);
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
	 * Executes the background RPC tool with the provided arguments.
	 *
	 * Workflow:
	 * 1. Capture parameters for logging
	 * 2. Verify background process is running
	 * 3. Send JSON-RPC request via SocketClient
	 * 4. Convert RPC response to ToolResult
	 * 5. Handle errors gracefully with descriptive messages
	 *
	 * @param args - Arguments to pass to the RPC method (will be sent as JSON-RPC params)
	 * @returns Promise resolving to the tool execution result
	 */
	protected async executeImpl(args: any): Promise<ToolResult> {
		// Capture parameters for logging and error context
		this.captureParams(args);

		logger.debug(
			`[BackgroundToolWrapper] Executing tool '${this.name}': method=${this.method}, plugin=${this.pluginName}`
		);

		try {
			// Step 1: Verify background process is running
			// We don't auto-start the process here - it should be started at app startup
			// or explicitly by the user. This prevents unexpected daemon spawning during tool calls.
			if (!this.processManager.isRunning(this.pluginName!)) {
				const processState = this.processManager.getState(this.pluginName!);
				const errorMsg = processState === undefined
					? `Background process '${this.pluginName}' has not been started. Start the daemon first.`
					: `Background process '${this.pluginName}' is not running (state: ${processState}). The daemon may have crashed or failed to start.`;

				logger.warn(`[BackgroundToolWrapper] ${errorMsg}`);

				return this.formatErrorResponse(
					errorMsg,
					'plugin_error'
				);
			}

			// Step 2: Send JSON-RPC request to background process
			// SocketClient handles connection, timeout, and protocol validation
			logger.debug(
				`[BackgroundToolWrapper] Sending RPC request: socket=${this.socketPath}, method=${this.method}, timeout=${this.timeout}ms`
			);

			const result = await this.socketClient.sendRequest(
				this.socketPath,
				this.method,
				args,
				this.timeout
			);

			// Step 3: Convert RPC result to ToolResult format
			// RPC success response contains the result in the 'result' field
			logger.debug(
				`[BackgroundToolWrapper] RPC call succeeded for tool '${this.name}'`
			);

			// Defensive validation: ensure result is an object
			if (typeof result !== 'object' || result === null) {
				logger.warn(
					`[BackgroundToolWrapper] RPC result for '${this.name}' is not an object, wrapping in data field`
				);
				return this.formatSuccessResponse({
					output: 'Tool executed successfully',
					data: result
				});
			}

			// Safely access result fields with type checking
			const message = typeof result.message === 'string' ? result.message : 'Tool executed successfully';
			const data = result.data !== undefined ? result.data : result;

			return this.formatSuccessResponse({
				output: message,
				data: data
			});

		} catch (error) {
			// Step 4: Handle errors with descriptive messages
			const errorMessage = error instanceof Error ? error.message : String(error);

			logger.error(
				`[BackgroundToolWrapper] RPC call failed for tool '${this.name}': ${errorMessage}`
			);

			// Categorize errors for better user feedback
			let errorType: 'plugin_error' | 'system_error' | 'timeout_error' = 'plugin_error';
			let enhancedMessage = errorMessage;

			// Connection errors (socket not found, permission denied, etc.)
			if (errorMessage.includes('Socket file not found') ||
			    errorMessage.includes('ENOENT') ||
			    errorMessage.includes('daemon may not be running')) {
				enhancedMessage = `Cannot connect to background process '${this.pluginName}'. The daemon socket is not available. The process may have crashed or not started properly.`;
				errorType = 'plugin_error';
			}
			// Permission errors
			else if (errorMessage.includes('Permission denied') || errorMessage.includes('EACCES')) {
				enhancedMessage = `Permission denied accessing socket for '${this.pluginName}'. Check socket file permissions at: ${this.socketPath}`;
				errorType = 'system_error';
			}
			// Connection refused
			else if (errorMessage.includes('Connection refused') || errorMessage.includes('ECONNREFUSED')) {
				enhancedMessage = `Background process '${this.pluginName}' is not accepting connections. The daemon may be starting up or in an error state.`;
				errorType = 'plugin_error';
			}
			// Timeout errors
			else if (errorMessage.includes('timeout')) {
				enhancedMessage = `RPC request to '${this.pluginName}' timed out after ${this.timeout}ms. The daemon may be unresponsive or the operation is taking too long.`;
				errorType = 'timeout_error';
			}
			// RPC-level errors (method not found, invalid params, etc.)
			else if (errorMessage.includes('RPC error')) {
				// RPC errors already have good messages from SocketClient
				enhancedMessage = `Plugin '${this.pluginName}' RPC error: ${errorMessage}`;
				errorType = 'plugin_error';
			}
			// JSON parse errors
			else if (errorMessage.includes('JSON') || errorMessage.includes('parse')) {
				enhancedMessage = `Invalid response from background process '${this.pluginName}'. The daemon may have returned malformed data: ${errorMessage}`;
				errorType = 'plugin_error';
			}
			// Generic errors
			else {
				enhancedMessage = `Background process '${this.pluginName}' error: ${errorMessage}`;
			}

			return this.formatErrorResponse(
				enhancedMessage,
				errorType
			);
		}
	}
}
