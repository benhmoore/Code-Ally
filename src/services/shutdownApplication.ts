import type { ServiceRegistry } from './ServiceRegistry.js';

/**
 * Start cancellation for every resource owner before waiting for any one owner.
 * Keep registrations alive until those owners settle, then drain service cleanup.
 * A failed cleanup never suppresses another attempt or masquerades as success.
 */
export async function shutdownApplication(registry: ServiceRegistry): Promise<Error[]> {
  const failures: Error[] = [];
  const attempt = async (label: string, operation: () => void | Promise<void>) => {
    try { await operation(); }
    catch (cause) { failures.push(new Error(`Shutdown failed for ${label}`, { cause })); }
  };

  await Promise.all([
    // Enqueue the recoverable interruption before agent cancellation can enqueue
    // a user-cancel transition. Process exit must not cancel the durable goal.
    attempt('durable run', () => registry.get('run_supervisor')?.interruptForShutdown('Owning Code-Ally process closed')),
    attempt('primary agent', () => registry.get('agent')?.interrupt({ kind: 'user_cancel' })),
    attempt('background watchers', () => registry.get('background_task_registry')?.shutdown()),
    attempt('background shells', () => registry.get('bash_process_manager')?.shutdown()),
    attempt('background agents', () => registry.get('background_agent_manager')?.shutdown()),
  ]);
  await attempt('service registry', () => registry.shutdown());
  return failures;
}
