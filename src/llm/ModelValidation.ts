/**
 * Model validation utilities
 *
 * Provides tools for testing model capabilities, particularly function calling support.
 */

import { logger } from '../services/Logger.js';
import { API_TIMEOUTS } from '../config/constants.js';
import { ModelCapabilitiesIndex } from '../services/ModelCapabilitiesIndex.js';

export interface ToolCallingSupportResult {
  supportsTools: boolean;
  error?: string;
}

export interface ImageSupportResult {
  supportsImages: boolean;
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
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUTS.OLLAMA_VALIDATION_CHAT_TIMEOUT);

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

/**
 * Test if a model supports vision/image input
 *
 * Sends a minimal test request with a 1x1 red PNG image to check if the model
 * supports Ollama's image API. This is used during setup and when creating
 * agents with custom models.
 *
 * @param endpoint - Ollama API endpoint
 * @param modelName - Model name to test
 * @returns Result indicating whether model supports images and any error message
 */
export async function testModelImageSupport(
  endpoint: string,
  modelName: string
): Promise<ImageSupportResult> {
  try {
    // Valid 10x10 red PNG in base64 (generated with sharp)
    const base64Image =
      'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAFElEQVR4nGP4z8CABzGMSjNgCRYAt8pjnQuW8k0AAAAASUVORK5CYII=';

    // Minimal test payload with an image
    const testPayload = {
      model: modelName,
      messages: [
        {
          role: 'user',
          content: 'What color is this?',
          images: [base64Image],
        },
      ],
      stream: false,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUTS.OLLAMA_VALIDATION_CHAT_TIMEOUT);

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

      // Check for explicit image support errors
      if (
        errorData.error &&
        (errorData.error.includes('does not support images') ||
          errorData.error.includes('vision') ||
          errorData.error.toLowerCase().includes('image'))
      ) {
        return {
          supportsImages: false,
          error: errorData.error,
        };
      }

      // Check for 400/415 status codes with image-related errors
      if ((response.status === 400 || response.status === 415) && errorData.error?.toLowerCase().includes('image')) {
        return {
          supportsImages: false,
          error: errorData.error,
        };
      }

      // Other errors - might be transient, assume images are supported
      return { supportsImages: true };
    }

    // Successful response means model supports images
    return { supportsImages: true };
  } catch (error) {
    // Network errors or timeouts - allow continuation (only block on explicit "does not support images" errors)
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.warn(`Network error during image support check: ${errorMsg}`);
    return {
      supportsImages: true,
      error: errorMsg,
    };
  }
}

export interface ModelCapabilitiesResult {
  supportsTools: boolean;
  supportsImages: boolean;
  fromCache: boolean;
  error?: string;
}

/**
 * Test model capabilities (tools and images) with caching
 *
 * First checks the ModelCapabilitiesIndex cache for existing results.
 * If cached results are found (and endpoint matches), returns those immediately.
 * If not cached, runs both tool calling and image support tests in parallel,
 * stores the results in the cache, and returns the combined result.
 *
 * @param endpoint - Ollama API endpoint
 * @param modelName - Model name to test
 * @returns Combined result with tool and image support status, cache status, and any errors
 */
export async function testModelCapabilities(
  endpoint: string,
  modelName: string
): Promise<ModelCapabilitiesResult> {
  const capabilitiesIndex = ModelCapabilitiesIndex.getInstance();

  // Ensure index is loaded (safe to call multiple times)
  await capabilitiesIndex.load();

  // Check cache first
  const cached = capabilitiesIndex.getCapabilities(modelName, endpoint);
  if (cached) {
    logger.debug(`Cache hit for model capabilities: ${modelName} at ${endpoint}`);
    return {
      supportsTools: cached.supportsTools,
      supportsImages: cached.supportsImages,
      fromCache: true,
    };
  }

  logger.debug(`Cache miss for model capabilities: ${modelName} at ${endpoint}, running tests`);

  // Run both tests in parallel
  const [toolResult, imageResult] = await Promise.all([
    testModelToolCalling(endpoint, modelName),
    testModelImageSupport(endpoint, modelName),
  ]);

  // Store in cache
  capabilitiesIndex.setCapabilities(modelName, endpoint, {
    supportsTools: toolResult.supportsTools,
    supportsImages: imageResult.supportsImages,
  });

  // Combine errors if any
  const errors = [toolResult.error, imageResult.error].filter(Boolean);
  const combinedError = errors.length > 0 ? errors.join('; ') : undefined;

  return {
    supportsTools: toolResult.supportsTools,
    supportsImages: imageResult.supportsImages,
    fromCache: false,
    error: combinedError,
  };
}
