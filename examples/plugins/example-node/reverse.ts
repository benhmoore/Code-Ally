#!/usr/bin/env node
/**
 * Reverse String Plugin - Example Executable Plugin (TypeScript/Node.js)
 *
 * This demonstrates how to create an executable plugin in TypeScript/Node.js.
 * The plugin receives JSON via stdin and outputs JSON via stdout.
 * Configuration is read from environment variables.
 *
 * Signal Handling:
 * - Handles SIGTERM/SIGINT for graceful shutdown when interrupted
 * - More complex plugins should cleanup resources (files, connections, etc.) in the handler
 */

interface InputData {
  text: string;
  preserve_case?: boolean;
}

interface SuccessResult {
  success: true;
  original: string;
  reversed: string;
  length: number;
  preserved_case: boolean;
  config_applied: {
    prefix: string | null;
    suffix: string | null;
    api_key_present: boolean;
  };
}

interface ErrorResult {
  success: false;
  error: string;
  error_type: string;
}

type Result = SuccessResult | ErrorResult;

/**
 * Reverse a string, optionally preserving case.
 * Applies prefix/suffix from configuration if provided.
 */
function reverseString(text: string, preserveCase: boolean = true): Result {
  try {
    // Read configuration from environment variables
    const prefix = process.env.PLUGIN_CONFIG_PREFIX || '';
    const suffix = process.env.PLUGIN_CONFIG_SUFFIX || '';
    const apiKey = process.env.PLUGIN_CONFIG_API_KEY || '';

    let reversedText: string;

    if (preserveCase) {
      // Simple reversal
      reversedText = text.split('').reverse().join('');
    } else {
      // Reverse and convert to lowercase
      reversedText = text.split('').reverse().join('').toLowerCase();
    }

    // Apply prefix and suffix from config
    if (prefix) {
      reversedText = prefix + reversedText;
    }
    if (suffix) {
      reversedText = reversedText + suffix;
    }

    return {
      success: true,
      original: text,
      reversed: reversedText,
      length: text.length,
      preserved_case: preserveCase,
      config_applied: {
        prefix: prefix || null,
        suffix: suffix || null,
        api_key_present: Boolean(apiKey)
      }
    };
  } catch (e) {
    const error = e as Error;
    return {
      success: false,
      error: `Failed to reverse string: ${error.message}`,
      error_type: 'processing_error'
    };
  }
}

/**
 * Handle SIGTERM/SIGINT gracefully
 */
function signalHandler(): void {
  // For simple plugins like this, we can just exit
  // More complex plugins would cleanup resources here
  process.exit(0);
}

/**
 * Main entry point - reads JSON from stdin, outputs JSON to stdout
 */
async function main(): Promise<void> {
  // Register signal handlers for graceful shutdown
  process.on('SIGTERM', signalHandler);
  process.on('SIGINT', signalHandler);

  try {
    // Read input from stdin
    const chunks: Buffer[] = [];

    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }

    const inputString = Buffer.concat(chunks).toString('utf-8');
    const inputData: InputData = JSON.parse(inputString);

    // Extract parameters
    const text = inputData.text || '';
    const preserveCase = inputData.preserve_case !== undefined ? inputData.preserve_case : true;

    let result: Result;

    // Validate input
    if (!text) {
      result = {
        success: false,
        error: 'Missing required parameter: text',
        error_type: 'validation_error'
      };
    } else {
      // Execute the operation
      result = reverseString(text, preserveCase);
    }

    // Output result as JSON
    console.log(JSON.stringify(result));

  } catch (e) {
    const error = e as Error;

    // Check if it's a JSON parsing error
    const isJsonError = error.name === 'SyntaxError' && error.message.includes('JSON');

    const errorResult: ErrorResult = {
      success: false,
      error: isJsonError ? `Invalid JSON input: ${error.message}` : `Unexpected error: ${error.message}`,
      error_type: isJsonError ? 'input_error' : 'system_error'
    };

    console.log(JSON.stringify(errorResult));
    process.exit(1);
  }
}

// Run main function
main();
