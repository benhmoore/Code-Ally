/**
 * ModelClient - Abstract interface for LLM providers
 *
 * Defines the contract that all LLM backend implementations must follow.
 * Supports both streaming and non-streaming modes, function calling, and cancellation.
 *
 * @example
 * ```typescript
 * const client = new OllamaClient({ endpoint: 'http://localhost:11434' });
 * const response = await client.send(messages, { functions, stream: true });
 * ```
 */

import { Message, FunctionDefinition } from '../types/index.js';

/**
 * Options for sending messages to the LLM
 */
export interface SendOptions {
  /** Function definitions for tool calling */
  functions?: FunctionDefinition[];
  /** Enable streaming responses */
  stream?: boolean;
  /** Maximum number of retry attempts */
  maxRetries?: number;
  /** Temperature for response generation (0.0 to 2.0, higher = more creative) */
  temperature?: number;
  /** Parent call ID for associating events with specific agents/tool calls */
  parentId?: string;
  /** Suppress thinking display (for background services like title generation) */
  suppressThinking?: boolean;
  /**
   * Dynamic max tokens calculated from remaining context.
   * When provided, overrides the client's static maxTokens for this request.
   * Calculated as: floor((contextSize - inputTokens) * 0.9)
   */
  dynamicMaxTokens?: number;
}

/**
 * Response from the LLM
 */
export interface LLMResponse {
  /** Always 'assistant' for model responses */
  role: 'assistant';
  /** Text content of the response */
  content: string;
  /** Tool calls requested by the model */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: Record<string, any>;
    };
  }>;
  /** Native reasoning trace (for models that support it) */
  thinking?: string;
  /** Internal flag indicating content was streamed */
  _content_was_streamed?: boolean;
  /** Internal flag for UI coordination */
  _should_replace_streaming?: boolean;
  /** Indicates if the request was interrupted */
  interrupted?: boolean;
  /** Indicates if an error occurred */
  error?: boolean;
  /** Error suggestions for the user */
  suggestions?: string[];
  /** Validation errors for tool calls */
  validation_errors?: string[];
  /** Flag indicating tool call validation failed */
  tool_call_validation_failed?: boolean;
  /** Flag indicating this is a partial response (interrupted by error mid-stream) */
  partial?: boolean;
  /** Error message for partial/interrupted responses */
  error_message?: string;
}

/**
 * Chunk of data from a streaming response
 */
export interface StreamChunk {
  /** Role of the message (typically 'assistant') */
  role?: 'assistant';
  /** Content chunk */
  content?: string;
  /** Thinking/reasoning chunk */
  thinking?: string;
  /** Tool calls (complete array, not incremental) */
  tool_calls?: LLMResponse['tool_calls'];
  /** Indicates the stream is complete */
  done?: boolean;
}

/**
 * Configuration for model client initialization
 */
export interface ModelClientConfig {
  /** API endpoint URL */
  endpoint: string;
  /** Model identifier */
  modelName: string | null;
  /** Sampling temperature (0.0 - 1.0) */
  temperature: number;
  /** Context window size in tokens */
  contextSize: number;
  /** Maximum tokens to generate */
  maxTokens: number;
  /** Keep-alive duration in seconds (optional) */
  keepAlive?: number;
  /** Reasoning effort level for reasoning models: "low", "medium", "high" (optional) */
  reasoningEffort?: string;
  /** Activity stream for emitting events (optional) */
  activityStream?: any; // Using 'any' to avoid circular dependency
}

/**
 * Abstract base class for LLM clients
 *
 * Provides a standard interface for interacting with different LLM backends.
 * Implementations must handle:
 * - Message sending with function calling support
 * - Streaming responses
 * - Error handling and retry logic
 * - Cancellation/interruption
 */
export abstract class ModelClient {
  /**
   * Send messages to the LLM and receive a response
   *
   * @param messages - Conversation history
   * @param options - Send options (functions, streaming, retries)
   * @returns Promise resolving to the LLM's response
   *
   * @example
   * ```typescript
   * const response = await client.send(
   *   [{ role: 'user', content: 'Hello!' }],
   *   { stream: false }
   * );
   * ```
   */
  abstract send(messages: readonly Message[], options?: SendOptions): Promise<LLMResponse>;

  /**
   * Get the current model name
   */
  abstract get modelName(): string;

  /**
   * Get the API endpoint URL
   */
  abstract get endpoint(): string;

  /**
   * Update the model name at runtime (optional)
   *
   * Allows changing which model to use without recreating the client.
   * The next request will use the new model.
   */
  abstract setModelName?(newModelName: string): void;

  /**
   * Cancel any ongoing requests (optional)
   */
  abstract cancel?(): void;

  /**
   * Close the client and cleanup resources (optional)
   */
  abstract close?(): Promise<void>;
}
