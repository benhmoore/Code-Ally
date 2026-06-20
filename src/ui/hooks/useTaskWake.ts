/**
 * useTaskWake - Auto-wake the idle main agent when a watched task completes
 *
 * This is the proactive, push-based half of the wait/watch feature: when a task
 * the model flagged for watching (a backgrounded agent, or a `watch` with
 * wake=true) completes WHILE the main agent is idle (turn ended, awaiting the
 * user), it injects a system-initiated continuation turn so Ally processes the
 * result without the user having to prompt it.
 *
 * Guards:
 * - Only WATCHED tasks wake (registry.isWatched); each wakes at most once.
 * - Only when the main conversation is active and idle (not mid-turn, not
 *   viewing a background agent). Completions while busy are delivered by the
 *   existing result drain on the current turn; completions while viewing an
 *   agent flush when the user returns to main and the loop goes idle.
 */

import { useEffect, useRef } from 'react';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { BackgroundTaskRegistry } from '@services/BackgroundTaskRegistry.js';
import { useActivityStreamContext } from '../contexts/ActivityContext.js';
import { ActivityEventType, ActivityEvent } from '@shared/index.js';

export interface UseTaskWakeParams {
  /** True while the main agent is processing a turn. */
  isThinking: boolean;
  /** Which agent's transcript is shown ('main' === primary conversation). */
  activeAgentId: string;
  /** Submit a (system-initiated) turn to the main agent. */
  submit: (text: string) => void;
}

export function useTaskWake({ isThinking, activeAgentId, submit }: UseTaskWakeParams): void {
  const activityStream = useActivityStreamContext();

  // Live refs so the event subscription (set up once) reads current state.
  const isThinkingRef = useRef(isThinking);
  const activeAgentIdRef = useRef(activeAgentId);
  const pendingRef = useRef<string[]>([]); // task ids awaiting a wake
  const wakingRef = useRef(false);

  useEffect(() => { isThinkingRef.current = isThinking; }, [isThinking]);
  useEffect(() => { activeAgentIdRef.current = activeAgentId; }, [activeAgentId]);

  // Try to flush pending wakes when the loop is idle on the main conversation.
  const flush = useRef<() => void>(() => {});
  flush.current = () => {
    if (wakingRef.current) return;
    if (isThinkingRef.current) return;
    if (activeAgentIdRef.current !== 'main') return;
    if (pendingRef.current.length === 0) return;

    const registry = ServiceRegistry.getInstance();
    const taskRegistry = registry.get<BackgroundTaskRegistry>('background_task_registry');
    if (!taskRegistry) return;

    const ids = pendingRef.current;
    pendingRef.current = [];

    const sections = ids.map((id) => {
      const t = taskRegistry.get(id);
      if (!t) return `- ${id}: (completed; details no longer available)`;
      const body = t.result ?? t.error ?? '(no output)';
      return `- ${t.kind} ${t.id} (${t.label}) [${t.status}]:\n${body}`;
    });
    if (sections.length === 0) return;

    wakingRef.current = true;
    const noun = ids.length === 1 ? 'task' : 'tasks';
    submit(
      `[Background watch] ${ids.length} ${noun} you were watching completed:\n\n` +
      `${sections.join('\n\n')}\n\nReview the result(s) and continue as appropriate.`
    );
    // Allow subsequent wakes once this turn starts processing.
    setTimeout(() => { wakingRef.current = false; }, 0);
  };

  // Re-attempt flush whenever idle/active-view state changes (covers tasks that
  // completed while Ally was busy or while the user was viewing another agent).
  useEffect(() => {
    flush.current();
  }, [isThinking, activeAgentId]);

  useEffect(() => {
    const onComplete = (event: ActivityEvent) => {
      const taskId = event.data?.taskId;
      if (!taskId) return;
      const registry = ServiceRegistry.getInstance();
      const taskRegistry = registry.get<BackgroundTaskRegistry>('background_task_registry');
      if (!taskRegistry || !taskRegistry.isWatched(taskId)) return;
      taskRegistry.clearWatched(taskId); // wake at most once
      pendingRef.current.push(taskId);
      // Defer so the task's final state is settled in the registry.
      setTimeout(() => flush.current(), 50);
    };

    const unsubs = [
      ActivityEventType.AGENT_BACKGROUND_COMPLETE,
      ActivityEventType.BACKGROUND_TASK_COMPLETE,
    ].map((type) => activityStream.subscribe(type, onComplete));
    return () => unsubs.forEach((u) => u());
  }, [activityStream]);
}
