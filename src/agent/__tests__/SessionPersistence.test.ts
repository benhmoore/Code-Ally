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

  function turnPersistence(autoSave: ReturnType<typeof vi.fn>) {
    const forceSave = vi.fn(async () => true);
    registry.registerInstance('session_manager', {
      getCurrentSession: () => 'session-1', autoSave, forceSave,
    } as never);
    const conversation = {
      getMessages: () => [{ role: 'user', content: 'durable objective' }],
      getTranscript: () => [], getCheckpoint: () => null,
      getProviderState: () => ({ kind: 'chat' }),
    };
    return { owner: new SessionPersistence(conversation as never, 'test-agent'), forceSave };
  }

  it('waits for snapshot admission before forcing the turn boundary', async () => {
    let admit!: (value: boolean) => void;
    const autoSave = vi.fn(() => new Promise<boolean>(resolve => { admit = resolve; }));
    const { owner, forceSave } = turnPersistence(autoSave);
    const commit = owner.commitTurnStart();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(forceSave).not.toHaveBeenCalled();
    admit(true);
    await commit;
    expect(forceSave).toHaveBeenCalledOnce();
  });

  it.each(['rejected', 'declined'])('does not persist a turn after %s snapshot admission', async outcome => {
    const autoSave = outcome === 'rejected'
      ? vi.fn().mockRejectedValue(new Error('snapshot preparation failed'))
      : vi.fn().mockResolvedValue(false);
    const { owner, forceSave } = turnPersistence(autoSave);
    await expect(owner.commitTurnStart()).rejects.toThrow();
    expect(forceSave).not.toHaveBeenCalled();
    // Noncritical autosave reports failure without leaking an unhandled rejection.
    await expect(owner.autoSave()).resolves.toBeUndefined();
  });

  it('surfaces a declined force-save rather than admitting the turn', async () => {
    const { owner, forceSave } = turnPersistence(vi.fn().mockResolvedValue(true));
    forceSave.mockResolvedValue(false);
    await expect(owner.commitTurnStart()).rejects.toThrow('Session turn boundary was not persisted');
  });

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
