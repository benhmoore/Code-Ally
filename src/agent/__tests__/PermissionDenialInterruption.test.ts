/**
 * Integration test for permission denial interruption
 *
 * Tests that when a user denies permission, the agent is fully interrupted
 * and stops execution immediately.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Agent } from '../Agent.js';
import { ModelClient } from '../../llm/ModelClient.js';
import { ToolManager } from '../../tools/ToolManager.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { TrustManager, PermissionChoice } from '../TrustManager.js';
import { PermissionManager } from '../../security/PermissionManager.js';
import { Config, ActivityEventType } from '../../types/index.js';
import { PermissionDeniedError } from '../../security/PathSecurity.js';
import { BashTool } from '../../tools/BashTool.js';

describe('Permission Denial Interruption', () => {
  let agent: Agent;
  let modelClient: ModelClient;
  let toolManager: ToolManager;
  let activityStream: ActivityStream;
  let trustManager: TrustManager;
  let permissionManager: PermissionManager;
  let mockConfig: Config;

  beforeEach(() => {
    // Create mock configuration
    mockConfig = {
      context_size: 200000,
      tool_call_activity_timeout: 30,
      compact_threshold: 80,
      parallel_tools: true,
    } as Config;

    // Create activity stream
    activityStream = new ActivityStream();

    // Create trust manager with activity stream
    trustManager = new TrustManager(false, activityStream);

    // Create permission manager
    permissionManager = new PermissionManager(trustManager);

    // Create mock model client
    modelClient = {
      send: vi.fn().mockResolvedValue({
        content: 'Test response',
        tool_calls: [],
      }),
      close: vi.fn(),
    } as any;

    // Create tool manager with BashTool
    const bashTool = new BashTool(activityStream, mockConfig);
    toolManager = new ToolManager([bashTool], activityStream);

    // Create agent
    agent = new Agent(
      modelClient,
      toolManager,
      activityStream,
      {
        config: mockConfig,
        isSpecializedAgent: false,
      },
      undefined,
      permissionManager
    );
  });

  afterEach(async () => {
    if (agent) {
      await agent.cleanup();
    }
  });

  it('should interrupt agent when user denies permission', async () => {
    // Mock LLM to return a tool call that requires confirmation
    (modelClient.send as any).mockResolvedValueOnce({
      content: '',
      tool_calls: [
        {
          id: 'test-call-1',
          type: 'function',
          function: {
            name: 'bash',
            arguments: { command: 'rm test.txt' },
          },
        },
      ],
    });

    // Track events
    const events: any[] = [];
    activityStream.subscribe(ActivityEventType.PERMISSION_REQUEST, (event) => {
      events.push(event);

      // Simulate user denying permission
      setTimeout(() => {
        activityStream.emit({
          id: event.id,
          type: ActivityEventType.PERMISSION_RESPONSE,
          timestamp: Date.now(),
          data: {
            requestId: event.data.requestId,
            choice: PermissionChoice.DENY,
          },
        });
      }, 10);
    });

    activityStream.subscribe(ActivityEventType.AGENT_END, (event) => {
      events.push(event);
    });

    // Send message that triggers tool call requiring permission
    const response = await agent.sendMessage('Delete the test file');

    // Verify agent stopped due to permission denial
    expect(response).toBe('Permission denied. Tell Ally what to do instead.');

    // Verify interruption was marked
    expect(agent.getInterruptionManager().wasRequestInterrupted()).toBe(true);

    // Verify PERMISSION_REQUEST event was emitted
    const permissionRequestEvents = events.filter(
      (e) => e.type === ActivityEventType.PERMISSION_REQUEST
    );
    expect(permissionRequestEvents.length).toBeGreaterThan(0);

    // Verify AGENT_END event was emitted with interruption flag
    const agentEndEvents = events.filter(
      (e) => e.type === ActivityEventType.AGENT_END
    );
    expect(agentEndEvents.length).toBeGreaterThan(0);
    expect(agentEndEvents[0].data.interrupted).toBe(true);
  });

  it('should not execute any more tools after permission denial', async () => {
    // Mock LLM to return multiple tool calls
    (modelClient.send as any).mockResolvedValueOnce({
      content: '',
      tool_calls: [
        {
          id: 'test-call-1',
          type: 'function',
          function: {
            name: 'bash',
            arguments: { command: 'rm test1.txt' },
          },
        },
        {
          id: 'test-call-2',
          type: 'function',
          function: {
            name: 'bash',
            arguments: { command: 'rm test2.txt' },
          },
        },
      ],
    });

    // Track tool executions
    const toolExecutions: string[] = [];
    const originalExecuteTool = toolManager.executeTool.bind(toolManager);
    toolManager.executeTool = vi.fn(async (toolName, args, ...rest) => {
      toolExecutions.push(toolName);
      return originalExecuteTool(toolName, args, ...rest);
    });

    // Deny the first permission request
    activityStream.subscribe(ActivityEventType.PERMISSION_REQUEST, (event) => {
      setTimeout(() => {
        activityStream.emit({
          id: event.id,
          type: ActivityEventType.PERMISSION_RESPONSE,
          timestamp: Date.now(),
          data: {
            requestId: event.data.requestId,
            choice: PermissionChoice.DENY,
          },
        });
      }, 10);
    });

    // Send message
    const response = await agent.sendMessage('Delete test files');

    // Verify agent stopped
    expect(response).toBe('Permission denied. Tell Ally what to do instead.');

    // Verify only the first tool was attempted (and failed due to permission denial)
    // The second tool should never be reached
    expect(toolExecutions.length).toBeLessThanOrEqual(1);
  });

  it('should allow agent to continue if permission is granted', async () => {
    // Mock LLM to return tool call, then final response
    (modelClient.send as any)
      .mockResolvedValueOnce({
        content: '',
        tool_calls: [
          {
            id: 'test-call-1',
            type: 'function',
            function: {
              name: 'bash',
              arguments: { command: 'echo hello' },
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        content: 'Task completed successfully',
        tool_calls: [],
      });

    // Grant permission
    activityStream.subscribe(ActivityEventType.PERMISSION_REQUEST, (event) => {
      setTimeout(() => {
        activityStream.emit({
          id: event.id,
          type: ActivityEventType.PERMISSION_RESPONSE,
          timestamp: Date.now(),
          data: {
            requestId: event.data.requestId,
            choice: PermissionChoice.ALLOW,
          },
        });
      }, 10);
    });

    // Send message
    const response = await agent.sendMessage('Run echo command');

    // Verify agent completed successfully
    expect(response).toBe('Task completed successfully');

    // Verify interruption was NOT marked
    expect(agent.getInterruptionManager().wasRequestInterrupted()).toBe(false);
  });
});
