import type { BackgroundAgentStatus } from '@services/BackgroundAgentManager.js';

/**
 * An entered child is only interactive while its tracked run is alive. Once
 * it settles (or is removed), the UI must stop routing input to that child.
 */
export function shouldRestoreMainView(
  activeAgentId: string,
  taskStatus: BackgroundAgentStatus | null,
): boolean {
  return activeAgentId !== 'main' && taskStatus !== 'running';
}
