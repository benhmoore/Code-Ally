/** Share publication ownership among the terminal's activity domains. */
import { useEffect, useMemo, useRef } from 'react';
import type { Agent } from '@agent/Agent.js';
import type { ModalEntry } from '../useModalState.js';
import { ActivityRequestScope } from './ActivityRequestScope.js';

function routeIdentity(entry: ModalEntry | undefined): string | undefined {
  if (!entry) return undefined;
  if ('queue' in entry) return `${entry.kind}:${entry.queue[0]?.requestId ?? ''}`;
  if ('request' in entry && 'requestId' in entry.request) return `${entry.kind}:${entry.request.requestId}`;
  return entry.kind;
}

export function useActivityRequestScope(
  agent: Agent,
  modal: ModalEntry | undefined,
  activeAgentId = 'main'
): ActivityRequestScope {
  const route = routeIdentity(modal);
  const current = useRef({ agent, activeAgentId, route });
  // Publication predicates read the render's owner immediately, before passive effects.
  current.current = { agent, activeAgentId, route };
  const scope = useMemo(
    () =>
      new ActivityRequestScope(
        () => current.current.agent === agent && current.current.activeAgentId === activeAgentId,
        () => current.current.route
      ),
    [agent, activeAgentId]
  );
  useEffect(() => {
    scope.open();
    return () => scope.close();
  }, [scope]);
  useEffect(() => {
    scope.updateRoute(route);
  }, [scope, route]);
  return scope;
}
