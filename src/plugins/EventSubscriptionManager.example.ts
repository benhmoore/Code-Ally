/**
 * Example usage of EventSubscriptionManager
 *
 * This file demonstrates how to use the EventSubscriptionManager to:
 * 1. Subscribe plugins to events
 * 2. Dispatch events to subscribed plugins
 * 3. Manage subscriptions
 */

import { EventSubscriptionManager, APPROVED_EVENTS } from './EventSubscriptionManager.js';
import { SocketClient } from './SocketClient.js';
import { BackgroundProcessManager } from './BackgroundProcessManager.js';

// Example: Setting up the EventSubscriptionManager
async function setupExample() {
  // Create dependencies
  const socketClient = new SocketClient();
  const processManager = new BackgroundProcessManager();

  // Create the event subscription manager
  const eventManager = new EventSubscriptionManager(socketClient, processManager);

  // Example 1: Subscribe a plugin to specific events
  eventManager.subscribe('my-logger-plugin', '/tmp/my-logger-plugin.sock', [
    'TOOL_CALL_START',
    'TOOL_CALL_END',
    'AGENT_START',
    'AGENT_END',
  ]);

  // Example 2: Subscribe another plugin to different events
  eventManager.subscribe('my-analytics-plugin', '/tmp/my-analytics-plugin.sock', [
    'CONTEXT_USAGE_UPDATE',
    'TODO_UPDATE',
    'COMPACTION_COMPLETE',
  ]);

  // Example 3: Subscribe a plugin to all approved events
  eventManager.subscribe('my-monitoring-plugin', '/tmp/my-monitoring-plugin.sock', [
    ...APPROVED_EVENTS,
  ]);

  // Example 4: Dispatch an event (fire-and-forget, non-blocking)
  await eventManager.dispatch('TOOL_CALL_START', {
    toolName: 'bash',
    arguments: { command: 'ls -la' },
  });

  // Example 5: Check who's subscribed to an event
  const toolCallSubscribers = eventManager.getSubscribers('TOOL_CALL_START');
  console.log('Subscribers to TOOL_CALL_START:', toolCallSubscribers);
  // Output: ['my-logger-plugin', 'my-monitoring-plugin']

  // Example 6: Check if a plugin is subscribed
  const isSubscribed = eventManager.isSubscribed('my-logger-plugin');
  console.log('Is my-logger-plugin subscribed?', isSubscribed);
  // Output: true

  // Example 7: Get subscription details for a plugin
  const subscription = eventManager.getSubscription('my-logger-plugin');
  console.log('Subscription details:', subscription);
  // Output: { pluginName: 'my-logger-plugin', socketPath: '/tmp/my-logger-plugin.sock', events: [...] }

  // Example 8: Unsubscribe a plugin
  eventManager.unsubscribe('my-logger-plugin');

  // Example 9: Error handling - subscribing to unapproved events
  try {
    eventManager.subscribe('bad-plugin', '/tmp/bad-plugin.sock', [
      'TOOL_CALL_START',
      'UNAPPROVED_EVENT', // This will throw an error
    ]);
  } catch (error) {
    console.error('Error:', error);
    // Error will explain which events are unapproved
  }

  // Example 10: Integration with ActivityStream (pseudo-code)
  // In your ActivityStream or event emitter:
  // activityStream.on('TOOL_CALL_START', (data) => {
  //   eventManager.dispatch('TOOL_CALL_START', data);
  // });
}

// Example: What happens on the plugin daemon side
// The daemon receives JSON-RPC notifications like this:
const exampleNotification = {
  jsonrpc: '2.0',
  method: 'on_event',
  params: {
    event_type: 'TOOL_CALL_START',
    event_data: {
      toolName: 'bash',
      arguments: { command: 'ls -la' },
    },
    timestamp: 1699999999999,
  },
};

// Plugin daemon should implement a handler for the "on_event" method:
// def handle_on_event(params):
//     event_type = params['event_type']
//     event_data = params['event_data']
//     timestamp = params['timestamp']
//
//     if event_type == 'TOOL_CALL_START':
//         log_tool_call(event_data)
//     elif event_type == 'AGENT_END':
//         update_metrics(event_data)

// Example: Typical workflow in Ally
async function typicalWorkflow() {
  const socketClient = new SocketClient();
  const processManager = new BackgroundProcessManager();
  const eventManager = new EventSubscriptionManager(socketClient, processManager);

  // 1. When a background plugin starts and registers, subscribe it to events
  const pluginName = 'my-plugin';
  const socketPath = '/tmp/my-plugin.sock';
  const requestedEvents = ['TOOL_CALL_START', 'TOOL_CALL_END', 'AGENT_START', 'AGENT_END'];

  eventManager.subscribe(pluginName, socketPath, requestedEvents);

  // 2. During execution, dispatch events as they occur
  // (These would typically be called from ActivityStream or other event sources)

  // When a tool call starts
  await eventManager.dispatch('TOOL_CALL_START', {
    toolName: 'Read',
    arguments: { file_path: '/path/to/file.ts' },
  });

  // When a tool call ends
  await eventManager.dispatch('TOOL_CALL_END', {
    toolName: 'Read',
    result: { success: true, linesRead: 100 },
  });

  // When an agent session starts
  await eventManager.dispatch('AGENT_START', {
    agentType: 'main',
    sessionId: 'abc123',
  });

  // When an agent session ends
  await eventManager.dispatch('AGENT_END', {
    agentType: 'main',
    sessionId: 'abc123',
    tokensUsed: 5000,
  });

  // 3. When plugin stops, unsubscribe
  eventManager.unsubscribe(pluginName);
}

// Export for reference
export { setupExample, typicalWorkflow, exampleNotification };
