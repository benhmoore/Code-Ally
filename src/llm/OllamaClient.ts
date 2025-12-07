/**
 * OllamaClient - Ollama API implementation with function calling support
 *
 * Handles communication with Ollama's chat API, including:
 * - Streaming and non-streaming responses
 * - Function calling (both legacy and modern formats)
 * - Tool call validation and repair
 * - Infinite retry with capped exponential backoff (network errors, HTTP 500/503, JSON errors, stream timeouts)
 * - Backoff capped at 60 seconds, timeout capped at 10 minutes
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
import { Message, FunctionDefinition, ActivityEventType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { logger } from '../services/Logger.js';
import { API_TIMEOUTS, TIME_UNITS, PERMISSION_MESSAGES, ID_GENERATION, RETRY_CONFIG } from '../config/constants.js';

/**
 * Ollama API payload structure
 */
interface OllamaPayload {
  model: string;
  messages: readonly Message[];
  stream: boolean;
  options: {
    temperature: number;
    num_ctx: number;
    num_predict: number;
    keep_alive?: number;
  };
  tools?: FunctionDefinition[];
  tool_choice?: string;
  reasoning_effort?: string; // For gpt-oss and reasoning models
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
  private _modelName: string; // Not readonly - allows runtime model changes
  private _temperature: number; // Not readonly - allows runtime changes
  private _contextSize: number; // Not readonly - allows runtime changes
  private _maxTokens: number; // Not readonly - allows runtime changes
  private readonly keepAlive?: number;
  private readonly reasoningEffort?: string;
  private readonly apiUrl: string;
  private readonly activityStream?: ActivityStream;

  // Track active requests for cancellation (keyed by request ID)
  private activeRequests: Map<string, AbortController> = new Map();

  private circuitBreakerFailures: number = 0;
  private circuitBreakerOpenUntil: number = 0;

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
    this._modelName = config.modelName || '';
    this._temperature = config.temperature;
    this._contextSize = config.contextSize;
    this._maxTokens = config.maxTokens;
    this.keepAlive = config.keepAlive;
    this.reasoningEffort = config.reasoningEffort;
    this.activityStream = config.activityStream;
    this.apiUrl = `${this._endpoint}/api/chat`;
  }

  get modelName(): string {
    return this._modelName;
  }

  get endpoint(): string {
    return this._endpoint;
  }

  /**
   * Update the model name at runtime
   *
   * @param newModelName - New model to use for subsequent requests
   */
  setModelName(newModelName: string): void {
    logger.debug(`[OLLAMA_CLIENT] Changing model from ${this._modelName} to ${newModelName}`);
    this._modelName = newModelName;
  }

  /**
   * Update the temperature at runtime
   *
   * @param newTemperature - New temperature value (0.0-2.0)
   */
  setTemperature(newTemperature: number): void {
    logger.debug(`[OLLAMA_CLIENT] Changing temperature from ${this._temperature} to ${newTemperature}`);
    this._temperature = newTemperature;
  }

  /**
   * Update the context size at runtime
   *
   * @param newContextSize - New context window size in tokens
   */
  setContextSize(newContextSize: number): void {
    logger.debug(`[OLLAMA_CLIENT] Changing context size from ${this._contextSize} to ${newContextSize}`);
    this._contextSize = newContextSize;
  }

  /**
   * Update the max tokens at runtime
   *
   * @param newMaxTokens - New maximum tokens to generate
   */
  setMaxTokens(newMaxTokens: number): void {
    logger.debug(`[OLLAMA_CLIENT] Changing max tokens from ${this._maxTokens} to ${newMaxTokens}`);
    this._maxTokens = newMaxTokens;
  }

  /**
   * Cancel all ongoing requests
   */
  cancel(): void {
    logger.debug('[OLLAMA_CLIENT] Cancelling', this.activeRequests.size, 'active requests');
    for (const [requestId, controller] of this.activeRequests.entries()) {
      logger.debug('[OLLAMA_CLIENT] Aborting request:', requestId);
      controller.abort();
    }
    this.activeRequests.clear();
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
   * Implements infinite retry logic with capped exponential backoff for network/HTTP/timeout/stream timeout errors.
   * Backoff is capped at 60 seconds and timeout growth is capped at 10 minutes.
   * Tool call validation is performed on all responses.
   *
   * @param messages - Conversation history
   * @param options - Send options
   * @returns Promise resolving to the LLM's response
   */
  async send(messages: readonly Message[], options: SendOptions = {}): Promise<LLMResponse> {
    const { functions, stream = false, maxRetries: _maxRetries = 3, temperature, parentId, suppressThinking = false, dynamicMaxTokens } = options;

    // Generate unique request ID for this request
    // Generate request ID: req-{timestamp}-{7-char-random} (base-36, skip '0.' prefix)
    const requestId = `req-${Date.now()}-${Math.random().toString(ID_GENERATION.RANDOM_STRING_RADIX).substring(ID_GENERATION.RANDOM_STRING_SUBSTRING_START, ID_GENERATION.RANDOM_STRING_SUBSTRING_START + ID_GENERATION.RANDOM_STRING_LENGTH_LONG)}`;
    logger.debug('[OLLAMA_CLIENT] Starting request:', requestId);

    // Reset circuit breaker at the start of each new request
    // This ensures each user request gets a fresh start, while the circuit breaker
    // still protects against persistent failures during retries within this request
    this.circuitBreakerFailures = 0;
    this.circuitBreakerOpenUntil = 0;

    // Prepare payload
    const payload = this.preparePayload(messages, functions, stream, temperature, dynamicMaxTokens);

    try {
      // Infinite retry loop with capped exponential backoff
      let attempt = 0;
      const startTime = Date.now();

      while (true) {
        // Check circuit breaker
        if (Date.now() < this.circuitBreakerOpenUntil) {
          logger.error('[OLLAMA_CLIENT] Circuit breaker open - Ollama appears to be persistently failing');
          return this.handleRequestError(new Error('Circuit breaker open - retries paused'));
        }

        // Check total time budget
        if (Date.now() - startTime > RETRY_CONFIG.MAX_TOTAL_REQUEST_TIME) {
          logger.error('[OLLAMA_CLIENT] Maximum retry time exceeded (30 minutes)');
          return this.handleRequestError(new Error('Request timeout after 30 minutes'));
        }

        try {
          // Execute request with cancellation support
          const result = await this.executeRequestWithCancellation(requestId, payload, stream, attempt, parentId, suppressThinking);

          // Validate and repair tool calls (ALL responses, not just non-streaming)
          if (result.tool_calls && result.tool_calls.length > 0) {
            const validationResult = this.normalizeToolCallsInMessage(result);

            // GAP 3: Return validation error response for Agent-level continuation
            // Instead of retrying the entire request, return error response with malformed tool calls
            // This allows Agent to add the assistant's response to history and request continuation
            if (!validationResult.valid) {
              logger.warn(
                `[OLLAMA_CLIENT] Tool call validation failed in ${stream ? 'streaming' : 'non-streaming'} response, ` +
                `returning error for Agent-level continuation...`
              );
              logger.debug('[OLLAMA_CLIENT] Validation errors:', validationResult.errors);

              // Return error response with malformed tool calls and validation errors
              return {
                role: 'assistant',
                content: result.content || '',
                tool_calls: result.tool_calls, // Include malformed calls
                error: true,
                tool_call_validation_failed: true,
                validation_errors: validationResult.errors,
              };
            }
          }

          // Validation passed or no tool calls - reset circuit breaker and return result
          this.circuitBreakerFailures = 0;
          return result;
        } catch (error: any) {
          // Handle abort/interruption
          if (error.name === 'AbortError') {
            logger.debug('[OLLAMA_CLIENT] Request aborted:', requestId);
            return {
              role: 'assistant',
              content: '', // Empty content - don't pollute conversation history
              interrupted: true,
            };
          }

          // Retry on network errors with capped exponential backoff
          if (this.isNetworkError(error)) {
            const circuitError = this.incrementCircuitBreakerFailure();
            if (circuitError) {
              return this.handleRequestError(circuitError);
            }

            const backoffSeconds = Math.min(Math.pow(2, attempt), RETRY_CONFIG.MAX_BACKOFF_SECONDS);
            logger.debug(`[OLLAMA_CLIENT] Network error on request ${requestId}, retrying in ${backoffSeconds}s...`);
            await this.sleep(backoffSeconds * TIME_UNITS.MS_PER_SECOND);
            attempt++;
            continue;
          }

          // Retry on HTTP 500/503 errors with capped exponential backoff
          // These are often transient errors (malformed tool calls, internal server errors)
          if (this.isRetryableHttpError(error)) {
            const circuitError = this.incrementCircuitBreakerFailure();
            if (circuitError) {
              return this.handleRequestError(circuitError);
            }

            const backoffSeconds = Math.min(Math.pow(2, attempt), RETRY_CONFIG.MAX_BACKOFF_SECONDS);
            logger.debug(`[OLLAMA_CLIENT] HTTP ${error.httpStatus} error on request ${requestId}, retrying in ${backoffSeconds}s...`);
            await this.sleep(backoffSeconds * TIME_UNITS.MS_PER_SECOND);
            attempt++;
            continue;
          }

          // Retry on JSON errors with capped linear backoff
          if (error instanceof SyntaxError) {
            const circuitError = this.incrementCircuitBreakerFailure();
            if (circuitError) {
              return this.handleRequestError(circuitError);
            }

            const backoffSeconds = Math.min(1 + attempt, RETRY_CONFIG.MAX_BACKOFF_SECONDS);
            logger.debug(`[OLLAMA_CLIENT] JSON parse error on request ${requestId}, retrying in ${backoffSeconds}s...`);
            await this.sleep(backoffSeconds * TIME_UNITS.MS_PER_SECOND);
            attempt++;
            continue;
          }

          // PHASE 3: Retry on stream timeout with capped exponential backoff
          // Stream timeouts occur when streaming starts but hangs without closing
          if (error.message?.includes('Stream read timeout')) {
            const circuitError = this.incrementCircuitBreakerFailure();
            if (circuitError) {
              return this.handleRequestError(circuitError);
            }

            const backoffSeconds = Math.min(Math.pow(2, attempt), RETRY_CONFIG.MAX_BACKOFF_SECONDS);
            logger.debug(`[OLLAMA_CLIENT] Stream timeout on request ${requestId}, retrying in ${backoffSeconds}s (attempt ${attempt + 1})...`);
            await this.sleep(backoffSeconds * TIME_UNITS.MS_PER_SECOND);
            attempt++;
            continue;
          }

          // Non-retryable error - return error response
          logger.debug(`[OLLAMA_CLIENT] Non-retryable error on request ${requestId}`);

          // Check if this is an image-related error
          const errorMsg = error.message || String(error);
          const isImageError = errorMsg.includes('Cannot decode or download image') ||
                               errorMsg.includes('image') && (error.httpStatus === 400 || error.httpStatus === 415);

          const errorResponse = this.handleRequestError(error);

          // If image error, mark response to trigger image stripping from history
          if (isImageError) {
            logger.debug('[OLLAMA_CLIENT] Image-related error detected - marking for image removal from history');
            (errorResponse as any).shouldStripImages = true;
          }

          return errorResponse;
        }
      }
    } finally {
      // Always clean up request tracking
      logger.debug('[OLLAMA_CLIENT] Cleaning up request:', requestId);
      this.activeRequests.delete(requestId);
    }
  }

  /**
   * Prepare the Ollama API payload
   */
  private preparePayload(
    messages: readonly Message[],
    functions?: FunctionDefinition[],
    stream: boolean = false,
    temperature?: number,
    dynamicMaxTokens?: number
  ): OllamaPayload {
    const payload: OllamaPayload = {
      model: this._modelName,
      messages,
      stream,
      options: {
        temperature: temperature !== undefined ? temperature : this._temperature,
        num_ctx: this._contextSize,
        num_predict: dynamicMaxTokens ?? this._maxTokens,
      },
    };

    if (this.keepAlive !== undefined) {
      payload.options.keep_alive = this.keepAlive;
    }

    // Add reasoning_effort if configured (for gpt-oss and reasoning models)
    if (this.reasoningEffort) {
      payload.reasoning_effort = this.reasoningEffort;
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
    requestId: string,
    payload: OllamaPayload,
    stream: boolean,
    attempt: number,
    parentId?: string,
    suppressThinking?: boolean
  ): Promise<LLMResponse> {
    // Create abort controller for this request
    const abortController = new AbortController();
    this.activeRequests.set(requestId, abortController);

    try {
      // Calculate adaptive timeout with cap at 10 minutes
      const timeout = Math.min(
        API_TIMEOUTS.LLM_REQUEST_BASE + attempt * API_TIMEOUTS.LLM_REQUEST_RETRY_INCREMENT,
        RETRY_CONFIG.MAX_LLM_TIMEOUT
      );

      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          abortController.abort();
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
        signal: abortController.signal,
      });

      // Race timeout and fetch
      const response = await Promise.race([fetchPromise, timeoutPromise]);

      // Check response status
      if (!response.ok) {
        const errorText = await response.text();
        // Create error with status code attached for retry logic
        const error: any = new Error(`HTTP ${response.status}: ${errorText}`);
        error.httpStatus = response.status;
        throw error;
      }

      // Process response
      if (stream) {
        return await this.processStreamingResponse(requestId, response, abortController, parentId, suppressThinking);
      } else {
        // Non-streaming mode - parse response
        // GAP 2: For non-streaming, the entire response arrives at once, so HTTP errors
        // happen before we get any data. However, we still wrap in try-catch to maintain
        // consistency with streaming error handling.
        const data = await response.json();
        return this.parseNonStreamingResponse(data, requestId, parentId, suppressThinking);
      }
    } catch (error) {
      // Re-throw to be handled by send()
      throw error;
    }
  }

  /**
   * Process streaming response from Ollama
   */
  private async processStreamingResponse(
    requestId: string,
    response: Response,
    abortController: AbortController,
    parentId?: string,
    suppressThinking?: boolean
  ): Promise<LLMResponse> {
    if (!response.body) {
      throw new Error('Response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let aggregatedContent = '';
    let aggregatedThinking = '';
    let aggregatedMessage: Partial<LLMResponse> = { role: 'assistant' };
    let contentWasStreamed = false;
    let hadThinking = false; // Track if we've seen thinking chunks
    let thinkingComplete = false; // Track if thinking block completed
    let streamTimedOut = false; // Track if stream timeout occurred

    // Line buffer to handle JSON objects that span multiple network chunks
    // Network chunks are determined by TCP packet sizes (~1500 bytes MTU), not JSON boundaries
    // A large JSON object (e.g., tool call with code) can span multiple packets
    let lineBuffer = '';

    try {
      while (true) {
        // Check for interruption via abort signal
        if (abortController.signal.aborted) {
          throw new Error('Streaming interrupted by user');
        }

        // Add timeout protection for stream reads
        // Ollama can start streaming but then hang without closing the stream
        const readTimeout = API_TIMEOUTS.LLM_REQUEST_BASE;
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error('Stream read timeout - no data received'));
          }, readTimeout);
        });

        const readPromise = reader.read();
        const { done, value } = await Promise.race([readPromise, timeoutPromise]);
        if (done) break;

        // Decode the chunk and prepend any buffered incomplete line from previous iteration
        const chunk = decoder.decode(value, { stream: true });
        lineBuffer += chunk;

        // Split by newline - Ollama sends one JSON object per line (NDJSON format)
        const lines = lineBuffer.split('\n');

        // The last element may be incomplete (no trailing newline yet)
        // Keep it in the buffer for the next iteration
        lineBuffer = lines.pop() || '';

        for (const line of lines) {
          // Skip empty lines
          if (!line.trim()) continue;

          try {
            const chunkData: any = JSON.parse(line);
            const message = chunkData.message || {};

            // Accumulate content
            const contentChunk = message.content || '';
            if (contentChunk) {
              aggregatedContent += contentChunk;
              aggregatedMessage.content = aggregatedContent;
              contentWasStreamed = true;

              // Emit assistant content chunk event for UI streaming
              if (this.activityStream) {
                this.activityStream.emit({
                  id: `assistant-${requestId}-${Date.now()}`,
                  type: ActivityEventType.ASSISTANT_CHUNK,
                  timestamp: Date.now(),
                  data: { chunk: contentChunk },
                });
              }
            }

            // Accumulate thinking
            const thinkingChunk = message.thinking || '';
            if (thinkingChunk) {
              hadThinking = true;
              aggregatedThinking += thinkingChunk;
              aggregatedMessage.thinking = aggregatedThinking;

              // Emit thinking chunk event for UI streaming
              if (this.activityStream) {
                this.activityStream.emit({
                  id: `thinking-${requestId}-${Date.now()}`,
                  type: ActivityEventType.THOUGHT_CHUNK,
                  timestamp: Date.now(),
                  data: { chunk: thinkingChunk },
                });
              }
            } else if (hadThinking && !thinkingComplete) {
              // First chunk without thinking after having thinking = thinking block complete
              thinkingComplete = true;

              // Log complete thinking for debugging
              logger.debug('[THINKING-COMPLETE]', `(${aggregatedThinking.length} chars)\n${aggregatedThinking}`);

              // Only emit if thinking display is not suppressed
              if (this.activityStream && aggregatedThinking && !suppressThinking) {
                this.activityStream.emit({
                  id: `thinking-complete-${requestId}`,
                  type: ActivityEventType.THOUGHT_COMPLETE,
                  timestamp: Date.now(),
                  parentId: parentId, // Associate thinking with agent/tool call
                  data: { thinking: aggregatedThinking },
                });
              }
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
            // Log parse error with context for debugging
            // This should now be rare since we properly buffer incomplete lines
            logger.warn('Failed to parse stream chunk:', parseError);
            logger.debug('[OLLAMA_CLIENT] Malformed line content:', line.substring(0, 200));
          }
        }
      }

      // Process any remaining content in the lineBuffer after stream ends
      // This handles the case where the final JSON object didn't end with a newline
      if (lineBuffer.trim()) {
        try {
          const chunkData: any = JSON.parse(lineBuffer);
          const message = chunkData.message || {};

          // Process final content chunk
          const contentChunk = message.content || '';
          if (contentChunk) {
            aggregatedContent += contentChunk;
            aggregatedMessage.content = aggregatedContent;
            contentWasStreamed = true;

            if (this.activityStream) {
              this.activityStream.emit({
                id: `assistant-${requestId}-${Date.now()}`,
                type: ActivityEventType.ASSISTANT_CHUNK,
                timestamp: Date.now(),
                data: { chunk: contentChunk },
              });
            }
          }

          // Process final thinking chunk
          const thinkingChunk = message.thinking || '';
          if (thinkingChunk) {
            hadThinking = true;
            aggregatedThinking += thinkingChunk;
            aggregatedMessage.thinking = aggregatedThinking;
          }

          // Process final tool calls
          if (message.tool_calls) {
            aggregatedMessage.tool_calls = message.tool_calls;
          }
        } catch (parseError) {
          // Final buffer wasn't valid JSON - log for debugging
          logger.warn('[OLLAMA_CLIENT] Failed to parse final buffer content:', parseError);
          logger.debug('[OLLAMA_CLIENT] Final buffer content:', lineBuffer.substring(0, 200));
        }
      }
    } catch (error: any) {
      if (error.message === 'Streaming interrupted by user') {
        logger.debug('[OLLAMA_CLIENT] Streaming interrupted for request:', requestId);
        return {
          role: 'assistant',
          content: aggregatedContent || PERMISSION_MESSAGES.USER_FACING_INTERRUPTION,
          interrupted: true,
          _content_was_streamed: contentWasStreamed,
        };
      }
      if (error.message === 'Stream read timeout - no data received') {
        // PHASE 3: Stream timeout retry - mark for retry instead of returning error
        logger.warn('[OLLAMA_CLIENT] Stream read timeout on request', requestId);
        logger.debug('[OLLAMA_CLIENT] Partial content before timeout:', aggregatedContent.length, 'chars');
        streamTimedOut = true;
        // Don't return here - let it fall through to retry logic below
      } else {
        // GAP 2: HTTP errors during streaming - check if we have partial response
        // If we received any content or tool calls before the error, return partial response
        const hasPartialResponse = aggregatedContent.trim().length > 0 || (aggregatedMessage.tool_calls && aggregatedMessage.tool_calls.length > 0);

        if (hasPartialResponse) {
          logger.debug('[OLLAMA_CLIENT] HTTP error during streaming with partial response - returning partial data');
          logger.debug('[OLLAMA_CLIENT] Partial content length:', aggregatedContent.length, 'Tool calls:', aggregatedMessage.tool_calls?.length || 0);

          return {
            role: 'assistant',
            content: aggregatedContent,
            tool_calls: aggregatedMessage.tool_calls,
            thinking: aggregatedThinking || undefined,
            error: true,
            partial: true,
            error_message: `Response interrupted: ${error.message}`,
            _content_was_streamed: contentWasStreamed,
          } as LLMResponse;
        }

        // No partial response - re-throw for full retry
        throw error;
      }
    }

    // PHASE 3: If stream timed out, throw error to trigger retry
    if (streamTimedOut) {
      // Throw a retryable error that will be caught by send() retry loop
      throw new Error('Stream read timeout - retrying request');
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
  private parseNonStreamingResponse(data: any, requestId: string, parentId?: string, suppressThinking?: boolean): LLMResponse {
    const message = data.message || {};

    const response: LLMResponse = {
      role: 'assistant',
      content: message.content || '',
    };

    if (message.thinking) {
      response.thinking = message.thinking;

      // Log thinking for non-streaming responses
      logger.debug('[THINKING-COMPLETE-NONSTREAM]', `(${message.thinking.length} chars)\n${message.thinking}`);

      // Emit THOUGHT_COMPLETE event for non-streaming responses
      // Only emit if thinking display is not suppressed
      if (this.activityStream && !suppressThinking) {
        this.activityStream.emit({
          id: `thinking-complete-${requestId}`,
          type: ActivityEventType.THOUGHT_COMPLETE,
          timestamp: Date.now(),
          parentId: parentId, // Associate thinking with agent/tool call
          data: { thinking: message.thinking },
        });
      }
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
      logger.warn('Failed to convert function_call to tool_calls:', error);
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
   * Increments circuit breaker failure counter and opens circuit if threshold exceeded.
   * @returns Error to return if circuit breaker opened, null otherwise
   */
  private incrementCircuitBreakerFailure(): Error | null {
    this.circuitBreakerFailures++;
    if (this.circuitBreakerFailures >= RETRY_CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
      this.circuitBreakerOpenUntil = Date.now() + RETRY_CONFIG.CIRCUIT_BREAKER_COOLDOWN;
      logger.warn(
        `[OLLAMA_CLIENT] Circuit breaker opened after ${RETRY_CONFIG.CIRCUIT_BREAKER_THRESHOLD} consecutive failures`
      );
      return new Error('Too many consecutive failures');
    }
    return null;
  }

  /**
   * Handle request errors and generate user-friendly responses
   */
  private handleRequestError(error: any): LLMResponse {
    const errorMsg = error.message || String(error);
    logger.debug('[OLLAMA_CLIENT] handleRequestError called');
    logger.debug('[OLLAMA_CLIENT] Error message:', errorMsg);
    logger.debug('[OLLAMA_CLIENT] Error type:', error.constructor.name);
    logger.debug('[OLLAMA_CLIENT] HTTP status:', error.httpStatus);

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

    const errorContent = `Error communicating with Ollama: ${errorMsg}\n\nSuggested fixes:\n${suggestions.map(s => `- ${s}`).join('\n')}`;
    logger.debug('[OLLAMA_CLIENT] Error response content length:', errorContent.length);
    logger.debug('[OLLAMA_CLIENT] Error response preview:', errorContent.substring(0, 150));

    return {
      role: 'assistant',
      content: errorContent,
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
   * Check if error is a retryable HTTP error (500/503)
   *
   * HTTP 500 (Internal Server Error): Often caused by malformed tool calls or model errors
   * HTTP 503 (Service Unavailable): Temporary server overload or maintenance
   *
   * Both are typically transient and may succeed on retry
   */
  private isRetryableHttpError(error: any): boolean {
    return error.httpStatus === 500 || error.httpStatus === 503;
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
