/**
 * SocketClient Usage Examples
 *
 * This file demonstrates how to use the SocketClient class for JSON-RPC
 * communication with background plugin processes.
 */

import { SocketClient } from './SocketClient.js';

/**
 * Example 1: Basic RPC request
 *
 * Send a simple RPC request with parameters and handle the result.
 */
async function exampleBasicRequest() {
  const client = new SocketClient();
  const socketPath = '/path/to/daemon.sock';

  try {
    // Send RPC request with parameters
    const result = await client.sendRequest(
      socketPath,
      'search',
      {
        query: 'hello world',
        limit: 10,
      },
      30000 // 30 second timeout (optional, defaults to 30s)
    );

    console.log('Search results:', result);
  } catch (error) {
    console.error('RPC request failed:', error);
  }
}

/**
 * Example 2: Request without parameters
 *
 * Some RPC methods don't require parameters.
 */
async function exampleNoParams() {
  const client = new SocketClient();
  const socketPath = '/path/to/daemon.sock';

  try {
    const status = await client.sendRequest(socketPath, 'getStatus');
    console.log('Daemon status:', status);
  } catch (error) {
    console.error('Status check failed:', error);
  }
}

/**
 * Example 3: Health check
 *
 * Check if the daemon is alive and accepting connections.
 */
async function exampleHealthCheck() {
  const client = new SocketClient();
  const socketPath = '/path/to/daemon.sock';

  try {
    await client.checkConnection(socketPath, 5000); // 5 second timeout
    console.log('Daemon is healthy');
  } catch (error) {
    console.error('Daemon is not responding:', error);
  }
}

/**
 * Example 4: Error handling
 *
 * Demonstrates handling different types of errors.
 */
async function exampleErrorHandling() {
  const client = new SocketClient();
  const socketPath = '/path/to/daemon.sock';

  try {
    const result = await client.sendRequest(socketPath, 'riskyOperation', {
      data: 'test',
    });
    console.log('Operation succeeded:', result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for specific error types
    if (errorMessage.includes('Socket file not found')) {
      console.error('Daemon is not running');
      // Maybe start the daemon here?
    } else if (errorMessage.includes('Permission denied')) {
      console.error('No permission to access socket');
      // Check file permissions
    } else if (errorMessage.includes('timeout')) {
      console.error('Request timed out - daemon may be overloaded');
      // Maybe retry with longer timeout?
    } else if (errorMessage.includes('RPC error')) {
      console.error('Application error:', errorMessage);
      // Extract error details from message
    } else {
      console.error('Unexpected error:', errorMessage);
    }
  }
}

/**
 * Example 5: Multiple sequential requests
 *
 * The client is stateless, so you can reuse the same instance
 * for multiple requests.
 */
async function exampleMultipleRequests() {
  const client = new SocketClient();
  const socketPath = '/path/to/daemon.sock';

  try {
    // First request: initialize
    await client.sendRequest(socketPath, 'initialize', { config: 'test' });

    // Second request: perform operation
    const result = await client.sendRequest(socketPath, 'process', {
      input: 'data',
    });

    // Third request: cleanup
    await client.sendRequest(socketPath, 'cleanup');

    console.log('All operations completed:', result);
  } catch (error) {
    console.error('Operation failed:', error);
  }
}

/**
 * Example 6: Parallel requests to different daemons
 *
 * Since each request is independent, you can run multiple requests
 * in parallel to different daemons.
 */
async function exampleParallelRequests() {
  const client = new SocketClient();

  try {
    const [result1, result2, result3] = await Promise.all([
      client.sendRequest('/path/to/daemon1.sock', 'getData', { id: 1 }),
      client.sendRequest('/path/to/daemon2.sock', 'getData', { id: 2 }),
      client.sendRequest('/path/to/daemon3.sock', 'getData', { id: 3 }),
    ]);

    console.log('All results:', { result1, result2, result3 });
  } catch (error) {
    console.error('At least one request failed:', error);
  }
}

/**
 * Example 7: Custom timeout for long operations
 *
 * Some operations may take longer than the default 30 seconds.
 */
async function exampleLongOperation() {
  const client = new SocketClient();
  const socketPath = '/path/to/daemon.sock';

  try {
    // Set a 5 minute timeout for long-running operation
    const result = await client.sendRequest(
      socketPath,
      'performExpensiveAnalysis',
      { dataset: 'large' },
      300000 // 5 minutes
    );

    console.log('Analysis complete:', result);
  } catch (error) {
    console.error('Analysis failed or timed out:', error);
  }
}

/**
 * Example 8: Retry logic
 *
 * Implement retry logic for transient failures.
 */
async function exampleWithRetry() {
  const client = new SocketClient();
  const socketPath = '/path/to/daemon.sock';
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await client.sendRequest(socketPath, 'getData', {
        id: 123,
      });
      console.log('Request succeeded:', result);
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Only retry on timeout or connection errors
      const shouldRetry =
        errorMessage.includes('timeout') ||
        errorMessage.includes('Connection refused');

      if (!shouldRetry || attempt === maxRetries) {
        console.error(`Request failed after ${attempt} attempts:`, error);
        throw error;
      }

      console.log(`Attempt ${attempt} failed, retrying...`);
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Wait 1s before retry
    }
  }
}

// Export examples for reference
export {
  exampleBasicRequest,
  exampleNoParams,
  exampleHealthCheck,
  exampleErrorHandling,
  exampleMultipleRequests,
  exampleParallelRequests,
  exampleLongOperation,
  exampleWithRetry,
};
