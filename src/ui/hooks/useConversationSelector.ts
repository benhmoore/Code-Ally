import { useMemo, useSyncExternalStore } from 'react';
import type { ConversationViewSnapshot } from '@services/ConversationViewStore.js';

/** Read-only boundary shared by live sessions and frozen completed conversations. */
export interface ConversationSource {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => ConversationViewSnapshot;
}

export const EMPTY_CONVERSATION: ConversationViewSnapshot = {
  messages: [], activeToolCalls: [], isThinking: false, isCompacting: false,
  contextUsage: 0, statusMessages: [], compactionNotices: [],
};
const noSubscribe = () => () => {};
export function frozenConversation(snapshot = EMPTY_CONVERSATION): ConversationSource {
  return { subscribe: noSubscribe, getSnapshot: () => snapshot };
}

/** Subscribe only to the values a surface renders, preserving unchanged selections. */
export function useConversationSelector<T>(
  source: ConversationSource,
  select: (snapshot: ConversationViewSnapshot) => T,
  equal: (previous: T, next: T) => boolean = Object.is,
): T {
  const getSelection = useMemo(() => {
    let previousSnapshot: ConversationViewSnapshot | undefined;
    let selection: T;
    return () => {
      const snapshot = source.getSnapshot();
      if (snapshot !== previousSnapshot) {
        const next = select(snapshot);
        if (!previousSnapshot || !equal(selection, next)) selection = next;
        previousSnapshot = snapshot;
      }
      return selection;
    };
  }, [source, select, equal]);
  return useSyncExternalStore(source.subscribe, getSelection, getSelection);
}

export function shallowEqual<T extends object>(previous: T, next: T): boolean {
  const keys = Object.keys(previous) as Array<keyof T>;
  return keys.length === Object.keys(next).length && keys.every(key => Object.is(previous[key], next[key]));
}

export const selectThinking = (view: ConversationViewSnapshot): boolean => view.isThinking;
export const selectActivity = (view: ConversationViewSnapshot) => ({
  isThinking: view.isThinking, isCompacting: view.isCompacting,
});
