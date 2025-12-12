/**
 * BackgroundAgentManager - Manages background agent execution
 *
 * Provides lifecycle management, activity buffering, and status monitoring
 * for agents running in the background (parallel to the primary agent).
 */

import { Agent } from '../agent/Agent.js';
import { ActivityStream } from './ActivityStream.js';
import { ActivityEventType } from '../types/index.js';
import { logger } from './Logger.js';
import { formatDuration } from '../ui/utils/timeUtils.js';

/**
 * Information about a managed background agent
 */
export interface BackgroundAgentInfo {
  /** Unique identifier: bg-agent-{timestamp}-{random} */
  id: string;
  /** Agent instance */
  agent: Agent;
  /** Original task prompt */
  taskPrompt: string;
  /** Type of agent (e.g., 'task', 'explore') */
  agentType: string;
  /** Unix timestamp when agent started */
  startTime: number;
  /** Current status */
  status: 'executing' | 'completed' | 'error';
  /** Final result summary (set on completion) */
  finalResult?: string;
  /** Error message (set on error) */
  errorMessage?: string;
  /** Unix timestamp when agent completed/errored (null while running) */
  completionTime: number | null;
  /** Parent agent ID (for orphan detection) */
  parentAgentId?: string;
}

/**
 * Manages a collection of background agents
 *
 * Provides centralized tracking, activity buffering, and lifecycle management
 * for background agents. Enforces agent limits and provides monitoring capabilities.
 */
export class BackgroundAgentManager {
  private readonly agents: Map<string, BackgroundAgentInfo> = new Map();
  private readonly activityStream: ActivityStream;
  private readonly maxAgents: number;

  constructor(activityStream: ActivityStream, maxAgents: number = 3) {
    this.activityStream = activityStream;
    this.maxAgents = maxAgents;
  }

  /**
   * Register a new background agent
   *
   * Enforces the maximum agent limit. If limit is reached, the oldest
   * completed agent is removed. If all agents are running, an error
   * is thrown.
   *
   * @param agent - Agent instance
   * @param taskPrompt - Original task prompt
   * @param agentType - Type of agent (e.g., 'task', 'explore')
   * @param parentAgentId - Parent agent ID (for orphan detection)
   * @returns The assigned agent ID
   * @throws Error if agent limit reached and no completed agents exist
   */
  register(
    agent: Agent,
    taskPrompt: string,
    agentType: string,
    parentAgentId?: string
  ): string {
    // Check if we've hit the limit
    if (this.agents.size >= this.maxAgents) {
      // Try to remove oldest completed agent
      const removed = this.removeOldestCompletedAgent();

      if (!removed) {
        throw new Error(
          `Background agent limit reached (${this.maxAgents}). ` +
          `Kill an existing agent before starting a new one.`
        );
      }

      logger.debug(
        `[BackgroundAgentManager] Removed oldest completed agent to make room for new agent`
      );
    }

    // Generate unique ID
    const id = this.generateAgentId();

    // Create agent info
    const info: BackgroundAgentInfo = {
      id,
      agent,
      taskPrompt,
      agentType,
      startTime: Date.now(),
      status: 'executing',
      completionTime: null,
      parentAgentId,
    };

    this.agents.set(id, info);
    logger.debug(`[BackgroundAgentManager] Registered agent ${id} (type: ${agentType})`);

    // Emit start event
    this.activityStream.emit({
      id: this.generateEventId(),
      type: ActivityEventType.BACKGROUND_AGENT_START,
      timestamp: Date.now(),
      data: {
        agentId: id,
        taskPrompt,
        agentType,
      },
    });

    return id;
  }

  /**
   * Get a background agent by ID
   *
   * @param id - Agent identifier
   * @returns BackgroundAgentInfo if found, undefined otherwise
   */
  getAgent(id: string): BackgroundAgentInfo | undefined {
    return this.agents.get(id);
  }

  /**
   * List all tracked background agents
   *
   * @returns Array of all BackgroundAgentInfo objects
   */
  listAgents(): BackgroundAgentInfo[] {
    return Array.from(this.agents.values());
  }

  /**
   * Mark agent as completed with result
   *
   * Emits BACKGROUND_AGENT_COMPLETE event with duration.
   *
   * @param id - Agent identifier
   * @param result - Final result summary
   */
  markCompleted(id: string, result: string): void {
    const info = this.agents.get(id);

    if (!info) {
      logger.warn(`[BackgroundAgentManager] Agent ${id} not found for completion`);
      return;
    }

    const now = Date.now();
    info.status = 'completed';
    info.finalResult = result;
    info.completionTime = now;

    const durationSeconds = Math.round((now - info.startTime) / 1000);

    logger.debug(`[BackgroundAgentManager] Agent ${id} completed (${durationSeconds}s)`);

    // Emit completion event
    this.activityStream.emit({
      id: this.generateEventId(),
      type: ActivityEventType.BACKGROUND_AGENT_COMPLETE,
      timestamp: now,
      data: {
        agentId: id,
        result,
        durationSeconds,
      },
    });
  }

  /**
   * Mark agent as failed with error
   *
   * Emits BACKGROUND_AGENT_ERROR event with duration.
   *
   * @param id - Agent identifier
   * @param error - Error message
   */
  markError(id: string, error: string): void {
    const info = this.agents.get(id);

    if (!info) {
      logger.warn(`[BackgroundAgentManager] Agent ${id} not found for error marking`);
      return;
    }

    const now = Date.now();
    info.status = 'error';
    info.errorMessage = error;
    info.completionTime = now;

    const durationSeconds = Math.round((now - info.startTime) / 1000);

    logger.debug(`[BackgroundAgentManager] Agent ${id} failed (${durationSeconds}s)`);

    // Emit error event
    this.activityStream.emit({
      id: this.generateEventId(),
      type: ActivityEventType.BACKGROUND_AGENT_ERROR,
      timestamp: now,
      data: {
        agentId: id,
        error,
        durationSeconds,
      },
    });
  }

  /**
   * Inject a steering message into a background agent
   *
   * Uses the agent's existing interjection mechanism to inject
   * user guidance mid-execution.
   *
   * @param id - Agent identifier
   * @param message - Steering message to inject
   * @returns true if injection succeeded, false if agent not found
   */
  injectSteering(id: string, message: string): boolean {
    const info = this.agents.get(id);

    if (!info) {
      logger.debug(`[BackgroundAgentManager] Agent ${id} not found for steering`);
      return false;
    }

    // Only allow steering for executing agents
    if (info.status !== 'executing') {
      logger.debug(`[BackgroundAgentManager] Agent ${id} is not executing (status: ${info.status})`);
      return false;
    }

    // Use agent's interjection mechanism
    info.agent.addUserInterjection(message);
    info.agent.interrupt('interjection');

    logger.debug(`[BackgroundAgentManager] Injected steering message into agent ${id}`);

    // Emit steering event
    this.activityStream.emit({
      id: this.generateEventId(),
      type: ActivityEventType.BACKGROUND_AGENT_STEERING,
      timestamp: Date.now(),
      data: {
        agentId: id,
        message,
      },
    });

    return true;
  }

  /**
   * Kill a background agent
   *
   * Interrupts the agent and removes it from tracking.
   *
   * @param id - Agent identifier
   * @param signal - Unused (for API consistency)
   * @returns true if agent was found and killed, false otherwise
   */
  killAgent(id: string): boolean {
    const info = this.agents.get(id);

    if (!info) {
      logger.debug(`[BackgroundAgentManager] Agent ${id} not found for killing`);
      return false;
    }

    try {
      // Interrupt the agent (cancel type)
      info.agent.interrupt('cancel');
      logger.debug(`[BackgroundAgentManager] Interrupted agent ${id}`);

      // Remove from tracking BEFORE emitting event
      // This ensures subscribers see the updated state
      this.agents.delete(id);
      logger.debug(`[BackgroundAgentManager] Removed agent ${id} from tracking`);

      // Emit killed event after removing from tracking
      this.activityStream.emit({
        id: this.generateEventId(),
        type: ActivityEventType.BACKGROUND_AGENT_KILLED,
        timestamp: Date.now(),
        data: {
          agentId: id,
        },
      });

      return true;
    } catch (error) {
      logger.error(`[BackgroundAgentManager] Failed to kill agent ${id}:`, error);
      return false;
    }
  }

  /**
   * Generate status reminders for primary agent
   *
   * Creates reminder strings for:
   * - All executing agents
   * - Agents that completed within the last 5 minutes
   * - Agents that errored within the last 5 minutes
   *
   * Format matches BashProcessManager.getStatusReminders():
   * - Executing: "Background agent {id} [executing]: "{prompt}" ({elapsed}). Use agent-output(agent_id="{id}") to check progress or kill-agent(agent_id="{id}") to stop."
   * - Completed: "Background agent {id} [completed]: "{prompt}" finished ({elapsed}). Use agent-output(agent_id="{id}") to read results."
   * - Error: "Background agent {id} [error]: "{prompt}" failed ({elapsed}). Use agent-output(agent_id="{id}") to see error."
   *
   * @returns Array of reminder strings
   */
  getStatusReminders(): string[] {
    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;
    const reminders: string[] = [];

    for (const info of this.agents.values()) {
      const elapsed = formatDuration(now - info.startTime);

      if (info.status === 'executing') {
        // Agent is still running
        reminders.push(
          `Background agent ${info.id} [executing]: "${info.taskPrompt}" (${elapsed}). ` +
          `Use agent-output(agent_id="${info.id}") to check progress or kill-agent(agent_id="${info.id}") to stop.`
        );
      } else if (info.status === 'completed' && info.completionTime && info.completionTime >= fiveMinutesAgo) {
        // Agent completed within last 5 minutes
        reminders.push(
          `Background agent ${info.id} [completed]: "${info.taskPrompt}" finished (${elapsed}). ` +
          `Use agent-output(agent_id="${info.id}") to read results.`
        );
      } else if (info.status === 'error' && info.completionTime && info.completionTime >= fiveMinutesAgo) {
        // Agent errored within last 5 minutes
        reminders.push(
          `Background agent ${info.id} [error]: "${info.taskPrompt}" failed (${elapsed}). ` +
          `Use agent-output(agent_id="${info.id}") to see error.`
        );
      }
    }

    return reminders;
  }

  /**
   * Get the current number of tracked agents
   *
   * @returns Number of agents currently tracked
   */
  getCount(): number {
    return this.agents.size;
  }

  /**
   * Shutdown all running background agents
   *
   * Interrupts all executing agents and clears tracking.
   */
  shutdown(): void {
    const executingAgents = Array.from(this.agents.values()).filter(
      info => info.status === 'executing'
    );

    if (executingAgents.length > 0) {
      logger.info(`[BackgroundAgentManager] Shutting down ${executingAgents.length} background agent(s)...`);

      for (const info of executingAgents) {
        try {
          info.agent.interrupt('cancel');
        } catch (error) {
          logger.warn(`[BackgroundAgentManager] Failed to interrupt agent ${info.id}:`, error);
        }
      }
    }

    this.agents.clear();
    logger.debug('[BackgroundAgentManager] Shutdown complete');
  }

  /**
   * Remove the oldest completed agent from tracking
   *
   * @returns true if an agent was removed, false if no completed agents exist
   */
  private removeOldestCompletedAgent(): boolean {
    let oldestCompleted: BackgroundAgentInfo | null = null;
    let oldestTime = Infinity;

    // Find the oldest completed agent
    for (const info of this.agents.values()) {
      if (info.status !== 'executing' && info.startTime < oldestTime) {
        oldestCompleted = info;
        oldestTime = info.startTime;
      }
    }

    if (oldestCompleted) {
      this.agents.delete(oldestCompleted.id);
      logger.debug(`[BackgroundAgentManager] Removed oldest completed agent ${oldestCompleted.id}`);
      return true;
    }

    return false;
  }

  /**
   * Generate unique agent ID
   *
   * Format: bg-agent-{timestamp}-{random}
   *
   * @returns Unique agent identifier
   */
  private generateAgentId(): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `bg-agent-${timestamp}-${random}`;
  }

  /**
   * Generate unique event ID
   *
   * @returns Unique event identifier
   */
  private generateEventId(): string {
    return `evt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }
}
