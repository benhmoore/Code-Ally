import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Agent } from '@agent/Agent.js';
import { logger, LogLevel } from '@services/Logger.js';
import { ServiceRegistry } from '@services/ServiceRegistry.js';

const getLogLevel = () => logger.getLevel();
const noSubscribe = () => () => {};
const noFocus = () => null;
const EMPTY_STATS = { heapMB: 0, tokensUsed: 0, tokensTotal: 0 };

/** Debug sampling follows logger changes and the selected agent, never the global token owner. */
export function useAgentDiagnostics(agent: Agent | undefined, completedTokens?: number) {
  const isDebugMode = useSyncExternalStore(logger.subscribeLevel, getLogLevel, getLogLevel) === LogLevel.DEBUG;
  const [sampled, setSampled] = useState<{ agent: Agent | undefined; completedTokens?: number; stats: typeof EMPTY_STATS }>();
  const focusManager = useMemo(() => agent
    ? agent.getScopedRegistry()?.get('focus_manager') ?? ServiceRegistry.getInstance().get('focus_manager') : null, [agent]);
  const getFocus = useMemo(() => focusManager ? () => focusManager.getFocusDisplay() : noFocus, [focusManager]);
  const currentFocus = useSyncExternalStore(focusManager?.subscribe ?? noSubscribe, getFocus, getFocus);
  useEffect(() => {
    if (!isDebugMode) return;
    const sample = () => {
      const tokens = completedTokens === undefined ? agent?.getTokenManager() : undefined;
      setSampled({ agent, completedTokens, stats: {
        heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        tokensUsed: completedTokens ?? tokens?.getCurrentTokenCount() ?? 0,
        tokensTotal: tokens?.getContextSize() ?? 0,
      } });
    };
    sample();
    const interval = setInterval(sample, 1000);
    return () => clearInterval(interval);
  }, [agent, completedTokens, isDebugMode]);
  const debugStats = sampled?.agent === agent && sampled?.completedTokens === completedTokens
    ? sampled?.stats ?? EMPTY_STATS : EMPTY_STATS;
  return { isDebugMode, debugStats, currentFocus };
}
