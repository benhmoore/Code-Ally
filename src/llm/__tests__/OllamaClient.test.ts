/**
 * Tests for OllamaClient
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OllamaClient } from '../OllamaClient.js';
import type { Message } from '../../types/index.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch as any;

describe('OllamaClient', () => {
  let client: OllamaClient;

  beforeEach(() => {
    client = new OllamaClient({
      endpoint: 'http://localhost:11434',
      modelName: 'qwen2.5-coder:32b',
      temperature: 0.3,
      contextSize: 16384,
      maxTokens: 5000,
    });

    // Reset mocks
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize with correct configuration', () => {
      expect(client.modelName).toBe('qwen2.5-coder:32b');
      expect(client.endpoint).toBe('http://localhost:11434');
    });

    it('should use default model if not provided', () => {
      const defaultClient = new OllamaClient({
        endpoint: 'http://localhost:11434',
        modelName: null,
        temperature: 0.3,
        contextSize: 16384,
        maxTokens: 5000,
      });

      expect(defaultClient.modelName).toBe('qwen2.5-coder:32b');
    });
  });

  describe('Non-streaming responses', () => {
    it('should send messages and receive a response', async () => {
      const mockResponse = {
        message: {
          role: 'assistant',
          content: 'Hello! How can I help you?',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const messages: Message[] = [{ role: 'user', content: 'Hello' }];

      const result = await client.send(messages, { stream: false });

      expect(result.role).toBe('assistant');
      expect(result.content).toBe('Hello! How can I help you?');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should handle responses with thinking', async () => {
      const mockResponse = {
        message: {
          role: 'assistant',
          content: 'Let me help.',
          thinking: 'First I need to understand the request...',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const messages: Message[] = [{ role: 'user', content: 'Help me' }];

      const result = await client.send(messages, { stream: false });

      expect(result.thinking).toBe('First I need to understand the request...');
    });

    it('should handle tool calls', async () => {
      const mockResponse = {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-123',
              type: 'function',
              function: {
                name: 'bash',
                arguments: { command: 'ls -la' },
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const messages: Message[] = [{ role: 'user', content: 'List files' }];

      const result = await client.send(messages, { stream: false });

      expect(result.tool_calls).toHaveLength(1);
      expect(result.tool_calls![0].function.name).toBe('bash');
      expect(result.tool_calls![0].function.arguments).toEqual({ command: 'ls -la' });
    });

    it('should convert legacy function_call to tool_calls', async () => {
      const mockResponse = {
        message: {
          role: 'assistant',
          content: '',
          function_call: {
            name: 'bash',
            arguments: '{"command": "ls -la"}',
          },
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const messages: Message[] = [{ role: 'user', content: 'List files' }];

      const result = await client.send(messages, { stream: false });

      expect(result.tool_calls).toBeDefined();
      expect(result.tool_calls).toHaveLength(1);
      expect(result.tool_calls![0].function.name).toBe('bash');
    });

    it('should include function definitions in request', async () => {
      const mockResponse = {
        message: {
          role: 'assistant',
          content: 'Response',
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const messages: Message[] = [{ role: 'user', content: 'Test' }];
      const functions = [
        {
          type: 'function' as const,
          function: {
            name: 'bash',
            description: 'Execute bash commands',
            parameters: {
              type: 'object' as const,
              properties: {
                command: { type: 'string' as const },
              },
            },
          },
        },
      ];

      await client.send(messages, { functions, stream: false });

      const callArgs = mockFetch.mock.calls[0];
      const payload = JSON.parse(callArgs[1].body);

      expect(payload.tools).toEqual(functions);
      expect(payload.tool_choice).toBe('auto');
    });
  });

  describe('Error handling', () => {
    it('should handle network errors with retry', async () => {
      mockFetch
        .mockRejectedValueOnce(new TypeError('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            message: { role: 'assistant', content: 'Success' },
          }),
        });

      const messages: Message[] = [{ role: 'user', content: 'Test' }];

      const result = await client.send(messages, { stream: false, maxRetries: 1 });

      expect(result.content).toBe('Success');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should return error response after max retries', async () => {
      mockFetch.mockRejectedValue(new TypeError('Network error'));

      const messages: Message[] = [{ role: 'user', content: 'Test' }];

      const result = await client.send(messages, { stream: false, maxRetries: 1 });

      expect(result.error).toBe(true);
      expect(result.content).toContain('Error communicating with Ollama');
      expect(result.suggestions).toBeDefined();
    });

    it('should handle HTTP errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Model not found',
      });

      const messages: Message[] = [{ role: 'user', content: 'Test' }];

      const result = await client.send(messages, { stream: false, maxRetries: 0 });

      expect(result.error).toBe(true);
      expect(result.content).toContain('HTTP 404');
    });

    it('should handle JSON parse errors with retry', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          json: async () => {
            throw new SyntaxError('Invalid JSON');
          },
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            message: { role: 'assistant', content: 'Success' },
          }),
        });

      const messages: Message[] = [{ role: 'user', content: 'Test' }];

      const result = await client.send(messages, { stream: false, maxRetries: 1 });

      expect(result.content).toBe('Success');
    });

    it('should provide helpful suggestions for connection refused', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const messages: Message[] = [{ role: 'user', content: 'Test' }];

      const result = await client.send(messages, { stream: false, maxRetries: 0 });

      expect(result.suggestions).toContain('Start Ollama service: `ollama serve`');
    });

    it('should provide helpful suggestions for 404 errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not found',
      });

      const messages: Message[] = [{ role: 'user', content: 'Test' }];

      const result = await client.send(messages, { stream: false, maxRetries: 0 });

      expect(result.suggestions?.some(s => s.includes('ollama list'))).toBe(true);
    });
  });

  describe('Cancellation', () => {
    it('should cancel ongoing request', async () => {
      mockFetch.mockImplementation(
        (_url: string, options: any) =>
          new Promise((resolve, reject) => {
            const signal = options?.signal;

            // Listen for abort signal
            if (signal) {
              signal.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'AbortError'));
              });
            }

            setTimeout(() => {
              resolve({
                ok: true,
                json: async () => ({
                  message: { role: 'assistant', content: 'Done' },
                }),
              });
            }, 1000);
          })
      );

      const messages: Message[] = [{ role: 'user', content: 'Test' }];

      const promise = client.send(messages, { stream: false });

      // Cancel after a short delay
      setTimeout(() => client.cancel(), 50);

      const result = await promise;

      expect(result.interrupted).toBe(true);
      expect(result.content).toContain('[Request cancelled by user]');
    });
  });

  describe('Tool call validation', () => {
    it('should validate and repair tool calls', async () => {
      const mockResponse = {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              // Missing id
              type: 'function',
              function: {
                name: 'bash',
                arguments: { command: 'ls' },
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const messages: Message[] = [{ role: 'user', content: 'Test' }];

      const result = await client.send(messages, { stream: false });

      // Should have repaired the missing id
      expect(result.tool_calls).toBeDefined();
      expect(result.tool_calls![0].id).toMatch(/^repaired-/);
    });

    it('should parse string arguments in tool calls', async () => {
      const mockResponse = {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call-123',
              type: 'function',
              function: {
                name: 'bash',
                arguments: '{"command": "ls"}', // String instead of object
              },
            },
          ],
        },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const messages: Message[] = [{ role: 'user', content: 'Test' }];

      const result = await client.send(messages, { stream: false });

      expect(result.tool_calls![0].function.arguments).toEqual({ command: 'ls' });
    });
  });

  describe('Payload preparation', () => {
    it('should prepare payload with correct structure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Test' },
        }),
      });

      const messages: Message[] = [{ role: 'user', content: 'Hello' }];

      await client.send(messages, { stream: false });

      const callArgs = mockFetch.mock.calls[0];
      const payload = JSON.parse(callArgs[1].body);

      expect(payload.model).toBe('qwen2.5-coder:32b');
      expect(payload.messages).toEqual(messages);
      expect(payload.stream).toBe(false);
      expect(payload.options).toEqual({
        temperature: 0.3,
        num_ctx: 16384,
        num_predict: 5000,
      });
    });

    it('should include keep_alive if provided', async () => {
      const clientWithKeepAlive = new OllamaClient({
        endpoint: 'http://localhost:11434',
        modelName: 'qwen2.5-coder:32b',
        temperature: 0.3,
        contextSize: 16384,
        maxTokens: 5000,
        keepAlive: 600,
      });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          message: { role: 'assistant', content: 'Test' },
        }),
      });

      const messages: Message[] = [{ role: 'user', content: 'Hello' }];

      await clientWithKeepAlive.send(messages, { stream: false });

      const callArgs = mockFetch.mock.calls[0];
      const payload = JSON.parse(callArgs[1].body);

      expect(payload.options.keep_alive).toBe(600);
    });
  });
});
