# AgentPoolService Integration Guide

Based on Code Ally architecture patterns, here's how to integrate AgentPoolService.

---

## 1. Service Class Template

```typescript
// src/services/AgentPoolService.ts

import { IService } from '../types/index.js';
import { ActivityStream } from './ActivityStream.js';
import { logger } from './Logger.js';
import { Agent, AgentConfig } from '../agent/Agent.js';
import { ModelClient } from '../llm/ModelClient.js';
import { ToolManager } from '../tools/ToolManager.js';

export interface AgentPoolConfig {
  maxAgents?: number;           // Maximum concurrent agents
  maxQueuedTasks?: number;      // Maximum queued tasks
  taskTimeoutMs?: number;       // Task execution timeout
  enableAutoCleanup?: boolean;  // Auto-cleanup idle agents
}

export interface PooledAgentHandle {
  poolId: string;               // Unique pool/batch ID
  agentId: string;              // Agent instance ID
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: number;
}

/**
 * AgentPoolService - Manages pool of concurrent agents
 *
 * Provides:
 * - Concurrent agent execution with queue management
 * - Task tracking via unique pool IDs
 * - Resource pooling and cleanup
 */
export class AgentPoolService implements IService {
  private activeAgents: Map<string, Agent> = new Map();
  private taskQueue: Array<{
    poolId: string;
    agentConfig: AgentConfig;
    message: string;
    timestamp: number;
  }> = [];
  private poolHandles: Map<string, PooledAgentHandle> = new Map();
  private modelClient: ModelClient;
  private toolManager: ToolManager;
  private config: AgentPoolConfig;

  constructor(
    modelClient: ModelClient,
    toolManager: ToolManager,
    activityStream: ActivityStream,
    config: AgentPoolConfig = {}
  ) {
    this.modelClient = modelClient;
    this.toolManager = toolManager;
    this.activityStream = activityStream;
    this.config = {
      maxAgents: config.maxAgents ?? 3,
      maxQueuedTasks: config.maxQueuedTasks ?? 10,
      taskTimeoutMs: config.taskTimeoutMs ?? 300000,
      enableAutoCleanup: config.enableAutoCleanup ?? true,
    };
  }

  /**
   * Initialize service (create cleanup interval)
   */
  async initialize(): Promise<void> {
    logger.debug('[AGENT_POOL] Service initialized');
    if (this.config.enableAutoCleanup) {
      this.startCleanupInterval();
    }
  }

  /**
   * Submit task to agent pool
   *
   * Returns a handle for tracking the task
   */
  async submitTask(
    agentConfig: AgentConfig,
    message: string
  ): Promise<PooledAgentHandle> {
    const poolId = this.generatePoolId();

    // Check queue size
    if (this.taskQueue.length >= this.config.maxQueuedTasks!) {
      throw new Error(
        `Agent pool queue full (max ${this.config.maxQueuedTasks})`
      );
    }

    // Create and track handle
    const handle: PooledAgentHandle = {
      poolId,
      agentId: '', // Will be set when agent starts
      status: 'queued',
      createdAt: Date.now(),
    };
    this.poolHandles.set(poolId, handle);

    // Add to queue
    this.taskQueue.push({
      poolId,
      agentConfig,
      message,
      timestamp: Date.now(),
    });

    // Process queue
    this.processQueue();

    return handle;
  }

  /**
   * Get task status
   */
  getTaskStatus(poolId: string): PooledAgentHandle | null {
    return this.poolHandles.get(poolId) ?? null;
  }

  /**
   * Get task result (after completion)
   */
  async getTaskResult(poolId: string): Promise<string | null> {
    const handle = this.poolHandles.get(poolId);
    if (!handle || handle.status !== 'completed') {
      return null;
    }
    // Return from results map or cache
    return this.resultCache.get(poolId) ?? null;
  }

  /**
   * Process queued tasks with concurrency control
   */
  private async processQueue(): Promise<void> {
    while (
      this.taskQueue.length > 0 &&
      this.activeAgents.size < this.config.maxAgents!
    ) {
      const task = this.taskQueue.shift();
      if (!task) break;

      this.executeTask(task);
    }
  }

  /**
   * Execute a single task
   */
  private async executeTask(task: any): Promise<void> {
    const { poolId, agentConfig, message } = task;
    const handle = this.poolHandles.get(poolId);

    if (!handle) return;

    try {
      // Create agent for this task
      const agent = new Agent(
        this.modelClient,
        this.toolManager,
        this.activityStream,
        agentConfig
      );

      // Track agent
      handle.agentId = `agent-pool-${poolId}`;
      handle.status = 'running';
      this.activeAgents.set(poolId, agent);

      // Execute with timeout
      const result = await Promise.race([
        agent.sendMessage(message),
        new Promise<string>((_, reject) =>
          setTimeout(
            () => reject(new Error('Task timeout')),
            this.config.taskTimeoutMs
          )
        ),
      ]);

      // Cache result
      this.resultCache.set(poolId, result);
      handle.status = 'completed';

      logger.debug('[AGENT_POOL] Task completed:', poolId);
    } catch (error) {
      handle.status = 'failed';
      logger.error('[AGENT_POOL] Task failed:', poolId, error);
    } finally {
      // Clean up agent
      this.activeAgents.delete(poolId);
      await this.processQueue();
    }
  }

  /**
   * Generate unique pool ID
   */
  private generatePoolId(): string {
    return `pool-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Start cleanup interval for idle tasks
   */
  private startCleanupInterval(): void {
    setInterval(() => {
      const now = Date.now();
      for (const [poolId, handle] of this.poolHandles.entries()) {
        // Clean up completed tasks after 5 minutes
        if (
          (handle.status === 'completed' || handle.status === 'failed') &&
          now - handle.createdAt > 5 * 60 * 1000
        ) {
          this.poolHandles.delete(poolId);
          this.resultCache.delete(poolId);
        }
      }
    }, 60000); // Check every minute
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    logger.debug('[AGENT_POOL] Cleanup started');

    // Stop all active agents
    for (const [_poolId, agent] of this.activeAgents.entries()) {
      await agent.cleanup();
    }

    this.activeAgents.clear();
    this.taskQueue = [];
    this.poolHandles.clear();
    this.resultCache.clear();

    logger.debug('[AGENT_POOL] Cleanup completed');
  }

  // Private storage
  private activityStream: ActivityStream;
  private resultCache: Map<string, string> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
}
```

---

## 2. Tool Integration

```typescript
// src/tools/AgentPoolTool.ts

import { BaseTool } from './BaseTool.js';
import { ToolResult, FunctionDefinition } from '../types/index.js';
import { ActivityStream } from '../services/ActivityStream.js';
import { ServiceRegistry } from '../services/ServiceRegistry.js';
import { AgentPoolService, PooledAgentHandle } from '../services/AgentPoolService.js';

export class AgentPoolTool extends BaseTool {
  readonly name = 'agent_pool';
  readonly description =
    'Execute multiple agents concurrently. Returns task handle for tracking.';
  readonly requiresConfirmation = false;

  constructor(activityStream: ActivityStream) {
    super(activityStream);
  }

  getFunctionDefinition(): FunctionDefinition {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              description: 'Array of tasks to execute concurrently',
              items: {
                type: 'object',
                properties: {
                  agent_name: {
                    type: 'string',
                    description: 'Name of agent to use',
                  },
                  task_prompt: {
                    type: 'string',
                    description: 'Task instructions',
                  },
                },
                required: ['task_prompt'],
              },
            },
            wait_for_completion: {
              type: 'boolean',
              description:
                'Wait for all tasks to complete (default: false for async)',
            },
          },
          required: ['tasks'],
        },
      },
    };
  }

  protected async executeImpl(args: any): Promise<ToolResult> {
    this.captureParams(args);

    const tasks = args.tasks as Array<{
      agent_name?: string;
      task_prompt: string;
    }>;
    const waitForCompletion = args.wait_for_completion ?? false;

    if (!Array.isArray(tasks) || tasks.length === 0) {
      return this.formatErrorResponse(
        'tasks must be a non-empty array',
        'validation_error'
      );
    }

    const registry = ServiceRegistry.getInstance();
    const poolService = registry.get<AgentPoolService>('agent_pool_service');

    if (!poolService) {
      return this.formatErrorResponse(
        'Agent pool service not available',
        'system_error'
      );
    }

    try {
      // Submit all tasks
      const handles: PooledAgentHandle[] = [];
      for (const task of tasks) {
        const handle = await poolService.submitTask(
          {
            config: {}, // Use default config
            isSpecializedAgent: true,
          },
          task.task_prompt
        );
        handles.push(handle);
      }

      // Wait for completion if requested
      if (waitForCompletion) {
        const results = await Promise.all(
          handles.map(h => this.waitForTask(poolService, h.poolId))
        );

        return this.formatSuccessResponse({
          content: `Executed ${results.length} tasks concurrently`,
          task_handles: handles.map(h => ({
            pool_id: h.poolId,
            agent_id: h.agentId,
          })),
          results,
        });
      } else {
        return this.formatSuccessResponse({
          content: `Submitted ${handles.length} tasks to agent pool`,
          task_handles: handles.map(h => ({
            pool_id: h.poolId,
            status: h.status,
          })),
        });
      }
    } catch (error) {
      return this.formatErrorResponse(
        `Failed to submit tasks: ${error}`,
        'execution_error'
      );
    }
  }

  private async waitForTask(
    poolService: AgentPoolService,
    poolId: string
  ): Promise<string | null> {
    // Poll for completion (implement backoff)
    let attempts = 0;
    while (attempts < 600) {
      // 10 minute timeout with 1 second intervals
      const handle = poolService.getTaskStatus(poolId);
      if (handle?.status === 'completed' || handle?.status === 'failed') {
        return poolService.getTaskResult(poolId);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }
    throw new Error(`Task ${poolId} timeout`);
  }
}
```

---

## 3. Service Registration in cli.ts

Add to the main `cli.ts` file after line 520 (before agent creation):

```typescript
// Import AgentPoolService
const { AgentPoolService } = await import('./services/AgentPoolService.js');
const { AgentPoolTool } = await import('./tools/AgentPoolTool.ts');

// Create agent pool service
const agentPoolService = new AgentPoolService(
  modelClient,
  toolManager,
  activityStream,
  {
    maxAgents: config.agent_pool_max_agents ?? 3,
    maxQueuedTasks: config.agent_pool_max_queue ?? 10,
    taskTimeoutMs: config.agent_pool_timeout_ms ?? 300000,
    enableAutoCleanup: true,
  }
);
await agentPoolService.initialize();
registry.registerInstance('agent_pool_service', agentPoolService);

// Add tool to tool list
tools.push(new AgentPoolTool(activityStream));
```

---

## 4. Command Integration (Optional)

```typescript
// src/agent/commands/PoolCommand.ts

import { Command } from './Command.js';
import { type Message } from '../../types/index.js';
import { type ServiceRegistry } from '../../services/ServiceRegistry.js';
import { type CommandResult } from '../CommandHandler.js';
import { AgentPoolService } from '../../services/AgentPoolService.js';

export class PoolCommand extends Command {
  readonly name = '/pool';
  readonly description = 'Manage agent pool';
  protected readonly useYellowOutput = true;

  async execute(
    args: string[],
    _messages: Message[],
    serviceRegistry: ServiceRegistry
  ): Promise<CommandResult> {
    if (args.length === 0) {
      return this.showHelp();
    }

    const poolService = serviceRegistry.get<AgentPoolService>('agent_pool_service');
    if (!poolService) {
      return this.createError('Agent pool service not available');
    }

    const subcommand = args[0]!.toLowerCase();

    switch (subcommand) {
      case 'status': {
        // Show pool status
        return this.createResponse('Agent pool status: OK');
      }
      case 'clear': {
        // Clear all queued tasks
        await poolService.cleanup();
        return this.createResponse('Agent pool cleared');
      }
      default:
        return this.createError(`Unknown subcommand: ${subcommand}`);
    }
  }

  private showHelp(): CommandResult {
    return {
      handled: true,
      response: `Pool Commands:
  /pool status - Show agent pool status
  /pool clear  - Clear all queued tasks
`,
    };
  }
}
```

Register in CommandHandler:
```typescript
this.registerCommand(new PoolCommand());
```

---

## 5. ToolResult Return Patterns

For AgentPoolService operations:

```typescript
// Success with handles (for LLM to reference later)
return this.formatSuccessResponse({
  content: 'Submitted 3 tasks to agent pool',
  task_count: 3,
  pool_ids: ['pool-123', 'pool-124', 'pool-125'],
  // Each pool_id can be queried later via /pool status <id>
});

// Error with helpful context
return this.formatErrorResponse(
  'Agent pool at max capacity (3/3 agents busy)',
  'execution_error',
  'Try waiting a moment or reducing the number of tasks',
  { current_queue_size: 5, max_queue: 10 }
);

// Status query result
return this.formatSuccessResponse({
  pool_id: 'pool-123',
  status: 'completed',
  result: 'Task output here...',
  duration_ms: 5234,
});
```

---

## 6. Key Integration Points Summary

1. **Service Registration:** Register in `cli.ts` after other services
2. **Lifecycle:** Implements `IService` with `initialize()` and `cleanup()`
3. **Tool Integration:** Extend `BaseTool`, use `formatSuccessResponse()` and `formatErrorResponse()`
4. **Handle Tracking:** Return unique `pool_id` for each submitted task
5. **ServiceRegistry Access:** Tools/commands access via `registry.get<AgentPoolService>('agent_pool_service')`
6. **Error Handling:** Use appropriate `ErrorType` values for different failure scenarios

---

## 7. Testing Patterns

```typescript
// src/services/__tests__/AgentPoolService.test.ts

describe('AgentPoolService', () => {
  let poolService: AgentPoolService;
  let mockModelClient: any;
  let mockToolManager: any;
  let activityStream: ActivityStream;

  beforeEach(() => {
    activityStream = new ActivityStream();
    mockModelClient = { /* mock */ };
    mockToolManager = { /* mock */ };

    poolService = new AgentPoolService(
      mockModelClient,
      mockToolManager,
      activityStream,
      { maxAgents: 2 }
    );
  });

  it('should generate unique pool IDs', async () => {
    const handle1 = await poolService.submitTask({}, 'task 1');
    const handle2 = await poolService.submitTask({}, 'task 2');

    expect(handle1.poolId).not.toEqual(handle2.poolId);
  });

  it('should queue tasks when at capacity', async () => {
    // Submit 3 tasks with max 2 concurrent
    const h1 = await poolService.submitTask({}, 'task 1');
    const h2 = await poolService.submitTask({}, 'task 2');
    const h3 = await poolService.submitTask({}, 'task 3');

    expect(h1.status).toEqual('queued');
    expect(h2.status).toEqual('queued');
    expect(h3.status).toEqual('queued');
  });

  it('should reject when queue is full', async () => {
    // Max 2 concurrent + max 10 queue = 12 total
    for (let i = 0; i < 12; i++) {
      await poolService.submitTask({}, `task ${i}`);
    }

    await expect(poolService.submitTask({}, 'overflow task')).rejects.toThrow(
      /queue full/
    );
  });
});
```
