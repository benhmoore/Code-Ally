/**
 * Agent - Main orchestrator for LLM conversation and tool execution
 *
 * Core responsibilities:
 * - Manages conversation message history
 * - Sends messages to LLM with function definitions
 * - Parses tool calls from LLM responses
 * - Orchestrates tool execution (via ToolOrchestrator)
 * - Emits events via ActivityStream for UI updates
 * - Handles follow-up responses after tool execution
 *
 * Based on Python implementation patterns adapted for TypeScript/async.
 */

import { ModelClient, LLMResponse } from '../llm/ModelClient.js';
import { ToolManager } from '../tools/ToolManager.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ToolOrchestrator } from './ToolOrchestrator.js';
import { ToolResultManager } from '../services/ToolResultManager.js';
import { PermissionManager } from '../security/PermissionManager.js';
import { Message, ActivityEventType, Config } from '../types/index.js';
import { logger } from '../services/Logger.js';

export interface AgentConfig {
  /** Whether this is a specialized/delegated agent */
  isSpecializedAgent?: boolean;
  /** Enable verbose logging */
  verbose?: boolean;
  /** System prompt to prepend */
  systemPrompt?: string;
  /** Application configuration */
  config: Config;
  /** Parent tool call ID (for nested agents) */
  parentCallId?: string;
}

/**
 * Agent orchestrates the entire conversation flow
 */
export class Agent {
  private modelClient: ModelClient;
  private toolManager: ToolManager;
  private activityStream: ActivityStream;
  private toolOrchestrator: ToolOrchestrator;
  private config: AgentConfig;

  // Conversation state
  private messages: Message[] = [];
  private requestInProgress: boolean = false;
  private interrupted: boolean = false;

  // Agent instance ID for debugging
  private readonly instanceId: string;

  constructor(
    modelClient: ModelClient,
    toolManager: ToolManager,
    activityStream: ActivityStream,
    config: AgentConfig,
    toolResultManager?: ToolResultManager,
    permissionManager?: PermissionManager
  ) {
    this.modelClient = modelClient;
    this.toolManager = toolManager;
    this.activityStream = activityStream;
    this.config = config;

    // Generate unique instance ID for debugging
    this.instanceId = `agent-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Created - isSpecialized:', config.isSpecializedAgent || false, 'parentCallId:', config.parentCallId || 'none');

    // Create tool orchestrator
    this.toolOrchestrator = new ToolOrchestrator(
      toolManager,
      activityStream,
      this,
      config,
      toolResultManager,
      permissionManager
    );

    // Initialize with system prompt if provided
    if (config.systemPrompt) {
      this.messages.push({
        role: 'system',
        content: config.systemPrompt,
      });
      logger.debug('[AGENT_CONTEXT]', this.instanceId, 'System prompt added, length:', config.systemPrompt.length);
    }
  }

  /**
   * Get the model client (used by CommandHandler for /compact)
   */
  getModelClient(): ModelClient {
    return this.modelClient;
  }

  /**
   * Send a user message and get a response
   *
   * Main entry point for conversation turns. Handles:
   * - Adding user message to history
   * - Sending to LLM with function definitions
   * - Processing tool calls (if any)
   * - Returning final response
   *
   * @param message - User's message
   * @returns Promise resolving to the assistant's final response
   */
  async sendMessage(message: string): Promise<string> {
    // Add user message
    this.messages.push({
      role: 'user',
      content: message,
    });

    // Emit user message event
    this.emitEvent({
      id: this.generateId(),
      type: ActivityEventType.AGENT_START,
      timestamp: Date.now(),
      data: { message },
    });

    try {
      // Reset interrupted flag and mark request in progress
      this.interrupted = false;
      this.requestInProgress = true;

      // Send to LLM and process response
      const response = await this.getLLMResponse();

      // Check if interrupted before processing
      if (this.interrupted) {
        throw new Error('Request interrupted by user');
      }

      // Process response (handles both tool calls and text responses)
      const finalResponse = await this.processLLMResponse(response);

      return finalResponse;
    } catch (error) {
      if (this.interrupted || (error instanceof Error && error.message.includes('interrupted'))) {
        return '[Request interrupted by user]';
      }
      throw error;
    } finally {
      this.requestInProgress = false;
      this.interrupted = false;
    }
  }

  /**
   * Interrupt the current request
   *
   * Called when user presses Ctrl+C during an ongoing request.
   * Sets a flag that will cause the request to abort gracefully.
   */
  interrupt(): void {
    if (this.requestInProgress) {
      this.interrupted = true;
      this.emitEvent({
        id: this.generateId(),
        type: ActivityEventType.AGENT_END,
        timestamp: Date.now(),
        data: { interrupted: true },
      });
    }
  }

  /**
   * Check if a request is currently in progress
   */
  isProcessing(): boolean {
    return this.requestInProgress;
  }

  /**
   * Get response from LLM
   *
   * @returns LLM response with potential tool calls
   */
  private async getLLMResponse(): Promise<LLMResponse> {
    // Get function definitions from tool manager
    const functions = this.toolManager.getFunctionDefinitions();

    // Log conversation state before sending to LLM
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Sending', this.messages.length, 'messages to LLM');
    if (logger.isDebugEnabled()) {
      this.messages.forEach((msg, idx) => {
        const preview = msg.content.length > 100 ? msg.content.slice(0, 97) + '...' : msg.content;
        const toolInfo = msg.tool_calls ? ` toolCalls:${msg.tool_calls.length}` : '';
        const toolCallId = msg.tool_call_id ? ` toolCallId:${msg.tool_call_id}` : '';
        console.log(`  [${idx}] ${msg.role}${toolInfo}${toolCallId} - ${preview}`);
      });
    }

    // Emit thinking indicator
    this.emitEvent({
      id: this.generateId(),
      type: ActivityEventType.THOUGHT_CHUNK,
      timestamp: Date.now(),
      data: { text: 'Thinking...', thinking: true },
    });

    try {
      // Send to model
      const response = await this.modelClient.send(this.messages, {
        functions,
        stream: this.config.config.parallel_tools, // Enable streaming if configured
      });

      return response;
    } catch (error) {
      // Emit error event
      this.emitEvent({
        id: this.generateId(),
        type: ActivityEventType.ERROR,
        timestamp: Date.now(),
        data: { error: error instanceof Error ? error.message : String(error) },
      });

      throw error;
    }
  }

  /**
   * Process LLM response (handles both tool calls and text)
   *
   * @param response - LLM response
   * @returns Final text response
   */
  private async processLLMResponse(response: LLMResponse): Promise<string> {
    // Check for interruption
    if (this.interrupted || response.interrupted) {
      return '[Request interrupted by user]';
    }

    // Check for error
    if (response.error) {
      return response.content || 'An error occurred';
    }

    // Extract tool calls
    const toolCalls = response.tool_calls || [];

    // Log LLM response to trace tool call origins
    logger.debug('[AGENT] LLM response - hasContent:', !!response.content, 'toolCallCount:', toolCalls.length);
    if (toolCalls.length > 0) {
      logger.debug('[AGENT] Tool calls from LLM:');
      toolCalls.forEach((tc, idx) => {
        logger.debug(`  [${idx}] ${tc.function.name}(${JSON.stringify(tc.function.arguments)}) id:${tc.id}`);
      });
    }

    if (toolCalls.length > 0) {
      // Check for interruption before processing tools
      if (this.interrupted) {
        return '[Request interrupted by user]';
      }
      // Response contains tool calls
      return await this.processToolResponse(response, toolCalls);
    } else {
      // Text-only response
      return this.processTextResponse(response);
    }
  }

  /**
   * Process a response that contains tool calls
   *
   * @param response - LLM response with tool calls
   * @param toolCalls - Parsed tool calls
   * @returns Final response after tool execution and follow-up
   */
  private async processToolResponse(
    response: LLMResponse,
    toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, any> };
    }>
  ): Promise<string> {
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Processing tool response with', toolCalls.length, 'tool calls');

    // Unwrap batch calls before adding to conversation
    // This ensures the conversation history matches what was actually executed
    const unwrappedToolCalls = this.unwrapBatchToolCalls(toolCalls);
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'After unwrapping:', unwrappedToolCalls.length, 'tool calls');

    // Add assistant message with unwrapped tool calls to history
    const toolCallsForMessage = unwrappedToolCalls.map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    this.messages.push({
      role: 'assistant',
      content: response.content || '',
      tool_calls: toolCallsForMessage,
    });

    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Assistant message with tool calls added. Total messages:', this.messages.length);

    // Execute tool calls via orchestrator (pass original calls for unwrapping)
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Executing tool calls via orchestrator...');
    await this.toolOrchestrator.executeToolCalls(toolCalls);
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Tool calls completed. Total messages now:', this.messages.length);

    // Clear current turn (for redundancy detection)
    this.toolManager.clearCurrentTurn();

    // Get follow-up response from LLM
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Getting follow-up response from LLM...');
    const followUpResponse = await this.getLLMResponse();

    // Recursively process the follow-up (it might contain more tool calls)
    return await this.processLLMResponse(followUpResponse);
  }

  /**
   * Process a text-only response (no tool calls)
   *
   * @param response - LLM text response
   * @returns The text content
   */
  private processTextResponse(response: LLMResponse): string {
    // Add assistant message to history
    this.messages.push({
      role: 'assistant',
      content: response.content,
    });

    // Emit completion event
    this.emitEvent({
      id: this.generateId(),
      type: ActivityEventType.AGENT_END,
      timestamp: Date.now(),
      data: { content: response.content },
    });

    return response.content;
  }

  /**
   * Generate system prompt with tool descriptions
   *
   * Creates a system prompt that includes descriptions of all available tools.
   *
   * @returns System prompt string
   */
  generateSystemPrompt(): string {
    const functions = this.toolManager.getFunctionDefinitions();

    let prompt = this.config.systemPrompt || 'You are a helpful AI assistant.';
    prompt += '\n\nYou have access to the following tools:\n\n';

    for (const func of functions) {
      prompt += `- **${func.function.name}**: ${func.function.description}\n`;

      // Add parameter descriptions
      const params = func.function.parameters.properties;
      if (params && Object.keys(params).length > 0) {
        prompt += '  Parameters:\n';
        for (const [paramName, paramSchema] of Object.entries(params)) {
          const required = func.function.parameters.required?.includes(paramName) ? ' (required)' : '';
          const desc = paramSchema.description || 'No description';
          prompt += `    - ${paramName}${required}: ${desc}\n`;
        }
      }

      prompt += '\n';
    }

    prompt += '\nUse these tools to complete tasks effectively.';

    return prompt;
  }

  /**
   * Unwrap batch tool calls into individual tool calls
   *
   * Batch is a transparent wrapper - we extract its children so the conversation
   * history shows the actual tools that were executed.
   */
  private unwrapBatchToolCalls(
    toolCalls: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, any> };
    }>
  ): Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: Record<string, any> };
  }> {
    const unwrapped: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: Record<string, any> };
    }> = [];

    for (const toolCall of toolCalls) {
      // Check if this is a batch call
      if (toolCall.function.name === 'batch') {
        const tools = toolCall.function.arguments.tools;

        if (Array.isArray(tools)) {
          // Convert each tool spec into a proper tool call
          tools.forEach((spec: any, index: number) => {
            unwrapped.push({
              id: `${toolCall.id}-unwrapped-${index}`,
              type: 'function',
              function: {
                name: spec.name,
                arguments: spec.arguments,
              },
            });
          });
        }
      } else {
        // Not a batch call, keep as-is
        unwrapped.push(toolCall);
      }
    }

    return unwrapped;
  }

  /**
   * Add a message to conversation history
   *
   * @param message - Message to add
   */
  addMessage(message: Message): void {
    this.messages.push(message);

    // Log message addition for context tracking
    const toolInfo = message.tool_calls ? ` toolCalls:${message.tool_calls.length}` : '';
    const toolCallId = message.tool_call_id ? ` toolCallId:${message.tool_call_id}` : '';
    const toolName = message.name ? ` name:${message.name}` : '';
    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Message added:', message.role, toolInfo, toolCallId, toolName, '- Total messages:', this.messages.length);
  }

  /**
   * Get the current conversation history
   *
   * @returns Array of messages
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * Rewind conversation to a specific user message
   *
   * Truncates the conversation history to just before the selected user message.
   * The selected message will be available for editing and re-submission.
   *
   * @param userMessageIndex - Index of the user message in the filtered user messages array
   * @returns The content of the target message for pre-filling the input
   */
  async rewindToMessage(userMessageIndex: number): Promise<string> {
    // Filter to user messages only
    const userMessages = this.messages.filter(m => m.role === 'user');

    if (userMessageIndex < 0 || userMessageIndex >= userMessages.length) {
      throw new Error(`Invalid message index: ${userMessageIndex}. Must be between 0 and ${userMessages.length - 1}`);
    }

    // Get the target user message
    const targetMessage = userMessages[userMessageIndex];
    if (!targetMessage) {
      throw new Error(`Target message at index ${userMessageIndex} not found`);
    }

    // Find its position in the full messages array
    const cutoffIndex = this.messages.findIndex(
      m => m.role === 'user' && m.timestamp === targetMessage.timestamp && m.content === targetMessage.content
    );

    if (cutoffIndex === -1) {
      throw new Error('Target message not found in conversation history');
    }

    // Preserve system message and truncate to just before the target message
    const systemMessage = this.messages[0]?.role === 'system' ? this.messages[0] : null;
    const truncatedMessages = this.messages.slice(systemMessage ? 1 : 0, cutoffIndex);

    // Update messages array
    this.messages = systemMessage ? [systemMessage, ...truncatedMessages] : truncatedMessages;

    logger.debug('[AGENT_CONTEXT]', this.instanceId, 'Rewound to message', userMessageIndex, '- Total messages now:', this.messages.length);

    // Return the target message content for pre-filling the input
    return targetMessage.content;
  }

  /**
   * Check if a request is currently in progress
   */
  isRequestInProgress(): boolean {
    return this.requestInProgress;
  }

  /**
   * Emit an activity event
   */
  private emitEvent(event: any): void {
    this.activityStream.emit(event);
  }

  /**
   * Generate a unique ID for events
   */
  private generateId(): string {
    return `agent-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Cancel any ongoing request
   */
  cancel(): void {
    if (this.modelClient.cancel) {
      this.modelClient.cancel();
    }
  }

  /**
   * Cleanup resources
   *
   * NOTE: Subagents share the ModelClient with the main agent, so they should
   * NOT close it. Only the main agent should close the shared client.
   */
  async cleanup(): Promise<void> {
    // Only close the model client if this is NOT a specialized subagent
    // Subagents share the client and shouldn't close it
    if (!this.config.isSpecializedAgent && this.modelClient.close) {
      await this.modelClient.close();
    }
  }
}
