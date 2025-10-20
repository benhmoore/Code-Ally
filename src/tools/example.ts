/**
 * Example: Using the Tool System
 *
 * This demonstrates how to set up and use the tool system with event handling.
 */

import { ActivityStream } from '../services/ActivityStream.js';
// import { ActivityEventType } from '../types/index.js';
import { ToolManager } from './ToolManager.js';
import { BashTool } from './BashTool.js';
import { ReadTool } from './ReadTool.js';

async function main() {
  // 1. Create activity stream for event handling
  const activityStream = new ActivityStream();

  // 2. Subscribe to events for logging
  activityStream.subscribe('*', (event) => {
    console.log(`[${event.type}] ${JSON.stringify(event.data, null, 2)}`);
  });

  // 3. Create tools
  const tools = [
    new BashTool(activityStream),
    new ReadTool(activityStream),
  ];

  // 4. Create tool manager
  const toolManager = new ToolManager(tools, activityStream);

  // 5. Get function definitions for LLM
  const functionDefs = toolManager.getFunctionDefinitions();
  console.log('\n=== Function Definitions ===');
  console.log(JSON.stringify(functionDefs, null, 2));

  // 6. Execute a tool (bash)
  console.log('\n=== Executing Bash Tool ===');
  const bashResult = await toolManager.executeTool('bash', {
    command: 'echo "Hello from tool system!"',
    description: 'Test echo command',
  });
  console.log('Result:', bashResult);

  // 7. Execute another tool (read)
  console.log('\n=== Executing Read Tool ===');
  const readResult = await toolManager.executeTool('read', {
    file_paths: ['package.json'],
    limit: 10,
  });
  console.log('Result:', readResult);

  // 8. Test validation (missing required parameter)
  console.log('\n=== Testing Validation ===');
  const invalidResult = await toolManager.executeTool('bash', {
    // Missing 'command' parameter
  });
  console.log('Result:', invalidResult);

  // 9. Test redundancy detection
  console.log('\n=== Testing Redundancy Detection ===');
  await toolManager.executeTool('bash', {
    command: 'echo "first call"',
  });
  const redundantResult = await toolManager.executeTool('bash', {
    command: 'echo "first call"', // Same command, same turn
  });
  console.log('Result:', redundantResult);

  // 10. Clear turn and try again
  toolManager.clearCurrentTurn();
  const afterClearResult = await toolManager.executeTool('bash', {
    command: 'echo "first call"', // Now allowed
  });
  console.log('Result after clearing turn:', afterClearResult);
}

// Run example
main().catch(console.error);
