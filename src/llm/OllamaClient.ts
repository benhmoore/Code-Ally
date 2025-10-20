/**
 * OllamaClient - Ollama API implementation with function calling support
 *
 * Handles communication with Ollama's chat API, including:
 * - Streaming and non-streaming responses
 * - Function calling (both legacy and modern formats)
 * - Tool call validation and repair
 * - Automatic retry with exponential backoff
 * - Request cancellation via AbortController
 *
 * Based on the Python implementation with TypeScript improvements.
 */

import {
  ModelClient,
  ModelClientConfig,
  SendOptions,
  LLMResponse,
} from './ModelClient.js';
import { Message, FunctionDefinition } from '../types/index.js';

/**
 * Ollama API payload structure
 */
interface OllamaPayload {
  model: string;
  messages: Message[];
  stream: boolean;
  options: {
    temperature: number;
    num_ctx: number;
    num_predict: number;
    keep_alive?: number;
  };
  tools?: FunctionDefinition[];
  tool_choice?: string;
}

/**
 * Validation result for tool calls
 */
interface ValidationResult {
  valid: boolean;
  errors: string[];
  partial_repairs?: any[];
}

export class OllamaClient extends ModelClient {
  private readonly _endpoint: string;
  private readonly _modelName: string;
  private readonly temperature: number;
  private readonly contextSize: number;
  private readonly maxTokens: number;
  private readonly keepAlive?: number;
  private readonly apiUrl: string;

  private currentAbortController?: AbortController;
  private interrupted: boolean = false;

  /**
   * Initialize the Ollama client
   *
   * @param config - Client configuration
   *
   * @example
   * ```typescript
   * const client = new OllamaClient({
   *   endpoint: 'http://localhost:11434',
   *   modelName: 'qwen2.5-coder:32b',
   *   temperature: 0.3,
   *   contextSize: 16384,
   *   maxTokens: 5000
   * });
   * ```
   */
  constructor(config: ModelClientConfig) {
    super();
    this._endpoint = config.endpoint;
    this._modelName = config.modelName || 'qwen2.5-coder:32b';
    this.temperature = config.temperature;
    this.contextSize = config.contextSize;
    this.maxTokens = config.maxTokens;
    this.keepAlive = config.keepAlive;
    this.apiUrl = `${this._endpoint}/api/chat`;
  }

  get modelName(): string {
    return this._modelName;
  }

  get endpoint(): string {
    return this._endpoint;
  }

  /**
   * Cancel any ongoing request
   */
  cancel(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.interrupted = true;
    }
  }

  /**
   * Close the client and cleanup resources
   */
  async close(): Promise<void> {
    // Cancel any ongoing requests
    this.cancel();
    // No additional cleanup needed for Ollama client
  }

  /**
   * Send messages to Ollama and receive a response
   *
   * Implements retry logic with exponential backoff and tool call validation.
   *
   * @param messages - Conversation history
   * @param options - Send options
   * @returns Promise resolving to the LLM's response
   */
  async send(messages: Message[], options: SendOptions = {}): Promise<LLMResponse> {
    const { functions, stream = false, maxRetries: _maxRetries = 3 } = options;
    const maxRetries = _maxRetries;

    // Prepare payload
    const payload = this.preparePayload(messages, functions, stream);

    // Retry loop with exponential backoff
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        // Execute request with cancellation support
        const result = await this.executeRequestWithCancellation(payload, stream, attempt);

        // Validate and repair tool calls (non-streaming only)
        if (!stream && result.tool_calls && result.tool_calls.length > 0) {
          const validationResult = this.normalizeToolCallsInMessage(result);

          if (!validationResult.valid) {
            // Attempt to retry with error feedback
            const retryResult = await this.handleToolCallValidationRetry(
              result,
              messages,
              functions,
              maxRetries
            );

            if (retryResult) {
              return retryResult;
            }

            // Return error response if retries exhausted
            return {
              role: 'assistant',
              content: `I attempted to call tools but encountered validation errors. ${validationResult.errors.join('; ')}`,
              tool_call_validation_failed: true,
              validation_errors: validationResult.errors,
            };
          }
        }

        return result;
      } catch (error: any) {
        // Handle abort/interruption
        if (error.name === 'AbortError' || this.interrupted) {
          this.interrupted = false;
          return {
            role: 'assistant',
            content: '[Request cancelled by user]',
            interrupted: true,
          };
        }

        // Retry on network errors
        if (this.isNetworkError(error) && attempt < maxRetries) {
          const waitTime = Math.pow(2, attempt);
          await this.sleep(waitTime * 1000);
          continue;
        }

        // Retry on JSON errors
        if (error instanceof SyntaxError && attempt < maxRetries) {
          const waitTime = (1 + attempt) * 1000;
          await this.sleep(waitTime);
          continue;
        }

        // Return error response
        return this.handleRequestError(error, attempt + 1);
      }
    }

    // Should never reach here due to loop logic
    return {
      role: 'assistant',
      content: 'Maximum retry attempts exceeded',
      error: true,
    };
  }

  /**
   * Prepare the Ollama API payload
   */
  private preparePayload(
    messages: Message[],
    functions?: FunctionDefinition[],
    stream: boolean = false
  ): OllamaPayload {
    const payload: OllamaPayload = {
      model: this._modelName,
      messages,
      stream,
      options: {
        temperature: this.temperature,
        num_ctx: this.contextSize,
        num_predict: this.maxTokens,
      },
    };

    if (this.keepAlive !== undefined) {
      payload.options.keep_alive = this.keepAlive;
    }

    // Add function definitions if provided
    if (functions && functions.length > 0) {
      payload.tools = functions;
      payload.tool_choice = 'auto';
    }

    return payload;
  }

  /**
   * Execute HTTP request with cancellation support
   */
  private async executeRequestWithCancellation(
    payload: OllamaPayload,
    stream: boolean,
    attempt: number
  ): Promise<LLMResponse> {
    // Create abort controller for cancellation
    this.currentAbortController = new AbortController();

    try {
      // Calculate adaptive timeout
      const baseTimeout = 240000; // 4 minutes
      const timeout = baseTimeout + attempt * 60000; // Add 1 minute per retry

      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          this.currentAbortController?.abort();
          reject(new Error('Request timeout'));
        }, timeout);
      });

      // Create fetch promise
      const fetchPromise = fetch(this.apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: this.currentAbortController.signal,
      });

      // Race timeout and fetch
      const response = await Promise.race([fetchPromise, timeoutPromise]);

      // Check response status
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      // Process response
      if (stream) {
        return await this.processStreamingResponse(response);
      } else {
        const data = await response.json();
        return this.parseNonStreamingResponse(data);
      }
    } finally {
      this.currentAbortController = undefined;
    }
  }

  /**
   * Process streaming response from Ollama
   */
  private async processStreamingResponse(response: Response): Promise<LLMResponse> {
    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let aggregatedContent = '';
    let aggregatedThinking = '';
    let aggregatedMessage: Partial<LLMResponse> = { role: 'assistant' };
    let contentWasStreamed = false;

    try {
      while (true) {
        // Check for interruption
        if (this.interrupted) {
          throw new Error('Streaming interrupted by user');
        }

        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const chunkData: any = JSON.parse(line);
            const message = chunkData.message || {};

            // Accumulate content
            const contentChunk = message.content || '';
            if (contentChunk) {
              aggregatedContent += contentChunk;
              aggregatedMessage.content = aggregatedContent;
              contentWasStreamed = true;
            }

            // Accumulate thinking
            const thinkingChunk = message.thinking || '';
            if (thinkingChunk) {
              aggregatedThinking += thinkingChunk;
              aggregatedMessage.thinking = aggregatedThinking;
            }

            // Handle tool calls (replace, not accumulate)
            if (message.tool_calls) {
              aggregatedMessage.tool_calls = message.tool_calls;
            }

            // Check for completion
            if (chunkData.done) {
              break;
            }
          } catch (parseError) {
            // Skip malformed chunks
            console.warn('Failed to parse stream chunk:', parseError);
          }
        }
      }
    } catch (error: any) {
      if (error.message === 'Streaming interrupted by user') {
        this.interrupted = false;
        return {
          role: 'assistant',
          content: aggregatedContent || '[Request interrupted by user]',
          interrupted: true,
          _content_was_streamed: contentWasStreamed,
        };
      }
      throw error;
    }

    // Set streaming flags
    if (contentWasStreamed) {
      aggregatedMessage._content_was_streamed = true;
      aggregatedMessage._should_replace_streaming = true;
    }

    return aggregatedMessage as LLMResponse;
  }

  /**
   * Parse non-streaming response from Ollama
   */
  private parseNonStreamingResponse(data: any): LLMResponse {
    const message = data.message || {};

    const response: LLMResponse = {
      role: 'assistant',
      content: message.content || '',
    };

    if (message.thinking) {
      response.thinking = message.thinking;
    }

    if (message.tool_calls) {
      response.tool_calls = message.tool_calls;
    }

    // Convert legacy function_call to tool_calls
    if (message.function_call && !message.tool_calls) {
      this.convertFunctionCallToToolCalls(response, message.function_call);
    }

    return response;
  }

  /**
   * Convert legacy function_call format to modern tool_calls format
   */
  private convertFunctionCallToToolCalls(response: LLMResponse, functionCall: any): void {
    try {
      const args =
        typeof functionCall.arguments === 'string'
          ? JSON.parse(functionCall.arguments)
          : functionCall.arguments;

      response.tool_calls = [
        {
          id: `function-${Date.now()}`,
          type: 'function',
          function: {
            name: functionCall.name,
            arguments: args,
          },
        },
      ];
    } catch (error) {
      console.warn('Failed to convert function_call to tool_calls:', error);
    }
  }

  /**
   * Normalize and validate tool calls in a message
   */
  private normalizeToolCallsInMessage(message: LLMResponse): ValidationResult {
    const errors: string[] = [];
    const validCalls: any[] = [];

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return { valid: true, errors: [] };
    }

    for (let i = 0; i < message.tool_calls.length; i++) {
      const call = message.tool_calls[i];
      const repairResult = this.repairSingleToolCall(call, i);

      if (repairResult.valid) {
        validCalls.push(repairResult.repaired);
      } else {
        errors.push(...repairResult.errors);
      }
    }

    // Update message with repaired calls
    if (validCalls.length > 0) {
      message.tool_calls = validCalls;
    }

    return {
      valid: errors.length === 0,
      errors,
      partial_repairs: validCalls,
    };
  }

  /**
   * Attempt to repair a single tool call
   */
  private repairSingleToolCall(
    call: any,
    index: number
  ): { valid: boolean; errors: string[]; repaired?: any } {
    const errors: string[] = [];
    const repaired: any = { ...call };

    // Repair missing/invalid ID
    if (!repaired.id || typeof repaired.id !== 'string') {
      repaired.id = `repaired-${Date.now()}-${index}`;
    }

    // Repair missing type
    if (!repaired.type) {
      repaired.type = 'function';
    }

    // Handle flat structure (name/arguments at top level)
    if (repaired.name && !repaired.function) {
      repaired.function = {
        name: repaired.name,
        arguments: repaired.arguments || {},
      };
      delete repaired.name;
      delete repaired.arguments;
    }

    // Validate function object
    if (!repaired.function || typeof repaired.function !== 'object') {
      errors.push(`Tool call ${index}: Missing or invalid function object`);
      return { valid: false, errors };
    }

    // Validate function name
    if (!repaired.function.name || typeof repaired.function.name !== 'string') {
      errors.push(`Tool call ${index}: Missing or invalid function name`);
      return { valid: false, errors };
    }

    // Parse JSON string arguments
    if (typeof repaired.function.arguments === 'string') {
      try {
        repaired.function.arguments = JSON.parse(repaired.function.arguments);
      } catch (error) {
        errors.push(`Tool call ${index}: Invalid JSON in arguments: ${error}`);
        return { valid: false, errors };
      }
    }

    // Ensure arguments is an object
    if (!repaired.function.arguments || typeof repaired.function.arguments !== 'object') {
      repaired.function.arguments = {};
    }

    return { valid: true, errors: [], repaired };
  }

  /**
   * Handle tool call validation retry
   */
  private async handleToolCallValidationRetry(
    result: LLMResponse,
    originalMessages: Message[],
    functions?: FunctionDefinition[],
    _maxRetries: number = 2
  ): Promise<LLMResponse | null> {
    // Build retry conversation with error feedback
    const errorMessage = this.createToolCallErrorMessage(result);

    // Convert tool_calls format from LLMResponse to Message format
    const toolCallsForMessage = result.tool_calls?.map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: JSON.stringify(tc.function.arguments),
      },
    }));

    const retryMessages: Message[] = [
      ...originalMessages,
      {
        role: 'assistant' as const,
        content: result.content || '',
        tool_calls: toolCallsForMessage,
      },
      {
        role: 'user' as const,
        content: errorMessage,
      },
    ];

    // Retry without streaming
    try {
      return await this.send(retryMessages, { functions, stream: false, maxRetries: 0 });
    } catch (error) {
      return null;
    }
  }

  /**
   * Create error message for tool call validation failures
   */
  private createToolCallErrorMessage(result: LLMResponse): string {
    const validationResult = this.normalizeToolCallsInMessage(result);

    let message = 'I encountered errors with your tool calls. Please fix these issues:\n\n';

    validationResult.errors.forEach((error, index) => {
      message += `${index + 1}. ${error}\n`;
    });

    message += '\nPlease ensure your tool calls follow this exact format:\n';
    message += '```json\n';
    message += JSON.stringify(
      {
        id: 'unique-id',
        type: 'function',
        function: {
          name: 'tool_name',
          arguments: {},
        },
      },
      null,
      2
    );
    message += '\n```\n\n';
    message += 'Try your tool calls again with the correct format.';

    return message;
  }

  /**
   * Handle request errors and generate user-friendly responses
   */
  private handleRequestError(error: any, attempts: number): LLMResponse {
    const errorMsg = error.message || String(error);

    let suggestions: string[] = [];

    if (errorMsg.includes('ECONNREFUSED')) {
      suggestions = [
        'Start Ollama service: `ollama serve`',
        'Check if another process is using port 11434',
      ];
    } else if (errorMsg.includes('404')) {
      suggestions = [
        'Check if the model is available: `ollama list`',
        `Pull the model if needed: \`ollama pull ${this._modelName}\``,
      ];
    } else if (errorMsg.includes('timeout')) {
      suggestions = [
        'Try increasing the timeout in configuration',
        'Check your internet connection',
        'Verify Ollama server is running properly',
      ];
    } else if (error instanceof SyntaxError) {
      suggestions = [
        'Try restarting Ollama: `ollama serve`',
        'Check if the model supports function calling',
        'Verify model compatibility with Code Ally',
      ];
    } else {
      suggestions = [
        'Check that Ollama is running: `ollama serve`',
        'Verify Ollama is accessible at the configured endpoint',
        'Check the Ollama logs for errors',
      ];
    }

    return {
      role: 'assistant',
      content: `Error communicating with Ollama after ${attempts} attempt(s): ${errorMsg}\n\nSuggested fixes:\n${suggestions.map(s => `- ${s}`).join('\n')}`,
      error: true,
      suggestions,
    };
  }

  /**
   * Check if error is a network error
   */
  private isNetworkError(error: any): boolean {
    return (
      error.name === 'TypeError' ||
      error.message?.includes('fetch') ||
      error.message?.includes('network') ||
      error.message?.includes('ECONNREFUSED') ||
      error.message?.includes('ETIMEDOUT')
    );
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
