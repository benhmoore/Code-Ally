/** Subscribe to the runtime permission owner and persist explicit mode changes. */
import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { ServiceRegistry } from '@services/ServiceRegistry.js';
import { applyRuntimeConfigUpdates } from '@services/RuntimeConfigSync.js';
import type { PermissionSnapshot } from '@services/PermissionPolicyService.js';
import type { PermissionMode } from '../../security/PermissionMode.js';
import type { Config } from '@shared/index.js';
import { nextPermissionMode } from '../utils/permissionPresentation.js';
import type { AppActions } from '../contexts/AppContext.js';

const noSubscribe = () => () => {};

function usePolicySource(requestedMode: PermissionMode) {
  const policy = ServiceRegistry.getInstance().get('permission_policy');
  const fallback = useMemo<PermissionSnapshot>(
    () => ({
      requestedMode,
      effectiveMode: 'manual',
      reviewing: false,
      fallbackReason: requestedMode === 'auto' ? 'Automatic review is unavailable in this session.' : undefined,
    }),
    [requestedMode]
  );
  const getFallback = useCallback(() => fallback, [fallback]);
  return { subscribe: policy?.subscribe ?? noSubscribe, getSnapshot: policy?.getSnapshot ?? getFallback };
}

/** Decision updates only rerender the audit surface that reads the full snapshot. */
export function usePermissionSnapshot(requestedMode: PermissionMode): PermissionSnapshot {
  const source = usePolicySource(requestedMode);
  return useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

export function usePermissionMode(config: Config, actions: Pick<AppActions, 'updateConfig' | 'addMessage'>) {
  const { subscribe, getSnapshot } = usePolicySource(config.permission_mode);
  const getMode = useCallback(() => getSnapshot().effectiveMode, [getSnapshot]);
  const effectiveMode = useSyncExternalStore(subscribe, getMode, getMode);
  const changing = useRef(false);
  const cycle = useCallback(() => {
    if (changing.current) return;
    const requested = getSnapshot().requestedMode;
    const next = nextPermissionMode(requested);
    const registry = ServiceRegistry.getInstance();
    const manager = registry.get('config_manager');
    if (!manager) {
      actions.addMessage({
        role: 'assistant',
        content: 'Permission mode could not be changed: configuration is unavailable.',
        metadata: { isError: true },
      });
      return;
    }
    changing.current = true;
    void manager
      .setValue('permission_mode', next)
      .then(() => {
        applyRuntimeConfigUpdates(registry, { permission_mode: next });
        actions.updateConfig({ permission_mode: next });
      })
      .catch(error => {
        actions.addMessage({
          role: 'assistant',
          content: `Permission mode could not be changed: ${String(error)}`,
          metadata: { isError: true },
        });
      })
      .finally(() => {
        changing.current = false;
      });
  }, [getSnapshot, actions]);
  return { effectiveMode, cycle };
}
