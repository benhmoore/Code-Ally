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
  SamplingParams,
} from './ModelClient.js';
import { Message, FunctionDefinition, ActivityEventType } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { logger } from '../services/Logger.js';
import { API_TIMEOUTS, PERMISSION_MESSAGES, ID_GENERATION, RETRY_CONFIG } from '../config/constants.js';
import { resolveModelProfile } from './modelProfile.js';
import { buildRequestHeaders } from './requestHeaders.js';
import { CircuitBreaker, runWithRetries } from './httpTransport.js';

/**
 * Ollama API payload structure
 */
interface OllamaPayload {
  model: string;
  messages: readonly Message[];
  stream: boolean;
  /**
   * Model unload timing. Ollama reads keep_alive as a TOP-LEVEL field of
   * /api/chat — placing it under `options` (as earlier versions did) silently
   * has no effect.
   */
  keep_alive?: number;
  options: {
    temperature: number;
    num_ctx: number;
    num_predict: number;
    top_p?: number;
    top_k?: number;
    min_p?: number;
    repeat_penalty?: number;
    stop?: string[];
  };
  tools?: FunctionDefinition[];
  tool_choice?: string;
  /** OpenAI-style reasoning knob — gpt-oss family only. */
  reasoning_effort?: string;
  /** Ollama's generic reasoning toggle — GLM/DeepSeek-R1/QwQ/etc. */
  think?: boolean;
}

/**
 * Validation result for tool calls
 */
interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Extract server-reported token usage from an Ollama chunk/response, if present.
 * Ollama puts prompt_eval_count / eval_count on the final (done) object.
 */
function extractOllamaUsage(obj: any): LLMResponse['usage'] | undefined {
  if (!obj) return undefined;
  const promptTokens = typeof obj.prompt_eval_count === 'number' ? obj.prompt_eval_count : undefined;
  const completionTokens = typeof obj.eval_count === 'number' ? obj.eval_count : undefined;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return { promptTokens, completionTokens };
}

export class OllamaClient extends ModelClient {
  private _endpoint: string;
  private _modelName: string; // Not readonly - allows runtime model changes
  private _temperature: number; // Not readonly - allows runtime changes
  private _contextSize: number; // Not readonly - allows runtime changes
  private _maxTokens: number; // Not readonly - allows runtime changes
  private _reasoningEffort?: string; // Not readonly - allows runtime changes
  private readonly keepAlive?: number;
  private readonly sampling?: SamplingParams;
  private readonly requestHeaders: Record<string, string>;
  private apiUrl: string;
  private readonly activityStream?: ActivityStream;

  // Track active requests for cancellation (keyed by request ID)
  private activeRequests: Map<string, AbortController> = new Map();

  private readonly breaker = new CircuitBreaker();

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
    this._reasoningEffort = config.reasoningEffort;
    this.keepAlive = config.keepAlive;
    this.sampling = config.sampling;
    this.requestHeaders = buildRequestHeaders({ apiKey: config.apiKey, headers: config.headers });
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
   * Update the API endpoint URL at runtime
   *
   * @param newEndpoint - New Ollama API endpoint
   */
  setEndpoint(newEndpoint: string): void {
    logger.debug(`[OLLAMA_CLIENT] Changing endpoint from ${this._endpoint} to ${newEndpoint}`);
    this._endpoint = newEndpoint;
    this.apiUrl = `${this._endpoint}/api/chat`;
    this.breaker.reset();
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
   * Update the reasoning effort at runtime
   *
   * @param newReasoningEffort - New reasoning effort level (e.g., 'low', 'medium', 'high')
   */
  setReasoningEffort(newReasoningEffort: string | undefined): void {
    logger.debug(`[OLLAMA_CLIENT] Changing reasoning effort from ${this._reasoningEffort} to ${newReasoningEffort}`);
    this._reasoningEffort = newReasoningEffort;
  }

  /**
   * Close the client and cleanup resources.
   *
   * Shutdown only: aborts whatever is still in flight as the client is torn down.
   * This is NOT per-request cancellation — callers cancel their own request by
   * aborting the `signal` they passed to send().
   */
  async close(): Promise<void> {
    logger.debug('[OLLAMA_CLIENT] Closing, aborting', this.activeRequests.size, 'in-flight requests');
    for (const [requestId, controller] of this.activeRequests.entries()) {
      logger.debug('[OLLAMA_CLIENT] Aborting request:', requestId);
      controller.abort();
    }
    this.activeRequests.clear();
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
  async send(messages: readonly Message[], options: SendOptions): Promise<LLMResponse> {
    const { functions, stream = false, temperature, parentId, suppressThinking = false, dynamicMaxTokens, signal } = options;

    // Per-request stream override: a sub-agent supplies its scoped stream so its
    // thinking/assistant events route to its own stream instead of the shared root.
    const eventStream: ActivityStream | undefined = options.activityStream ?? this.activityStream;

    // Generate unique request ID for this request
    // Generate request ID: req-{timestamp}-{7-char-random} (base-36, skip '0.' prefix)
    const requestId = `req-${Date.now()}-${Math.random().toString(ID_GENERATION.RANDOM_STRING_RADIX).substring(ID_GENERATION.RANDOM_STRING_SUBSTRING_START, ID_GENERATION.RANDOM_STRING_SUBSTRING_START + ID_GENERATION.RANDOM_STRING_LENGTH_LONG)}`;
    logger.debug('[OLLAMA_CLIENT] Starting request:', requestId);

    // Prepare payload
    const payload = this.preparePayload(messages, functions, stream, temperature, dynamicMaxTokens);

    try {
      // Shared retry policy (capped backoff + circuit breaker + time budget).
      // The per-attempt work below is Ollama-specific; the loop is not.
      return await runWithRetries<LLMResponse>({
        breaker: this.breaker,
        onRetry: (label, delaySec, attemptNum) => {
          logger.debug(`[OLLAMA_CLIENT] ${label} on request ${requestId}, retrying in ${delaySec}s (attempt ${attemptNum})...`);
          this.emitStatusMessage(`${label}, retrying in ${delaySec}s...`);
        },
        onInterrupted: () => {
          logger.debug('[OLLAMA_CLIENT] Request aborted:', requestId);
          return {
            role: 'assistant',
            content: '', // Empty content - don't pollute conversation history
            interrupted: true,
          };
        },
        onError: (error: any) => {
          logger.debug(`[OLLAMA_CLIENT] Non-retryable error on request ${requestId}`);
          // Check if this is an image-related error
          const errorMsg = error.message || String(error);
          const isImageError = errorMsg.includes('Cannot decode or download image') ||
                               errorMsg.includes('image') && (error.httpStatus === 400 || error.httpStatus === 415);
          const errorResponse = this.handleRequestError(error);
          if (isImageError) {
            logger.debug('[OLLAMA_CLIENT] Image-related error detected - marking for image removal from history');
            (errorResponse as any).shouldStripImages = true;
          }
          return errorResponse;
        },
        attempt: async (attempt) => {
          // Execute request with cancellation support
          const result = await this.executeRequestWithCancellation(requestId, payload, stream, attempt, signal, parentId, suppressThinking, eventStream);

          // Validate and repair tool calls (ALL responses, not just non-streaming)
          if (result.tool_calls && result.tool_calls.length > 0) {
            const validationResult = this.normalizeToolCallsInMessage(result);

            // Return a validation-error response for Agent-level continuation rather
            // than retrying the whole request. This is a terminal (non-retried)
            // outcome, so it is returned from attempt() — not thrown.
            if (!validationResult.valid) {
              logger.warn(
                `[OLLAMA_CLIENT] Tool call validation failed in ${stream ? 'streaming' : 'non-streaming'} response, ` +
                `returning error for Agent-level continuation...`
              );
              logger.debug('[OLLAMA_CLIENT] Validation errors:', validationResult.errors);

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

          return result;
        },
      });
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

    // Apply explicit sampling overrides. Only set fields are copied through, so
    // an unset field preserves the model's own Modelfile default.
    if (this.sampling) {
      const { top_p, top_k, min_p, repeat_penalty, stop } = this.sampling;
      if (top_p !== undefined) payload.options.top_p = top_p;
      if (top_k !== undefined) payload.options.top_k = top_k;
      if (min_p !== undefined) payload.options.min_p = min_p;
      if (repeat_penalty !== undefined) payload.options.repeat_penalty = repeat_penalty;
      if (stop !== undefined && stop.length > 0) payload.options.stop = stop;
    }

    // keep_alive is a TOP-LEVEL field of /api/chat (Ollama ignores it under options).
    if (this.keepAlive !== undefined) {
      payload.keep_alive = this.keepAlive;
    }

    // Reasoning control is family-specific: gpt-oss uses `reasoning_effort`,
    // the GLM/DeepSeek-R1/QwQ family uses the generic `think` boolean, and
    // non-reasoning models get neither (sending either is at best ignored and
    // at worst rejected by the backend).
    const profile = resolveModelProfile(this._modelName);
    if (profile.reasoningControl === 'reasoning_effort') {
      if (this._reasoningEffort) {
        payload.reasoning_effort = this._reasoningEffort;
      }
    } else if (profile.reasoningControl === 'think') {
      payload.think = true;
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
    callerSignal: AbortSignal,
    parentId?: string,
    suppressThinking?: boolean,
    eventStream?: ActivityStream
  ): Promise<LLMResponse> {
    // Per-request abort controller. The caller's signal is the OWNER of this
    // request: when the owning agent interrupts, only its requests abort. We keep
    // an internal controller so we can also abort for the time-to-response timeout
    // (a retryable condition) and distinguish the two reasons downstream.
    const abortController = new AbortController();
    this.activeRequests.set(requestId, abortController);

    if (callerSignal.aborted) {
      abortController.abort();
    }
    const onCallerAbort = () => abortController.abort();
    callerSignal.addEventListener('abort', onCallerAbort, { once: true });

    // Calculate adaptive timeout with cap at 10 minutes
    const timeout = Math.min(
      API_TIMEOUTS.LLM_REQUEST_BASE + attempt * API_TIMEOUTS.LLM_REQUEST_RETRY_INCREMENT,
      RETRY_CONFIG.MAX_LLM_TIMEOUT
    );

    // This timer bounds TIME-TO-RESPONSE-HEADERS only. It MUST be cleared once the
    // fetch resolves; otherwise it later fires mid-stream and aborts a perfectly
    // healthy in-progress response. Stream stalls after headers are handled
    // separately by the per-read timeout inside processStreamingResponse.
    let responseTimedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        responseTimedOut = true;
        abortController.abort();
        reject(new Error('Request timeout'));
      }, timeout);
    });

    try {
      // Create fetch promise
      const fetchPromise = fetch(this.apiUrl, {
        method: 'POST',
        headers: this.requestHeaders,
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });

      // Race timeout and fetch
      const response = await Promise.race([fetchPromise, timeoutPromise]);

      // Headers received within budget — stop the time-to-response timer so it can
      // never abort the stream that follows.
      clearTimeout(timeoutHandle);

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
        return await this.processStreamingResponse(requestId, response, abortController, callerSignal, parentId, suppressThinking, eventStream);
      } else {
        // Non-streaming mode - parse response
        // GAP 2: For non-streaming, the entire response arrives at once, so HTTP errors
        // happen before we get any data. However, we still wrap in try-catch to maintain
        // consistency with streaming error handling.
        let data;
        try {
          data = await response.json();
        } catch (parseError) {
          logger.debug(`[OllamaClient] Failed to parse non-streaming response JSON:`, parseError);
          throw parseError;
        }
        return this.parseNonStreamingResponse(data, requestId, parentId, suppressThinking, eventStream);
      }
    } catch (error: any) {
      // A timeout aborts the internal controller and surfaces here as an AbortError
      // (the fetch reacting to abort) rather than the explicit 'Request timeout'.
      // Normalize it to the retryable timeout error so it is not misread as an
      // owner-initiated interruption.
      if (responseTimedOut && error?.name === 'AbortError') {
        throw new Error('Request timeout');
      }
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  }

  /**
   * Process streaming response from Ollama
   */
  private async processStreamingResponse(
    requestId: string,
    response: Response,
    abortController: AbortController,
    callerSignal: AbortSignal,
    parentId?: string,
    suppressThinking?: boolean,
    eventStream: ActivityStream | undefined = this.activityStream
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
        // Check for interruption via abort signal. Distinguish WHY we aborted:
        // an owner-initiated abort (the agent interrupting) is a real interruption;
        // any other internal abort is treated as a retryable stream timeout rather
        // than being mislabeled as a user interruption.
        if (abortController.signal.aborted) {
          if (callerSignal.aborted) {
            throw new Error('Streaming interrupted by user');
          }
          throw new Error('Stream read timeout - no data received');
        }

        // Add timeout protection for stream reads
        // Ollama can start streaming but then hang without closing the stream
        const readTimeout = API_TIMEOUTS.LLM_REQUEST_BASE;
        let readTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          readTimeoutHandle = setTimeout(() => {
            reject(new Error('Stream read timeout - no data received'));
          }, readTimeout);
        });

        const readPromise = reader.read();
        let done: boolean, value: Uint8Array | undefined;
        try {
          ({ done, value } = await Promise.race([readPromise, timeoutPromise]));
        } finally {
          // Clear the per-read timer so a settled read never leaves a dangling
          // timer that rejects (and aborts) a later, healthy iteration.
          clearTimeout(readTimeoutHandle);
        }
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
              if (eventStream) {
                eventStream.emit({
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
              if (eventStream) {
                eventStream.emit({
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
              if (eventStream && aggregatedThinking && !suppressThinking) {
                eventStream.emit({
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
              const usage = extractOllamaUsage(chunkData);
              if (usage) aggregatedMessage.usage = usage;
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

            if (eventStream) {
              eventStream.emit({
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

          // Capture server-reported token usage from the final chunk
          const usage = extractOllamaUsage(chunkData);
          if (usage) aggregatedMessage.usage = usage;
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
  private parseNonStreamingResponse(data: any, requestId: string, parentId?: string, suppressThinking?: boolean, eventStream: ActivityStream | undefined = this.activityStream): LLMResponse {
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
      if (eventStream && !suppressThinking) {
        eventStream.emit({
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

    const usage = extractOllamaUsage(data);
    if (usage) response.usage = usage;

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

    // ALWAYS generate a unique ID to prevent duplicates from LLM
    // LLMs don't maintain state across responses and can reuse IDs (e.g., functions.glob:4)
    // Using timestamp + random suffix ensures uniqueness across the entire session
    const random = Math.random().toString(36).substring(2, 9);
    repaired.id = `call-${Date.now()}-${index}-${random}`;

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
   * Emit a status message for user-visible connection events
   */
  private emitStatusMessage(message: string): void {
    if (this.activityStream) {
      this.activityStream.emit({
        id: `status-${Date.now()}`,
        type: ActivityEventType.STATUS_MESSAGE,
        timestamp: Date.now(),
        data: { message },
      });
    }
  }
}
