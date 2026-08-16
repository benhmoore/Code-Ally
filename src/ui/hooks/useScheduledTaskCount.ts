/**
 * useScheduledTaskCount Hook
 *
 * Provides the count of enabled scheduled tasks for the current project/profile.
 */

import { useEffect, useState } from 'react';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { useActivityStreamContext } from '../contexts/ActivityContext.js';
import { ActivityEventType } from '@shared/index.js';

export function useScheduledTaskCount(): number {
  const [count, setCount] = useState(0);
  const activityStream = useActivityStreamContext();

  useEffect(() => {
    let cancelled = false;
    const update = async () => {
      const registry = ServiceRegistry.getInstance();
      const manager = registry.get('scheduled_task_manager');
      if (!manager) {
        if (!cancelled) setCount(0);
        return;
      }
      const tasks = await manager.listCurrentProject();
      if (!cancelled) {
        setCount(tasks.filter((task) => task.enabled).length);
      }
    };

    update();
    const unsubscribe = activityStream.subscribe(ActivityEventType.SCHEDULED_TASKS_UPDATED, () => {
      void update();
    });
    const interval = setInterval(() => void update(), 60_000);

    return () => {
      cancelled = true;
      unsubscribe();
      clearInterval(interval);
    };
  }, [activityStream]);

  return count;
}
