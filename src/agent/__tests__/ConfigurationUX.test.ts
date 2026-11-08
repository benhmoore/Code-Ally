import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigCommand } from '../commands/ConfigCommand.js';
import { ModelCommand } from '../commands/ModelCommand.js';
import { ConfigManager } from '../../services/ConfigManager.js';
import { ServiceRegistry } from '../../services/ServiceRegistry.js';
import { ActivityStream } from '../../services/ActivityStream.js';
import { ActivityEventType } from '../../types/index.js';
import { listProviderModels, probeModelCapabilities } from '../../llm/ProviderAdapter.js';

vi.mock('../../config/paths.js', async () => ({
  ...(await vi.importActual('../../config/paths.js')),
  getBaseConfigFile: () => '/nonexistent/ally-config-ux-base.json',
}));
vi.mock('../../llm/ProviderAdapter.js', () => ({ listProviderModels: vi.fn(), probeModelCapabilities: vi.fn() }));

describe('everyday settings and model commands', () => {
  let directory: string;
  let manager: ConfigManager;
  let registry: ServiceRegistry;
  let applied: ReturnType<typeof vi.fn>;
  let notified: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ally-config-ux-'));
    manager = new ConfigManager(join(directory, 'config.json'));
    registry = ServiceRegistry.getInstance();
    registry['_services'].clear();
    registry['_descriptors'].clear();
    registry.registerInstance('config_manager', manager);
    const stream = new ActivityStream();
    registry.registerInstance('activity_stream', stream);
    applied = vi.fn();
    notified = vi.fn();
    registry.registerInstance('agent', {
      applyConfigUpdates: applied,
      getModelIdentityChangeBlock: () => null,
    } as never);
    stream.subscribe(ActivityEventType.CONFIG_UPDATED, notified);
    vi.mocked(probeModelCapabilities).mockResolvedValue({ tools: 'supported', images: 'supported', fromCache: true });
  });
  afterEach(async () => {
    registry['_services'].clear();
    registry['_descriptors'].clear();
    vi.clearAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('starts with a compact overview and exposes focused descriptions/defaults without secrets', async () => {
    manager.applyRuntimeOverrides({ api_key: 'private-provider-secret' });
    const command = new ConfigCommand();
    const overview = await command.execute([], [], registry);
    expect(overview.response!.split('\n').length).toBeLessThan(40);
    expect(overview.response).toContain('/config show all');
    const detail = await command.execute(['show', 'context_size'], [], registry);
    expect(detail.response).toContain('32768');
    expect(detail.response).toContain('whole number');
    expect(detail.response).toContain('/config set context_size=');
    const secret = await command.execute(['show', 'api_key'], [], registry);
    expect(secret.response).toContain('[REDACTED]');
    expect(secret.response).not.toContain('private-provider-secret');
  });

  it('validates numeric values before persisting and applies a permitted 16k stress context once', async () => {
    const command = new ConfigCommand();
    const invalid = await command.execute(['set', 'context_size=0'], [], registry);
    expect(invalid.response).toContain('at least 1');
    expect(manager.getConfig().context_size).toBe(32768);
    expect(applied).not.toHaveBeenCalled();
    const changed = await command.execute(['set', 'context_size=16384'], [], registry);
    expect(changed.response).toContain('Saved to profile');
    expect(changed.response).toContain('stress testing');
    expect(manager.getConfig().context_size).toBe(16384);
    expect(applied).toHaveBeenCalledExactlyOnceWith({ context_size: 16384 });
    expect(notified).toHaveBeenCalledOnce();
  });

  it('never discloses stored credentials in typo suggestions', async () => {
    manager.applyRuntimeOverrides({ api_key: 'credential-never-print', search_api_key: 'another-private-key' });
    await expect(manager.setFromString('api=wrong')).rejects.toThrow('REDACTED');
    try {
      await manager.setFromString('api=wrong');
    } catch (error) {
      expect(String(error)).not.toContain('credential-never-print');
      expect(String(error)).not.toContain('another-private-key');
    }
  });

  it('resets an encrypted search key to null rather than the literal string null', async () => {
    const save = vi.fn(async (_key: string | null) => {});
    registry.registerInstance('integration_store', {
      getSettings: async () => ({ searchProvider: 'brave', searchAPIKey: 'private-search' }),
      setSearchAPIKey: save,
      saveSettings: vi.fn(async () => {}),
    } as never);
    await new ConfigCommand().execute(['reset', 'search_api_key'], [], registry);
    expect(save).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('persists search credentials before reporting success and rolls back memory when storage fails', async () => {
    const settings = { searchProvider: 'brave', searchAPIKey: 'old-search-key', searchCount: 0 };
    const persisted: string[] = [];
    const saveSettings = vi.fn(async () => { persisted.push(settings.searchAPIKey); });
    registry.registerInstance('integration_store', {
      getSettings: () => ({ ...settings }),
      setSearchProvider: (value: string) => { settings.searchProvider = value; settings.searchAPIKey = ''; },
      setSearchAPIKey: (value: string) => { settings.searchAPIKey = value; },
      saveSettings,
    } as never);
    const command = new ConfigCommand();
    const result = await command.execute(['set', 'search_api_key=UX-FAKE-CANARY'], [], registry);
    expect(result.response).toContain('Saved securely');
    expect(persisted).toEqual(['UX-FAKE-CANARY']);
    saveSettings.mockRejectedValueOnce(new Error('fixture storage denied'));
    const failed = await command.execute(['set', 'search_api_key=not-committed'], [], registry);
    expect(failed.response).toContain('fixture storage denied');
    expect(settings.searchAPIKey).toBe('UX-FAKE-CANARY');
  });

  it('uses the shared model transaction for direct selection and emits one applied update', async () => {
    const result = await new ModelCommand().execute(['coding-model'], [], registry);
    expect(manager.getConfig().model).toBe('coding-model');
    expect(result.response).toContain('Saved to profile and applied');
    expect(probeModelCapabilities).toHaveBeenCalledOnce();
    expect(applied).toHaveBeenCalledExactlyOnceWith({ model: 'coding-model' });
    expect(notified).toHaveBeenCalledOnce();
  });

  it('reports saved settings when runtime activation fails and still publishes the authoritative value', async () => {
    applied.mockImplementation(() => {
      throw new Error('runtime refused update');
    });
    const result = await new ConfigCommand().execute(['set', 'context_size=65536'], [], registry);
    expect(manager.getConfig().context_size).toBe(65536);
    expect(result.response).toContain('Settings saved, but could not be applied');
    expect(notified).toHaveBeenCalledOnce();
    expect(notified.mock.calls[0]![0].data).toEqual({ context_size: 65536 });
  });

  it('retries activation for the same value after a persisted update fails to apply', async () => {
    applied.mockImplementationOnce(() => {
      throw new Error('first activation failed');
    });
    const command = new ConfigCommand();
    await command.execute(['set', 'context_size=65536'], [], registry);
    const retry = await command.execute(['set', 'context_size=65536'], [], registry);
    expect(retry.response).toContain('Saved to profile and applied');
    expect(applied).toHaveBeenCalledTimes(2);
    expect(applied).toHaveBeenLastCalledWith({ context_size: 65536 });
  });

  it('reports saved defaults after reset activation fails', async () => {
    await manager.setValue('context_size', 65536);
    applied.mockImplementation(() => {
      throw new Error('runtime refused update');
    });
    const result = await new ConfigCommand().execute(['reset'], [], registry);
    expect(manager.getConfig().context_size).toBe(32768);
    expect(result.response).toContain('Defaults saved, but could not be applied');
    expect(notified).toHaveBeenCalledOnce();
  });

  it('publishes a directly selected model even when its saved selection needs runtime recovery', async () => {
    applied.mockImplementation(() => {
      throw new Error('client unavailable');
    });
    const result = await new ModelCommand().execute(['saved-model'], [], registry);
    expect(manager.getConfig().model).toBe('saved-model');
    expect(result.response).toContain('Model saved, but could not be applied');
    expect(notified).toHaveBeenCalledOnce();
    expect(notified.mock.calls[0]![0].data).toEqual({ model: 'saved-model' });
  });

  it('keeps service discovery recovery specific to the service command', async () => {
    vi.mocked(listProviderModels).mockResolvedValue({ supported: false, models: [] });
    const result = await new ModelCommand().execute(['service'], [], registry);
    expect(result.response).toContain('/model service <name>');
  });
});
