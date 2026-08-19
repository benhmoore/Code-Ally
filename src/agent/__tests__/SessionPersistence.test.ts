import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPersistence } from '../SessionPersistence.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';

describe('SessionPersistence.replaceConversation', () => {
  let registry: ServiceRegistry;

  beforeEach(() => {
    registry = ServiceRegistry.getInstance();
    (registry as any)._services.clear();
    (registry as any)._descriptors.clear();
  });

  afterEach(() => {
    (registry as any)._services.clear();
    (registry as any)._descriptors.clear();
  });

  const persistence = () => new SessionPersistence({} as never, 'test-agent');

  it('allows an in-memory rewind when session persistence is disabled', async () => {
    await expect(
      persistence().replaceConversation([], [], { kind: 'chat' })
    ).resolves.toBe(true);
  });

  it('allows an in-memory rewind when no session has been created', async () => {
    const replaceConversation = vi.fn();
    registry.registerInstance('session_manager', {
      getCurrentSession: () => null,
      replaceConversation,
    } as never);

    await expect(
      persistence().replaceConversation([], [], { kind: 'chat' })
    ).resolves.toBe(true);
    expect(replaceConversation).not.toHaveBeenCalled();
  });

  it('requires a durable replacement when a current session exists', async () => {
    const replaceConversation = vi.fn(async () => true);
    registry.registerInstance('session_manager', {
      getCurrentSession: () => 'session-1',
      replaceConversation,
    } as never);

    await expect(
      persistence().replaceConversation([], [], { kind: 'chat' })
    ).resolves.toBe(true);
    expect(replaceConversation).toHaveBeenCalledWith([], [], { kind: 'chat' });
  });

  it('surfaces missing replacement support for an active session', async () => {
    registry.registerInstance('session_manager', {
      getCurrentSession: () => 'session-1',
    } as never);

    await expect(
      persistence().replaceConversation([], [], { kind: 'chat' })
    ).resolves.toBe(false);
  });
});
