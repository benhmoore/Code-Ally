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
  const primaryAgent = registry.get('agent');
  const mainClient = registry.get('model_client');
  const serviceClient = registry.get('service_model_client');
  primaryAgent?.relinquishSharedResources?.(mainClient, registry.get('activity_stream'));
  primaryAgent?.relinquishSharedResources?.(serviceClient, null);

  await Promise.all([
    // Enqueue the recoverable interruption before agent cancellation can enqueue
    // a user-cancel transition. Process exit must not cancel the durable goal.
    attempt('durable run', () => registry.get('run_supervisor')?.interruptForShutdown('Owning Code-Ally process closed')),
    attempt('primary agent', () => registry.get('agent')?.stopAndDrain()),
    attempt('background watchers', () => registry.get('background_task_registry')?.shutdown()),
    attempt('background shells', () => registry.get('bash_process_manager')?.shutdown()),
    attempt('background agents', () => registry.get('background_agent_manager')?.shutdown()),
    attempt('idle admission', () => registry.get('idle_task_coordinator')?.cleanup()),
    ...(['session_title_generator', 'idle_message_generator', 'auto_tool_cleanup'] as const).map(name =>
      attempt(name, () => registry.get(name)?.cleanup())),
  ]);
  // Auxiliary persistence must settle before SessionManager cleanup. The
  // primary agent's cleanup owns its client; the separate service client has
  // no initialize/cleanup lifecycle and is owned here.
  const clients = new Set([mainClient, serviceClient]);
  for (const client of clients) {
    if (client) await attempt('model client', () => client.close?.());
  }
  await attempt('service registry', () => registry.shutdown());
  return failures;
}
