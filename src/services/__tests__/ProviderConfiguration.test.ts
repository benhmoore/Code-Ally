import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../ConfigManager.js';
import { ServiceRegistry } from '../ServiceRegistry.js';
import { CompletionProvider } from '../CompletionProvider.js';
import { ConfigCommand } from '../../agent/commands/ConfigCommand.js';
import { DEFAULT_CONFIG, CONFIG_TYPES, validateConfigValue } from '../../config/defaults.js';
import { MODEL_PROVIDERS } from '../../config/providers.js';
import { createModelClient } from '../../llm/createModelClient.js';
import { validateModel, validateModelToolCapability } from '../../utils/agentValidationUtils.js';
import { SetupWizard } from '../SetupWizard.js';
import { applyRuntimeConfigUpdates } from '../RuntimeConfigSync.js';

vi.mock('../../config/paths.js', async importOriginal => ({
  ...(await importOriginal<object>()),
  getBaseConfigFile: () => '/nonexistent/ally-test-config.json',
  ensureDirectories: async () => {},
}));

describe('provider configuration across user entry points', () => {
  let directory: string;
  let manager: ConfigManager;
  let registry: ServiceRegistry;
  let completions: CompletionProvider;
  const command = new ConfigCommand();
  const complete = (input: string) => completions.getCompletions(input, input.length);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'ally-provider-config-'));
    manager = new ConfigManager(join(directory, 'config.json'));
    registry = ServiceRegistry.getInstance();
    await registry.shutdown();
    registry.registerInstance('config_manager', manager);
    completions = new CompletionProvider(undefined, manager);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await registry.shutdown();
    await rm(directory, { recursive: true, force: true });
  });

  it('offers registered providers, with matching validation and setup defaults', async () => {
    expect((await complete('/config set provider=')).map(c => c.value)).toEqual(MODEL_PROVIDERS.map(p => p.value));
    const wizard = new SetupWizard(manager);
    for (const provider of MODEL_PROVIDERS) {
      expect(validateConfigValue('provider', provider.value)).toMatchObject({ valid: true });
      expect(wizard.getDefaultEndpoint(provider.value)).toBe(provider.endpoint);
    }
    expect(await complete('/config set provider=rap')).toEqual([
      expect.objectContaining({ insertText: 'provider=rapid-mlx' }),
    ]);
    expect((await complete('/config ')).map(c => c.value)).toEqual(
      expect.arrayContaining(['show', 'setup', 'set', 'reset'])
    );
  });

  it('recognizes every config parameter and suggests only values that validation accepts', async () => {
    expect(Object.keys(DEFAULT_CONFIG).sort()).toEqual(Object.keys(CONFIG_TYPES).sort());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    for (const key of Object.keys(DEFAULT_CONFIG) as (keyof typeof DEFAULT_CONFIG)[]) {
      if (key === 'setup_completed') continue;
      expect((await complete(`/config set ${key}`)).some(c => c.value === key)).toBe(true);
      for (const suggestion of await complete(`/config set ${key}=`)) {
        let value: unknown = suggestion.value;
        try {
          value = JSON.parse(suggestion.value);
        } catch {
          /* string */
        }
        expect(validateConfigValue(key, value).valid, `${key}=${suggestion.value}`).toBe(true);
      }
    }
    expect((await complete('/config set temperature=')).map(c => c.value)).toContain('null');
    expect((await complete('/config set service_model=')).map(c => c.value)).toContain('null');
  });

  it('switches the live main and service transports through /config, then discovers Rapid-MLX models', async () => {
    const main = await createModelClient({ config: manager.getConfig() });
    const service = await createModelClient({ config: manager.getConfig() });
    registry.registerInstance('model_client', main);
    registry.registerInstance('service_model_client', service);
    await manager.setValue('api_key', 'old-provider-secret');
    const result = await command.execute(['set', 'provider=rapid-mlx'], [], registry);
    expect(result.response).not.toContain('Error:');
    expect(manager.getConfig()).toMatchObject({
      provider: 'rapid-mlx',
      endpoint: 'http://127.0.0.1:8000',
      api_key: null,
    });
    const model = 'rapid-mlx/test-model';
    const fetchMock = vi
      .fn()
      .mockImplementation(
        async () => new Response(JSON.stringify({ data: [{ id: model, capabilities: ['text', 'tools'] }] }))
      );
    vi.stubGlobal('fetch', fetchMock);
    expect((await complete('/config set model=rapid')).map(c => c.value)).toEqual([model]);
    expect(await validateModel(model)).toMatchObject({ valid: true });
    expect(await validateModelToolCapability(model, ['read'])).toMatchObject({ valid: true, supportsTools: true });
    expect(fetchMock.mock.calls.every(([url]) => url === 'http://127.0.0.1:8000/v1/models')).toBe(true);
    await command.execute(['set', `model=${model}`], [], registry);
    for (const client of [main, service]) {
      expect(client.previewRequest([], { signal: new AbortController().signal })).toMatchObject({
        provider: 'openai-compat',
        url: 'http://127.0.0.1:8000/v1/chat/completions',
        payload: { model },
      });
    }
    const reloaded = new ConfigManager(join(directory, 'config.json'));
    await reloaded.initialize();
    expect(reloaded.getConfig()).toMatchObject({ provider: 'rapid-mlx', model });
  });

  it('preserves explicit endpoints and does not leak API keys in display or completions', async () => {
    await manager.setValues({ endpoint: 'http://127.0.0.1:9999', api_key: 'private-key' });
    const shown = await command.execute([], [], registry);
    expect(shown.response).toContain('provider');
    expect(shown.response).toContain('api_key');
    expect(shown.response).not.toContain('private-key');
    expect(JSON.stringify(await complete('/config set api'))).not.toContain('private-key');
    expect(await complete('/config set api_key=')).toEqual([]);
    const changed = await command.execute(['set', 'api_key=new-private-key'], [], registry);
    expect(changed.response).not.toContain('private-key');
    expect(await readFile(join(directory, 'config.json'), 'utf8')).not.toContain('private-key');
    await manager.setValue('provider', 'rapid-mlx');
    expect(manager.getValue('endpoint')).toBe('http://127.0.0.1:9999');
    expect((await complete('/config set endpoint=')).map(c => c.value)).toEqual([
      'http://127.0.0.1:9999',
      'http://127.0.0.1:8000',
    ]);
  });

  it('applies setup and sampling resets to existing clients', async () => {
    const client = await createModelClient({ config: manager.getConfig() });
    registry.registerInstance('model_client', client);
    const wizard = new SetupWizard(manager);
    await wizard.applySetupConfig({
      ...manager.getConfig(),
      provider: 'rapid-mlx',
      endpoint: wizard.getDefaultEndpoint('rapid-mlx'),
      model: 'test-model',
      temperature: 0.7,
      top_p: 0.9,
    } as any);
    applyRuntimeConfigUpdates(registry, manager.getConfig());
    expect(client.previewRequest([], { signal: new AbortController().signal })?.payload).toMatchObject({
      temperature: 0.7,
      top_p: 0.9,
    });
    await command.execute(['set', 'temperature=null'], [], registry);
    await command.execute(['set', 'top_p=null'], [], registry);
    const payload = client.previewRequest([], { signal: new AbortController().signal })?.payload;
    expect(payload).not.toHaveProperty('temperature');
    expect(payload).not.toHaveProperty('top_p');
  });

  it('rolls back changes when saving fails', async () => {
    vi.spyOn(manager, 'saveConfig').mockRejectedValue(new Error('disk full'));
    await expect(manager.setValue('provider', 'rapid-mlx')).rejects.toThrow('disk full');
    expect(manager.getConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('uses the same provider defaults for CLI overrides, single-field reset, and full reset', async () => {
    manager.applyRuntimeOverrides({ provider: 'rapid-mlx' });
    expect(manager.getValue('endpoint')).toBe('http://127.0.0.1:8000');
    await manager.resetField('provider');
    expect(manager.getConfig()).toMatchObject({ provider: 'ollama', endpoint: 'http://localhost:11434' });
    manager.applyRuntimeOverrides({ provider: 'rapid-mlx', temperature: 0.7 });
    const changes = await manager.reset();
    expect(changes).toMatchObject({ provider: true, endpoint: true, temperature: true });
    expect(manager.getConfig()).toEqual(DEFAULT_CONFIG);
  });

  it('does not save or apply provider changes blocked by conversation state', async () => {
    registry.registerInstance('agent', {
      getModelIdentityChangeBlock: () => 'Provider-native state requires a new session',
    });
    const result = await command.execute(['set', 'provider=rapid-mlx'], [], registry);
    expect(result.response).toContain('new session');
    expect(manager.getValue('provider')).toBe('ollama');
  });

  it('completes and resets an individual parameter without resetting the connection', async () => {
    await manager.setValues({ provider: 'rapid-mlx', temperature: 0.7 });
    expect(await complete('/config reset temper')).toEqual([
      expect.objectContaining({ insertText: 'temperature', continueInput: false }),
    ]);
    await command.execute(['reset', 'temperature'], [], registry);
    expect(manager.getValue('temperature')).toBeUndefined();
    expect(manager.getValue('provider')).toBe('rapid-mlx');
    const result = await command.execute(['reset', 'not-a-setting'], [], registry);
    expect(result.response).toContain('Unknown config key');
    expect(manager.getValue('provider')).toBe('rapid-mlx');
  });
});
