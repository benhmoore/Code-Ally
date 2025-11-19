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
import { SYSTEM_REMINDERS, isReminderFunction } from '../config/systemReminders.js';

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

// ===========================================
// CONTINUATION REMINDERS
// ===========================================

/**
 * Create HTTP error continuation reminder
 */
export function createHttpErrorReminder(errorMessage: string): Message {
  const config = SYSTEM_REMINDERS.CONTINUATIONS.HTTP_ERROR;
  const text = isReminderFunction(config.text)
    ? config.text(errorMessage)
    : config.text;
  return createSystemReminder(text as string, config.persist);
}

/**
 * Create empty response continuation reminder
 */
export function createEmptyResponseReminder(): Message {
  const config = SYSTEM_REMINDERS.CONTINUATIONS.EMPTY_RESPONSE;
  return createSystemReminder(config.text as string, config.persist);
}

/**
 * Create empty response after tools reminder
 */
export function createEmptyAfterToolsReminder(): Message {
  const config = SYSTEM_REMINDERS.CONTINUATIONS.EMPTY_AFTER_TOOLS;
  return createSystemReminder(config.text as string, config.persist);
}

// ===========================================
// VALIDATION REMINDERS
// ===========================================

/**
 * Create tool call validation error reminder
 */
export function createValidationErrorReminder(errors: string[]): Message {
  const config = SYSTEM_REMINDERS.VALIDATION.TOOL_CALL_ERRORS;
  const text = isReminderFunction(config.text)
    ? config.text(errors)
    : config.text;
  return createSystemReminder(text as string, config.persist);
}

// ===========================================
// REQUIREMENT REMINDERS
// ===========================================

/**
 * Create required tools warning reminder
 */
export function createRequiredToolsWarning(missingTools: string[]): Message {
  const config = SYSTEM_REMINDERS.REQUIREMENTS.REQUIRED_TOOLS_WARNING;
  const text = isReminderFunction(config.text)
    ? config.text(missingTools)
    : config.text;
  return createSystemReminder(text as string, config.persist);
}

/**
 * Create requirements not met reminder
 */
export function createRequirementsNotMetReminder(reminderMessage: string): Message {
  const config = SYSTEM_REMINDERS.REQUIREMENTS.REQUIREMENTS_NOT_MET;
  const text = isReminderFunction(config.text)
    ? config.text(reminderMessage)
    : config.text;
  return createSystemReminder(text as string, config.persist);
}

// ===========================================
// INTERRUPTION REMINDERS
// ===========================================

/**
 * Create user interruption reminder
 */
export function createInterruptionReminder(): Message {
  const config = SYSTEM_REMINDERS.INTERRUPTIONS.USER_INTERRUPTED;
  return createSystemReminder(config.text as string, config.persist);
}

/**
 * Create activity timeout reminder
 */
export function createActivityTimeoutReminder(
  elapsedSeconds: number,
  attempt: number,
  maxAttempts: number
): Message {
  const config = SYSTEM_REMINDERS.INTERRUPTIONS.ACTIVITY_TIMEOUT;
  const text = isReminderFunction(config.text)
    ? config.text(elapsedSeconds, attempt, maxAttempts)
    : config.text;
  return createSystemReminder(text as string, config.persist);
}

/**
 * Create activity timeout continuation reminder
 */
export function createActivityTimeoutContinuationReminder(): Message {
  const config = SYSTEM_REMINDERS.INTERRUPTIONS.ACTIVITY_TIMEOUT_CONTINUATION;
  return createSystemReminder(config.text as string, config.persist);
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
  const text = isReminderFunction(config.text)
    ? config.text(toolCallCount, originalPrompt)
    : config.text;
  return text as string;
}

// ===========================================
// EXPLORATORY TOOL REMINDERS
// ===========================================

/**
 * Create gentle exploratory tool warning
 */
export function createExploratoryGentleWarning(consecutiveCount: number): string {
  const config = SYSTEM_REMINDERS.EXPLORATORY.GENTLE_WARNING;
  const text = isReminderFunction(config.text)
    ? config.text(consecutiveCount)
    : config.text;
  return text as string;
}

/**
 * Create stern exploratory tool warning
 */
export function createExploratorySternWarning(consecutiveCount: number): string {
  const config = SYSTEM_REMINDERS.EXPLORATORY.STERN_WARNING;
  const text = isReminderFunction(config.text)
    ? config.text(consecutiveCount)
    : config.text;
  return text as string;
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
    return config.text as string;
  } else if (percentUsed >= 90) {
    const config = SYSTEM_REMINDERS.TIME.URGENT_90;
    const text = isReminderFunction(config.text)
      ? config.text(remaining, percentRemaining)
      : config.text;
    return text as string;
  } else if (percentUsed >= 75) {
    const config = SYSTEM_REMINDERS.TIME.WARNING_75;
    const text = isReminderFunction(config.text)
      ? config.text(remaining, percentRemaining)
      : config.text;
    return text as string;
  } else if (percentUsed >= 50) {
    const config = SYSTEM_REMINDERS.TIME.HALFWAY;
    const text = isReminderFunction(config.text)
      ? config.text(remaining)
      : config.text;
    return text as string;
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
  const text = isReminderFunction(config.text)
    ? config.text(todoTask, toolCallSummary)
    : config.text;
  return text as string;
}

// ===========================================
// CYCLE DETECTION REMINDERS
// ===========================================

/**
 * Create generic cycle warning
 */
export function createCycleWarning(toolName: string, count: number): string {
  const config = SYSTEM_REMINDERS.CYCLE_DETECTION.CYCLE_WARNING;
  const text = isReminderFunction(config.text)
    ? config.text(toolName, count)
    : config.text;
  return text as string;
}

/**
 * Create empty search streak warning
 */
export function createEmptySearchStreakWarning(streakCount: number): string {
  const config = SYSTEM_REMINDERS.CYCLE_DETECTION.EMPTY_SEARCH_STREAK;
  const text = isReminderFunction(config.text)
    ? config.text(streakCount)
    : config.text;
  return text as string;
}

/**
 * Create low hit rate warning
 */
export function createLowHitRateWarning(hitRate: number, searchCount: number): string {
  const config = SYSTEM_REMINDERS.CYCLE_DETECTION.LOW_HIT_RATE;
  const text = isReminderFunction(config.text)
    ? config.text(hitRate, searchCount)
    : config.text;
  return text as string;
}

// ===========================================
// CONTEXT USAGE REMINDERS
// ===========================================

/**
 * Create context usage warning for specialized agents
 */
export function createContextUsageWarning(contextUsage: number): Message {
  const config = SYSTEM_REMINDERS.CONTEXT.USAGE_WARNING;
  const text = isReminderFunction(config.text)
    ? config.text(contextUsage)
    : config.text;
  return createSystemReminder(text as string, config.persist);
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
  const text = isReminderFunction(config.text)
    ? config.text(agentId)
    : config.text;
  return {
    system_reminder: text as string,
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
  const text = isReminderFunction(config.text)
    ? config.text(agentType, taskPrompt, maxDuration, thoroughness)
    : config.text;
  return {
    system_reminder: text as string,
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
    system_reminder: config.text as string,
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
  const text = isReminderFunction(config.text)
    ? config.text(filePath)
    : config.text;
  return {
    system_reminder: text as string,
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
  return createSystemReminder(config.text as string, config.persist);
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
  const text = isReminderFunction(config.text)
    ? config.text(todoSummary, currentTask, guidance)
    : config.text;
  return createSystemReminder(text as string, config.persist);
}
