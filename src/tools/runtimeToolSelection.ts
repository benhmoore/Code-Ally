import type { BackgroundTask } from '../services/BackgroundTaskRegistry.js';

const SCHEDULE_INTENT = /\b(schedule(?:d|s|ing)?|recurr(?:ing|ence)?|cron|daily|weekly|monthly|every\s+(?:day|morning|evening|night|week|month)|remind\s+me)\b/i;
const DELAYED_ACTION_INTENT = /\b(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)|in\s+\d+\s+(?:minutes?|hours?|days?)|tomorrow\s+at)\b/i;
const WATCH_INTENT = /\b(watch|monitor|notify\s+me|poll|wait\s+until|when\s+.+\s+(?:appears|changes|finishes|is\s+ready))\b/i;
const LINE_EDIT_INTENT = /\b(?:at|on|insert|replace|delete|remove|edit)\s+lines?\s+\d+|\bline[- ]number/i;
const AGENT_MANAGEMENT_INTENT = /\b(?:manage|create|configure|edit|delete|remove|list)\b.{0,24}\bagents?\b|\bagent\s+(?:configuration|profile)\b/i;
const SESSION_INTENT = /\b(?:session|conversation)\s+history\b|\b(?:past|previous|earlier|prior|last)\s+(?:session|conversation|discussion)\b|\bwhat\s+did\s+we\b/i;
const TEMPORAL_INTENT = /\b(?:today|tomorrow|yesterday|now|current\s+(?:date|time)|this\s+(?:morning|evening|week|month)|latest)\b|\b(?:at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)|in\s+\d+\s+(?:minutes?|hours?|days?))\b/i;

export function needsTemporalContext(userText: string | undefined): boolean {
  const text = userText ?? '';
  return SCHEDULE_INTENT.test(text) || DELAYED_ACTION_INTENT.test(text) || TEMPORAL_INTENT.test(text);
}

export interface RuntimeToolSelectionContext {
  planModeActive: boolean;
  latestUserText?: string;
  backgroundTasks?: readonly Pick<BackgroundTask, 'kind' | 'status'>[];
  hasPersistentAgent?: boolean;
  hasToolResults?: boolean;
}

/**
 * Hide schemas that cannot be used in the current state or are only relevant
 * to an explicit user intent. Execution policy remains the authority; this is
 * a context/performance optimization for the provider request.
 */
export function getRuntimeToolExclusions(context: RuntimeToolSelectionContext): string[] {
  const exclusions: string[] = [];
  const tasks = context.backgroundTasks ?? [];
  const userText = context.latestUserText ?? '';

  if (!context.planModeActive) exclusions.push('write-plan', 'exit-plan-mode');
  if (!context.hasPersistentAgent) exclusions.push('agent-ask');
  if (!context.hasToolResults) exclusions.push('cleanup-call');

  const hasKnownShell = tasks.some(task => task.kind === 'shell');
  if (!hasKnownShell) exclusions.push('bash-output');

  const hasRunningShell = tasks.some(task => task.kind === 'shell' && task.status === 'running');
  if (!hasRunningShell) exclusions.push('kill-shell');

  const hasRunningAgent = tasks.some(task => task.kind === 'agent' && task.status === 'running');
  if (!hasRunningAgent) exclusions.push('cancel-agent');

  const hasRunningTask = tasks.some(task => task.status === 'running');
  if (!hasRunningTask) exclusions.push('wait');

  if (!SCHEDULE_INTENT.test(userText) && !DELAYED_ACTION_INTENT.test(userText)) exclusions.push('scheduled-tasks');
  if (!WATCH_INTENT.test(userText)) exclusions.push('watch');
  if (!LINE_EDIT_INTENT.test(userText)) exclusions.push('line-edit');
  if (!AGENT_MANAGEMENT_INTENT.test(userText)) exclusions.push('manage-agents');
  if (!SESSION_INTENT.test(userText)) exclusions.push('sessions');

  return exclusions;
}
