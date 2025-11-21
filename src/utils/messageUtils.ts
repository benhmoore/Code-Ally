/**
 * Message Utilities - Helper functions for creating system reminders
 *
 * This module provides type-safe utilities for creating system reminder messages.
 * All reminder text comes from the centralized SYSTEM_REMINDERS catalog.
 *
 * Usage:
 * - Use specific helpers (createInterruptionReminder, createTimeReminder, etc.)
 * - Use createSystemReminder() directly for custom reminders
 * - All helpers return properly formatted Message objects
 */

import { Message } from '../types/index.js';
import { SYSTEM_REMINDER } from '../config/constants.js';
import { SYSTEM_REMINDERS, SystemReminderConfig, isReminderFunction } from '../config/systemReminders.js';

/**
 * Core helper - creates a system reminder message
 *
 * @param content - Reminder content text
 * @param persist - Whether to persist in conversation history (default: false)
 * @returns Message object for conversation history
 */
export function createSystemReminder(
  content: string,
  persist: boolean = false
): Message {
  const persistAttr = persist ? ` ${SYSTEM_REMINDER.PERSIST_ATTRIBUTE}` : '';
  return {
    role: 'system',
    content: `${SYSTEM_REMINDER.OPENING_TAG}${persistAttr}>\n${content}\n${SYSTEM_REMINDER.CLOSING_TAG}`,
    timestamp: Date.now(),
  };
}

function resolveReminderText<T extends any[]>(
  config: SystemReminderConfig,
  ...args: T
): string {
  if (isReminderFunction(config.text)) {
    return config.text(...args);
  }
  return config.text;
}

// ===========================================
// CONTINUATION REMINDERS
// ===========================================

/**
 * Create HTTP error continuation reminder
 */
export function createHttpErrorReminder(errorMessage: string): Message {
  const config = SYSTEM_REMINDERS.CONTINUATIONS.HTTP_ERROR;
  return createSystemReminder(
    resolveReminderText(config, errorMessage),
    config.persist
  );
}

/**
 * Create empty response continuation reminder
 */
export function createEmptyResponseReminder(): Message {
  const config = SYSTEM_REMINDERS.CONTINUATIONS.EMPTY_RESPONSE;
  return createSystemReminder(
    resolveReminderText(config),
    config.persist
  );
}

/**
 * Create empty response after tools reminder
 */
export function createEmptyAfterToolsReminder(): Message {
  const config = SYSTEM_REMINDERS.CONTINUATIONS.EMPTY_AFTER_TOOLS;
  return createSystemReminder(
    resolveReminderText(config),
    config.persist
  );
}

// ===========================================
// VALIDATION REMINDERS
// ===========================================

/**
 * Create tool call validation error reminder
 */
export function createValidationErrorReminder(errors: string[]): Message {
  const config = SYSTEM_REMINDERS.VALIDATION.TOOL_CALL_ERRORS;
  return createSystemReminder(
    resolveReminderText(config, errors),
    config.persist
  );
}

// ===========================================
// REQUIREMENT REMINDERS
// ===========================================

/**
 * Create required tools warning reminder
 */
export function createRequiredToolsWarning(missingTools: string[]): Message {
  const config = SYSTEM_REMINDERS.REQUIREMENTS.REQUIRED_TOOLS_WARNING;
  return createSystemReminder(
    resolveReminderText(config, missingTools),
    config.persist
  );
}

/**
 * Create requirements not met reminder
 */
export function createRequirementsNotMetReminder(reminderMessage: string): Message {
  const config = SYSTEM_REMINDERS.REQUIREMENTS.REQUIREMENTS_NOT_MET;
  return createSystemReminder(
    resolveReminderText(config, reminderMessage),
    config.persist
  );
}

// ===========================================
// INTERRUPTION REMINDERS
// ===========================================

/**
 * Create user interruption reminder
 */
export function createInterruptionReminder(): Message {
  const config = SYSTEM_REMINDERS.INTERRUPTIONS.USER_INTERRUPTED;
  return createSystemReminder(
    resolveReminderText(config),
    config.persist
  );
}

/**
 * Create activity timeout continuation reminder
 */
export function createActivityTimeoutContinuationReminder(): Message {
  const config = SYSTEM_REMINDERS.INTERRUPTIONS.ACTIVITY_TIMEOUT_CONTINUATION;
  return createSystemReminder(
    resolveReminderText(config),
    config.persist
  );
}

/**
 * Create a system reminder for thinking loop detection
 *
 * @param reason The detected loop pattern (e.g., "Reconstruction cycle detected (3x)")
 * @returns System reminder message
 */
export function createThinkingLoopContinuationReminder(reason: string): Message {
  const config = SYSTEM_REMINDERS.INTERRUPTIONS.THINKING_LOOP;
  return createSystemReminder(
    resolveReminderText(config, reason),
    config.persist
  );
}

// ===========================================
// PROGRESS REMINDERS
// ===========================================

/**
 * Create checkpoint reminder
 */
export function createCheckpointReminder(
  toolCallCount: number,
  originalPrompt: string
): string {
  const config = SYSTEM_REMINDERS.PROGRESS.CHECKPOINT;
  return resolveReminderText(config, toolCallCount, originalPrompt);
}

// ===========================================
// EXPLORATORY TOOL REMINDERS
// ===========================================

/**
 * Create gentle exploratory tool warning
 */
export function createExploratoryGentleWarning(consecutiveCount: number): string {
  const config = SYSTEM_REMINDERS.EXPLORATORY.GENTLE_WARNING;
  return resolveReminderText(config, consecutiveCount);
}

/**
 * Create stern exploratory tool warning
 */
export function createExploratorySternWarning(consecutiveCount: number): string {
  const config = SYSTEM_REMINDERS.EXPLORATORY.STERN_WARNING;
  return resolveReminderText(config, consecutiveCount);
}

// ===========================================
// TIME REMINDERS
// ===========================================

/**
 * Create time reminder based on percentage used
 *
 * Returns appropriate urgency level based on time consumed:
 * - 50%: Gentle reminder
 * - 75%: Warning to wrap up
 * - 90%: Urgent finish current work
 * - 100%+: Critical wrap up immediately
 */
export function createTimeReminder(
  percentUsed: number,
  remaining: string
): string | null {
  const percentRemaining = Math.round(100 - percentUsed);

  if (percentUsed >= 100) {
    const config = SYSTEM_REMINDERS.TIME.EXCEEDED_100;
    return resolveReminderText(config);
  } else if (percentUsed >= 90) {
    const config = SYSTEM_REMINDERS.TIME.URGENT_90;
    return resolveReminderText(config, remaining, percentRemaining);
  } else if (percentUsed >= 75) {
    const config = SYSTEM_REMINDERS.TIME.WARNING_75;
    return resolveReminderText(config, remaining, percentRemaining);
  } else if (percentUsed >= 50) {
    const config = SYSTEM_REMINDERS.TIME.HALFWAY;
    return resolveReminderText(config, remaining);
  }

  return null;
}

// ===========================================
// FOCUS REMINDERS
// ===========================================

/**
 * Create focus reminder based on current in_progress todo
 */
export function createFocusReminder(
  todoTask: string,
  toolCallSummary: string
): string {
  const config = SYSTEM_REMINDERS.FOCUS.TODO_FOCUS;
  return resolveReminderText(config, todoTask, toolCallSummary);
}

// ===========================================
// CYCLE DETECTION REMINDERS
// ===========================================

/**
 * Create generic cycle warning
 */
export function createCycleWarning(toolName: string, count: number): string {
  const config = SYSTEM_REMINDERS.CYCLE_DETECTION.CYCLE_WARNING;
  return resolveReminderText(config, toolName, count);
}

/**
 * Create empty search streak warning
 */
export function createEmptySearchStreakWarning(streakCount: number): string {
  const config = SYSTEM_REMINDERS.CYCLE_DETECTION.EMPTY_SEARCH_STREAK;
  return resolveReminderText(config, streakCount);
}

/**
 * Create low hit rate warning
 */
export function createLowHitRateWarning(hitRate: number, searchCount: number): string {
  const config = SYSTEM_REMINDERS.CYCLE_DETECTION.LOW_HIT_RATE;
  return resolveReminderText(config, hitRate, searchCount);
}

// ===========================================
// CONTEXT USAGE REMINDERS
// ===========================================

/**
 * Create context usage warning for specialized agents
 */
export function createContextUsageWarning(contextUsage: number): Message {
  const config = SYSTEM_REMINDERS.CONTEXT.USAGE_WARNING;
  return createSystemReminder(
    resolveReminderText(config, contextUsage),
    config.persist
  );
}

// ===========================================
// TOOL-SPECIFIC REMINDERS
// ===========================================

/**
 * Create agent persistence reminder
 * Returns object with both reminder text and persistence flag
 */
export function createAgentPersistenceReminder(agentId: string): {
  system_reminder: string;
  system_reminder_persist: boolean;
} {
  const config = SYSTEM_REMINDERS.TOOLS.AGENT_PERSISTENCE;
  return {
    system_reminder: resolveReminderText(config, agentId),
    system_reminder_persist: config.persist,
  };
}

/**
 * Create agent task context reminder (persistent)
 * Returns object with both reminder text and persistence flag
 */
export function createAgentTaskContextReminder(
  agentType: string,
  taskPrompt: string,
  maxDuration: string | null,
  thoroughness: string
): {
  system_reminder: string;
  system_reminder_persist: boolean;
} {
  const config = SYSTEM_REMINDERS.TOOLS.AGENT_TASK_CONTEXT;
  return {
    system_reminder: resolveReminderText(config, agentType, taskPrompt, maxDuration, thoroughness),
    system_reminder_persist: config.persist,
  };
}

/**
 * Create plan accepted notification
 * Returns object with both reminder text and persistence flag
 */
export function createPlanAcceptedReminder(): {
  system_reminder: string;
  system_reminder_persist: boolean;
} {
  const config = SYSTEM_REMINDERS.TOOLS.PLAN_ACCEPTED;
  return {
    system_reminder: resolveReminderText(config),
    system_reminder_persist: config.persist,
  };
}

/**
 * Create write-temp file hint
 * Returns object with both reminder text and persistence flag
 */
export function createWriteTempHintReminder(filePath: string): {
  system_reminder: string;
  system_reminder_persist: boolean;
} {
  const config = SYSTEM_REMINDERS.TOOLS.WRITE_TEMP_HINT;
  return {
    system_reminder: resolveReminderText(config, filePath),
    system_reminder_persist: config.persist,
  };
}

// ===========================================
// TODO LIST REMINDERS
// ===========================================

/**
 * Create empty todo list reminder
 */
export function createEmptyTodoReminder(): Message {
  const config = SYSTEM_REMINDERS.TODO.EMPTY_LIST;
  return createSystemReminder(
    resolveReminderText(config),
    config.persist
  );
}

/**
 * Create active todo list reminder
 */
export function createActiveTodoReminder(
  todoSummary: string,
  currentTask: string | null,
  guidance: string
): Message {
  const config = SYSTEM_REMINDERS.TODO.ACTIVE_LIST;
  return createSystemReminder(
    resolveReminderText(config, todoSummary, currentTask, guidance),
    config.persist
  );
}
