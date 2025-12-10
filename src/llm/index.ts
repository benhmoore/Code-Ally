/**
 * LLM Integration Layer
 *
 * Provides abstractions and implementations for communicating with LLM backends.
 *
 * Main exports:
 * - ModelClient: Abstract base class for LLM clients
 * - OllamaClient: Ollama API implementation
 * - MessageHistory: Conversation state management
 * - FunctionCalling utilities: Tool schema conversion and validation
 */

// Core abstractions
export { ModelClient, type ModelClientConfig, type SendOptions, type LLMResponse, type StreamChunk } from './ModelClient.js';

// Implementations
export { OllamaClient } from './OllamaClient.js';

// Message management
export { MessageHistory, type MessageHistoryOptions } from './MessageHistory.js';

// Function calling utilities
export {
  parseToolCallArguments,
  extractToolCallData,
  createToolResultMessage,
  hasToolCalls,
  isValidToolCall,
} from './FunctionCalling.js';
