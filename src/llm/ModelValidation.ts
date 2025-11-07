/**
 * Model validation utilities
 *
 * Provides tools for testing model capabilities, particularly function calling support.
 */

import { logger } from '../services/Logger.js';

export interface ToolCallingSupportResult {
  supportsTools: boolean;
  error?: string;
}

/**
 * Test if a model supports tool/function calling
 *
 * Sends a minimal test request with a dummy function to check if the model
 * supports Ollama's tool calling API. This is used during setup and when
 * creating agents with custom models.
 *
 * @param endpoint - Ollama API endpoint
 * @param modelName - Model name to test
 * @returns Result indicating whether model supports tools and any error message
 */
export async function testModelToolCalling(
  endpoint: string,
  modelName: string
): Promise<ToolCallingSupportResult> {
  try {
    // Minimal test payload with a dummy function
    const testPayload = {
      model: modelName,
      messages: [
        {
          role: 'user',
          content: 'test',
        },
      ],
      stream: false,
      tools: [
        {
          type: 'function',
          function: {
            name: 'test_function',
            description: 'A test tool',
            parameters: {
              type: 'object',
              properties: {},
            },
          },
        },
      ],
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testPayload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorData = (await response.json().catch(() => ({
        error: 'Unknown error',
      }))) as { error?: string };

      // Check for the specific "does not support tools" error
      if (errorData.error && errorData.error.includes('does not support tools')) {
        return {
          supportsTools: false,
          error: errorData.error,
        };
      }

      // Other errors - might be transient, assume tools are supported
      return { supportsTools: true };
    }

    // Successful response means model supports tools
    return { supportsTools: true };
  } catch (error) {
    // Network errors or timeouts - allow continuation (only block on explicit "does not support tools" errors)
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`Network error during tool support check: ${errorMsg}`);
    return {
      supportsTools: true,
      error: errorMsg,
    };
  }
}
