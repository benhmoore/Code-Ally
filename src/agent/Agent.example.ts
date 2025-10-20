/**
 * Example usage of the Agent class
 *
 * This demonstrates how to create and use an Agent to orchestrate
 * tool execution and LLM communication.
 */

import { Agent, AgentConfig } from './Agent.js';
import { OllamaClient } from '../llm/OllamaClient.js';
import { ToolManager } from '../tools/ToolManager.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { BashTool } from '../tools/BashTool.js';
import { ReadTool } from '../tools/ReadTool.js';
import { ActivityEventType } from '../types/index.js';

/**
 * Example: Create an agent and have a conversation
 */
async function exampleConversation() {
  // 1. Create activity stream for event handling
  const activityStream = new ActivityStream();

  // Subscribe to events for logging
  activityStream.subscribe('*', event => {
    console.log(`[Event] ${event.type}:`, event.data);
  });

  // 2. Create model client
  const modelClient = new OllamaClient({
    endpoint: 'http://localhost:11434',
    modelName: 'qwen2.5-coder:32b',
    temperature: 0.3,
    contextSize: 16384,
    maxTokens: 5000,
  });

  // 3. Create tools
  const bashTool = new BashTool(activityStream);
  const readTool = new ReadTool(activityStream);

  // 4. Create tool manager
  const toolManager = new ToolManager([bashTool, readTool], activityStream);

  // 5. Create agent configuration
  const config: AgentConfig = {
    verbose: true,
    systemPrompt: 'You are a helpful coding assistant with access to bash and file reading tools.',
    config: {
      model: 'qwen2.5-coder:32b',
      endpoint: 'http://localhost:11434',
      context_size: 16384,
      temperature: 0.3,
      max_tokens: 5000,
      bash_timeout: 30000,
      auto_confirm: false,
      check_context_msg: true,
      parallel_tools: true,
      theme: 'auto',
      compact_threshold: 0.85,
      show_token_usage: true,
      show_context_in_prompt: true,
      tool_result_preview_lines: 10,
      tool_result_preview_enabled: true,
      diff_display_enabled: true,
      diff_display_max_file_size: 102400,
      diff_display_context_lines: 3,
      diff_display_theme: 'auto',
      diff_display_color_removed: 'on rgb(60,25,25)',
      diff_display_color_added: 'on rgb(25,60,25)',
      diff_display_color_modified: 'on rgb(60,60,25)',
      tool_result_max_tokens_normal: 1000,
      tool_result_max_tokens_moderate: 750,
      tool_result_max_tokens_aggressive: 500,
      tool_result_max_tokens_critical: 200,
      setup_completed: true,
    },
  };

  // 6. Create agent
  const agent = new Agent(modelClient, toolManager, activityStream, config);

  // 7. Have a conversation
  console.log('\n=== Starting conversation ===\n');

  try {
    // Example 1: Simple question
    console.log('User: What is the current directory?');
    const response1 = await agent.sendMessage('What is the current directory?');
    console.log('Assistant:', response1);

    // Example 2: Read a file
    console.log('\nUser: Read the package.json file');
    const response2 = await agent.sendMessage('Read the package.json file');
    console.log('Assistant:', response2);

    // Example 3: Multiple tools (concurrent if possible)
    console.log('\nUser: List files and show git status');
    const response3 = await agent.sendMessage('List files in current directory and show git status');
    console.log('Assistant:', response3);
  } catch (error) {
    console.error('Error:', error);
  } finally {
    // Cleanup
    await agent.cleanup();
  }
}

/**
 * Example: Subscribe to specific events
 */
async function exampleEventHandling() {
  const activityStream = new ActivityStream();

  // Track tool execution
  let toolsExecuted = 0;
  activityStream.subscribe(ActivityEventType.TOOL_CALL_START, event => {
    console.log(`Tool started: ${event.data.toolName}`);
    toolsExecuted++;
  });

  activityStream.subscribe(ActivityEventType.TOOL_CALL_END, event => {
    console.log(`Tool completed: ${event.data.toolName} (${event.data.success ? 'success' : 'error'})`);
  });

  // Track thinking
  activityStream.subscribe(ActivityEventType.THOUGHT_CHUNK, event => {
    if (event.data.thinking) {
      console.log('💭 Thinking...');
    }
  });

  // Create agent and have conversation
  // ... (similar setup as above)

  console.log(`\nTotal tools executed: ${toolsExecuted}`);
}

/**
 * Example: Message flow
 *
 * User message → Agent.sendMessage()
 *   ↓
 * Build message history with system prompt
 *   ↓
 * Send to OllamaClient with function definitions
 *   ↓
 * Parse response (content + tool_calls)
 *   ↓
 * If tool_calls: ToolOrchestrator.executeToolCalls() → emit events → recurse with results
 *   ↓
 * If content only: return response
 */

// Run example if this file is executed directly
// Uncomment to run:
// exampleConversation().catch(console.error);

export { exampleConversation, exampleEventHandling };
